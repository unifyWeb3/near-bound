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
use std::collections::BTreeMap;

mod types;

#[cfg(test)]
mod tests;

pub use bound_policy::Evaluation;
pub use bound_policy::Policy;
pub use types::{
    NonceState, Outcome, PeriodTotals, PolicyView, Receipt, Request, RequestMeta, RequestStatus,
    RequestView, SpendOutcome,
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

/// The longest policy period accepted, in seconds (one year).
const MAX_PERIOD_SECONDS: u64 = 31_536_000;

/// The largest payment rate accepted, in payments per minute.
const MAX_RATE_LIMIT: u64 = 10_000;

/// The key that records which schema version has migrated the state.
const MIGRATION_MARKER_KEY: &[u8] = b"certalyn_schema";

/// The schema version this build writes.
const SCHEMA_VERSION: u8 = 3;

/// The sidecar key prefixes. Each format is versioned.
const NONCE_PREFIX: &str = "certalyn_nonce_v1:";
const PERIOD_PREFIX: &str = "certalyn_period_v1:";
const REQUEST_META_PREFIX: &str = "certalyn_request_meta_v1:";
const RECEIPT_COUNT_KEY: &str = "certalyn_receipt_count_v1";
const AGENT_RECEIPT_COUNT_PREFIX: &str = "certalyn_agent_receipt_count_v1:";

/// The current time in seconds.
///
/// The chain reports the block timestamp in nanoseconds. The policy engine
/// compares that time against a period in seconds and a rate window in
/// seconds, so the contract converts once, here, and every stored timestamp
/// is in seconds.
fn now_seconds() -> u64 {
    env::block_timestamp() / 1_000_000_000
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
        Self {
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
        }
    }

    /// Bring legacy state up to the current sidecar schema. Owner only.
    ///
    /// The method is idempotent. It backfills nonce watermarks, request
    /// metadata, period totals and receipt counts. It also trims each legacy
    /// request index to the newest 256 ids. It never changes a stored policy,
    /// request or receipt, and it never deletes an existing receipt.
    pub fn migrate(&mut self) {
        self.only_owner();

        let marker = env::storage_read(MIGRATION_MARKER_KEY).unwrap_or_default();
        if marker == vec![SCHEMA_VERSION] {
            env::log_str("MigrationAlreadyApplied");
            return;
        }
        if !marker.is_empty() {
            env::panic_str("unsupported Certalyn migration schema");
        }

        let mut requests_by_agent: BTreeMap<String, Vec<Request>> = BTreeMap::new();
        for request_id in 0..self.next_request_id {
            if let Some(request) = self.requests.get(&request_id) {
                requests_by_agent
                    .entry(request.agent_id.to_string())
                    .or_default()
                    .push(request);
            }
        }

        for (agent_text, requests) in &requests_by_agent {
            let agent_id: AccountId = agent_text.parse().unwrap();
            let policy = self.policies.get(&agent_id);

            let mut accepted_nonce = policy.as_ref().map(|p| p.last_nonce).unwrap_or(0);
            let mut approved_nonce = accepted_nonce;
            for request in requests {
                accepted_nonce = accepted_nonce.max(request.nonce);
                if matches!(
                    request.status,
                    RequestStatus::Approved
                        | RequestStatus::ApprovedPending
                        | RequestStatus::SettlementFailed
                ) {
                    approved_nonce = approved_nonce.max(request.nonce);
                }
            }
            if self.nonce_state_sidecar(&agent_id).is_none() {
                self.set_nonce_state(
                    &agent_id,
                    &NonceState {
                        accepted_nonce,
                        approved_nonce,
                    },
                );
            }

            let mut reserved_by_period: BTreeMap<u64, u128> = BTreeMap::new();
            for request in requests {
                if self.request_meta_sidecar(request.request_id).is_none() {
                    let reserved_period = if request.status == RequestStatus::ApprovedPending {
                        policy.as_ref().map(|p| p.period_start).unwrap_or(0)
                    } else {
                        0
                    };
                    self.set_request_meta(
                        request.request_id,
                        &RequestMeta {
                            expires_at: request.created_at.saturating_add(REQUEST_TTL_SECONDS),
                            reserved_period_start: reserved_period,
                        },
                    );
                }
                if request.status == RequestStatus::ApprovedPending {
                    let period = self
                        .request_meta_sidecar(request.request_id)
                        .map(|meta| meta.reserved_period_start)
                        .unwrap_or(0);
                    if period != 0 {
                        *reserved_by_period.entry(period).or_default() = reserved_by_period
                            .get(&period)
                            .copied()
                            .unwrap_or(0)
                            .saturating_add(request.amount);
                    }
                }
            }

            if let Some(policy) = policy.as_ref() {
                for (period, reserved) in &reserved_by_period {
                    if self.period_totals_sidecar(&agent_id, *period).is_none() {
                        let settled = if policy.period_start == *period {
                            policy.spent.saturating_sub(*reserved)
                        } else {
                            0
                        };
                        self.set_period_totals(
                            &agent_id,
                            *period,
                            &PeriodTotals {
                                settled,
                                reserved: *reserved,
                            },
                        );
                    }
                }
                if self
                    .period_totals_sidecar(&agent_id, policy.period_start)
                    .is_none()
                {
                    let reserved = reserved_by_period
                        .get(&policy.period_start)
                        .copied()
                        .unwrap_or(0);
                    self.set_period_totals(
                        &agent_id,
                        policy.period_start,
                        &PeriodTotals {
                            settled: policy.spent.saturating_sub(reserved),
                            reserved,
                        },
                    );
                }
            }

            let mut index = self.agent_requests.get(&agent_id).unwrap_or_default();
            if index.len() > REQUEST_INDEX_CAPACITY {
                let remove = index.len() - REQUEST_INDEX_CAPACITY;
                index.drain(0..remove);
                self.agent_requests.insert(&agent_id, &index);
            }
        }

        let mut receipt_count = 0u64;
        let mut agent_receipt_counts: BTreeMap<String, u64> = BTreeMap::new();
        for receipt_id in 0..self.next_receipt_id {
            if let Some(receipt) = self.receipts.get(&receipt_id) {
                receipt_count += 1;
                *agent_receipt_counts
                    .entry(receipt.agent_id.to_string())
                    .or_default() += 1;
            }
        }
        self.set_receipt_count(receipt_count);
        for (agent_text, count) in agent_receipt_counts {
            let agent_id: AccountId = agent_text.parse().unwrap();
            self.set_agent_receipt_count(&agent_id, count);
        }

        env::storage_write(MIGRATION_MARKER_KEY, &[SCHEMA_VERSION]);
        env::log_str(&format!(
            "MigrationApplied schema {} requests {} receipts {}",
            SCHEMA_VERSION,
            requests_by_agent.values().map(Vec::len).sum::<usize>(),
            receipt_count
        ));
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
            },
        );

        nonce_state.accepted_nonce = nonce_state.accepted_nonce.max(nonce);
        self.set_nonce_state(&agent_id, &nonce_state);

        policy.request_count += 1;
        self.policies.insert(&agent_id, &policy);

        let mut index = self.agent_requests.get(&agent_id).unwrap_or_default();
        if index.len() == REQUEST_INDEX_CAPACITY {
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
            self.set_request_meta(request_id, &meta);
        } else {
            self.set_request_meta(
                request_id,
                &RequestMeta {
                    expires_at: 0,
                    reserved_period_start: period_start,
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

    /// Send a request to a human. The owner and the runner may do this.
    pub fn flag_request(&mut self, request_id: u64, reasons: Vec<String>) -> SpendOutcome {
        self.only_owner_or_runner();
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

        let mut policy = self.policy(&request.agent_id);
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

        let mut policy = self.policy(&request.agent_id);
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
    pub fn get_request_view(&self, request_id: u64) -> RequestView {
        let request = self.request(request_id);
        let expires_at = self
            .request_meta_sidecar(request_id)
            .filter(|meta| meta.expires_at != 0)
            .map(|meta| meta.expires_at);
        RequestView {
            request_id: request.request_id,
            agent_id: request.agent_id,
            vendor: request.vendor,
            amount: request.amount,
            nonce: request.nonce,
            memo: request.memo,
            status: request.status,
            created_at: request.created_at,
            receipt_id: request.receipt_id,
            flags: request.flags,
            expires_at,
        }
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
    /// Only requests that still need a human decision are open. The list is
    /// bounded by the 256-entry request index.
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
        let count = self.retained_receipt_count();
        let limit = limit.min(MAX_PAGE_SIZE);
        let mut result = Vec::new();
        for ordinal in 0..limit {
            let index = offset.saturating_add(ordinal);
            if index >= count {
                break;
            }
            let receipt_id = self.next_receipt_id - 1 - index;
            if let Some(receipt) = self.receipts.get(&receipt_id) {
                result.push(receipt);
            }
        }
        result
    }

    /// Read a page of receipts for one agent, newest first.
    pub fn get_agent_receipts(&self, agent_id: AccountId, offset: u64, limit: u64) -> Vec<Receipt> {
        if limit == 0 {
            return Vec::new();
        }
        let count = self.retained_receipt_count();
        let limit = limit.min(MAX_PAGE_SIZE);
        let mut matched = 0u64;
        let mut result = Vec::new();
        for index in 0..count {
            let receipt_id = self.next_receipt_id - 1 - index;
            let Some(receipt) = self.receipts.get(&receipt_id) else {
                continue;
            };
            if receipt.agent_id != agent_id {
                continue;
            }
            if matched < offset {
                matched += 1;
                continue;
            }
            result.push(receipt);
            if result.len() as u64 >= limit {
                break;
            }
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
        if let Some(count) = self.agent_receipt_count_sidecar(&agent_id) {
            return count;
        }
        let mut count = 0u64;
        for receipt_id in 0..self.next_receipt_id {
            if let Some(receipt) = self.receipts.get(&receipt_id) {
                if receipt.agent_id == agent_id {
                    count += 1;
                }
            }
        }
        count
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

    fn reason_bytes(reasons: &[String]) -> usize {
        reasons.iter().map(|reason| reason.len()).sum()
    }

    /// Settle an approved request from a known transfer result.
    fn settle_request(
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
        let meta = self.request_meta_sidecar(request_id);
        let reserved_period = meta
            .map(|meta| meta.reserved_period_start)
            .filter(|period| *period != 0);
        let mut policy = self.policies.get(&request.agent_id);
        if policy.is_none() {
            evidence.push("the policy was missing when settlement ran".to_string());
        }

        // `period_usage` is what the period has committed, the money that
        // moved plus the money held for a transfer that has not settled. The
        // receipt reports the money that moved, so a receipt never counts a
        // reservation as a spend.
        let mut period_usage = 0u128;
        let mut settled_usage = 0u128;
        let mut sidecar_accounted = false;
        let mut receipt_period = reserved_period.unwrap_or(0);
        if let Some(period) = reserved_period {
            if let Some(mut totals) = self.period_totals_sidecar(&request.agent_id, period) {
                totals.reserved = totals.reserved.saturating_sub(request.amount);
                if moved {
                    totals.settled = totals.settled.saturating_add(request.amount);
                }
                self.set_period_totals(&request.agent_id, period, &totals);
                period_usage = totals.used();
                settled_usage = totals.settled;
                sidecar_accounted = true;
            }
        }

        if let Some(policy) = policy.as_mut() {
            if receipt_period == 0 {
                receipt_period = policy.period_start;
            }
            let (current_period, mut current_totals) =
                self.prepare_current_period(&request.agent_id, policy, now);
            if !sidecar_accounted && !moved && receipt_period == current_period {
                current_totals.settled = current_totals.settled.saturating_sub(request.amount);
                self.set_period_totals(&request.agent_id, current_period, &current_totals);
                period_usage = current_totals.used();
                settled_usage = current_totals.settled;
            } else if !sidecar_accounted {
                period_usage = current_totals.used();
                settled_usage = current_totals.settled;
            }
            if receipt_period == 0 {
                receipt_period = current_period;
            }

            if !moved {
                let (window_start, count) = bound_policy::rate_window(policy, now);
                if window_start == policy.rate_window_start {
                    policy.rate_count = count.saturating_sub(1);
                } else {
                    policy.rate_window_start = window_start;
                    policy.rate_count = 0;
                }
            }
            policy.period_start = current_period;
            policy.spent = current_totals.used();
            self.policies.insert(&request.agent_id, policy);
        }

        if receipt_period == 0 {
            receipt_period = reserved_period.unwrap_or(now);
        }
        if sidecar_accounted && period_usage == 0 {
            if let Some(totals) = self.period_totals_sidecar(&request.agent_id, receipt_period) {
                period_usage = totals.used();
                settled_usage = totals.settled;
            }
        }
        if settled_usage == 0 && period_usage > 0 {
            settled_usage = period_usage;
        }

        let remaining = match policy.as_ref() {
            Some(policy) => policy.budget.saturating_sub(settled_usage),
            None => u128::MAX,
        };
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

    /// Deny an approval when the agent's policy no longer exists.
    fn deny_missing_policy(&mut self, request_id: u64, mut request: Request) -> SpendOutcome {
        request.status = RequestStatus::Denied;
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
            &[],
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
            evidence: Vec::new(),
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

    fn retained_receipt_count(&self) -> u64 {
        read_u64_sidecar(RECEIPT_COUNT_KEY.as_bytes()).unwrap_or(self.next_receipt_id)
    }

    fn set_receipt_count(&self, count: u64) {
        env::storage_write(RECEIPT_COUNT_KEY.as_bytes(), &encode_sidecar(&count));
    }

    fn agent_receipt_count_sidecar(&self, agent_id: &AccountId) -> Option<u64> {
        let key = format!("{}{}", AGENT_RECEIPT_COUNT_PREFIX, agent_id);
        read_u64_sidecar(key.as_bytes())
    }

    fn set_agent_receipt_count(&self, agent_id: &AccountId, count: u64) {
        let key = format!("{}{}", AGENT_RECEIPT_COUNT_PREFIX, agent_id);
        env::storage_write(key.as_bytes(), &encode_sidecar(&count));
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
        // The count is read before the id moves, so the fallback that uses
        // `next_receipt_id` counts the receipts that already exist.
        let receipt_count = self.retained_receipt_count();
        let receipt_id = self.next_receipt_id;
        self.next_receipt_id += 1;
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
        let agent_count = self.get_agent_receipt_count(agent_id.clone());
        self.receipts.insert(&receipt_id, &receipt);
        self.set_receipt_count(receipt_count + 1);
        self.set_agent_receipt_count(agent_id, agent_count + 1);
        self.prune_receipts(RECEIPT_RETENTION_LIMIT);
        receipt
    }

    /// Remove the oldest receipts until the retention limit is met.
    fn prune_receipts(&mut self, limit: u64) {
        let mut count = self.retained_receipt_count();
        while count > limit {
            let oldest_id = self.next_receipt_id - count;
            if let Some(receipt) = self.receipts.get(&oldest_id) {
                let agent_id = receipt.agent_id.clone();
                let agent_count = self.get_agent_receipt_count(agent_id.clone());
                self.receipts.remove(&oldest_id);
                self.set_agent_receipt_count(&agent_id, agent_count.saturating_sub(1));
            }
            count -= 1;
        }
        self.set_receipt_count(count);
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

/// Read one Borsh-encoded `u64` sidecar.
fn read_u64_sidecar(key: &[u8]) -> Option<u64> {
    env::storage_read(key).map(|bytes| decode_sidecar(&bytes, "counter"))
}
