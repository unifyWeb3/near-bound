/// A stand in for a paid API.
///
/// This contract is the counterparty in the demo. An agent calls
/// `call_paid_api`, attaches the fee, and the fee moves to the vendor. The
/// contract records what it was paid for, so the demo can show the money
/// arrived and what it was for.
///
/// It is deliberately small. The point of the demo is who is allowed to move
/// money, not what the money buys.

use near_sdk::{near, require, AccountId, NearToken};
use near_sdk::collections::LookupMap;

#[near(contract_state)]
pub struct Vendor {
    /// Who is allowed to buy from this vendor.
    customers: LookupMap<AccountId, u128>,
    /// The price of one lookup.
    fee: u128,
    /// The number of calls served.
    calls: u64,
    /// The total taken.
    taken: u128,
}

impl Default for Vendor {
    fn default() -> Self {
        Self {
            customers: LookupMap::new(b"customers".to_vec()),
            fee: 0,
            calls: 0,
            taken: 0,
        }
    }
}

#[near]
impl Vendor {
    /// Create the vendor. The caller becomes the owner.
    #[init]
    pub fn new(fee: u128) -> Self {
        require!(fee > 0, "the fee must be more than zero");
        Self {
            customers: LookupMap::new(b"customers".to_vec()),
            fee,
            calls: 0,
            taken: 0,
        }
    }

    /// Buy one lookup. The price is the attached deposit.
    ///
    /// Any deposit above the price is returned, so the caller cannot overpay
    /// by accident.
    #[payable]
    pub fn call_paid_api(&mut self, memo: String) {
        let payer = near_sdk::env::predecessor_account_id();
        let attached = near_sdk::env::attached_deposit();
        require!(
            attached.as_yoctonear() >= self.fee,
            "the attached deposit is below the price"
        );

        let already = self.customers.get(&payer).unwrap_or(0);
        let total = already + attached.as_yoctonear();
        self.customers.insert(&payer, &total);
        self.calls += 1;
        self.taken += attached.as_yoctonear();

        near_sdk::env::log_str(&format!("VendorCall {} {}", payer, memo));

        let refund = attached.as_yoctonear() - self.fee;
        if refund > 0 {
            let _ = near_sdk::Promise::new(payer).transfer(NearToken::from_yoctonear(refund));
        }
    }

    /// The price of one lookup.
    pub fn get_fee(&self) -> u128 {
        self.fee
    }

    /// The number of calls served.
    pub fn get_calls(&self) -> u64 {
        self.calls
    }

    /// The total taken.
    pub fn get_taken(&self) -> u128 {
        self.taken
    }

    /// What one customer has paid in total.
    pub fn get_customer_total(&self, customer: AccountId) -> u128 {
        self.customers.get(&customer).unwrap_or(0)
    }
}
