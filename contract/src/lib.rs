/// Bound, an agent wallet with a hard spend cap.
///
/// The owner holds the money. The agent asks the contract to move some of it.
/// The contract applies a policy that the agent cannot change, and writes a
/// receipt when the decision settles.
///
/// The state layout of this contract is frozen. The contract is live on
/// testnet and its state is already stored, so the state root (`Bound`) and
/// the stored types (`Policy`, `Request`, `Receipt`) cannot grow a field. The
/// accounting data that does not fit in those records lives in versioned
/// raw-storage sidecars. Their values use Borsh and their formats are covered
/// by compatibility tests.
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LookupMap, LookupSet};
use near_sdk::env;
use near_sdk::require;
use near_sdk::{near, AccountId, NearToken, PromiseError};

mod types;

#[cfg(test)]
mod tests;

pub use bound_policy::Evaluation;
pub use bound_policy::Policy;
pub use types::{
    LegacyReconciliation, LegacyReconciliationView, LegacyReservation, MigrationProgress,
    MigrationStatus, NonceState, Outcome, PeriodTotals, PolicyView, Receipt, ReceiptIndexState,
    Request, RequestMeta, RequestStatus, RequestView, SchemaMarker, SpendOutcome,
};

/// The request id written on a receipt that has no request behind it.
///
/// A receipt written when the agent asked and was refused has no request,
/// because no request was created. The sentinel says so without touching the
/// frozen layout of `Receipt`, and a real request id never reaches it.
pub const NO_REQUEST: u64 = u64::MAX;

/// How long a request stays open before it expires, in seconds (30 days).
const REQUEST_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;

/// The largest page a view method returns.
const MAX_PAGE_SIZE: u64 = 100;

/// The newest request ids kept in each agent's bounded index.
const REQUEST_INDEX_CAPACITY: usize = 256;

/// The most receipts kept by the contract.
const RECEIPT_RETENTION_LIMIT: u64 = 10_000;

/// How many receipts one read walks before it gives up.
///
/// Before the migration the receipts are read straight from the frozen state
/// map, because the bounded indexes are built by the migration itself.
const LEGACY_RECEIPT_SCAN_LIMIT: u64 = 1_000;

/// The longest policy period accepted, in seconds (one year).
const MAX_PERIOD_SECONDS: u64 = 31_536_000;

/// The largest payment rate accepted, in payments per minute.
const MAX_RATE_LIMIT: u64 = 10_000;

/// The versioned completion marker for the current sidecar schema.
const SCHEMA_KEY: &str = "certalyn_schema_v3";

/// The marker written by the earlier, unbounded migration implementation.
///
/// That layout used different request metadata and accounting sidecars. It is
/// not compatible with the current schema, so a state carrying this key is
/// refused instead of being decoded with the wrong assumptions.
const LEGACY_SCHEMA_MARKER_KEY: &[u8] = b"certalyn_schema";

/// The persisted cursor for the bounded migration.
const MIGRATION_PROGRESS_KEY: &str = "certalyn_migration_v2";

/// The schema version this build writes.
const SCHEMA_VERSION: u8 = 5;

/// The largest number of legacy ids inspected by one migration call.
const MIGRATION_BATCH_SIZE: u64 = 100;

/// The sidecar key prefixes. Each format is versioned.
const NONCE_PREFIX: &str = "certalyn_nonce_v1:";
const PERIOD_PREFIX: &str = "certalyn_period_v1:";
const REQUEST_META_PREFIX: &str = "certalyn_request_meta_v3:";
const RECEIPT_INDEX_KEY: &str = "certalyn_receipt_index_v3";
const RECEIPT_SLOT_PREFIX: &str = "certalyn_receipt_slot_v3:";
const AGENT_RECEIPT_INDEX_PREFIX: &str = "certalyn_agent_receipt_index_v3:";
const AGENT_RECEIPT_SLOT_PREFIX: &str = "certalyn_agent_receipt_slot_v3:";
const MIGRATION_REQUEST_INDEX_PREFIX: &str = "certalyn_migration_request_index_v1:";
/// The money of the historical requests that the new accounting has to place.
const LEGACY_RESERVATION_PREFIX: &str = "certalyn_legacy_reservation_v1:";
/// How many historical records still need the owner to name a period.
const LEGACY_UNRESOLVED_KEY: &str = "certalyn_legacy_unresolved_v1";
/// The agents the migration found, so their figures can be checked.
const MIGRATION_AGENT_PREFIX: &str = "certalyn_migration_agent_v1:";

/// The migration stages. The values are part of the version-2 progress
/// sidecar format.
const MIGRATION_STAGE_REQUESTS: u8 = 0;
const MIGRATION_STAGE_RECEIPTS: u8 = 1;
const MIGRATION_STAGE_VERIFY: u8 = 2;
const MIGRATION_STAGE_COMPLETE: u8 = 3;

/// The most agents one migration checks the figures of.
///
/// The figure check reads the stored policy of every agent the migration
/// found, so the list of agents has to stay bounded.
const MIGRATION_AGENT_LIMIT: usize = 64;

/// A timestamp above this value was written in nanoseconds.
///
/// The earliest contract wrote the block timestamp into the period field
/// without converting it, so a period can be a nanosecond value. A period in
/// seconds is below this value, and a period in nanoseconds is above it.
const SECONDS_TIMESTAMP_LIMIT: u64 = 1_000_000_000_000;

/// The current time in seconds.
///
/// The chain reports the block timestamp in nanoseconds. The policy engine
/// compares that time against a period in seconds and a rate window in
/// seconds, so the contract converts once, here, and every stored timestamp
/// is in seconds.
fn now_seconds() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

/// A timestamp that was written in nanoseconds, read back in seconds.
///
/// The earliest contract wrote the block timestamp into the period and the
/// created field without converting it. A value this large is a nanosecond
/// timestamp, and a period or a time that large would never come round again,
/// so it is converted rather than thrown away.
fn normalize_timestamp(value: u64) -> u64 {
    if value > SECONDS_TIMESTAMP_LIMIT {
        value / 1_000_000_000
    } else {
        value
    }
}

/// A period that was written in nanoseconds, read back in seconds.
///
/// The unit is the same as in `normalize_timestamp`. A period of zero means
/// the period is not known, and it is left alone.
fn normalize_period(value: u64) -> u64 {
    if value == 0 {
        return 0;
    }
    normalize_timestamp(value)
}

/// The contract state.
///
/// This exact field order and layout are frozen. Do not add a field here.
#[near(contract_state)]
pub struct Bound {
    /// The account that owns the contract and sets the policies.
    owner: AccountId,
    /// The service account that makes the counterparty decisions.
    runner: AccountId,
    policies: LookupMap<AccountId, Policy>,
    requests: LookupMap<u64, Request>,
    receipts: LookupMap<u64, Receipt>,
    /// The request ids of each agent, in order.
    ///
    /// The field stays in the frozen state root. New writes keep only the
    /// newest 256 ids, so the value cannot grow without bound.
    agent_requests: LookupMap<AccountId, Vec<u64>>,
    /// Receivers the owner refuses to pay.
    blocklist: LookupSet<AccountId>,
    next_request_id: u64,
    next_receipt_id: u64,
    /// When true every spend is refused, for every agent.
    kill_switch: bool,
}

impl Default for Bound {
    fn default() -> Self {
        near_sdk::env::panic_str("the contract must be initialized with new")
    }
}

#[near]
impl Bound {
    /// Create the contract. The caller becomes the owner and the first runner.
    #[init]
    pub fn new() -> Self {
        let owner = env::predecessor_account_id();
        let contract = Self {
            owner: owner.clone(),
            runner: owner,
            policies: LookupMap::new(b"policies".to_vec()),
            requests: LookupMap::new(b"requests".to_vec()),
            receipts: LookupMap::new(b"receipts".to_vec()),
            agent_requests: LookupMap::new(b"agent_requests".to_vec()),
            blocklist: LookupSet::new(b"blocklist".to_vec()),
            next_request_id: 0,
            next_receipt_id: 0,
            kill_switch: false,
        };
        // A fresh deployment is already at the current schema. A legacy state
        // has no marker and must pass through `migrate` before it can spend.
        env::storage_write(
            SCHEMA_KEY.as_bytes(),
            &encode_sidecar(&SchemaMarker {
                version: SCHEMA_VERSION,
            }),
        );
        contract
    }

    /// Bring legacy state up to the current sidecar schema. Owner only.
    ///
    /// The method is idempotent and does a bounded batch per call. It first
    /// walks request ids, then receipt ids, using the versioned progress
    /// sidecar as its cursor. Spend operations stay closed until the final
    /// call writes the completion marker.
    pub fn migrate(&mut self) {
        self.only_owner();

        if let Some(marker) = self.schema_marker_sidecar() {
            if marker.version == SCHEMA_VERSION {
                env::log_str("MigrationAlreadyApplied");
                return;
            }
            env::panic_str("unsupported Certalyn migration schema");
        }
        if env::storage_read(LEGACY_SCHEMA_MARKER_KEY).is_some() {
            env::panic_str("unsupported Certalyn migration schema");
        }

        let mut progress = self
            .migration_progress_sidecar()
            .unwrap_or(MigrationProgress {
                stage: MIGRATION_STAGE_REQUESTS,
                cursor: 0,
                request_end: self.next_request_id,
                // No receipt is indexed yet. The counter is how far the
                // migration has read, not how many receipts exist.
                receipt_end: 0,
                unresolved: 0,
            });

        // One call inspects a bounded number of ids. A stage that has nothing
        // left to inspect hands over to the next one straight away, so a
        // small contract finishes in a single call.
        let mut budget = MIGRATION_BATCH_SIZE;
        loop {
            match progress.stage {
                MIGRATION_STAGE_REQUESTS => {
                    if budget == 0 {
                        break;
                    }
                    let end = progress
                        .request_end
                        .min(progress.cursor.saturating_add(budget));
                    let done = progress.cursor;
                    while progress.cursor < end {
                        if let Some(request) = self.requests.get(&progress.cursor) {
                            self.migrate_request(&request);
                        }
                        progress.cursor += 1;
                    }
                    budget -= progress.cursor - done;
                    if progress.cursor >= progress.request_end {
                        progress.stage = MIGRATION_STAGE_RECEIPTS;
                        progress.cursor = 0;
                        continue;
                    }
                    break;
                }
                MIGRATION_STAGE_RECEIPTS => {
                    if budget == 0 {
                        break;
                    }
                    let end = self
                        .next_receipt_id
                        .min(progress.receipt_end.saturating_add(budget));
                    let done = progress.receipt_end;
                    while progress.receipt_end < end {
                        if let Some(receipt) = self.receipts.get(&progress.receipt_end) {
                            self.migrate_receipt(&receipt);
                        }
                        progress.receipt_end += 1;
                    }
                    budget -= progress.receipt_end - done;
                    if progress.receipt_end >= self.next_receipt_id {
                        progress.stage = MIGRATION_STAGE_VERIFY;
                        progress.cursor = 0;
                        continue;
                    }
                    break;
                }
                MIGRATION_STAGE_VERIFY => {
                    // A receipt written while the migration was running still
                    // has to be indexed, so the check goes back to that phase.
                    if progress.receipt_end < self.next_receipt_id {
                        progress.stage = MIGRATION_STAGE_RECEIPTS;
                        continue;
                    }
                    if self.legacy_figures_match() && self.unresolved_legacy_records() == 0 {
                        progress.stage = MIGRATION_STAGE_COMPLETE;
                        progress.cursor = 0;
                    }
                    break;
                }
                MIGRATION_STAGE_COMPLETE => break,
                _ => env::panic_str("invalid Certalyn migration progress"),
            }
        }

        progress.unresolved = self.unresolved_legacy_records();
        self.set_migration_progress(&progress);
        if progress.stage == MIGRATION_STAGE_COMPLETE {
            self.write_schema_marker();
            env::log_str("MigrationApplied");
        } else if progress.stage == MIGRATION_STAGE_VERIFY {
            env::log_str(&format!(
                "MigrationNeedsOwner unresolved {}",
                progress.unresolved
            ));
        } else {
            env::log_str(&format!(
                "MigrationProgress stage {} cursor {}",
                progress.stage, progress.cursor
            ));
        }
    }

    /// Hand the counterparty decisions to a service account.
    pub fn set_runner(&mut self, runner: AccountId) {
        self.only_owner();
        self.runner = runner;
    }

    /// Register an agent and its policy. Owner only.
    ///
    /// The budget is the most the agent may spend in one period. The vendors
    /// list is the allowlist of receivers. An empty list allows any receiver,
    /// which is a weaker policy and the app says so.
    ///
    /// An agent that already has a policy cannot be registered again, because
    /// registering writes a fresh policy and that would wipe the spend, the
    /// nonce and the request count of a live agent. To change the limits of a
    /// live agent use `set_budget`, `set_max_single_spend`, `set_vendors`,
    /// `set_rate_limit` and `set_revoked`, which all keep the counters.
    pub fn register_agent(
        &mut self,
        agent_id: AccountId,
        budget: u128,
        period_seconds: u64,
        vendors: Vec<AccountId>,
        max_single_spend: u128,
        rate_limit: u64,
    ) {
        self.only_owner();
        require!(
            self.policies.get(&agent_id).is_none(),
            "that agent already has a policy, change the limits instead of registering it again"
        );
        require!(budget > 0, "the budget must be more than zero");
        require!(period_seconds > 0, "the period must be longer than zero");
        require!(
            period_seconds <= MAX_PERIOD_SECONDS,
            "the period is too long"
        );
        require!(rate_limit > 0, "the rate limit must be more than zero");
        require!(rate_limit <= MAX_RATE_LIMIT, "the rate limit is too high");
        require!(
            max_single_spend > 0,
            "the single spend limit must be more than zero"
        );
        require!(
            bound_policy::validate_bounds(budget, 0, 0, 0, vendors.len()),
            "the policy is outside the allowed bounds"
        );
        require!(
            bound_policy::validate_bounds(max_single_spend, 0, 0, 0, 0),
            "the single spend limit is outside the allowed bounds"
        );

        let now = now_seconds();
        let policy = Policy {
            agent_id: agent_id.to_string(),
            budget,
            period_seconds,
            period_start: now,
            spent: 0,
            vendors: vendors.iter().map(AccountId::to_string).collect(),
            max_single_spend,
            rate_limit,
            rate_window_start: now,
            rate_count: 0,
            last_nonce: 0,
            revoked: false,
            request_count: 0,
        };
        self.policies.insert(&agent_id, &policy);
        self.agent_requests.insert(&agent_id, &Vec::new());
        env::log_str(&format!("AgentRegistered {}", agent_id));
    }

    /// Replace the vendor allowlist. Owner only.
    pub fn set_vendors(&mut self, agent_id: AccountId, vendors: Vec<AccountId>) {
        self.only_owner();
        require!(
            bound_policy::validate_bounds(0, 0, 0, 0, vendors.len()),
            "too many vendors"
        );
        let mut policy = self.policy(&agent_id);
        policy.vendors = vendors.iter().map(AccountId::to_string).collect();
        self.policies.insert(&agent_id, &policy);
    }

    /// Replace the period budget. Owner only.
    ///
    /// The counters of the agent are left alone, so the spend, the nonce and
    /// the request count of the period carry over to the new budget.
    pub fn set_budget(&mut self, agent_id: AccountId, budget: u128) {
        self.only_owner();
        require!(budget > 0, "the budget must be more than zero");
        require!(
            bound_policy::validate_bounds(budget, 0, 0, 0, 0),
            "the budget is outside the allowed bounds"
        );
        let mut policy = self.policy(&agent_id);
        policy.budget = budget;
        self.policies.insert(&agent_id, &policy);
    }

    /// Replace the cap on one payment. Owner only.
    ///
    /// The counters of the agent are left alone.
    pub fn set_max_single_spend(&mut self, agent_id: AccountId, max_single_spend: u128) {
        self.only_owner();
        require!(
            max_single_spend > 0,
            "the single spend limit must be more than zero"
        );
        require!(
            bound_policy::validate_bounds(max_single_spend, 0, 0, 0, 0),
            "the single spend limit is outside the allowed bounds"
        );
        let mut policy = self.policy(&agent_id);
        policy.max_single_spend = max_single_spend;
        self.policies.insert(&agent_id, &policy);
    }

    /// Replace the number of payments allowed in one minute. Owner only.
    ///
    /// The counters of the agent are left alone.
    pub fn set_rate_limit(&mut self, agent_id: AccountId, rate_limit: u64) {
        self.only_owner();
        require!(rate_limit > 0, "the rate limit must be more than zero");
        require!(rate_limit <= MAX_RATE_LIMIT, "the rate limit is too high");
        let mut policy = self.policy(&agent_id);
        policy.rate_limit = rate_limit;
        self.policies.insert(&agent_id, &policy);
    }

    /// Lock an agent out or let it back in. Owner only.
    pub fn set_revoked(&mut self, agent_id: AccountId, revoked: bool) {
        self.only_owner();
        let mut policy = self.policy(&agent_id);
        policy.revoked = revoked;
        self.policies.insert(&agent_id, &policy);
        env::log_str(&format!(
            "Agent{} {}",
            if revoked { "Revoked" } else { "Restored" },
            agent_id
        ));
    }

    /// Stop or resume every agent at once. Owner only.
    pub fn set_kill_switch(&mut self, on: bool) {
        self.only_owner();
        self.kill_switch = on;
    }

    /// Put a receiver on the blocklist. Owner only.
    pub fn block_account(&mut self, account_id: AccountId) {
        self.only_owner();
        self.blocklist.insert(&account_id);
    }

    /// Take a receiver off the blocklist. Owner only.
    pub fn unblock_account(&mut self, account_id: AccountId) {
        self.only_owner();
        self.blocklist.remove(&account_id);
    }

    /// Ask for a spend. Only the agent itself may call this, for itself.
    ///
    /// The hard checks run here, on the agent's own call, and a failure is
    /// recorded as a denial straight away. When they pass, the request waits
    /// for the counterparty decision.
    pub fn request_spend(
        &mut self,
        agent_id: AccountId,
        vendor: AccountId,
        amount: u128,
        nonce: u64,
        memo: String,
    ) -> SpendOutcome {
        let caller = env::predecessor_account_id();
        require!(
            caller == agent_id,
            "only the agent may request a spend for itself"
        );
        self.ensure_migrated();
        require!(
            bound_policy::validate_bounds(0, memo.len(), 0, 0, 0),
            "the memo is outside the allowed bounds"
        );

        let now = now_seconds();
        let mut policy = self.policy(&agent_id);
        let (period_start, totals) = self.prepare_current_period(&agent_id, &mut policy, now);

        if self.kill_switch {
            let spent = totals.used();
            let receipt = self.write_receipt(
                &agent_id,
                &vendor,
                amount,
                nonce,
                &memo,
                NO_REQUEST,
                Outcome::Denied,
                "KillSwitch",
                "the owner stopped every agent",
                &["kill switch is on".to_string()],
                period_start,
                spent,
                policy.budget.saturating_sub(spent),
            );
            env::log_str(&format!("SpendDenied {} {} KillSwitch", agent_id, vendor));
            return SpendOutcome {
                request_id: NO_REQUEST,
                approved: false,
                reason: "KillSwitch".to_string(),
                rule: "the owner stopped every agent".to_string(),
                evidence: receipt.evidence,
                spent: receipt.spent_after,
                remaining: receipt.remaining_after,
            };
        }

        let blocked = self.blocklist.contains(&vendor);
        let mut nonce_state = self.nonce_state(&agent_id, &policy);
        let mut check = policy.clone();
        check.last_nonce = nonce_state.accepted_nonce;
        check.spent = totals.used();

        let decision = bound_policy::evaluate(&check, vendor.as_str(), amount, nonce, now, blocked);
        if !decision.allowed {
            let receipt = self.write_receipt(
                &agent_id,
                &vendor,
                amount,
                nonce,
                &memo,
                NO_REQUEST,
                Outcome::Denied,
                &decision.reason,
                &decision.rule,
                &decision.evidence,
                decision.period_start,
                decision.spent,
                decision.remaining,
            );
            env::log_str(&format!(
                "SpendDenied {} {} {}",
                agent_id, vendor, decision.reason
            ));
            return SpendOutcome {
                request_id: NO_REQUEST,
                approved: false,
                reason: decision.reason,
                rule: decision.rule,
                evidence: decision.evidence,
                spent: receipt.spent_after,
                remaining: receipt.remaining_after,
            };
        }

        let request_id = self.next_request_id;
        self.next_request_id += 1;
        let request = Request {
            request_id,
            agent_id: agent_id.clone(),
            vendor: vendor.clone(),
            amount,
            nonce,
            memo,
            status: RequestStatus::Pending,
            created_at: now,
            receipt_id: None,
            flags: Vec::new(),
        };
        self.requests.insert(&request_id, &request);
        self.set_request_meta(
            request_id,
            &RequestMeta {
                expires_at: now.saturating_add(REQUEST_TTL_SECONDS),
                reserved_period_start: 0,
                approval_rate_window_start: 0,
                legacy: false,
            },
        );

        nonce_state.accepted_nonce = nonce_state.accepted_nonce.max(nonce);
        self.set_nonce_state(&agent_id, &nonce_state);

        policy.request_count += 1;
        self.policies.insert(&agent_id, &policy);

        let mut index = self.agent_requests.get(&agent_id).unwrap_or_default();
        while index.len() >= REQUEST_INDEX_CAPACITY {
            index.remove(0);
        }
        index.push(request_id);
        self.agent_requests.insert(&agent_id, &index);

        env::log_str(&format!(
            "SpendRequested {} {} {}",
            agent_id, vendor, amount
        ));

        SpendOutcome {
            request_id,
            approved: false,
            reason: String::new(),
            rule: "the request passed every hard check and is waiting for the counterparty check"
                .to_string(),
            evidence: Vec::new(),
            spent: totals.used(),
            remaining: policy.budget.saturating_sub(totals.used()),
        }
    }

    /// Move the money. The owner and the runner may do this for a pending
    /// request. Only the owner may do it for a flagged request.
    ///
    /// The policy is checked again at approval. The approval reserves the
    /// amount in the current period, so two approvals cannot together spend
    /// more than the budget.
    pub fn approve_request(&mut self, request_id: u64) -> SpendOutcome {
        self.only_owner_or_runner();
        self.ensure_migrated();
        require!(
            !self.kill_switch,
            "the kill switch is on, no request can be approved"
        );
        let mut request = self.request(request_id);
        require!(
            matches!(
                request.status,
                RequestStatus::Pending | RequestStatus::NeedsApproval
            ),
            "only an open request can be approved"
        );
        // The agent may not approve its own spend, not even when the agent is
        // also the owner or the runner. The counterparty has to be somebody
        // else.
        require!(
            env::predecessor_account_id() != request.agent_id,
            "the agent cannot approve its own request"
        );
        if request.status == RequestStatus::NeedsApproval {
            self.only_owner();
        }

        let now = now_seconds();
        if let Some(meta) = self.request_meta_sidecar(request_id) {
            if meta.expires_at != 0 && now >= meta.expires_at {
                return self.expire_request(
                    request_id,
                    "the request expired before it was decided".to_string(),
                );
            }
        }

        let mut policy = match self.policies.get(&request.agent_id) {
            Some(policy) => policy,
            None => return self.deny_missing_policy(request_id, request),
        };
        let (period_start, mut totals) =
            self.prepare_current_period(&request.agent_id, &mut policy, now);
        let blocked = self.blocklist.contains(&request.vendor);
        let mut nonce_state = self.nonce_state(&request.agent_id, &policy);
        let mut check = policy.clone();
        check.last_nonce = nonce_state.approved_nonce;
        check.spent = totals.used();

        let decision = bound_policy::evaluate(
            &check,
            request.vendor.as_str(),
            request.amount,
            request.nonce,
            now,
            blocked,
        );
        if !decision.allowed {
            request.status = RequestStatus::Denied;
            let receipt = self.write_receipt(
                &request.agent_id,
                &request.vendor,
                request.amount,
                request.nonce,
                &request.memo,
                request.request_id,
                Outcome::Denied,
                &decision.reason,
                &decision.rule,
                &decision.evidence,
                decision.period_start,
                decision.spent,
                decision.remaining,
            );
            request.receipt_id = Some(receipt.receipt_id);
            self.requests.insert(&request_id, &request);
            env::log_str(&format!(
                "SpendDenied {} {} {}",
                request.agent_id, request.vendor, decision.reason
            ));
            return SpendOutcome {
                request_id,
                approved: false,
                reason: decision.reason,
                rule: decision.rule,
                evidence: decision.evidence,
                spent: receipt.spent_after,
                remaining: receipt.remaining_after,
            };
        }

        let balance = env::account_balance();
        require!(
            balance.as_yoctonear() >= request.amount,
            "the contract does not hold enough for this spend"
        );

        totals.reserved = totals.reserved.saturating_add(request.amount);
        self.set_period_totals(&request.agent_id, period_start, &totals);

        nonce_state.approved_nonce = nonce_state.approved_nonce.max(request.nonce);
        nonce_state.accepted_nonce = nonce_state.accepted_nonce.max(request.nonce);
        self.set_nonce_state(&request.agent_id, &nonce_state);

        policy.period_start = period_start;
        policy.spent = totals.used();
        policy.last_nonce = nonce_state.approved_nonce;
        let (window_start, count) = bound_policy::rate_window(&policy, now);
        policy.rate_window_start = window_start;
        policy.rate_count = count + 1;
        self.policies.insert(&request.agent_id, &policy);

        if let Some(mut meta) = self.request_meta_sidecar(request_id) {
            meta.reserved_period_start = period_start;
            meta.approval_rate_window_start = window_start;
            self.set_request_meta(request_id, &meta);
        } else {
            self.set_request_meta(
                request_id,
                &RequestMeta {
                    expires_at: 0,
                    reserved_period_start: period_start,
                    approval_rate_window_start: window_start,
                    legacy: false,
                },
            );
        }

        request.status = RequestStatus::ApprovedPending;
        self.requests.insert(&request_id, &request);

        env::log_str(&format!(
            "SpendApproved {} {} {}",
            request.agent_id, request.vendor, request.amount
        ));

        near_sdk::Promise::new(request.vendor.clone())
            .transfer(NearToken::from_yoctonear(request.amount))
            .then(
                Self::ext_self()
                    .with_static_gas(near_sdk::Gas::from_tgas(10))
                    .on_transfer(request_id),
            )
            .detach();

        SpendOutcome {
            request_id,
            approved: true,
            reason: String::new(),
            rule: "every policy check passed and the counterparty check approved, the receipt is written when the transfer settles".to_string(),
            evidence: Vec::new(),
            spent: policy.spent,
            remaining: policy.budget.saturating_sub(policy.spent),
        }
    }

    /// Approve a request that was flagged for human review. Owner only.
    pub fn owner_approve_request(&mut self, request_id: u64) -> SpendOutcome {
        self.only_owner();
        let request = self.request(request_id);
        require!(
            request.status == RequestStatus::NeedsApproval,
            "only a flagged request can be approved with the owner method"
        );
        self.approve_request(request_id)
    }

    /// Reject a request that was flagged for human review. Owner only.
    pub fn owner_reject_request(&mut self, request_id: u64, reason: String) -> SpendOutcome {
        self.only_owner();
        let request = self.request(request_id);
        require!(
            request.status == RequestStatus::NeedsApproval,
            "only a flagged request can be rejected with the owner method"
        );
        self.reject_request(request_id, reason)
    }

    /// Settle an approved request after the transfer. Only the contract calls
    /// this.
    ///
    /// The receipt is written when the outcome of the transfer is known. The
    /// accounting is constant time. It reads one period total and never walks
    /// the request history.
    ///
    /// The callback does not wait for the migration. An upgrade can land while
    /// a transfer is in flight, and the money has to settle either way.
    #[private]
    pub fn on_transfer(
        &mut self,
        request_id: u64,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        let Some(request) = self.requests.get(&request_id) else {
            return;
        };
        if request.status != RequestStatus::ApprovedPending {
            return;
        }
        let (moved, evidence) = match result {
            Ok(()) => (true, Vec::new()),
            Err(error) => (false, vec![format!("the transfer failed with {}", error)]),
        };
        self.settle_request(
            request_id,
            moved,
            evidence,
            "TransferFailed",
            "the transfer did not go through and the budget was given back",
        );
    }

    /// Settle a request whose transfer callback never arrived. Owner only.
    ///
    /// The owner checks the transfer receipt and says whether the money moved.
    /// The contract then releases or keeps the reservation and writes the
    /// matching receipt.
    pub fn reconcile_request(&mut self, request_id: u64, moved: bool) -> SpendOutcome {
        self.only_owner();
        let request = self.request(request_id);
        require!(
            request.status == RequestStatus::ApprovedPending,
            "only an approved request that never settled can be reconciled"
        );
        self.settle_request(
            request_id,
            moved,
            Vec::new(),
            "Reconciled",
            if moved {
                "the owner confirmed that the transfer went through"
            } else {
                "the owner confirmed that the transfer did not go through and the budget was given back"
            },
        )
    }

    /// Name the period the money of a historical request belongs to. Owner
    /// only.
    ///
    /// The historical layout kept one flat spend figure and did not record
    /// the period a reservation belonged to. The migration therefore leaves
    /// the period of that money to the owner instead of guessing it. Naming
    /// the period moves the money from the period it was counted in to the
    /// period the owner names.
    pub fn reconcile_legacy_transfer(
        &mut self,
        request_id: u64,
        reservation_period_start: u64,
    ) -> LegacyReconciliation {
        self.only_owner();
        require!(
            reservation_period_start != 0,
            "the period of the reservation must be named"
        );
        let request = self.request(request_id);
        let Some(mut reservation) = self.legacy_reservation_sidecar(request_id) else {
            env::panic_str("that request has no historical money to reconcile");
        };
        let old_period = reservation.reservation_period_start;

        if old_period != reservation_period_start {
            if old_period != 0 {
                let mut totals = self
                    .period_totals_sidecar(&request.agent_id, old_period)
                    .unwrap_or(PeriodTotals {
                        settled: 0,
                        reserved: 0,
                    });
                if reservation.moved {
                    totals.settled = totals.settled.saturating_sub(reservation.amount);
                } else {
                    totals.reserved = totals.reserved.saturating_sub(reservation.amount);
                }
                self.set_period_totals(&request.agent_id, old_period, &totals);
            }
            let mut totals = self
                .period_totals_sidecar(&request.agent_id, reservation_period_start)
                .unwrap_or(PeriodTotals {
                    settled: 0,
                    reserved: 0,
                });
            if reservation.moved {
                totals.settled = totals.settled.saturating_add(reservation.amount);
            } else {
                totals.reserved = totals.reserved.saturating_add(reservation.amount);
            }
            self.set_period_totals(&request.agent_id, reservation_period_start, &totals);
            reservation.reservation_period_start = reservation_period_start;
            self.record_legacy_reservation(request_id, &request.agent_id, &reservation);
        }

        env::log_str(&format!(
            "LegacyReconciled {} {} {}",
            request.agent_id, request_id, reservation_period_start
        ));

        LegacyReconciliation {
            request_id,
            agent_id: request.agent_id,
            amount: reservation.amount,
            moved: reservation.moved,
            reservation_period_start,
            previous_period_start: old_period,
        }
    }

    /// Send a request to a human. The owner and the runner may do this.
    pub fn flag_request(&mut self, request_id: u64, reasons: Vec<String>) -> SpendOutcome {
        self.only_owner_or_runner();
        self.ensure_migrated();
        let mut request = self.request(request_id);
        require!(
            request.status == RequestStatus::Pending,
            "only a pending request can be flagged"
        );
        require!(!reasons.is_empty(), "a flag needs at least one reason");
        require!(
            bound_policy::validate_bounds(0, 0, reasons.len(), Self::reason_bytes(&reasons), 0),
            "the flag is outside the allowed bounds"
        );
        request.status = RequestStatus::NeedsApproval;
        request.flags = reasons.clone();
        self.requests.insert(&request_id, &request);
        env::log_str(&format!(
            "SpendFlagged {} {}",
            request.agent_id, request.vendor
        ));

        SpendOutcome {
            request_id,
            approved: false,
            reason: "CounterpartyWarned".to_string(),
            rule: "the counterparty check wants a human to look at this receiver".to_string(),
            evidence: reasons,
            spent: 0,
            remaining: 0,
        }
    }

    /// Refuse a request. The owner and the runner may do this for a pending
    /// request. Only the owner may do it for a flagged request.
    pub fn reject_request(&mut self, request_id: u64, reason: String) -> SpendOutcome {
        self.only_owner_or_runner();
        self.ensure_migrated();
        let mut request = self.request(request_id);
        require!(
            request.status == RequestStatus::Pending
                || request.status == RequestStatus::NeedsApproval,
            "only an open request can be rejected"
        );
        if request.status == RequestStatus::NeedsApproval {
            self.only_owner();
        }
        require!(!reason.is_empty(), "a rejection needs a reason");
        require!(
            bound_policy::validate_bounds(0, 0, 1, reason.len(), 0),
            "the rejection reason is outside the allowed bounds"
        );

        let mut policy = match self.policies.get(&request.agent_id) {
            Some(policy) => policy,
            // A request whose agent has no policy cannot be checked against
            // one. The request is still closed, with a receipt that says why.
            None => {
                return self.close_without_policy(
                    request_id,
                    request,
                    RequestStatus::Denied,
                    Outcome::Denied,
                    "the policy for this agent no longer exists",
                )
            }
        };
        let now = now_seconds();
        let (period_start, totals) =
            self.prepare_current_period(&request.agent_id, &mut policy, now);
        let spent = totals.used();
        let receipt = self.write_receipt(
            &request.agent_id,
            &request.vendor,
            request.amount,
            request.nonce,
            &request.memo,
            request.request_id,
            Outcome::Denied,
            "CounterpartyBlocked",
            "the counterparty check refused this receiver",
            std::slice::from_ref(&reason),
            period_start,
            spent,
            policy.budget.saturating_sub(spent),
        );

        request.status = RequestStatus::Denied;
        request.receipt_id = Some(receipt.receipt_id);
        self.requests.insert(&request_id, &request);
        env::log_str(&format!(
            "SpendDenied {} {} CounterpartyBlocked",
            request.agent_id, request.vendor
        ));

        SpendOutcome {
            request_id,
            approved: false,
            reason: "CounterpartyBlocked".to_string(),
            rule: "the counterparty check refused this receiver".to_string(),
            evidence: vec![reason],
            spent: receipt.spent_after,
            remaining: receipt.remaining_after,
        }
    }

    /// Close a request without a decision on the money. The owner and the
    /// runner may do this for a pending request. Only the owner may do it for
    /// a flagged request.
    pub fn expire_request(&mut self, request_id: u64, reason: String) -> SpendOutcome {
        self.only_owner_or_runner();
        self.ensure_migrated();
        let mut request = self.request(request_id);
        require!(
            request.status == RequestStatus::Pending
                || request.status == RequestStatus::NeedsApproval,
            "only an open request can be expired"
        );
        if request.status == RequestStatus::NeedsApproval {
            self.only_owner();
        }
        require!(!reason.is_empty(), "an expiry needs a reason");
        require!(
            bound_policy::validate_bounds(0, 0, 1, reason.len(), 0),
            "the expiry reason is outside the allowed bounds"
        );

        let mut policy = match self.policies.get(&request.agent_id) {
            Some(policy) => policy,
            // A request whose agent has no policy cannot be checked against
            // one. The request is still closed, with a receipt that says why.
            None => {
                return self.close_without_policy(
                    request_id,
                    request,
                    RequestStatus::Expired,
                    Outcome::Expired,
                    "the policy for this agent no longer exists",
                )
            }
        };
        let now = now_seconds();
        let (period_start, totals) =
            self.prepare_current_period(&request.agent_id, &mut policy, now);
        let spent = totals.used();

        request.status = RequestStatus::Expired;
        let receipt = self.write_receipt(
            &request.agent_id,
            &request.vendor,
            request.amount,
            request.nonce,
            &request.memo,
            request.request_id,
            Outcome::Expired,
            "RequestExpired",
            &reason,
            &[],
            period_start,
            spent,
            policy.budget.saturating_sub(spent),
        );
        request.receipt_id = Some(receipt.receipt_id);
        self.requests.insert(&request_id, &request);
        env::log_str(&format!(
            "SpendExpired {} {} {}",
            request.agent_id, request.vendor, request.amount
        ));

        SpendOutcome {
            request_id,
            approved: false,
            reason: "RequestExpired".to_string(),
            rule: reason.clone(),
            evidence: Vec::new(),
            spent: receipt.spent_after,
            remaining: receipt.remaining_after,
        }
    }

    /// Read one policy.
    pub fn get_policy(&self, agent_id: AccountId) -> PolicyView {
        let policy = self.policy(&agent_id);
        let now = now_seconds();
        let (period_start, totals) = self.current_period_for_view(&agent_id, &policy, now);
        let (_, rate_count) = bound_policy::rate_window(&policy, now);
        let nonce_state = self.nonce_state(&agent_id, &policy);
        let spent = totals.used();
        PolicyView {
            agent_id: policy.agent_id,
            budget: policy.budget,
            period_seconds: policy.period_seconds,
            period_start,
            spent,
            remaining: policy.budget.saturating_sub(spent),
            vendors: policy.vendors,
            max_single_spend: policy.max_single_spend,
            rate_limit: policy.rate_limit,
            rate_count,
            last_nonce: nonce_state.approved_nonce,
            revoked: policy.revoked,
            request_count: policy.request_count,
        }
    }

    /// Read one request.
    pub fn get_request(&self, request_id: u64) -> Request {
        self.request(request_id)
    }

    /// Read one request as the app sees it, with its expiry time.
    ///
    /// A request that passed its expiry time is reported as expired, because
    /// it can no longer be approved. The stored request keeps its status, so
    /// the history does not change.
    pub fn get_request_view(&self, request_id: u64) -> RequestView {
        let request = self.request(request_id);
        let expires_at = self
            .request_meta_sidecar(request_id)
            .filter(|meta| meta.expires_at != 0)
            .map(|meta| meta.expires_at);
        let status = if self.request_is_expired(request_id) {
            RequestStatus::Expired
        } else {
            request.status
        };
        RequestView {
            request_id: request.request_id,
            agent_id: request.agent_id,
            vendor: request.vendor,
            amount: request.amount,
            nonce: request.nonce,
            memo: request.memo,
            status,
            created_at: request.created_at,
            receipt_id: request.receipt_id,
            flags: request.flags,
            expires_at,
        }
    }

    /// Whether a request passed its expiry time.
    fn request_is_expired(&self, request_id: u64) -> bool {
        let now = now_seconds();
        self.request_meta_sidecar(request_id)
            .filter(|meta| meta.expires_at != 0)
            .map(|meta| now >= meta.expires_at)
            .unwrap_or(false)
    }

    /// Read a page of requests for one agent, newest first.
    pub fn get_requests(&self, agent_id: AccountId, offset: u64, limit: u64) -> Vec<RequestView> {
        if limit == 0 {
            return Vec::new();
        }
        let mut ids = self.get_request_ids(agent_id);
        ids.reverse();
        let mut result = Vec::new();
        let mut skipped = 0u64;
        for id in ids {
            if skipped < offset {
                skipped += 1;
                continue;
            }
            if result.len() as u64 >= limit.min(MAX_PAGE_SIZE) {
                break;
            }
            result.push(self.get_request_view(id));
        }
        result
    }

    /// Read the open requests for one agent, newest first.
    ///
    /// Only requests that still need a human decision are open. A request
    /// that passed its expiry time is not open, because it can no longer be
    /// approved. The list is bounded by the 256-entry request index.
    pub fn get_open_requests(&self, agent_id: AccountId) -> Vec<RequestView> {
        let mut ids = self.get_request_ids(agent_id.clone());
        ids.reverse();
        ids.into_iter()
            .filter_map(|id| self.requests.get(&id))
            .filter(|request| {
                request.agent_id == agent_id
                    && matches!(
                        request.status,
                        RequestStatus::Pending | RequestStatus::NeedsApproval
                    )
            })
            .filter(|request| !self.request_is_expired(request.request_id))
            .map(|request| self.get_request_view(request.request_id))
            .collect()
    }

    /// Read one receipt.
    pub fn get_receipt(&self, receipt_id: u64) -> Receipt {
        self.receipts
            .get(&receipt_id)
            .unwrap_or_else(|| panic!("no receipt with that id"))
    }

    /// Read one receipt, or nothing when there is no receipt with that id.
    pub fn get_receipt_safe(&self, receipt_id: u64) -> Option<Receipt> {
        self.receipts.get(&receipt_id)
    }

    /// Read a page of retained receipts, newest first.
    ///
    /// `offset` is an item offset within the retained receipts. A zero limit
    /// returns an empty page and every limit is capped.
    pub fn get_receipts(&self, offset: u64, limit: u64) -> Vec<Receipt> {
        if limit == 0 {
            return Vec::new();
        }
        let limit = limit.min(MAX_PAGE_SIZE);
        if !self.schema_is_current() {
            // Before the migration the receipts are read straight from the
            // frozen state map, the way the historical layout kept them.
            let mut result = Vec::new();
            let mut ordinal = 0u64;
            while ordinal < limit {
                let newest_offset = offset.saturating_add(ordinal);
                if newest_offset >= self.next_receipt_id {
                    break;
                }
                let receipt_id = self.next_receipt_id - 1 - newest_offset;
                if let Some(receipt) = self.receipts.get(&receipt_id) {
                    result.push(receipt);
                }
                ordinal += 1;
            }
            return result;
        }
        let index = self.receipt_index_state();
        let mut result = Vec::new();
        for ordinal in 0..limit {
            let newest_offset = offset.saturating_add(ordinal);
            if newest_offset >= index.len {
                break;
            }
            let from_newest = index.len - 1 - newest_offset;
            let slot = index.start.saturating_add(from_newest);
            let receipt_id = self.receipt_slot(slot);
            let receipt = self
                .receipts
                .get(&receipt_id)
                .unwrap_or_else(|| panic!("the receipt index points to a missing receipt"));
            result.push(receipt);
        }
        result
    }

    /// Read a page of receipts for one agent, newest first.
    pub fn get_agent_receipts(&self, agent_id: AccountId, offset: u64, limit: u64) -> Vec<Receipt> {
        if limit == 0 {
            return Vec::new();
        }
        let limit = limit.min(MAX_PAGE_SIZE);
        if !self.schema_is_current() {
            // Before the migration the receipts are read straight from the
            // frozen state map. The scan is bounded, so a very old contract
            // cannot make the read expensive.
            let mut result = Vec::new();
            let mut matched = 0u64;
            let mut scanned = 0u64;
            while (result.len() as u64) < limit && scanned < LEGACY_RECEIPT_SCAN_LIMIT {
                let receipt_id = self.next_receipt_id.saturating_sub(1 + scanned);
                scanned += 1;
                if receipt_id >= self.next_receipt_id {
                    break;
                }
                let Some(receipt) = self.receipts.get(&receipt_id) else {
                    continue;
                };
                if receipt.agent_id != agent_id {
                    continue;
                }
                if matched >= offset {
                    result.push(receipt);
                }
                matched += 1;
            }
            return result;
        }
        let index = self.agent_receipt_index_state(&agent_id);
        let mut result = Vec::new();
        for ordinal in 0..limit {
            let newest_offset = offset.saturating_add(ordinal);
            if newest_offset >= index.len {
                break;
            }
            let from_newest = index.len - 1 - newest_offset;
            let slot = index.start.saturating_add(from_newest);
            let receipt_id = self.agent_receipt_slot(&agent_id, slot);
            let receipt = self
                .receipts
                .get(&receipt_id)
                .unwrap_or_else(|| panic!("the receipt index points to a missing receipt"));
            result.push(receipt);
        }
        result
    }

    /// Read the request ids of one agent, oldest first.
    pub fn get_request_ids(&self, agent_id: AccountId) -> Vec<u64> {
        let mut ids = self.agent_requests.get(&agent_id).unwrap_or_default();
        if ids.len() > REQUEST_INDEX_CAPACITY {
            let remove = ids.len() - REQUEST_INDEX_CAPACITY;
            ids.drain(0..remove);
        }
        ids
    }

    /// How many receipts one agent has.
    pub fn get_agent_receipt_count(&self, agent_id: AccountId) -> u64 {
        self.agent_receipt_index_state(&agent_id).len
    }

    /// Whether the owner froze every agent.
    pub fn get_kill_switch(&self) -> bool {
        self.kill_switch
    }

    /// The owner of the contract.
    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    /// The account that makes the counterparty decisions.
    pub fn get_runner(&self) -> AccountId {
        self.runner.clone()
    }

    /// What the contract holds, in yoctoNEAR.
    pub fn treasury_balance(&self) -> u128 {
        env::account_balance().as_yoctonear()
    }

    /// How many receipts the contract retains.
    pub fn get_receipt_count(&self) -> u64 {
        self.retained_receipt_count()
    }

    /// The state of the bounded migration.
    pub fn get_migration_status(&self) -> MigrationStatus {
        let progress = self.migration_progress_sidecar();
        MigrationStatus {
            complete: self.schema_is_current(),
            stage: progress
                .map(|progress| progress.stage)
                .unwrap_or(MIGRATION_STAGE_REQUESTS),
            cursor: progress.map(|progress| progress.cursor).unwrap_or(0),
            unresolved: self.unresolved_legacy_counter(),
        }
    }

    /// The historical records whose money the owner still has to place.
    ///
    /// The list is bounded by the number of requests and is read newest
    /// first. A record with a period of zero is one the owner still has to
    /// name a period for.
    pub fn get_legacy_reconciliation(&self, limit: u64) -> Vec<LegacyReconciliationView> {
        let limit = limit.min(MAX_PAGE_SIZE);
        let mut out = Vec::new();
        let mut request_id = self.next_request_id;
        while request_id > 0 && (out.len() as u64) < limit {
            request_id -= 1;
            let Some(reservation) = self.legacy_reservation_sidecar(request_id) else {
                continue;
            };
            let Some(request) = self.requests.get(&request_id) else {
                continue;
            };
            out.push(LegacyReconciliationView {
                request_id,
                agent_id: request.agent_id,
                amount: reservation.amount,
                moved: reservation.moved,
                reservation_period_start: reservation.reservation_period_start,
            });
        }
        out
    }
}

/// The helpers that are not part of the public interface.
impl Bound {
    fn only_owner(&self) {
        let caller = env::predecessor_account_id();
        require!(caller == self.owner, "only the owner may do this");
    }

    fn only_owner_or_runner(&self) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner || caller == self.runner,
            "only the owner or the runner may do this"
        );
    }

    fn policy(&self, agent_id: &AccountId) -> Policy {
        self.policies
            .get(agent_id)
            .unwrap_or_else(|| env::panic_str("no policy for that agent"))
    }

    fn request(&self, request_id: u64) -> Request {
        self.requests
            .get(&request_id)
            .unwrap_or_else(|| panic!("no request with that id"))
    }

    /// Require the current sidecar schema before an operation changes the
    /// request lifecycle.
    fn ensure_migrated(&self) {
        require!(
            self.schema_is_current(),
            "the contract state must be migrated before this operation"
        );
    }

    /// Whether the state carries the current sidecar schema.
    fn schema_is_current(&self) -> bool {
        match self.schema_marker_sidecar() {
            Some(marker) => marker.version == SCHEMA_VERSION,
            None => false,
        }
    }

    fn schema_marker_sidecar(&self) -> Option<SchemaMarker> {
        env::storage_read(SCHEMA_KEY.as_bytes()).map(|bytes| decode_sidecar(&bytes, "schema"))
    }

    fn write_schema_marker(&self) {
        env::storage_write(
            SCHEMA_KEY.as_bytes(),
            &encode_sidecar(&SchemaMarker {
                version: SCHEMA_VERSION,
            }),
        );
    }

    fn migration_progress_sidecar(&self) -> Option<MigrationProgress> {
        env::storage_read(MIGRATION_PROGRESS_KEY.as_bytes())
            .map(|bytes| decode_sidecar(&bytes, "migration progress"))
    }

    fn set_migration_progress(&self, progress: &MigrationProgress) {
        env::storage_write(MIGRATION_PROGRESS_KEY.as_bytes(), &encode_sidecar(progress));
    }

    /// Backfill the sidecars for one historical request.
    ///
    /// The method is idempotent for the request it handles: the request meta
    /// sidecar records that the request was counted, so a resumed migration
    /// never writes the same metadata twice.
    ///
    /// The method does not touch the period totals. The settled money of a
    /// historical decision is placed once, from the receipt that recorded it,
    /// and the money of a transfer that was still in flight is left for the
    /// owner to place.
    fn migrate_request(&mut self, request: &Request) {
        let policy = self.policies.get(&request.agent_id);
        let mut nonce = self
            .nonce_state_sidecar(&request.agent_id)
            .unwrap_or_else(|| {
                let last_nonce = policy.as_ref().map(|policy| policy.last_nonce).unwrap_or(0);
                NonceState {
                    accepted_nonce: last_nonce,
                    approved_nonce: last_nonce,
                }
            });
        nonce.accepted_nonce = nonce.accepted_nonce.max(request.nonce);
        if matches!(
            request.status,
            RequestStatus::Approved
                | RequestStatus::ApprovedPending
                | RequestStatus::SettlementFailed
        ) {
            nonce.approved_nonce = nonce.approved_nonce.max(request.nonce);
        }
        self.set_nonce_state(&request.agent_id, &nonce);

        if self.request_meta_sidecar(request.request_id).is_none() {
            // The earliest contract wrote the block timestamp into the
            // request without converting it, so the time is normalized before
            // the expiry is worked out.
            let created_at = normalize_timestamp(request.created_at);
            self.set_request_meta(
                request.request_id,
                &RequestMeta {
                    expires_at: created_at.saturating_add(REQUEST_TTL_SECONDS),
                    // The historical layout did not record the period a
                    // reservation belonged to, so it is not guessed here.
                    reserved_period_start: 0,
                    // The historical layout did not record the rate window.
                    // Leaving this unknown prevents a late failure from
                    // refunding a slot in a newer window.
                    approval_rate_window_start: 0,
                    legacy: true,
                },
            );
        }

        self.remember_migration_agent(&request.agent_id);

        // Rebuild the bounded request index from the requests themselves. The
        // first request for an agent replaces any unbounded historical vector;
        // later requests extend it in id order.
        let mut ids = self
            .migration_request_index_sidecar(&request.agent_id)
            .unwrap_or_default();
        if !ids.contains(&request.request_id) {
            ids.push(request.request_id);
        }
        if ids.len() > REQUEST_INDEX_CAPACITY {
            let remove = ids.len() - REQUEST_INDEX_CAPACITY;
            ids.drain(0..remove);
        }
        self.set_migration_request_index(&request.agent_id, &ids);
        self.agent_requests.insert(&request.agent_id, &ids);

        // A historical transfer that was still in flight, and a historical
        // decision whose receipt is missing, both carry money the new
        // accounting cannot place on its own. The owner names the period.
        let needs_owner = match request.status {
            RequestStatus::ApprovedPending => true,
            RequestStatus::Approved => request.receipt_id.is_none(),
            _ => false,
        };
        if needs_owner
            && self
                .legacy_reservation_sidecar(request.request_id)
                .is_none()
        {
            self.record_legacy_reservation(
                request.request_id,
                &request.agent_id,
                &LegacyReservation {
                    amount: request.amount,
                    reservation_period_start: 0,
                    moved: request.status == RequestStatus::Approved,
                },
            );
        }
    }

    /// Add one historical receipt to the current indexes and place its money.
    ///
    /// The settled money of a historical decision is placed once, in the
    /// period the receipt recorded. A receipt whose request the owner still
    /// has to place is skipped, so no amount is counted twice.
    fn migrate_receipt(&mut self, receipt: &Receipt) {
        self.retain_existing_receipt(receipt);
        if receipt.outcome != Outcome::Approved {
            return;
        }
        if self
            .legacy_reservation_sidecar(receipt.request_id)
            .is_some()
        {
            return;
        }
        let period = normalize_period(receipt.period_start);
        if period == 0 {
            return;
        }
        let mut totals = self
            .period_totals_sidecar(&receipt.agent_id, period)
            .unwrap_or(PeriodTotals {
                settled: 0,
                reserved: 0,
            });
        totals.settled = totals.settled.saturating_add(receipt.amount);
        self.set_period_totals(&receipt.agent_id, period, &totals);
    }

    /// Remember an agent the migration found, so its figures can be checked.
    fn remember_migration_agent(&mut self, agent_id: &AccountId) {
        let mut agents = self.migration_agents_sidecar().unwrap_or_default();
        if agents.iter().any(|known| known == agent_id) {
            return;
        }
        require!(
            agents.len() < MIGRATION_AGENT_LIMIT,
            "the migration found more agents than it can check"
        );
        agents.push(agent_id.clone());
        self.set_migration_agents(&agents);
    }

    fn migration_agents_sidecar(&self) -> Option<Vec<AccountId>> {
        env::storage_read(MIGRATION_AGENT_PREFIX.as_bytes())
            .map(|bytes| decode_sidecar(&bytes, "migration agents"))
    }

    fn set_migration_agents(&self, agents: &[AccountId]) {
        env::storage_write(
            MIGRATION_AGENT_PREFIX.as_bytes(),
            &encode_sidecar(&agents.to_vec()),
        );
    }

    /// Whether the reconstructed figures match the stored ones.
    ///
    /// The historical layout kept one flat spend figure per agent and one
    /// period. The new layout keeps the settled and the reserved money of
    /// every period apart. The two have to agree on the historical period,
    /// otherwise the migration has guessed wrong somewhere and the owner has
    /// to say which period the money belongs to.
    fn legacy_figures_match(&self) -> bool {
        for agent_id in self.migration_agents_sidecar().unwrap_or_default() {
            let Some(policy) = self.policies.get(&agent_id) else {
                continue;
            };
            let legacy_figure = policy.spent;
            let period = normalize_period(policy.period_start);
            let reconstructed = self
                .period_totals_sidecar(&agent_id, period)
                .unwrap_or(PeriodTotals {
                    settled: 0,
                    reserved: 0,
                })
                .used();
            if reconstructed != legacy_figure {
                env::log_str(&format!(
                    "LegacyFigureMismatch {} legacy {} reconstructed {}",
                    agent_id, legacy_figure, reconstructed
                ));
                return false;
            }
        }
        true
    }

    /// The historical records whose money the owner still has to place.
    fn unresolved_legacy_records(&self) -> u64 {
        self.unresolved_legacy_counter()
    }

    fn unresolved_legacy_counter(&self) -> u64 {
        env::storage_read(LEGACY_UNRESOLVED_KEY.as_bytes())
            .map(|bytes| decode_sidecar(&bytes, "legacy unresolved counter"))
            .unwrap_or(0)
    }

    fn set_unresolved_legacy_counter(&self, count: u64) {
        env::storage_write(LEGACY_UNRESOLVED_KEY.as_bytes(), &encode_sidecar(&count));
    }

    /// Record the money of a historical request that the new accounting has
    /// to place, and count it while the owner has not named the period.
    fn record_legacy_reservation(
        &mut self,
        request_id: u64,
        agent_id: &AccountId,
        reservation: &LegacyReservation,
    ) {
        let previous = self.legacy_reservation_sidecar(request_id);
        self.set_legacy_reservation(request_id, reservation);
        let existed = previous.is_some();
        let was_placed = previous
            .map(|previous| previous.reservation_period_start != 0)
            .unwrap_or(false);
        let is_placed = reservation.reservation_period_start != 0;
        // The counter holds the records whose money is not placed yet.
        let change = match (existed, was_placed, is_placed) {
            (_, _, true) if was_placed => 0i8,
            (_, false, true) => -1,
            (true, true, false) => 1,
            (false, false, false) => 1,
            _ => 0,
        };
        if change != 0 {
            let count = self.unresolved_legacy_counter();
            if change < 0 {
                self.set_unresolved_legacy_counter(count.saturating_sub(1));
            } else {
                self.set_unresolved_legacy_counter(count.saturating_add(1));
            }
        }
        env::log_str(&format!(
            "LegacyReservation {} {} {} period {}",
            agent_id, request_id, reservation.amount, reservation.reservation_period_start
        ));
    }

    fn legacy_reservation_sidecar(&self, request_id: u64) -> Option<LegacyReservation> {
        let key = format!("{}{}", LEGACY_RESERVATION_PREFIX, request_id);
        env::storage_read(key.as_bytes()).map(|bytes| decode_sidecar(&bytes, "legacy reservation"))
    }

    fn set_legacy_reservation(&self, request_id: u64, reservation: &LegacyReservation) {
        let key = format!("{}{}", LEGACY_RESERVATION_PREFIX, request_id);
        env::storage_write(key.as_bytes(), &encode_sidecar(reservation));
    }

    fn migration_request_index_sidecar(&self, agent_id: &AccountId) -> Option<Vec<u64>> {
        let key = format!("{}{}", MIGRATION_REQUEST_INDEX_PREFIX, agent_id);
        env::storage_read(key.as_bytes())
            .map(|bytes| decode_sidecar(&bytes, "migration request index"))
    }

    fn set_migration_request_index(&self, agent_id: &AccountId, ids: &[u64]) {
        let key = format!("{}{}", MIGRATION_REQUEST_INDEX_PREFIX, agent_id);
        env::storage_write(key.as_bytes(), &encode_sidecar(&ids.to_vec()));
    }

    fn reason_bytes(reasons: &[String]) -> usize {
        reasons.iter().map(|reason| reason.len()).sum()
    }

    /// Settle an approved request from a known transfer result.
    ///
    /// A request of the current layout settles in the period its reservation
    /// holds. A historical request settles with the historical rules until
    /// the owner names the period its money belongs to. An upgrade that lands
    /// while a transfer is in flight therefore never loses the money and
    /// never guesses where it belongs.
    fn settle_request(
        &mut self,
        request_id: u64,
        moved: bool,
        evidence: Vec<String>,
        failure_reason: &str,
        failure_rule: &str,
    ) -> SpendOutcome {
        let Some(request) = self.requests.get(&request_id) else {
            return SpendOutcome {
                request_id,
                approved: false,
                reason: "RequestNotFound".to_string(),
                rule: "there is no request with that id".to_string(),
                evidence: Vec::new(),
                spent: 0,
                remaining: 0,
            };
        };
        if request.status != RequestStatus::ApprovedPending {
            return SpendOutcome {
                request_id,
                approved: false,
                reason: "AlreadySettled".to_string(),
                rule: "the request was already settled".to_string(),
                evidence: Vec::new(),
                spent: 0,
                remaining: 0,
            };
        }

        if self.request_is_legacy(request_id) {
            // A historical request whose money the owner has already placed
            // settles in the period the owner named.
            if let Some(reservation) = self.legacy_reservation_sidecar(request_id) {
                if reservation.reservation_period_start != 0 {
                    return self.settle_in_period(
                        request_id,
                        moved,
                        evidence,
                        failure_reason,
                        failure_rule,
                        reservation.reservation_period_start,
                    );
                }
            }
            return self.settle_legacy_request(
                request_id,
                moved,
                evidence,
                failure_reason,
                failure_rule,
            );
        }

        let period = self
            .request_meta_sidecar(request_id)
            .map(|meta| meta.reserved_period_start)
            .unwrap_or(0);
        if period == 0 {
            // A request of the current layout always records the period its
            // reservation holds. A missing one is a broken state, not a
            // reason to guess.
            env::panic_str("the reservation period of this request is missing");
        }
        self.settle_in_period(
            request_id,
            moved,
            evidence,
            failure_reason,
            failure_rule,
            period,
        )
    }

    /// Whether a request comes from the historical layout.
    ///
    /// A request with no metadata at all was written before the upgrade, so
    /// it is a historical request too.
    fn request_is_legacy(&self, request_id: u64) -> bool {
        match self.request_meta_sidecar(request_id) {
            Some(meta) => meta.legacy,
            None => true,
        }
    }

    /// Settle a request in the period its reservation holds.
    ///
    /// The accounting is constant time. It reads one period total and never
    /// walks the request history.
    fn settle_in_period(
        &mut self,
        request_id: u64,
        moved: bool,
        mut evidence: Vec<String>,
        failure_reason: &str,
        failure_rule: &str,
        reservation_period: u64,
    ) -> SpendOutcome {
        let Some(mut request) = self.requests.get(&request_id) else {
            return SpendOutcome {
                request_id,
                approved: false,
                reason: "RequestNotFound".to_string(),
                rule: "there is no request with that id".to_string(),
                evidence: Vec::new(),
                spent: 0,
                remaining: 0,
            };
        };
        if request.status != RequestStatus::ApprovedPending {
            return SpendOutcome {
                request_id,
                approved: false,
                reason: "AlreadySettled".to_string(),
                rule: "the request was already settled".to_string(),
                evidence: Vec::new(),
                spent: 0,
                remaining: 0,
            };
        }

        let now = now_seconds();
        let approval_rate_window = self
            .request_meta_sidecar(request_id)
            .map(|meta| meta.approval_rate_window_start)
            .unwrap_or(0);
        let mut policy = self.policies.get(&request.agent_id);

        // The sidecar is the accounting source. It knows which period owns
        // the reservation, so settlement never has to guess from the current
        // policy period.
        let mut totals = self
            .period_totals_sidecar(&request.agent_id, reservation_period)
            .unwrap_or(PeriodTotals {
                settled: 0,
                reserved: 0,
            });
        totals.reserved = totals.reserved.saturating_sub(request.amount);
        if moved {
            totals.settled = totals.settled.saturating_add(request.amount);
        }
        self.set_period_totals(&request.agent_id, reservation_period, &totals);
        let receipt_totals = totals;
        let receipt_period = reservation_period;

        if let Some(policy) = policy.as_mut() {
            let (current_period, current_totals) =
                self.prepare_current_period(&request.agent_id, policy, now);

            if !moved && approval_rate_window != 0 {
                let (current_window, _) = bound_policy::rate_window(policy, now);
                if approval_rate_window == policy.rate_window_start
                    && approval_rate_window == current_window
                {
                    policy.rate_count = policy.rate_count.saturating_sub(1);
                }
            }
            policy.period_start = current_period;
            policy.spent = current_totals.used();
            self.policies.insert(&request.agent_id, policy);
        } else {
            evidence.push("the policy was missing when settlement ran".to_string());
            evidence.push(
                "the remaining budget could not be checked because the policy was missing"
                    .to_string(),
            );
        }

        let settled_usage = receipt_totals.settled;
        let reserved_usage = receipt_totals.reserved;
        let remaining = match policy.as_ref() {
            Some(policy) => policy.budget.saturating_sub(receipt_totals.used()),
            None => u128::MAX,
        };
        evidence.push(format!("settled total {} yoctoNEAR", settled_usage));
        evidence.push(format!("reserved total {} yoctoNEAR", reserved_usage));

        let (status, outcome, reason, rule) = if moved {
            (
                RequestStatus::Approved,
                Outcome::Approved,
                if policy.is_none() {
                    "PolicyMissing"
                } else {
                    ""
                },
                if policy.is_none() {
                    "the transfer moved, but the policy was missing when settlement ran"
                } else {
                    "every policy check passed and the counterparty check approved"
                },
            )
        } else {
            (
                RequestStatus::SettlementFailed,
                Outcome::Failed,
                if policy.is_none() {
                    "PolicyMissing"
                } else {
                    failure_reason
                },
                if policy.is_none() {
                    "the transfer failed and the policy was missing when settlement ran"
                } else {
                    failure_rule
                },
            )
        };

        request.status = status;
        let receipt = self.write_receipt(
            &request.agent_id,
            &request.vendor,
            request.amount,
            request.nonce,
            &request.memo,
            request.request_id,
            outcome,
            reason,
            rule,
            &evidence,
            receipt_period,
            settled_usage,
            remaining,
        );
        request.receipt_id = Some(receipt.receipt_id);
        self.requests.insert(&request_id, &request);

        env::log_str(&format!(
            "Spend{} {} {} {}",
            if moved { "Settled" } else { "SettlementFailed" },
            request.agent_id,
            request.vendor,
            request.amount
        ));

        SpendOutcome {
            request_id,
            approved: moved,
            reason: reason.to_string(),
            rule: rule.to_string(),
            evidence,
            spent: settled_usage,
            remaining,
        }
    }

    /// Settle a historical request with the historical rules.
    ///
    /// The historical layout kept one flat spend figure and did not record
    /// the period a reservation belonged to. The settlement leaves that flat
    /// figure as it was and records the money, so the owner can name the
    /// period it belongs to. Nothing is guessed here.
    fn settle_legacy_request(
        &mut self,
        request_id: u64,
        moved: bool,
        mut evidence: Vec<String>,
        failure_reason: &str,
        failure_rule: &str,
    ) -> SpendOutcome {
        let Some(mut request) = self.requests.get(&request_id) else {
            return SpendOutcome {
                request_id,
                approved: false,
                reason: "RequestNotFound".to_string(),
                rule: "there is no request with that id".to_string(),
                evidence: Vec::new(),
                spent: 0,
                remaining: 0,
            };
        };
        if request.status != RequestStatus::ApprovedPending {
            return SpendOutcome {
                request_id,
                approved: false,
                reason: "AlreadySettled".to_string(),
                rule: "the request was already settled".to_string(),
                evidence: Vec::new(),
                spent: 0,
                remaining: 0,
            };
        }

        let now = now_seconds();
        let mut policy = self.policies.get(&request.agent_id);
        let legacy_period = policy
            .as_ref()
            .map(|policy| normalize_period(policy.period_start))
            .unwrap_or(0);

        if moved {
            // The money moved. The historical figure already counted the
            // reservation, so the figure stays and the money is placed in the
            // historical period.
            if legacy_period != 0 {
                let mut totals = self
                    .period_totals_sidecar(&request.agent_id, legacy_period)
                    .unwrap_or(PeriodTotals {
                        settled: 0,
                        reserved: 0,
                    });
                totals.settled = totals.settled.saturating_add(request.amount);
                self.set_period_totals(&request.agent_id, legacy_period, &totals);
            }
        } else if let Some(policy) = policy.as_mut() {
            // The money did not move. The historical rules gave the reserved
            // amount back as long as the period had not rolled over.
            let (current_period, _) = bound_policy::roll_period(policy, now);
            if current_period == normalize_period(policy.period_start) {
                policy.spent = policy.spent.saturating_sub(request.amount);
                self.policies.insert(&request.agent_id, policy);
            }
        }

        let spent = policy.as_ref().map(|policy| policy.spent).unwrap_or(0);
        let remaining = match policy.as_ref() {
            Some(policy) => policy.budget.saturating_sub(spent),
            None => u128::MAX,
        };

        // The money is placed in the historical period. The migration checks
        // that figure against the historical one, and the owner names the
        // period when the check says the historical period is the wrong one.
        self.record_legacy_reservation(
            request_id,
            &request.agent_id,
            &LegacyReservation {
                amount: request.amount,
                reservation_period_start: legacy_period,
                moved,
            },
        );

        if policy.is_none() {
            evidence.push("the policy was missing when settlement ran".to_string());
        }
        evidence.push(
            "the historical layout kept one spend figure and no reservation period, so the owner confirms the period of this transfer"
                .to_string(),
        );
        evidence.push(format!(
            "the historical spend figure includes the transfers that were still in flight, settled total {} yoctoNEAR",
            spent
        ));

        let (status, outcome, reason, rule) = if moved {
            (
                RequestStatus::Approved,
                Outcome::Approved,
                "",
                "every policy check passed and the counterparty check approved",
            )
        } else {
            (
                RequestStatus::SettlementFailed,
                Outcome::Failed,
                failure_reason,
                failure_rule,
            )
        };

        request.status = status;
        let receipt = self.write_receipt(
            &request.agent_id,
            &request.vendor,
            request.amount,
            request.nonce,
            &request.memo,
            request.request_id,
            outcome,
            reason,
            rule,
            &evidence,
            legacy_period,
            spent,
            remaining,
        );
        request.receipt_id = Some(receipt.receipt_id);
        self.requests.insert(&request_id, &request);

        env::log_str(&format!(
            "LegacySpend{} {} {} {}",
            if moved { "Settled" } else { "SettlementFailed" },
            request.agent_id,
            request.vendor,
            request.amount
        ));

        SpendOutcome {
            request_id,
            approved: moved,
            reason: reason.to_string(),
            rule: rule.to_string(),
            evidence,
            spent,
            remaining,
        }
    }

    /// Deny an approval when the agent's policy no longer exists.
    fn deny_missing_policy(&mut self, request_id: u64, mut request: Request) -> SpendOutcome {
        request.status = RequestStatus::Denied;
        let evidence = vec![
            "the policy was missing when approval ran".to_string(),
            "no budget total could be checked".to_string(),
        ];
        let receipt = self.write_receipt(
            &request.agent_id,
            &request.vendor,
            request.amount,
            request.nonce,
            &request.memo,
            request.request_id,
            Outcome::Denied,
            "PolicyMissing",
            "the policy for this agent no longer exists",
            &evidence,
            0,
            0,
            u128::MAX,
        );
        request.receipt_id = Some(receipt.receipt_id);
        self.requests.insert(&request_id, &request);
        SpendOutcome {
            request_id,
            approved: false,
            reason: "PolicyMissing".to_string(),
            rule: "the policy for this agent no longer exists".to_string(),
            evidence,
            spent: 0,
            remaining: u128::MAX,
        }
    }

    /// Close a request whose agent has no policy.
    ///
    /// The request cannot be checked against a budget that does not exist, so
    /// it is closed without one and the receipt says that the policy was
    /// missing. The request is never left open because of it.
    fn close_without_policy(
        &mut self,
        request_id: u64,
        mut request: Request,
        status: RequestStatus,
        outcome: Outcome,
        rule: &str,
    ) -> SpendOutcome {
        let evidence = vec![
            "the policy for this agent no longer exists".to_string(),
            "no budget total could be checked".to_string(),
        ];
        let receipt = self.write_receipt(
            &request.agent_id,
            &request.vendor,
            request.amount,
            request.nonce,
            &request.memo,
            request.request_id,
            outcome,
            "PolicyMissing",
            rule,
            &evidence,
            0,
            0,
            u128::MAX,
        );
        request.status = status;
        request.receipt_id = Some(receipt.receipt_id);
        self.requests.insert(&request_id, &request);
        SpendOutcome {
            request_id,
            approved: false,
            reason: "PolicyMissing".to_string(),
            rule: rule.to_string(),
            evidence,
            spent: 0,
            remaining: u128::MAX,
        }
    }

    /// Prepare and persist the canonical current budget period.
    fn prepare_current_period(
        &mut self,
        agent_id: &AccountId,
        policy: &mut Policy,
        now: u64,
    ) -> (u64, PeriodTotals) {
        let (period_start, legacy_spent) = bound_policy::roll_period(policy, now);
        let totals = if period_start != policy.period_start {
            match self.period_totals_sidecar(agent_id, period_start) {
                Some(totals) => totals,
                None => {
                    let totals = PeriodTotals {
                        settled: 0,
                        reserved: 0,
                    };
                    self.set_period_totals(agent_id, period_start, &totals);
                    totals
                }
            }
        } else {
            match self.period_totals_sidecar(agent_id, period_start) {
                Some(totals) => totals,
                None => {
                    let totals = PeriodTotals {
                        settled: legacy_spent,
                        reserved: 0,
                    };
                    self.set_period_totals(agent_id, period_start, &totals);
                    totals
                }
            }
        };
        policy.period_start = period_start;
        policy.spent = totals.used();
        // Persist the canonical rolled period even when the caller goes on to
        // deny the request. A denial must not leave the old period active.
        self.policies.insert(agent_id, policy);
        (period_start, totals)
    }

    /// Read the current budget period without changing stored state.
    fn current_period_for_view(
        &self,
        agent_id: &AccountId,
        policy: &Policy,
        now: u64,
    ) -> (u64, PeriodTotals) {
        let (period_start, legacy_spent) = bound_policy::roll_period(policy, now);
        if period_start != policy.period_start {
            (
                period_start,
                self.period_totals_sidecar(agent_id, period_start)
                    .unwrap_or(PeriodTotals {
                        settled: 0,
                        reserved: 0,
                    }),
            )
        } else {
            (
                period_start,
                self.period_totals_sidecar(agent_id, period_start)
                    .unwrap_or(PeriodTotals {
                        settled: legacy_spent,
                        reserved: 0,
                    }),
            )
        }
    }

    /// Read the nonce watermarks, with a safe legacy fallback.
    fn nonce_state(&self, agent_id: &AccountId, policy: &Policy) -> NonceState {
        self.nonce_state_sidecar(agent_id).unwrap_or(NonceState {
            accepted_nonce: policy.last_nonce,
            approved_nonce: policy.last_nonce,
        })
    }

    fn nonce_state_sidecar(&self, agent_id: &AccountId) -> Option<NonceState> {
        let key = format!("{}{}", NONCE_PREFIX, agent_id);
        env::storage_read(key.as_bytes()).map(|bytes| decode_sidecar(&bytes, "nonce"))
    }

    fn set_nonce_state(&self, agent_id: &AccountId, state: &NonceState) {
        let key = format!("{}{}", NONCE_PREFIX, agent_id);
        env::storage_write(key.as_bytes(), &encode_sidecar(state));
    }

    fn period_totals_sidecar(
        &self,
        agent_id: &AccountId,
        period_start: u64,
    ) -> Option<PeriodTotals> {
        let key = format!("{}{}:{}", PERIOD_PREFIX, agent_id, period_start);
        env::storage_read(key.as_bytes()).map(|bytes| decode_sidecar(&bytes, "period totals"))
    }

    fn set_period_totals(&self, agent_id: &AccountId, period_start: u64, totals: &PeriodTotals) {
        let key = format!("{}{}:{}", PERIOD_PREFIX, agent_id, period_start);
        env::storage_write(key.as_bytes(), &encode_sidecar(totals));
    }

    fn request_meta_sidecar(&self, request_id: u64) -> Option<RequestMeta> {
        let key = format!("{}{}", REQUEST_META_PREFIX, request_id);
        env::storage_read(key.as_bytes()).map(|bytes| decode_sidecar(&bytes, "request metadata"))
    }

    fn set_request_meta(&self, request_id: u64, meta: &RequestMeta) {
        let key = format!("{}{}", REQUEST_META_PREFIX, request_id);
        env::storage_write(key.as_bytes(), &encode_sidecar(meta));
    }

    /// The retained global receipt index.
    fn receipt_index_state(&self) -> ReceiptIndexState {
        env::storage_read(RECEIPT_INDEX_KEY.as_bytes())
            .map(|bytes| decode_sidecar(&bytes, "receipt index"))
            .unwrap_or_else(ReceiptIndexState::empty)
    }

    fn set_receipt_index_state(&self, state: &ReceiptIndexState) {
        env::storage_write(RECEIPT_INDEX_KEY.as_bytes(), &encode_sidecar(state));
    }

    fn receipt_slot(&self, slot: u64) -> u64 {
        let key = format!("{}{}", RECEIPT_SLOT_PREFIX, slot);
        let bytes = env::storage_read(key.as_bytes())
            .unwrap_or_else(|| panic!("the receipt index points to a missing slot"));
        decode_sidecar(&bytes, "receipt slot")
    }

    fn set_receipt_slot(&self, slot: u64, receipt_id: u64) {
        let key = format!("{}{}", RECEIPT_SLOT_PREFIX, slot);
        env::storage_write(key.as_bytes(), &encode_sidecar(&receipt_id));
    }

    fn remove_receipt_slot(&self, slot: u64) {
        let key = format!("{}{}", RECEIPT_SLOT_PREFIX, slot);
        env::storage_remove(key.as_bytes());
    }

    /// The retained receipt index for one agent.
    fn agent_receipt_index_state(&self, agent_id: &AccountId) -> ReceiptIndexState {
        let key = format!("{}{}", AGENT_RECEIPT_INDEX_PREFIX, agent_id);
        env::storage_read(key.as_bytes())
            .map(|bytes| decode_sidecar(&bytes, "agent receipt index"))
            .unwrap_or_else(ReceiptIndexState::empty)
    }

    fn set_agent_receipt_index_state(&self, agent_id: &AccountId, state: &ReceiptIndexState) {
        let key = format!("{}{}", AGENT_RECEIPT_INDEX_PREFIX, agent_id);
        env::storage_write(key.as_bytes(), &encode_sidecar(state));
    }

    fn agent_receipt_slot(&self, agent_id: &AccountId, slot: u64) -> u64 {
        let key = format!("{}{}:{}", AGENT_RECEIPT_SLOT_PREFIX, agent_id, slot);
        let bytes = env::storage_read(key.as_bytes())
            .unwrap_or_else(|| panic!("the agent receipt index points to a missing slot"));
        decode_sidecar(&bytes, "agent receipt slot")
    }

    fn set_agent_receipt_slot(&self, agent_id: &AccountId, slot: u64, receipt_id: u64) {
        let key = format!("{}{}:{}", AGENT_RECEIPT_SLOT_PREFIX, agent_id, slot);
        env::storage_write(key.as_bytes(), &encode_sidecar(&receipt_id));
    }

    fn remove_agent_receipt_slot(&self, agent_id: &AccountId, slot: u64) {
        let key = format!("{}{}:{}", AGENT_RECEIPT_SLOT_PREFIX, agent_id, slot);
        env::storage_remove(key.as_bytes());
    }

    fn retained_receipt_count(&self) -> u64 {
        if self.schema_is_current() {
            self.receipt_index_state().len
        } else {
            // Before the migration the contract keeps every receipt, the way
            // the historical layout did.
            self.next_receipt_id
        }
    }

    /// Append one receipt id to the global and per-agent indexes.
    fn append_receipt_to_indexes(&mut self, receipt_id: u64, agent_id: &AccountId) {
        let mut global = self.receipt_index_state();
        let global_slot = global.end();
        self.set_receipt_slot(global_slot, receipt_id);
        global.len = global.len.saturating_add(1);
        self.set_receipt_index_state(&global);

        let mut agent = self.agent_receipt_index_state(agent_id);
        let agent_slot = agent.end();
        self.set_agent_receipt_slot(agent_id, agent_slot, receipt_id);
        agent.len = agent.len.saturating_add(1);
        self.set_agent_receipt_index_state(agent_id, &agent);
    }

    /// Remove the oldest retained receipt and its index entries.
    ///
    /// The oldest global receipt is also the oldest retained receipt of its
    /// agent, so both indexes can be advanced without a history scan.
    fn prune_oldest_receipt(&mut self) {
        let mut global = self.receipt_index_state();
        if global.len == 0 {
            return;
        }
        let global_slot = global.start;
        let receipt_id = self.receipt_slot(global_slot);
        let receipt = self
            .receipts
            .get(&receipt_id)
            .unwrap_or_else(|| panic!("the receipt index points to a missing receipt"));

        let mut agent = self.agent_receipt_index_state(&receipt.agent_id);
        if agent.len == 0 {
            panic!("the agent receipt index is missing a receipt");
        }
        let agent_slot = agent.start;
        let indexed_id = self.agent_receipt_slot(&receipt.agent_id, agent_slot);
        if indexed_id != receipt_id {
            panic!("the receipt indexes disagree about the oldest receipt");
        }
        self.remove_agent_receipt_slot(&receipt.agent_id, agent_slot);
        agent.start = agent.start.saturating_add(1);
        agent.len = agent.len.saturating_sub(1);
        self.set_agent_receipt_index_state(&receipt.agent_id, &agent);

        self.receipts.remove(&receipt_id);
        self.remove_receipt_slot(global_slot);
        global.start = global.start.saturating_add(1);
        global.len = global.len.saturating_sub(1);
        self.set_receipt_index_state(&global);
    }

    /// Add a receipt that already exists in the frozen state map to the
    /// current indexes. Migration calls this in bounded batches.
    fn retain_existing_receipt(&mut self, receipt: &Receipt) {
        // The bound is on the index, which holds the receipts the contract
        // keeps. Before the migration the index is empty, so nothing is
        // pruned while the receipts are being read in.
        if self.receipt_index_state().len >= RECEIPT_RETENTION_LIMIT {
            self.prune_oldest_receipt();
        }
        self.append_receipt_to_indexes(receipt.receipt_id, &receipt.agent_id);
    }

    /// Write the receipt of one decision and retain it within the limit.
    #[allow(clippy::too_many_arguments)]
    fn write_receipt(
        &mut self,
        agent_id: &AccountId,
        vendor: &AccountId,
        amount: u128,
        nonce: u64,
        memo: &str,
        request_id: u64,
        outcome: Outcome,
        reason: &str,
        rule: &str,
        evidence: &[String],
        period_start: u64,
        spent: u128,
        remaining: u128,
    ) -> Receipt {
        let receipt_id = self.next_receipt_id;
        self.next_receipt_id = self
            .next_receipt_id
            .checked_add(1)
            .unwrap_or_else(|| panic!("the receipt id counter overflowed"));
        let receipt = Receipt {
            receipt_id,
            request_id,
            agent_id: agent_id.clone(),
            vendor: vendor.clone(),
            amount,
            nonce,
            memo: memo.to_string(),
            outcome,
            reason: reason.to_string(),
            rule: rule.to_string(),
            evidence: evidence.to_vec(),
            period_start,
            spent_after: spent,
            remaining_after: remaining,
            created_at: now_seconds(),
        };
        self.receipts.insert(&receipt_id, &receipt);
        if self.schema_is_current() {
            if self.receipt_index_state().len >= RECEIPT_RETENTION_LIMIT {
                self.prune_oldest_receipt();
            }
            self.append_receipt_to_indexes(receipt_id, agent_id);
        } else {
            // Before the migration the bounded indexes do not exist yet. The
            // migration builds them, so a receipt written in the meantime is
            // indexed once, by the migration, and not twice.
            require!(
                self.next_receipt_id <= RECEIPT_RETENTION_LIMIT,
                "the contract holds more receipts than the migration can index"
            );
        }
        receipt
    }
}

/// Encode one sidecar value with Borsh.
fn encode_sidecar<T: BorshSerialize>(value: &T) -> Vec<u8> {
    let mut bytes = Vec::new();
    if value.serialize(&mut bytes).is_err() {
        env::panic_str("could not encode a Certalyn sidecar");
    }
    bytes
}

/// Decode one sidecar value with Borsh.
fn decode_sidecar<T: BorshDeserialize>(bytes: &[u8], label: &str) -> T {
    match T::try_from_slice(bytes) {
        Ok(value) => value,
        Err(_) => env::panic_str(&format!("invalid Certalyn {} sidecar", label)),
    }
}
