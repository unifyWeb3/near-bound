/// Bound, an agent wallet with a hard spend cap.
///
/// The shape of the product is one sentence. The owner holds the money, the
/// agent holds a key that can ask the contract to spend it, and the contract
/// refuses anything the policy does not allow. The agent cannot move money
/// by itself, and it cannot change the policy.
///
/// The rules live in the `bound-policy` crate as a pure function, so they can
/// be tested without a chain. The same rules are implemented in the paper
/// harness in JavaScript.

use near_sdk::collections::{LookupMap, LookupSet};
use near_sdk::{near, AccountId, NearToken};
use near_sdk::require;

mod types;

pub use bound_policy::Evaluation;
pub use bound_policy::Policy;
pub use types::{Outcome, PolicyView, Receipt, Request, RequestStatus, SpendOutcome};

/// The contract state.
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
        let owner = near_sdk::env::predecessor_account_id();
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
        require!(budget > 0, "the budget must be more than zero");
        require!(period_seconds > 0, "the period must be longer than zero");
        require!(rate_limit > 0, "the rate limit must be more than zero");
        require!(max_single_spend > 0, "the single spend limit must be more than zero");

        let now = near_sdk::env::block_timestamp();
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
        near_sdk::env::log_str(&format!("AgentRegistered {}", agent_id));
    }

    /// Replace the vendor allowlist. Owner only.
    pub fn set_vendors(&mut self, agent_id: AccountId, vendors: Vec<AccountId>) {
        self.only_owner();
        let mut policy = self.policy(&agent_id);
        policy.vendors = vendors.iter().map(AccountId::to_string).collect();
        self.policies.insert(&agent_id, &policy);
    }

    /// Replace the period budget. Owner only.
    pub fn set_budget(&mut self, agent_id: AccountId, budget: u128) {
        self.only_owner();
        require!(budget > 0, "the budget must be more than zero");
        let mut policy = self.policy(&agent_id);
        policy.budget = budget;
        self.policies.insert(&agent_id, &policy);
    }

    /// Lock an agent out or let it back in. Owner only.
    pub fn set_revoked(&mut self, agent_id: AccountId, revoked: bool) {
        self.only_owner();
        let mut policy = self.policy(&agent_id);
        policy.revoked = revoked;
        self.policies.insert(&agent_id, &policy);
        near_sdk::env::log_str(&format!(
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
        let caller = near_sdk::env::predecessor_account_id();
        require!(caller == agent_id, "only the agent may request a spend for itself");
        require!(!self.kill_switch, "the kill switch is on");

        let now = near_sdk::env::block_timestamp();
        let policy = self.policy(&agent_id);
        let blocked = self.blocklist.contains(&vendor);

        let decision = bound_policy::evaluate(&policy, vendor.as_str(), amount, nonce, now, blocked);
        if !decision.allowed {
            let receipt = self.write_receipt(
                &agent_id,
                &vendor,
                amount,
                nonce,
                &memo,
                0,
                Outcome::Denied,
                &decision.reason,
                &decision.rule,
                &decision.evidence,
                decision.period_start,
                decision.spent,
                decision.remaining,
            );
            near_sdk::env::log_str(&format!(
                "SpendDenied {} {} {}",
                agent_id, vendor, decision.reason
            ));
            return SpendOutcome {
                request_id: 0,
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

        let (period_start, spent_before) = bound_policy::roll_period(&policy, now);
        let mut policy = policy;
        policy.request_count += 1;
        policy.period_start = period_start;
        policy.spent = spent_before;
        self.policies.insert(&agent_id, &policy);

        let mut index = self.agent_requests.get(&agent_id).unwrap_or_default();
        index.push(request_id);
        self.agent_requests.insert(&agent_id, &index);

        near_sdk::env::log_str(&format!(
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
            spent: spent_before,
            remaining: policy.budget.saturating_sub(spent_before),
        }
    }

    /// Move the money. The owner and the runner may do this.
    pub fn approve_request(&mut self, request_id: u64) -> SpendOutcome {
        self.only_owner_or_runner();
        let mut request = self.request(request_id);
        require!(
            request.status == RequestStatus::Pending,
            "only a pending request can be approved"
        );

        let now = near_sdk::env::block_timestamp();
        let mut policy = self.policy(&request.agent_id);
        let blocked = self.blocklist.contains(&request.vendor);
        let decision = bound_policy::evaluate(
            &policy,
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
            near_sdk::env::log_str(&format!(
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

        let balance = near_sdk::env::account_balance();
        require!(
            balance.as_yoctonear() >= request.amount,
            "the contract does not hold enough for this spend"
        );

        policy.period_start = decision.period_start;
        policy.spent = decision.spent;
        policy.last_nonce = request.nonce;
        let (window_start, count) = bound_policy::rate_window(&policy, now);
        policy.rate_window_start = window_start;
        policy.rate_count = count + 1;
        self.policies.insert(&request.agent_id, &policy);

        let receipt = self.write_receipt(
            &request.agent_id,
            &request.vendor,
            request.amount,
            request.nonce,
            &request.memo,
            request.request_id,
            Outcome::Approved,
            "",
            "every policy check passed and the counterparty check approved",
            &[],
            decision.period_start,
            policy.spent,
            policy.budget.saturating_sub(policy.spent),
        );

        request.status = RequestStatus::Approved;
        request.receipt_id = Some(receipt.receipt_id);
        self.requests.insert(&request_id, &request);

        near_sdk::env::log_str(&format!(
            "SpendApproved {} {} {}",
            request.agent_id, request.vendor, request.amount
        ));

        let _ = near_sdk::Promise::new(request.vendor.clone())
            .transfer(NearToken::from_yoctonear(request.amount));

        SpendOutcome {
            request_id,
            approved: true,
            reason: String::new(),
            rule: "every policy check passed and the counterparty check approved".to_string(),
            evidence: Vec::new(),
            spent: receipt.spent_after,
            remaining: receipt.remaining_after,
        }
    }

    /// Send a request to a human. The owner and the runner may do this.
    ///
    /// This is what the off chain counterparty check calls when it finds
    /// something it is not sure about. The money does not move until the owner
    /// acts.
    pub fn flag_request(&mut self, request_id: u64, reasons: Vec<String>) -> SpendOutcome {
        self.only_owner_or_runner();
        let mut request = self.request(request_id);
        require!(
            request.status == RequestStatus::Pending,
            "only a pending request can be flagged"
        );
        require!(!reasons.is_empty(), "a flag needs at least one reason");
        request.status = RequestStatus::NeedsApproval;
        request.flags = reasons.clone();
        self.requests.insert(&request_id, &request);
        near_sdk::env::log_str(&format!("SpendFlagged {} {}", request.agent_id, request.vendor));

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

    /// Refuse a request. The owner and the runner may do this.
    pub fn reject_request(&mut self, request_id: u64, reason: String) -> SpendOutcome {
        self.only_owner_or_runner();
        let mut request = self.request(request_id);
        require!(
            request.status == RequestStatus::Pending || request.status == RequestStatus::NeedsApproval,
            "only an open request can be rejected"
        );
        require!(!reason.is_empty(), "a rejection needs a reason");

        let policy = self.policy(&request.agent_id);
        let now = near_sdk::env::block_timestamp();
        let (period_start, spent) = bound_policy::roll_period(&policy, now);

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
            &vec![reason.clone()],
            period_start,
            spent,
            policy.budget.saturating_sub(spent),
        );

        request.status = RequestStatus::Denied;
        request.receipt_id = Some(receipt.receipt_id);
        self.requests.insert(&request_id, &request);
        near_sdk::env::log_str(&format!(
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

    /// Approve a request that a human has to look at. Owner only.
    pub fn owner_approve_request(&mut self, request_id: u64) -> SpendOutcome {
        self.only_owner();
        let request = self.request(request_id);
        require!(
            request.status == RequestStatus::NeedsApproval,
            "only a flagged request can be approved by the owner"
        );
        self.approve_request(request_id)
    }

    /// Refuse a request that a human has to look at. Owner only.
    pub fn owner_reject_request(&mut self, request_id: u64, reason: String) -> SpendOutcome {
        self.only_owner();
        self.reject_request(request_id, reason)
    }

    /// Read one policy.
    pub fn get_policy(&self, agent_id: AccountId) -> PolicyView {
        let policy = self.policy(&agent_id);
        let now = near_sdk::env::block_timestamp();
        let (period_start, spent) = bound_policy::roll_period(&policy, now);
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
            rate_count: policy.rate_count,
            last_nonce: policy.last_nonce,
            revoked: policy.revoked,
            request_count: policy.request_count,
        }
    }

    /// Read one request.
    pub fn get_request(&self, request_id: u64) -> Request {
        self.request(request_id)
    }

    /// Read one receipt.
    pub fn get_receipt(&self, receipt_id: u64) -> Receipt {
        self.receipts
            .get(&receipt_id)
            .unwrap_or_else(|| panic!("no receipt with that id"))
    }

    /// Read the receipt ids of one agent.
    pub fn get_request_ids(&self, agent_id: AccountId) -> Vec<u64> {
        self.agent_requests.get(&agent_id).unwrap_or_default()
    }

    /// Whether a receiver is on the blocklist.
    pub fn is_blocked(&self, account_id: AccountId) -> bool {
        self.blocklist.contains(&account_id)
    }

    /// Whether the kill switch is on.
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
        near_sdk::env::account_balance().as_yoctonear()
    }
}

/// The helpers that are not part of the public interface.
impl Bound {
    fn only_owner(&self) {
        let caller = near_sdk::env::predecessor_account_id();
        require!(caller == self.owner, "only the owner may do this");
    }

    fn only_owner_or_runner(&self) {
        let caller = near_sdk::env::predecessor_account_id();
        require!(
            caller == self.owner || caller == self.runner,
            "only the owner or the runner may do this"
        );
    }

    fn policy(&self, agent_id: &AccountId) -> Policy {
        self.policies
            .get(agent_id)
            .unwrap_or_else(|| near_sdk::env::panic_str("no policy for that agent"))
    }

    fn request(&self, request_id: u64) -> Request {
        self.requests
            .get(&request_id)
            .unwrap_or_else(|| panic!("no request with that id"))
    }

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
            created_at: near_sdk::env::block_timestamp(),
        };
        self.receipts.insert(&receipt_id, &receipt);
        receipt
    }
}
