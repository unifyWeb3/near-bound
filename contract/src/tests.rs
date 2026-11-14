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

/// A NEAR account id from its name.
fn account(name: &str) -> AccountId {
    name.parse().unwrap()
}

/// Rebuild the mocked chain with a different caller, keeping the state.
///
/// The owner and the agent are different accounts, so the chain has to be
/// rebuilt between the calls they make. The state of the contract is taken
/// out and put back, so it survives.
fn call_as(caller: AccountId) {
    call_as_at(caller, NOW);
}

/// Rebuild the mocked chain with a different caller and a different time.
fn call_as_at(caller: AccountId, timestamp: u64) {
    let storage = near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
    let context = VMContextBuilder::new()
        .current_account_id(account(CONTRACT))
        .predecessor_account_id(caller)
        .account_balance(NearToken::from_near(20))
        .block_timestamp(timestamp)
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
    // Rust's test runner can reuse a worker thread for another test. The
    // mocked chain lives in thread-local storage, so clear it before every
    // test and keep each test's state independent.
    near_sdk::mock::with_mocked_blockchain(|blockchain| {
        let _ = blockchain.take_storage();
    });
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
    ask_at(contract, amount, nonce, memo, NOW)
}

/// The agent asks for a spend at a given time.
fn ask_at(contract: &mut Bound, amount: u128, nonce: u64, memo: &str, timestamp: u64) -> u64 {
    call_as_at(account(AGENT), timestamp);
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

/// Put one request into the frozen state map and remove every sidecar that
/// the remediated contract would have written for it.
///
/// The state root and request layout are the historical ones, so this is a
/// genuine legacy fixture rather than a mock of the migration methods.
fn seed_legacy_request(contract: &mut Bound, nonce: u64) -> u64 {
    let request_id = contract.next_request_id;
    let request = Request {
        request_id,
        agent_id: account(AGENT),
        vendor: account(VENDOR),
        amount: 100,
        nonce,
        memo: "historical request".to_string(),
        status: RequestStatus::Pending,
        created_at: NOW / 1_000_000_000,
        receipt_id: None,
        flags: Vec::new(),
    };
    contract.requests.insert(&request_id, &request);
    contract.next_request_id = request_id + 1;
    contract
        .agent_requests
        .insert(&account(AGENT), &vec![request_id]);
    let mut policy = contract.policy(&account(AGENT));
    policy.request_count += 1;
    contract.policies.insert(&account(AGENT), &policy);

    near_sdk::env::storage_remove(SCHEMA_KEY.as_bytes());
    near_sdk::env::storage_remove(format!("{}{}", NONCE_PREFIX, account(AGENT)).as_bytes());
    near_sdk::env::storage_remove(format!("{}{}", REQUEST_META_PREFIX, request_id).as_bytes());
    near_sdk::env::storage_remove(
        format!("{}{}", MIGRATION_REQUEST_INDEX_PREFIX, account(AGENT)).as_bytes(),
    );
    request_id
}

/// Remove every sidecar the current layout would have written, so the state
/// looks the way the historical contract left it.
///
/// The historical contract wrote the request and the receipt into the frozen
/// state map and nothing else. There was no metadata sidecar, no accounting
/// sidecar and one flat spend figure on the policy.
fn strip_legacy_sidecars(contract: &mut Bound) {
    near_sdk::env::storage_remove(SCHEMA_KEY.as_bytes());
    near_sdk::env::storage_remove(format!("{}{}", NONCE_PREFIX, account(AGENT)).as_bytes());
    near_sdk::env::storage_remove(
        format!("{}{}", MIGRATION_REQUEST_INDEX_PREFIX, account(AGENT)).as_bytes(),
    );
    for request_id in 0..contract.next_request_id {
        near_sdk::env::storage_remove(format!("{}{}", REQUEST_META_PREFIX, request_id).as_bytes());
    }
    let period = contract.policy(&account(AGENT)).period_start;
    near_sdk::env::storage_remove(
        format!("{}{}:{}", PERIOD_PREFIX, account(AGENT), period).as_bytes(),
    );
    near_sdk::env::storage_remove(
        format!(
            "{}{}:{}",
            PERIOD_PREFIX,
            account(AGENT),
            normalize_period(period)
        )
        .as_bytes(),
    );
}

/// Put one historical request into the frozen state.
fn seed_legacy_request_with(
    contract: &mut Bound,
    nonce: u64,
    amount: u128,
    status: RequestStatus,
    created_at: u64,
) -> u64 {
    let request_id = contract.next_request_id;
    let request = Request {
        request_id,
        agent_id: account(AGENT),
        vendor: account(VENDOR),
        amount,
        nonce,
        memo: "historical request".to_string(),
        status,
        created_at,
        receipt_id: None,
        flags: Vec::new(),
    };
    contract.requests.insert(&request_id, &request);
    contract.next_request_id = request_id + 1;
    let mut ids = contract
        .agent_requests
        .get(&account(AGENT))
        .unwrap_or_default();
    ids.push(request_id);
    contract.agent_requests.insert(&account(AGENT), &ids);
    let mut policy = contract.policy(&account(AGENT));
    policy.request_count += 1;
    contract.policies.insert(&account(AGENT), &policy);

    strip_legacy_sidecars(contract);
    request_id
}

/// Put one historical decision into the frozen state, with its receipt.
fn seed_legacy_settled_request(contract: &mut Bound, nonce: u64, amount: u128, period: u64) -> u64 {
    let request_id =
        seed_legacy_request_with(contract, nonce, amount, RequestStatus::Approved, period);
    let receipt_id = contract.next_receipt_id;
    let receipt = Receipt {
        receipt_id,
        request_id,
        agent_id: account(AGENT),
        vendor: account(VENDOR),
        amount,
        nonce,
        memo: "historical request".to_string(),
        outcome: Outcome::Approved,
        reason: String::new(),
        rule: "every policy check passed and the counterparty check approved".to_string(),
        evidence: Vec::new(),
        period_start: period,
        spent_after: amount,
        remaining_after: BUDGET.saturating_sub(amount),
        created_at: period,
    };
    contract.receipts.insert(&receipt_id, &receipt);
    contract.next_receipt_id = receipt_id + 1;
    let mut request = contract.requests.get(&request_id).unwrap();
    request.receipt_id = Some(receipt_id);
    contract.requests.insert(&request_id, &request);
    near_sdk::env::storage_remove(
        format!("{}{}:{}", PERIOD_PREFIX, account(AGENT), period).as_bytes(),
    );
    strip_legacy_sidecars(contract);
    request_id
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
    assert_eq!(contract.get_policy(account(AGENT)).remaining, 900);
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

/// F-02. A failed payment gives the rate slot back.
#[test]
fn a_failed_payment_gives_the_rate_slot_back() {
    let mut contract = setup();
    let first = ask(&mut contract, 100, 1, "fails");
    approve(&mut contract, first);
    assert_eq!(contract.get_policy(account(AGENT)).rate_count, 1);

    contract.on_transfer(first, Err(PromiseError::Failed));

    assert_eq!(
        contract.get_policy(account(AGENT)).rate_count,
        0,
        "a payment that never happened must not use a rate slot"
    );
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

/// A flagged request waits for the owner, and the owner can approve it.
#[test]
fn the_owner_can_approve_a_flagged_request() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "flagged");

    call_as(account(OWNER));
    contract.flag_request(request_id, vec!["odd receiver".to_string()]);
    assert_eq!(
        contract.get_request(request_id).status,
        RequestStatus::NeedsApproval
    );

    call_as(account(OWNER));
    let outcome = contract.owner_approve_request(request_id);
    assert!(outcome.approved, "the owner approves a flagged request");
    assert_eq!(
        contract.get_request(request_id).status,
        RequestStatus::ApprovedPending
    );
}

/// The runner may not approve a flagged request. It waits for the owner.
#[test]
fn the_runner_cannot_approve_a_flagged_request() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "flagged");

    call_as(account(OWNER));
    contract.flag_request(request_id, vec!["odd receiver".to_string()]);

    // A runner is an account the owner names.
    call_as(account(OWNER));
    contract.set_runner(account("runner.testnet"));

    call_as(account("runner.testnet"));
    let refused = panics(|| {
        let _ = contract.approve_request(request_id);
    });
    assert!(refused, "a flagged request waits for the owner alone");
}

/// The runner may approve an ordinary request.
#[test]
fn the_runner_can_approve_an_ordinary_request() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "ordinary");

    call_as(account(OWNER));
    contract.set_runner(account("runner.testnet"));

    call_as(account("runner.testnet"));
    let outcome = contract.approve_request(request_id);
    assert!(outcome.approved);
}

/// A nonce that was accepted cannot be used again, even when the request it
/// was used on was never decided.
#[test]
fn an_accepted_nonce_cannot_be_replayed() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "first");
    approve(&mut contract, request_id);
    contract.on_transfer(request_id, Ok(()));

    call_as(account(AGENT));
    let outcome = contract.request_spend(
        account(AGENT),
        account(VENDOR),
        100,
        1,
        "replay".to_string(),
    );
    assert!(!outcome.approved);
    assert_eq!(outcome.reason, "NonceReplay");
}

/// A nonce that was accepted but never approved is still spent.
#[test]
fn an_accepted_nonce_cannot_be_replayed_before_it_is_approved() {
    let mut contract = setup();
    let _first = ask(&mut contract, 100, 1, "never decided");

    call_as(account(AGENT));
    let outcome = contract.request_spend(
        account(AGENT),
        account(VENDOR),
        100,
        1,
        "replay".to_string(),
    );
    assert!(!outcome.approved);
    assert_eq!(outcome.reason, "NonceReplay");
}

/// The settlement does not walk the history of the agent.
#[test]
fn the_settlement_is_constant_time_with_a_long_history() {
    let mut contract = setup();

    for index in 1..=300u64 {
        let _ = ask(&mut contract, 1, index, &format!("request {}", index));
    }

    let request_id = ask(&mut contract, 100, 301, "settles");
    approve(&mut contract, request_id);
    contract.on_transfer(request_id, Ok(()));

    let receipt = contract.get_receipt(0);
    assert_eq!(receipt.outcome, Outcome::Approved);
    assert_eq!(receipt.spent_after, 100);
}

/// Two payments that settle out of order still leave the right figures.
#[test]
fn payments_that_settle_out_of_order_leave_the_right_figures() {
    let mut contract = setup();
    let first = ask(&mut contract, 100, 1, "first");
    let second = ask(&mut contract, 200, 2, "second");

    approve(&mut contract, first);
    approve(&mut contract, second);

    // The second one settles first.
    contract.on_transfer(second, Ok(()));
    let receipt = contract.get_receipt(0);
    assert_eq!(receipt.outcome, Outcome::Approved);
    assert_eq!(
        receipt.spent_after, 200,
        "the second payment settled, the first one is still reserved"
    );

    contract.on_transfer(first, Ok(()));
    let receipt = contract.get_receipt(1);
    assert_eq!(receipt.outcome, Outcome::Approved);
    assert_eq!(receipt.spent_after, 300, "both payments settled");
}

/// A payment that fails after the period ended does not touch the new one.
#[test]
fn a_failure_after_the_period_ended_does_not_corrupt_the_new_period() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "fails");

    approve(&mut contract, request_id);

    // The period ends before the transfer settles.
    let later = NOW + 3_600 * 1_000_000_000;
    call_as_at(account(OWNER), later);
    contract.on_transfer(request_id, Err(PromiseError::Failed));

    let policy = contract.get_policy(account(AGENT));
    assert_eq!(policy.spent, 0, "the new period starts clean");
    assert_eq!(policy.remaining, BUDGET);
}

/// A payment that settles after the period ended does not touch the new one.
#[test]
fn a_settlement_after_the_period_ended_does_not_corrupt_the_new_period() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "settles late");

    approve(&mut contract, request_id);

    let later = NOW + 3_600 * 1_000_000_000;
    call_as_at(account(OWNER), later);
    contract.on_transfer(request_id, Ok(()));

    let policy = contract.get_policy(account(AGENT));
    assert_eq!(policy.spent, 0, "the new period starts clean");
    assert_eq!(
        contract.get_request(request_id).status,
        RequestStatus::Approved,
        "the money moved, so the request is paid"
    );
}

/// The owner can close a request that is no longer wanted.
#[test]
fn the_owner_can_expire_a_request() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "to expire");

    call_as(account(OWNER));
    let outcome = contract.expire_request(request_id, "the vendor is no longer needed".to_string());
    assert!(!outcome.approved);
    assert_eq!(outcome.reason, "RequestExpired");

    assert_eq!(
        contract.get_request(request_id).status,
        RequestStatus::Expired
    );
    assert_eq!(contract.get_receipt_count(), 1);
    let receipt = contract.get_receipt(0);
    assert_eq!(receipt.outcome, Outcome::Expired);
    assert_eq!(receipt.amount, 100);
}

/// A request that sat past its time to live cannot be approved.
#[test]
fn an_expired_request_cannot_be_approved() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "too old");

    let much_later = NOW + (REQUEST_TTL_SECONDS + 60) * 1_000_000_000;
    call_as_at(account(OWNER), much_later);
    let outcome = contract.approve_request(request_id);

    assert!(!outcome.approved);
    assert_eq!(outcome.reason, "RequestExpired");
    assert_eq!(
        contract.get_request(request_id).status,
        RequestStatus::Expired
    );
    assert_eq!(contract.get_policy(account(AGENT)).spent, 0);
}

/// An approved request whose transfer callback never ran can be closed by
/// the owner, and the reservation comes back.
#[test]
fn the_owner_can_reconcile_a_request_that_never_settled() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "stuck");

    approve(&mut contract, request_id);
    assert_eq!(contract.get_policy(account(AGENT)).spent, 100);

    // The owner says the transfer did not go through.
    call_as(account(OWNER));
    let outcome = contract.reconcile_request(request_id, false);
    assert!(!outcome.approved);
    assert_eq!(outcome.reason, "Reconciled");

    assert_eq!(
        contract.get_policy(account(AGENT)).spent,
        0,
        "the reservation is given back"
    );
    assert_eq!(
        contract.get_request(request_id).status,
        RequestStatus::SettlementFailed
    );
    let receipt = contract.get_receipt(0);
    assert_eq!(receipt.outcome, Outcome::Failed);
}

/// The owner can also say the transfer did go through.
#[test]
fn the_owner_can_reconcile_a_request_that_did_move() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "moved");

    approve(&mut contract, request_id);

    call_as(account(OWNER));
    let outcome = contract.reconcile_request(request_id, true);
    assert!(outcome.approved);
    assert_eq!(contract.get_policy(account(AGENT)).spent, 100);
    let receipt = contract.get_receipt(0);
    assert_eq!(receipt.outcome, Outcome::Approved);
}

/// A budget inside the allowed range is accepted, and the demo budget of
/// five NEAR is inside it.
#[test]
fn a_budget_inside_the_allowed_range_is_accepted() {
    call_as(account(OWNER));
    let mut contract = Bound::new();
    contract.register_agent(
        account(AGENT),
        5_000_000_000_000_000_000_000_000,
        3600,
        vec![account(VENDOR)],
        1_000_000_000_000_000_000_000_000,
        5,
    );
    assert_eq!(
        contract.get_policy(account(AGENT)).budget,
        5_000_000_000_000_000_000_000_000
    );
}

/// A budget above the allowed range is refused.
#[test]
fn a_budget_above_the_allowed_range_is_refused() {
    call_as(account(OWNER));
    let mut contract = Bound::new();
    let refused = panics(|| {
        contract.register_agent(
            account(AGENT),
            bound_policy::MAX_BUDGET + 1,
            3600,
            vec![account(VENDOR)],
            100,
            5,
        )
    });
    assert!(refused, "a budget above the limit is refused");
}

/// A memo that is too long is refused.
#[test]
fn a_memo_that_is_too_long_is_refused() {
    let mut contract = setup();
    call_as(account(AGENT));
    let memo = "x".repeat(bound_policy::MAX_MEMO_BYTES + 1);
    let refused = panics(|| {
        let _ = contract.request_spend(account(AGENT), account(VENDOR), 100, 1, memo.to_string());
    });
    assert!(refused, "a memo above the limit is refused");
}

/// The requests of one agent are read in pages.
#[test]
fn the_requests_of_one_agent_are_read_in_pages() {
    let mut contract = setup();

    for index in 1..=10u64 {
        let _ = ask(&mut contract, 10, index, &format!("req {}", index));
    }

    let page1 = contract.get_requests(account(AGENT), 0, 5);
    assert_eq!(page1.len(), 5);
    assert_eq!(page1[0].request_id, 9, "the newest request comes first");

    let page2 = contract.get_requests(account(AGENT), 5, 5);
    assert_eq!(page2.len(), 5);
    assert_eq!(page2[0].request_id, 4);

    let page3 = contract.get_requests(account(AGENT), 15, 5);
    assert!(page3.is_empty());
}

/// The receipts of one agent are read in pages, newest first.
#[test]
fn the_receipts_of_one_agent_are_read_in_pages() {
    let mut contract = setup();

    for index in 1..=5u64 {
        let request_id = ask(&mut contract, 100, index, &format!("req {}", index));
        approve(&mut contract, request_id);
        contract.on_transfer(request_id, Ok(()));
    }

    let page1 = contract.get_agent_receipts(account(AGENT), 0, 2);
    assert_eq!(page1.len(), 2);
    assert_eq!(page1[0].receipt_id, 4);
    assert_eq!(page1[1].receipt_id, 3);

    let page2 = contract.get_agent_receipts(account(AGENT), 2, 2);
    assert_eq!(page2.len(), 2);
    assert_eq!(page2[0].receipt_id, 2);

    let page3 = contract.get_agent_receipts(account(AGENT), 4, 2);
    assert_eq!(page3.len(), 1);
}

/// A receipt of one agent does not change the count of another agent.
#[test]
fn the_receipt_counts_of_two_agents_are_independent() {
    let mut contract = setup();
    assert_eq!(contract.get_agent_receipt_count(account(AGENT)), 0);
    assert_eq!(contract.get_receipt_count(), 0);

    call_as(account(OWNER));
    contract.register_agent(
        account("agent-two.testnet"),
        BUDGET,
        3600,
        vec![account(VENDOR)],
        MAX_SINGLE_SPEND,
        RATE_LIMIT,
    );

    call_as(account("agent-two.testnet"));
    let outcome = contract.request_spend(
        account("agent-two.testnet"),
        account(VENDOR),
        100,
        1,
        "agent two".to_string(),
    );
    call_as(account(OWNER));
    contract.approve_request(outcome.request_id);
    contract.on_transfer(outcome.request_id, Ok(()));

    assert_eq!(contract.get_agent_receipt_count(account(AGENT)), 0);
    assert_eq!(contract.get_receipt_count(), 1);
    let agent_two: AccountId = "agent-two.testnet".parse().unwrap();
    assert_eq!(contract.get_agent_receipt_count(agent_two), 1);
}

/// A receipt is never removed and never changed.
#[test]
fn a_receipt_is_never_removed_or_changed() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "kept");
    approve(&mut contract, request_id);
    contract.on_transfer(request_id, Ok(()));

    let before = contract.get_receipt(0);

    // One payment a minute, so every approval is inside its own rate window.
    for index in 2..=10u64 {
        let later = NOW + (index - 1) * 61 * 1_000_000_000;
        let other = ask_at(&mut contract, 50, index, "more", later);
        call_as_at(account(OWNER), later);
        let outcome = contract.approve_request(other);
        assert!(outcome.approved, "the request is approved");
        contract.on_transfer(other, Ok(()));
    }

    let after = contract.get_receipt(0);
    assert_eq!(after.receipt_id, before.receipt_id);
    assert_eq!(after.amount, before.amount);
    assert_eq!(after.outcome, before.outcome);
    assert_eq!(contract.get_receipt_count(), 10);
}

/// A receipt that does not exist is reported as missing, not as a crash.
#[test]
fn a_receipt_that_does_not_exist_is_reported_as_missing() {
    let contract = setup();
    assert!(contract.get_receipt_safe(999_999).is_none());
}

/// The settlement callback is idempotent.
#[test]
fn the_settlement_callback_is_idempotent() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "idempotent");
    approve(&mut contract, request_id);

    contract.on_transfer(request_id, Ok(()));
    let count1 = contract.get_receipt_count();

    contract.on_transfer(request_id, Ok(()));
    let count2 = contract.get_receipt_count();

    assert_eq!(count1, count2, "the settlement runs once");
}

/// The migration marks the schema and keeps every request.
#[test]
fn the_migration_marks_the_schema_and_keeps_the_requests() {
    let mut contract = setup();
    let request_id = seed_legacy_request(&mut contract, 1);

    // A legacy state has no current schema marker, so neither a request nor
    // an approval can run until the owner has migrated it.
    call_as(account(OWNER));
    assert!(panics(|| {
        let _ = contract.approve_request(request_id);
    }));

    call_as(account(AGENT));
    assert!(panics(|| {
        let _ = contract.request_spend(
            account(AGENT),
            account(VENDOR),
            100,
            2,
            "before migration".to_string(),
        );
    }));

    call_as(account(OWNER));
    contract.migrate();
    let marker = contract.schema_marker_sidecar().unwrap();
    assert_eq!(marker.version, SCHEMA_VERSION);
    assert_eq!(
        contract.get_request(request_id).status,
        RequestStatus::Pending
    );
    assert_eq!(contract.get_request_ids(account(AGENT)).len(), 1);

    // The accepted nonce came from the historical request, so it cannot be
    // replayed after migration.
    call_as(account(AGENT));
    let replay = contract.request_spend(
        account(AGENT),
        account(VENDOR),
        100,
        1,
        "replay after migration".to_string(),
    );
    assert_eq!(replay.reason, "NonceReplay");
}

/// The open requests of one agent are the ones waiting for a decision.
#[test]
fn the_open_requests_are_the_ones_waiting_for_a_decision() {
    let mut contract = setup();
    let first = ask(&mut contract, 100, 1, "waiting");
    let second = ask(&mut contract, 200, 2, "also waiting");

    let open = contract.get_open_requests(account(AGENT));
    assert_eq!(open.len(), 2);
    assert_eq!(open[0].request_id, second, "the newest request comes first");
    assert_eq!(open[1].request_id, first);

    approve(&mut contract, first);

    let open = contract.get_open_requests(account(AGENT));
    assert_eq!(open.len(), 1, "a decided request is no longer open");
    assert_eq!(open[0].request_id, second);
}

/// The first request has the id zero and is still readable.
#[test]
fn the_first_request_has_the_id_zero() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "first");
    assert_eq!(request_id, 0);

    let request = contract.get_request(0);
    assert_eq!(request.amount, 100);

    let ids = contract.get_request_ids(account(AGENT));
    assert!(ids.contains(&0));
}

/// A legacy state is migrated in bounded request and receipt phases.
#[test]
fn the_legacy_migration_is_batched_and_resumable() {
    let mut contract = setup();
    let mut ids = Vec::new();
    for nonce in 1..=101u64 {
        let request_id = nonce - 1;
        ids.push(request_id);
        let request = Request {
            request_id,
            agent_id: account(AGENT),
            vendor: account(VENDOR),
            amount: 10,
            nonce,
            memo: "legacy".to_string(),
            status: RequestStatus::Pending,
            created_at: NOW / 1_000_000_000,
            receipt_id: None,
            flags: Vec::new(),
        };
        contract.requests.insert(&request_id, &request);
    }
    contract.next_request_id = 101;
    contract.agent_requests.insert(&account(AGENT), &ids);
    let mut policy = contract.policy(&account(AGENT));
    policy.request_count = 101;
    contract.policies.insert(&account(AGENT), &policy);
    near_sdk::env::storage_remove(SCHEMA_KEY.as_bytes());
    near_sdk::env::storage_remove(format!("{}{}", NONCE_PREFIX, account(AGENT)).as_bytes());

    call_as(account(OWNER));
    contract.migrate();
    let progress = contract.migration_progress_sidecar().unwrap();
    assert_eq!(progress.stage, MIGRATION_STAGE_REQUESTS);
    assert_eq!(progress.cursor, MIGRATION_BATCH_SIZE);
    assert!(contract.schema_marker_sidecar().is_none());

    // The second call finishes the request phase, reads the receipts and
    // checks the figures, so the completion marker is written.
    contract.migrate();
    assert_eq!(
        contract.schema_marker_sidecar().unwrap().version,
        SCHEMA_VERSION
    );
    assert_eq!(
        contract
            .nonce_state_sidecar(&account(AGENT))
            .unwrap()
            .accepted_nonce,
        101
    );
    assert_eq!(contract.get_request_ids(account(AGENT)).len(), 101);

    // The completion marker makes another call a no-op.
    contract.migrate();
    assert_eq!(
        contract.schema_marker_sidecar().unwrap().version,
        SCHEMA_VERSION
    );
}

/// An owner-only migration rejects a runner and an unsupported legacy marker.
#[test]
fn the_migration_is_owner_only_and_rejects_an_unknown_schema() {
    let mut contract = setup();
    near_sdk::env::storage_remove(SCHEMA_KEY.as_bytes());
    call_as(account(OWNER));
    contract.set_runner(account("runner.testnet"));

    call_as(account("runner.testnet"));
    assert!(panics(|| contract.migrate()));

    near_sdk::env::storage_write(LEGACY_SCHEMA_MARKER_KEY, &[99]);
    call_as(account(OWNER));
    assert!(panics(|| contract.migrate()));
}

/// A historical transfer that was still in flight needs the owner to name the
/// period its money belongs to. The historical layout kept one flat figure
/// and no reservation period, so the migration does not guess.
#[test]
fn a_historical_transfer_waits_for_the_owner_to_name_its_period() {
    let mut contract = setup();
    let request_id = seed_legacy_request(&mut contract, 1);
    let mut request = contract.get_request(request_id);
    request.status = RequestStatus::ApprovedPending;
    contract.requests.insert(&request_id, &request);
    let mut policy = contract.policy(&account(AGENT));
    // The historical figure counted the reservation when it was approved.
    policy.spent = 100;
    contract.policies.insert(&account(AGENT), &policy);
    let period = policy.period_start;

    call_as(account(OWNER));
    contract.migrate();

    // The migration does not finish while the money of the transfer is in a
    // period nobody has named.
    assert!(contract.schema_marker_sidecar().is_none());
    assert_eq!(contract.get_migration_status().unresolved, 1);
    let pending = contract.get_legacy_reconciliation(10);
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].request_id, request_id);
    assert_eq!(pending[0].reservation_period_start, 0);

    // The owner names the period, and the migration finishes.
    call_as(account(OWNER));
    let outcome = contract.reconcile_legacy_transfer(request_id, period);
    assert_eq!(outcome.reservation_period_start, period);
    contract.migrate();
    assert_eq!(
        contract.schema_marker_sidecar().unwrap().version,
        SCHEMA_VERSION
    );

    let totals = contract
        .period_totals_sidecar(&account(AGENT), period)
        .unwrap();
    assert_eq!(totals.settled, 0);
    assert_eq!(totals.reserved, 100);
    assert_eq!(totals.used(), 100);
    assert_eq!(contract.get_migration_status().unresolved, 0);
}

/// The transfer that settles after the owner named the period moves the money
/// from reserved to settled in that period.
#[test]
fn a_reconciled_historical_transfer_settles_in_the_named_period() {
    let mut contract = setup();
    let request_id = seed_legacy_request(&mut contract, 1);
    let mut request = contract.get_request(request_id);
    request.status = RequestStatus::ApprovedPending;
    contract.requests.insert(&request_id, &request);
    let mut policy = contract.policy(&account(AGENT));
    policy.spent = 100;
    contract.policies.insert(&account(AGENT), &policy);
    let period = policy.period_start;

    call_as(account(OWNER));
    contract.migrate();
    call_as(account(OWNER));
    contract.reconcile_legacy_transfer(request_id, period);
    contract.migrate();

    contract.on_transfer(request_id, Ok(()));
    let receipt = contract.get_receipt(0);
    assert_eq!(receipt.outcome, Outcome::Approved);
    assert_eq!(receipt.period_start, period);

    let totals = contract
        .period_totals_sidecar(&account(AGENT), period)
        .unwrap();
    assert_eq!(totals.settled, 100);
    assert_eq!(totals.reserved, 0);
}

/// A failure in an older rate window does not refund a newer window's slot.
#[test]
fn an_old_rate_window_failure_does_not_refund_a_new_window() {
    let mut contract = setup();
    let first = ask(&mut contract, 100, 1, "old window");
    approve(&mut contract, first);

    let later = NOW + 61 * 1_000_000_000;
    let second = ask_at(&mut contract, 100, 2, "new window", later);
    call_as_at(account(OWNER), later);
    assert!(contract.approve_request(second).approved);
    assert_eq!(contract.get_policy(account(AGENT)).rate_count, 1);

    call_as_at(account(OWNER), later + 1_000_000_000);
    contract.on_transfer(first, Err(PromiseError::Failed));
    assert_eq!(
        contract.get_policy(account(AGENT)).rate_count,
        1,
        "the old failure must not take the new window's slot"
    );
}

/// A failed reservation is not reported as settled money.
#[test]
fn a_failed_reservation_is_reported_separately_from_settled_money() {
    let mut contract = setup();
    let first = ask(&mut contract, 100, 1, "fails");
    let second = ask(&mut contract, 200, 2, "still reserved");
    approve(&mut contract, first);
    approve(&mut contract, second);

    contract.on_transfer(first, Err(PromiseError::Failed));
    let receipt = contract.get_receipt(0);
    assert_eq!(receipt.outcome, Outcome::Failed);
    assert_eq!(receipt.spent_after, 0);
    assert!(
        receipt
            .evidence
            .iter()
            .any(|item| item.contains("reserved total 200")),
        "the receipt must report the other reservation separately: {:?}",
        receipt.evidence
    );
    assert_eq!(contract.get_policy(account(AGENT)).spent, 200);
}

/// A successful transfer still settles when the policy has disappeared.
#[test]
fn a_successful_settlement_survives_a_missing_policy() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "policy disappears");
    approve(&mut contract, request_id);
    contract.policies.remove(&account(AGENT));

    contract.on_transfer(request_id, Ok(()));
    let receipt = contract.get_receipt(0);
    assert_eq!(receipt.outcome, Outcome::Approved);
    assert_eq!(receipt.reason, "PolicyMissing");
    assert!(receipt
        .evidence
        .iter()
        .any(|item| item.contains("policy was missing")));
    assert_eq!(
        contract.get_request(request_id).status,
        RequestStatus::Approved
    );
}

/// A failed transfer also survives a missing policy without claiming a spend.
#[test]
fn a_failed_settlement_survives_a_missing_policy() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "policy disappears");
    approve(&mut contract, request_id);
    let period = contract.policy(&account(AGENT)).period_start;
    contract.policies.remove(&account(AGENT));

    contract.on_transfer(request_id, Err(PromiseError::Failed));
    let receipt = contract.get_receipt(0);
    assert_eq!(receipt.outcome, Outcome::Failed);
    assert_eq!(receipt.reason, "PolicyMissing");
    assert_eq!(receipt.spent_after, 0);
    assert!(receipt
        .evidence
        .iter()
        .any(|item| item.contains("policy was missing")));

    // The reservation is given back, even though the policy is gone.
    let totals = contract
        .period_totals_sidecar(&account(AGENT), period)
        .unwrap();
    assert_eq!(totals.reserved, 0, "the reservation was released");
    assert_eq!(totals.settled, 0);
}

/// The exact expiry instant is already expired.
#[test]
fn a_request_expires_at_the_exact_expiry_instant() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "exact expiry");
    let expiry = NOW + REQUEST_TTL_SECONDS * 1_000_000_000;

    call_as_at(account(OWNER), expiry);
    let outcome = contract.approve_request(request_id);
    assert_eq!(outcome.reason, "RequestExpired");
    assert_eq!(
        contract.get_request(request_id).status,
        RequestStatus::Expired
    );
}

/// The approved nonce watermark is separate and monotonic.
#[test]
fn approvals_use_a_separate_monotonic_nonce_watermark() {
    let mut contract = setup();
    let first = ask(&mut contract, 100, 2, "nonce two");
    let second = ask(&mut contract, 100, 3, "nonce three");

    assert!(approve(&mut contract, second).approved);
    let refused = approve(&mut contract, first);
    assert_eq!(refused.reason, "NonceReplay");
    assert_eq!(
        contract.get_request(second).status,
        RequestStatus::ApprovedPending
    );
    assert_eq!(contract.get_request(first).status, RequestStatus::Denied);
    let nonce = contract.nonce_state_sidecar(&account(AGENT)).unwrap();
    assert_eq!(nonce.accepted_nonce, 3);
    assert_eq!(nonce.approved_nonce, 3);
}

/// A denial after a rollover persists the canonical period.
#[test]
fn a_denial_after_a_rollover_persists_the_current_period() {
    let mut contract = setup();
    call_as(account(OWNER));
    contract.set_kill_switch(true);
    let later = NOW + 3_600 * 1_000_000_000;

    call_as_at(account(AGENT), later);
    let outcome = contract.request_spend(
        account(AGENT),
        account(VENDOR),
        100,
        1,
        "denied after rollover".to_string(),
    );
    assert_eq!(outcome.reason, "KillSwitch");
    assert_eq!(
        contract.get_policy(account(AGENT)).period_start,
        later / 1_000_000_000
    );
}

/// The per-agent request index keeps only its newest 256 ids.
#[test]
fn the_request_index_is_bounded_to_256_ids() {
    let mut contract = setup();
    contract.next_request_id = 300;
    contract
        .agent_requests
        .insert(&account(AGENT), &(0u64..300u64).collect::<Vec<u64>>());

    call_as(account(AGENT));
    let outcome = contract.request_spend(
        account(AGENT),
        account(VENDOR),
        100,
        1,
        "newest".to_string(),
    );
    let ids = contract.get_request_ids(account(AGENT));
    assert_eq!(ids.len(), REQUEST_INDEX_CAPACITY);
    assert_eq!(ids.first(), Some(&45));
    assert_eq!(ids.last(), Some(&outcome.request_id));
}

/// A malformed sidecar fails loudly instead of being treated as a default.
#[test]
fn a_malformed_nonce_sidecar_is_refused() {
    let mut contract = setup();
    near_sdk::env::storage_write(
        format!("{}{}", NONCE_PREFIX, account(AGENT)).as_bytes(),
        &[1],
    );

    call_as(account(AGENT));
    assert!(panics(|| {
        let _ = contract.request_spend(
            account(AGENT),
            account(VENDOR),
            100,
            1,
            "malformed sidecar".to_string(),
        );
    }));
}

/// Migration enforces the receipt retention limit while it builds the index.
#[test]
fn the_legacy_migration_enforces_the_receipt_retention_limit() {
    let mut contract = setup();
    let created_at = NOW / 1_000_000_000;
    for receipt_id in 0..=RECEIPT_RETENTION_LIMIT {
        let receipt = Receipt {
            receipt_id,
            request_id: NO_REQUEST,
            agent_id: account(AGENT),
            vendor: account(VENDOR),
            amount: 1,
            nonce: receipt_id + 1,
            memo: "legacy receipt".to_string(),
            outcome: Outcome::Denied,
            reason: "LegacyDecision".to_string(),
            rule: "historical decision".to_string(),
            evidence: Vec::new(),
            period_start: created_at,
            spent_after: 0,
            remaining_after: BUDGET,
            created_at,
        };
        contract.receipts.insert(&receipt_id, &receipt);
    }
    contract.next_receipt_id = RECEIPT_RETENTION_LIMIT + 1;
    near_sdk::env::storage_remove(SCHEMA_KEY.as_bytes());

    call_as(account(OWNER));
    contract.migrate();
    let mut calls = 1;
    while contract.schema_marker_sidecar().is_none() && calls < 110 {
        // Each migration call is a separate transaction with its own gas.
        call_as_at(account(OWNER), NOW);
        contract.migrate();
        calls += 1;
    }

    assert_eq!(contract.get_receipt_count(), RECEIPT_RETENTION_LIMIT);
    assert_eq!(
        contract.get_agent_receipt_count(account(AGENT)),
        RECEIPT_RETENTION_LIMIT
    );
    assert!(contract.get_receipt_safe(0).is_none());
    assert!(contract.get_receipt_safe(RECEIPT_RETENTION_LIMIT).is_some());
    let newest = contract.get_receipts(0, 1);
    assert_eq!(newest[0].receipt_id, RECEIPT_RETENTION_LIMIT);
}

/// A transfer that was in flight when the upgrade landed still settles.
///
/// The callback must not wait for the migration, because a callback that
/// fails is not retried by the chain. The money settles, the receipt is
/// written, and the amount is counted once.
#[test]
fn a_transfer_that_was_in_flight_when_the_upgrade_landed_still_settles() {
    let mut contract = setup();
    let period = contract.policy(&account(AGENT)).period_start;
    let request_id = seed_legacy_request_with(
        &mut contract,
        1,
        100,
        RequestStatus::ApprovedPending,
        period,
    );
    let mut policy = contract.policy(&account(AGENT));
    // The historical figure counted the reservation when it was approved.
    policy.spent = 100;
    contract.policies.insert(&account(AGENT), &policy);

    // The callback arrives while the state is still the historical one.
    contract.on_transfer(request_id, Ok(()));

    assert_eq!(
        contract.get_request(request_id).status,
        RequestStatus::Approved,
        "the transfer settled"
    );
    let receipt = contract.get_receipt(0);
    assert_eq!(receipt.outcome, Outcome::Approved);
    assert!(receipt
        .evidence
        .iter()
        .any(|item| item.contains("the owner confirms the period")));

    // The migration reads the same receipt and must not count it twice.
    call_as(account(OWNER));
    contract.migrate();
    assert_eq!(
        contract.schema_marker_sidecar().unwrap().version,
        SCHEMA_VERSION
    );

    let totals = contract
        .period_totals_sidecar(&account(AGENT), period)
        .unwrap();
    assert_eq!(totals.settled, 100, "the amount is counted once");
    assert_eq!(totals.reserved, 0);
    assert_eq!(totals.used(), 100);
}

/// The settled money of a historical decision is placed once, not once per
/// migration call.
#[test]
fn the_migration_counts_the_settled_money_of_a_historical_decision_once() {
    let mut contract = setup();
    let period = contract.policy(&account(AGENT)).period_start;
    seed_legacy_settled_request(&mut contract, 1, 100, period);
    let mut policy = contract.policy(&account(AGENT));
    policy.spent = 100;
    policy.period_start = period;
    contract.policies.insert(&account(AGENT), &policy);

    call_as(account(OWNER));
    contract.migrate();
    assert_eq!(
        contract.schema_marker_sidecar().unwrap().version,
        SCHEMA_VERSION
    );

    let totals = contract
        .period_totals_sidecar(&account(AGENT), period)
        .unwrap();
    assert_eq!(totals.settled, 100);
    assert_eq!(totals.reserved, 0);

    // Another migration call changes nothing.
    contract.migrate();
    let totals = contract
        .period_totals_sidecar(&account(AGENT), period)
        .unwrap();
    assert_eq!(totals.settled, 100, "the amount is still counted once");
}

/// A request that passed its expiry time is not open any more.
#[test]
fn an_expired_request_is_not_open_any_more() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "will expire");
    assert_eq!(contract.get_open_requests(account(AGENT)).len(), 1);

    let after = NOW + REQUEST_TTL_SECONDS * 1_000_000_000;
    call_as_at(account(AGENT), after);
    let open = contract.get_open_requests(account(AGENT));
    assert!(open.is_empty(), "an expired request is not open");
    assert_eq!(
        contract.get_request_view(request_id).status,
        RequestStatus::Expired
    );
}

/// A request whose agent has no policy can still be closed.
#[test]
fn a_request_without_a_policy_can_be_rejected_and_expired() {
    let mut contract = setup();
    let rejected = ask(&mut contract, 100, 1, "no policy");
    let expired = ask(&mut contract, 200, 2, "no policy");
    contract.policies.remove(&account(AGENT));

    call_as(account(OWNER));
    let outcome = contract.reject_request(rejected, "not wanted".to_string());
    assert_eq!(outcome.reason, "PolicyMissing");
    assert_eq!(contract.get_request(rejected).status, RequestStatus::Denied);

    call_as(account(OWNER));
    let outcome = contract.expire_request(expired, "too old".to_string());
    assert_eq!(outcome.reason, "PolicyMissing");
    assert_eq!(contract.get_request(expired).status, RequestStatus::Expired);

    assert_eq!(contract.get_receipt_count(), 2);
    assert_eq!(contract.get_receipt(0).reason, "PolicyMissing");
    assert_eq!(contract.get_receipt(1).reason, "PolicyMissing");
}

/// The agent may not approve its own spend, not even when the agent is also
/// the owner.
#[test]
fn the_owner_cannot_approve_a_request_of_its_own_agent_account() {
    let mut contract = setup();
    call_as(account(OWNER));
    contract.register_agent(
        account(OWNER),
        BUDGET,
        3600,
        vec![account(VENDOR)],
        MAX_SINGLE_SPEND,
        RATE_LIMIT,
    );

    // The owner asks for a spend as its own agent.
    call_as(account(OWNER));
    let outcome = contract.request_spend(
        account(OWNER),
        account(VENDOR),
        100,
        1,
        "the owner is also the agent".to_string(),
    );
    let request_id = outcome.request_id;

    // The owner may not approve it.
    call_as(account(OWNER));
    assert!(panics(|| {
        let _ = contract.approve_request(request_id);
    }));
    assert_eq!(
        contract.get_request(request_id).status,
        RequestStatus::Pending
    );
}

/// The runner may not approve a request of the agent it runs for.
#[test]
fn the_runner_cannot_approve_a_request_of_its_own_agent_account() {
    let mut contract = setup();
    call_as(account(OWNER));
    contract.set_runner(account(AGENT));

    let request_id = ask(&mut contract, 100, 1, "the runner is the agent");

    call_as(account(AGENT));
    assert!(panics(|| {
        let _ = contract.approve_request(request_id);
    }));
    assert_eq!(
        contract.get_request(request_id).status,
        RequestStatus::Pending
    );
}

/// The migration finishes on the shape of the contract that is live now.
///
/// The live state holds requests from several budget periods, a request that
/// was written with a nanosecond timestamp and a policy whose spend figure
/// belongs to the period it rolled into.
#[test]
fn the_migration_finishes_on_the_shape_of_the_live_contract() {
    let mut contract = setup();
    let period = contract.policy(&account(AGENT)).period_start;

    // A settled decision from an older period.
    seed_legacy_settled_request(&mut contract, 1, 50, period - 7200);
    // A settled decision in the period the policy is in.
    seed_legacy_settled_request(&mut contract, 2, 100, period);
    // A request that was written with a nanosecond timestamp.
    let nanoseconds = seed_legacy_request_with(
        &mut contract,
        3,
        100,
        RequestStatus::Pending,
        NOW.saturating_mul(1_000_000_000),
    );
    // A request that is still waiting for a decision.
    let waiting = seed_legacy_request_with(
        &mut contract,
        4,
        100,
        RequestStatus::Pending,
        NOW / 1_000_000_000,
    );

    // The historical layout kept one flat figure for the current period.
    let mut policy = contract.policy(&account(AGENT));
    policy.spent = 100;
    policy.period_start = period;
    contract.policies.insert(&account(AGENT), &policy);

    call_as(account(OWNER));
    contract.migrate();

    assert_eq!(
        contract.schema_marker_sidecar().unwrap().version,
        SCHEMA_VERSION,
        "the migration finished"
    );
    assert_eq!(contract.get_migration_status().unresolved, 0);

    // The settled money of the older period is in that period.
    let older = contract
        .period_totals_sidecar(&account(AGENT), period - 7200)
        .unwrap();
    assert_eq!(older.settled, 50);
    assert_eq!(older.reserved, 0);

    // The settled money of the current period is in that period.
    let current = contract
        .period_totals_sidecar(&account(AGENT), period)
        .unwrap();
    assert_eq!(current.settled, 100);
    assert_eq!(current.reserved, 0);

    // The request with the nanosecond timestamp got a real expiry.
    let view = contract.get_request_view(nanoseconds);
    assert!(view.expires_at.is_some());
    assert!(view.expires_at.unwrap() < u64::MAX);

    // The waiting request is still open and still decidable.
    let open = contract.get_open_requests(account(AGENT));
    assert!(open.iter().any(|view| view.request_id == waiting));
    call_as(account(OWNER));
    assert!(contract.approve_request(waiting).approved);
}

/// A historical request that the owner approves after the migration settles
/// once.
///
/// The approval reserves the amount in the period sidecar, and the settlement
/// releases it there. The historical flat figure is not touched, because it
/// was never part of the new accounting.
#[test]
fn a_historical_request_approved_after_the_migration_settles_once() {
    let mut contract = setup();
    let request_id = seed_legacy_request_with(
        &mut contract,
        1,
        100,
        RequestStatus::Pending,
        NOW / 1_000_000_000,
    );

    call_as(account(OWNER));
    contract.migrate();
    assert_eq!(
        contract.schema_marker_sidecar().unwrap().version,
        SCHEMA_VERSION
    );

    // The owner approves the historical request.
    call_as(account(OWNER));
    assert!(contract.approve_request(request_id).approved);
    let period = contract.policy(&account(AGENT)).period_start;
    let reserved = contract
        .period_totals_sidecar(&account(AGENT), period)
        .unwrap();
    assert_eq!(reserved.reserved, 100, "the amount is reserved");

    // The transfer settles.
    contract.on_transfer(request_id, Ok(()));
    let totals = contract
        .period_totals_sidecar(&account(AGENT), period)
        .unwrap();
    assert_eq!(totals.settled, 100, "the amount is settled money");
    assert_eq!(totals.reserved, 0, "the reservation is released");
    assert_eq!(totals.used(), 100, "the amount is counted once");

    let receipt = contract.get_receipt(0);
    assert_eq!(receipt.outcome, Outcome::Approved);
    assert_eq!(receipt.spent_after, 100);
}

/// The stored enum discriminants and the sidecar byte layouts are fixed.
#[test]
fn the_frozen_discriminants_and_sidecar_layouts_are_stable() {
    assert_eq!(borsh::to_vec(&Outcome::Approved).unwrap(), vec![0]);
    assert_eq!(borsh::to_vec(&Outcome::Denied).unwrap(), vec![1]);
    assert_eq!(borsh::to_vec(&Outcome::Failed).unwrap(), vec![2]);
    assert_eq!(borsh::to_vec(&Outcome::Expired).unwrap(), vec![3]);
    assert_eq!(borsh::to_vec(&RequestStatus::Pending).unwrap(), vec![0]);
    assert_eq!(
        borsh::to_vec(&RequestStatus::NeedsApproval).unwrap(),
        vec![1]
    );
    assert_eq!(borsh::to_vec(&RequestStatus::Approved).unwrap(), vec![2]);
    assert_eq!(borsh::to_vec(&RequestStatus::Denied).unwrap(), vec![3]);
    assert_eq!(
        borsh::to_vec(&RequestStatus::ApprovedPending).unwrap(),
        vec![4]
    );
    assert_eq!(
        borsh::to_vec(&RequestStatus::SettlementFailed).unwrap(),
        vec![5]
    );
    assert_eq!(borsh::to_vec(&RequestStatus::Expired).unwrap(), vec![6]);

    assert_eq!(
        encode_sidecar(&PeriodTotals {
            settled: 1,
            reserved: 2,
        }),
        vec![
            1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0
        ]
    );
    assert_eq!(
        encode_sidecar(&NonceState {
            accepted_nonce: 1,
            approved_nonce: 2,
        }),
        vec![1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]
    );
    assert_eq!(
        encode_sidecar(&SchemaMarker {
            version: SCHEMA_VERSION,
        }),
        vec![SCHEMA_VERSION]
    );

    // The version-3 request metadata: the expiry, the reservation period,
    // the rate window and the legacy flag.
    assert_eq!(
        encode_sidecar(&RequestMeta {
            expires_at: 1,
            reserved_period_start: 2,
            approval_rate_window_start: 3,
            legacy: true,
        }),
        vec![1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 1]
    );

    // The version-2 migration progress: the stage, the cursor, the two ends
    // and the number of records that still need the owner.
    assert_eq!(
        encode_sidecar(&MigrationProgress {
            stage: MIGRATION_STAGE_REQUESTS,
            cursor: 1,
            request_end: 2,
            receipt_end: 3,
            unresolved: 4,
        }),
        vec![
            0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0,
            0, 0, 0, 0,
        ]
    );

    // The historical record: the amount, the period and the flag.
    assert_eq!(
        encode_sidecar(&LegacyReservation {
            amount: 1,
            reservation_period_start: 2,
            moved: true,
        }),
        vec![1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 1]
    );
}
