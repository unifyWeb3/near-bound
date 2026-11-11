//! Tests for the Bound contract.
//!
//! The policy engine has its own tests in the `bound-policy` crate. These
//! tests cover the contract: who may call what, what the kill switch does,
//! what happens when the transfer to the vendor fails, and the fact that two
//! approvals cannot together go over the budget.
//!
//! They run on near-sdk's mocked chain, so they need no network and no
//! sandbox.

use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{MockedBlockchain, NearToken};

/// The block timestamp the tests run at, in nanoseconds.
const NOW: u64 = 1_800_000_000_000_000_000;

/// The contract account.
const CONTRACT: &str = "bound.testnet";
/// The account that owns the contract and approves spends.
const OWNER: &str = "owner.testnet";
/// The account that asks for spends. It holds no money.
const AGENT: &str = "agent.testnet";
/// The account that gets paid.
const VENDOR: &str = "vendor.testnet";

/// The budget every test starts with.
const BUDGET: u128 = 1_000;
/// The cap on one payment every test starts with.
const MAX_SINGLE_SPEND: u128 = 600;
/// The payments allowed in one minute every test starts with.
const RATE_LIMIT: u64 = 5;

fn account(name: &str) -> AccountId {
    name.parse().unwrap()
}

/// Rebuild the mocked chain with a different caller, keeping the state.
///
/// The owner and the agent are different accounts, so the chain has to be
/// rebuilt between the calls they make. The state of the contract is taken
/// out and put back, so it survives.
fn call_as(caller: AccountId) {
    let storage = near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
    let context = VMContextBuilder::new()
        .current_account_id(account(CONTRACT))
        .predecessor_account_id(caller)
        .account_balance(NearToken::from_near(20))
        .block_timestamp(NOW)
        .build();
    near_sdk::env::set_blockchain_interface(MockedBlockchain::new(
        context,
        near_sdk::test_vm_config(),
        near_parameters::RuntimeFeesConfig::test(),
        Vec::default(),
        storage,
        Default::default(),
        None,
    ));
}

/// A contract with one agent registered and nothing spent.
fn setup() -> Bound {
    call_as(account(OWNER));
    let mut contract = Bound::new();
    contract.register_agent(
        account(AGENT),
        BUDGET,
        3600,
        vec![account(VENDOR)],
        MAX_SINGLE_SPEND,
        RATE_LIMIT,
    );
    contract
}

/// The agent asks for a spend.
fn ask(contract: &mut Bound, amount: u128, nonce: u64, memo: &str) -> u64 {
    call_as(account(AGENT));
    let outcome = contract.request_spend(
        account(AGENT),
        account(VENDOR),
        amount,
        nonce,
        memo.to_string(),
    );
    outcome.request_id
}

/// The owner approves a request.
fn approve(contract: &mut Bound, request_id: u64) -> SpendOutcome {
    call_as(account(OWNER));
    contract.approve_request(request_id)
}

/// Run a closure and report whether it panicked.
fn panics(f: impl FnOnce()) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
}

/// F-01. A request made before the freeze is refused at approval after it.
#[test]
fn a_request_made_before_the_freeze_is_refused_after_the_freeze() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "asked before the freeze");

    // The owner freezes every agent.
    call_as(account(OWNER));
    contract.set_kill_switch(true);

    // The approval must not go through.
    let mut refused = false;
    call_as(account(OWNER));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        contract.approve_request(request_id)
    }));
    if result.is_err() {
        refused = true;
    }
    assert!(refused, "the kill switch must stop the approval");

    // Nothing was decided and nothing was written.
    assert_eq!(
        contract.get_receipt_count(),
        0,
        "a frozen approval must not write a receipt"
    );
    assert_eq!(
        contract.get_request(request_id).status,
        RequestStatus::Pending,
        "the request must stay open"
    );
    assert_eq!(contract.get_policy(account(AGENT)).spent, 0);

    // The owner lifts the freeze and the same request can be approved.
    call_as(account(OWNER));
    contract.set_kill_switch(false);
    let outcome = approve(&mut contract, request_id);
    assert!(outcome.approved);
}

/// F-01. The kill switch stops every agent, not just one.
#[test]
fn the_kill_switch_stops_a_second_agent_too() {
    let mut contract = setup();
    call_as(account(OWNER));
    contract.register_agent(
        account("agent-two.testnet"),
        BUDGET,
        3600,
        vec![account(VENDOR)],
        MAX_SINGLE_SPEND,
        RATE_LIMIT,
    );
    call_as(account(OWNER));
    contract.set_kill_switch(true);

    call_as(account("agent-two.testnet"));
    let outcome = contract.request_spend(
        account("agent-two.testnet"),
        account(VENDOR),
        100,
        1,
        "asked while frozen".to_string(),
    );
    assert!(!outcome.approved);
    assert_eq!(outcome.reason, "KillSwitch");
}

/// F-02. A transfer that settles writes an approved receipt.
#[test]
fn a_transfer_that_settles_writes_an_approved_receipt() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "settles");

    let outcome = approve(&mut contract, request_id);
    assert!(outcome.approved);

    // The receipt is written when the transfer settles, not before.
    assert_eq!(
        contract.get_receipt_count(),
        0,
        "no receipt before the settlement"
    );
    assert_eq!(
        contract.get_request(request_id).status,
        RequestStatus::ApprovedPending
    );

    // The budget is reserved while the transfer is in flight.
    assert_eq!(contract.get_policy(account(AGENT)).spent, 100);

    contract.on_transfer(request_id, Ok(()));

    assert_eq!(contract.get_receipt_count(), 1);
    let receipt = contract.get_receipt(0);
    assert_eq!(receipt.outcome, Outcome::Approved);
    assert_eq!(receipt.amount, 100);
    assert_eq!(receipt.request_id, request_id);
    assert_eq!(
        contract.get_request(request_id).status,
        RequestStatus::Approved
    );
    assert_eq!(contract.get_policy(account(AGENT)).spent, 100);
}

/// F-02. A transfer that fails gives the budget back and says so.
#[test]
fn a_failed_transfer_gives_the_budget_back() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "fails");

    approve(&mut contract, request_id);
    assert_eq!(
        contract.get_policy(account(AGENT)).spent,
        100,
        "the budget is reserved while the transfer is in flight"
    );

    contract.on_transfer(request_id, Err(PromiseError::Failed));

    assert_eq!(contract.get_receipt_count(), 1);
    let receipt = contract.get_receipt(0);
    assert_eq!(receipt.outcome, Outcome::Failed);
    assert_eq!(receipt.reason, "TransferFailed");
    assert!(
        receipt.evidence.iter().any(|e| e.contains("failed")),
        "the receipt must say what happened"
    );
    assert_eq!(
        contract.get_policy(account(AGENT)).spent,
        0,
        "a failed payment must not eat into the budget"
    );
    assert_eq!(
        contract.get_request(request_id).status,
        RequestStatus::SettlementFailed
    );
}

/// F-02. A failed transfer leaves the budget free for the next request.
#[test]
fn a_request_after_a_failed_transfer_is_allowed() {
    let mut contract = setup();
    let first = ask(&mut contract, 100, 1, "fails");
    approve(&mut contract, first);
    contract.on_transfer(first, Err(PromiseError::Failed));

    let second = ask(&mut contract, 100, 2, "after the failure");
    let outcome = approve(&mut contract, second);
    assert!(outcome.approved, "the budget was given back");
}

/// F-03. An agent that already has a policy cannot be registered again.
#[test]
fn registering_an_agent_twice_is_refused() {
    let mut contract = setup();
    call_as(account(OWNER));
    let refused = panics(|| {
        contract.register_agent(
            account(AGENT),
            BUDGET,
            3600,
            vec![account(VENDOR)],
            MAX_SINGLE_SPEND,
            RATE_LIMIT,
        )
    });
    assert!(refused, "a live agent must not be registered again");
}

/// F-03. Registering an agent again does not wipe its counters.
#[test]
fn registering_an_agent_again_would_have_wiped_the_counters() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "counts");
    approve(&mut contract, request_id);
    contract.on_transfer(request_id, Ok(()));

    let before = contract.get_policy(account(AGENT));
    assert_eq!(before.spent, 100);
    assert_eq!(before.last_nonce, 1);
    assert_eq!(before.request_count, 1);

    // The old code overwrote the policy here and lost all three.
    let refused = panics(|| {
        contract.register_agent(
            account(AGENT),
            BUDGET,
            3600,
            vec![account(VENDOR)],
            MAX_SINGLE_SPEND,
            RATE_LIMIT,
        )
    });
    assert!(refused);

    let after = contract.get_policy(account(AGENT));
    assert_eq!(after.spent, before.spent);
    assert_eq!(after.last_nonce, before.last_nonce);
    assert_eq!(after.request_count, before.request_count);
}

/// F-03. Changing the limits keeps the counters of the agent.
#[test]
fn changing_the_limits_keeps_the_counters() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "counts");
    approve(&mut contract, request_id);
    contract.on_transfer(request_id, Ok(()));
    let before = contract.get_policy(account(AGENT));

    call_as(account(OWNER));
    contract.set_budget(account(AGENT), 5_000);
    contract.set_max_single_spend(account(AGENT), 2_000);
    contract.set_rate_limit(account(AGENT), 9);
    let after = contract.get_policy(account(AGENT));

    assert_eq!(after.budget, 5_000);
    assert_eq!(after.max_single_spend, 2_000);
    assert_eq!(after.rate_limit, 9);
    assert_eq!(after.spent, before.spent);
    assert_eq!(after.last_nonce, before.last_nonce);
    assert_eq!(after.request_count, before.request_count);
}

/// The concurrency proof. Two approvals cannot together go over the budget,
/// because the second one is checked against the spend the first one
/// reserved.
#[test]
fn two_approvals_cannot_together_go_over_the_budget() {
    let mut contract = setup();
    let first = ask(&mut contract, 600, 1, "first");
    let second = ask(&mut contract, 600, 2, "second");

    let outcome = approve(&mut contract, first);
    assert!(outcome.approved);

    // The second one is 600 on top of the 600 already reserved, and the
    // budget is 1000.
    let outcome = approve(&mut contract, second);
    assert!(!outcome.approved);
    assert_eq!(outcome.reason, "BudgetExceeded");

    let receipt = contract.get_receipt(0);
    assert_eq!(receipt.outcome, Outcome::Denied);
    assert_eq!(receipt.reason, "BudgetExceeded");
    assert_eq!(receipt.spent_after, 600);

    // Only the first payment is in the budget.
    assert_eq!(contract.get_policy(account(AGENT)).spent, 600);
    assert_eq!(contract.get_policy(account(AGENT)).remaining, 400);
}

/// The concurrency proof, the other way round. The second approval is
/// refused even though both requests were made before either was approved.
#[test]
fn a_request_made_early_cannot_spend_a_reserved_budget() {
    let mut contract = setup();
    // Both requests exist before any approval.
    let first = ask(&mut contract, 500, 1, "first");
    let second = ask(&mut contract, 600, 2, "second");

    approve(&mut contract, first);
    let outcome = approve(&mut contract, second);
    assert!(!outcome.approved);
    assert_eq!(outcome.reason, "BudgetExceeded");
    assert_eq!(contract.get_policy(account(AGENT)).spent, 500);
}

/// Only the agent may ask for a spend, and only for itself.
#[test]
fn only_the_agent_may_ask_for_a_spend() {
    let mut contract = setup();
    call_as(account("stranger.testnet"));
    let refused = panics(|| {
        contract.request_spend(
            account(AGENT),
            account(VENDOR),
            100,
            1,
            "not the agent".to_string(),
        );
    });
    assert!(refused, "only the agent may ask for a spend for itself");
}

/// The agent cannot approve its own request, even if it is the owner.
#[test]
fn the_agent_cannot_approve_its_own_request() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "self approval");
    call_as(account(AGENT));
    let refused = panics(|| {
        let _ = contract.approve_request(request_id);
    });
    assert!(refused, "the agent must not approve its own request");
}

/// Only the owner may change the policy.
#[test]
fn only_the_owner_may_change_the_policy() {
    let mut contract = setup();
    call_as(account(AGENT));
    let refused = panics(|| {
        contract.set_budget(account(AGENT), 10_000);
    });
    assert!(refused, "only the owner may change the budget");
}
