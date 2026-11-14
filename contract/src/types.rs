/// Data structures for the Bound contract.
///
/// Every one of them is stored with Borsh, so the field order and the types
/// are part of the contract's state layout. Changing them changes the state
/// layout, so they only change before deployment.
///
/// The layouts of `Policy`, `Request` and `Receipt` are frozen: the contract
/// is live on testnet and its state is already stored. New enum variants are
/// appended, never inserted, because the borsh discriminant of an enum
/// variant is its position and inserting one would change how the stored
/// values decode.
///
/// The same rule applies to the contract state root. A field cannot be added
/// there either, so the facts the new accounting needs live in sidecar
/// structs under their own storage prefixes. A sidecar key is independent of
/// the state root, so it can be introduced by a redeploy that keeps the old
/// state.
use borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::{near, AccountId};

/// The outcome of a spend attempt.
///
/// The variants are appended, never inserted, so the borsh discriminants of
/// the ones that are already stored on chain keep their values.
#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Outcome {
    /// The money moved.
    Approved,
    /// The money did not move.
    Denied,
    /// The decision was made but the transfer did not go through, so no money
    /// moved and the budget was given back.
    Failed,
    /// The request was closed without a decision on the money. Nothing moved.
    Expired,
}

/// Where a request is in its life cycle.
///
/// The variants are appended, never inserted, so the borsh discriminants of
/// the ones that are already stored on chain keep their values.
#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum RequestStatus {
    /// The agent asked, the hard checks passed, no decision has been made yet.
    Pending,
    /// The counterparty check found something a human should look at.
    NeedsApproval,
    /// The money moved.
    Approved,
    /// The money did not move.
    Denied,
    /// The owner approved and the transfer is in flight. The receipt is
    /// written when the transfer settles.
    ApprovedPending,
    /// The owner approved but the transfer did not go through. The budget was
    /// given back and the receipt says so.
    SettlementFailed,
    /// The request was closed without a decision on the money.
    Expired,
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
    /// The time the request was made, in seconds since the epoch.
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
    /// The time the receipt was written, in seconds since the epoch.
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
    /// The start of the current budget period, in seconds since the epoch.
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

/// A view of a request, for the app.
///
/// The stored `Request` cannot grow a field, so the expiry time travels in a
/// sidecar and is joined into this view. `None` means the request carries no
/// known expiry, which is the case for the requests written before the
/// upgrade.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct RequestView {
    pub request_id: u64,
    pub agent_id: AccountId,
    pub vendor: AccountId,
    pub amount: u128,
    pub nonce: u64,
    pub memo: String,
    pub status: RequestStatus,
    pub created_at: u64,
    pub receipt_id: Option<u64>,
    pub flags: Vec<String>,
    /// When the request expires, in seconds since the epoch.
    pub expires_at: Option<u64>,
}

/// The authoritative amount used by one agent in one budget period.
///
/// `settled` is money that moved. `reserved` is money held for a transfer
/// that has not settled yet. The compatibility field `Policy::spent` mirrors
/// their sum, but this sidecar is the accounting source.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct PeriodTotals {
    pub settled: u128,
    pub reserved: u128,
}

impl PeriodTotals {
    /// The amount this period has committed.
    pub fn used(&self) -> u128 {
        self.settled.saturating_add(self.reserved)
    }
}

/// Request data that cannot be added to the frozen `Request` record.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct RequestMeta {
    /// When the request expires, in seconds since the epoch.
    pub expires_at: u64,
    /// The period that holds the reservation. Zero means no reservation.
    pub reserved_period_start: u64,
}

/// The two nonce watermarks of an agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct NonceState {
    /// The highest nonce ever accepted for a request.
    pub accepted_nonce: u64,
    /// The highest nonce ever approved.
    pub approved_nonce: u64,
}
