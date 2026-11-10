use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, MockedBlockchain, NearToken};

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

/// F-01. A request made before the freeze is refused at approval after it.
#[test]
fn a_request_made_before_the_freeze_is_refused_after_the_freeze() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "asked before the freeze");

    // The owner freezes every agent.
    call_as(account(OWNER));
    contract.set_kill_switch(true);

    // The approval must not go through.
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        contract.approve_request(request_id)
    }))
    .is_err();
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

/// F-03. An agent that already has a policy cannot be registered again.
#[test]
fn registering_an_agent_twice_is_refused() {
    let mut contract = setup();
    call_as(account(OWNER));
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        contract.register_agent(
            account(AGENT),
            BUDGET,
            3600,
            vec![account(VENDOR)],
            MAX_SINGLE_SPEND,
            RATE_LIMIT,
        )
    }))
    .is_err();
    assert!(refused, "a live agent must not be registered again");
}

/// F-03. Changing the limits keeps the counters of the agent.
#[test]
fn changing_the_limits_keeps_the_counters() {
    let mut contract = setup();
    let request_id = ask(&mut contract, 100, 1, "counts");
    call_as(account(OWNER));
    contract.approve_request(request_id);
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
