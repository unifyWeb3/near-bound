/// Data structures for the Bound contract.
///
/// Every one of them is stored with Borsh, so the field order and the types
/// are part of the contract's state layout. Changing them changes the state
/// layout, so they only change before deployment.

use near_sdk::{near, AccountId};

/// The outcome of a spend attempt.
#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The money moved.
    Approved,
    /// The money did not move.
    Denied,
}

/// Where a request is in its life cycle.
#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq)]
pub enum RequestStatus {
    /// The agent asked, the hard checks passed, no decision has been made yet.
    Pending,
    /// The counterparty check found something a human should look at.
    NeedsApproval,
    /// The money moved.
    Approved,
    /// The money did not move.
    Denied,
}

/// One request for a spend.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Request {
    pub request_id: u64,
    pub agent_id: AccountId,
    pub vendor: AccountId,
    /// The amount in yoctoNEAR.
    pub amount: u128,
    pub nonce: u64,
    pub memo: String,
    pub status: RequestStatus,
    pub created_at: u64,
    pub receipt_id: Option<u64>,
    /// Why the counterparty check asked for a human.
    pub flags: Vec<String>,
}

/// The record of one decision. Denials are recorded too.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Receipt {
    pub receipt_id: u64,
    pub request_id: u64,
    pub agent_id: AccountId,
    pub vendor: AccountId,
    pub amount: u128,
    pub nonce: u64,
    pub memo: String,
    pub outcome: Outcome,
    /// Empty when the spend was approved.
    pub reason: String,
    /// The rule that decided, in plain words.
    pub rule: String,
    /// The facts behind the decision.
    pub evidence: Vec<String>,
    pub period_start: u64,
    pub spent_after: u128,
    pub remaining_after: u128,
    pub created_at: u64,
}

/// The result of a request, returned to the caller.
#[near(serializers = [json])]
#[derive(Clone, PartialEq, Eq)]
pub struct SpendOutcome {
    pub request_id: u64,
    pub approved: bool,
    /// Empty when the request was accepted for review.
    pub reason: String,
    pub rule: String,
    pub evidence: Vec<String>,
    pub spent: u128,
    pub remaining: u128,
}

/// A view of a policy, for the app.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct PolicyView {
    pub agent_id: String,
    pub budget: u128,
    pub period_seconds: u64,
    pub period_start: u64,
    pub spent: u128,
    pub remaining: u128,
    pub vendors: Vec<String>,
    pub max_single_spend: u128,
    pub rate_limit: u64,
    pub rate_count: u64,
    pub last_nonce: u64,
    pub revoked: bool,
    pub request_count: u64,
}
