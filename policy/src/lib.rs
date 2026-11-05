//! The policy rules, as a pure function.
//!
//! This is the same rule set the paper harness implements in JavaScript, and
//! the two are tested against the same cases. The order of the checks is part
//! of the design. A dangerous receiver is refused before the budget is looked
//! at, so a bad receiver is refused even when money is left.
//!
//! Nothing in this crate touches the chain, so it can be tested on its own.

use borsh::{BorshDeserialize, BorshSerialize};

/// The outcome of checking one request against one policy.
#[derive(Clone, PartialEq, Eq)]
pub struct Evaluation {
    /// Whether the request may go ahead.
    pub allowed: bool,
    /// The machine readable reason, for example `BudgetExceeded`.
    pub reason: String,
    /// The rule in plain words.
    pub rule: String,
    /// The facts behind the decision.
    pub evidence: Vec<String>,
    /// The period the decision applies to, after any rollover.
    pub period_start: u64,
    /// How much has been spent in that period. For an allowed request this
    /// includes the request amount. For a denial it is the spend before the
    /// decision, so a rejected spend never consumes budget.
    pub spent: u128,
    /// How much is left in that period. Uses the same rule as `spent`.
    pub remaining: u128,
}

impl Evaluation {
    fn deny(
        reason: &str,
        rule: &str,
        evidence: Vec<String>,
        period_start: u64,
        spent: u128,
        remaining: u128,
    ) -> Self {
        Self {
            allowed: false,
            reason: reason.to_string(),
            rule: rule.to_string(),
            evidence,
            period_start,
            spent,
            remaining,
        }
    }
}

/// The policy that governs one agent.
#[derive(BorshSerialize, BorshDeserialize, Clone, PartialEq, Eq)]
pub struct Policy {
    /// The account that may ask for a spend. It holds no funds.
    pub agent_id: String,
    /// The most the agent may spend in one period.
    pub budget: u128,
    /// How long one budget period lasts, in seconds.
    pub period_seconds: u64,
    /// When the current period started, in seconds since the epoch.
    ///
    /// The unit is seconds, and the caller must convert. The chain reports
    /// the block timestamp in nanoseconds, and a nanosecond value here makes
    /// every period look finished, which resets the budget on every call.
    pub period_start: u64,
    /// How much has been spent in the current period.
    pub spent: u128,
    /// The only receivers this agent may pay. An empty list means any receiver.
    pub vendors: Vec<String>,
    /// The most the agent may spend in one payment.
    pub max_single_spend: u128,
    /// How many payments are allowed in one minute.
    pub rate_limit: u64,
    /// When the current rate window started, in seconds since the epoch.
    pub rate_window_start: u64,
    /// How many payments happened in the current rate window.
    pub rate_count: u64,
    /// The highest nonce this agent has used. A nonce must be higher.
    pub last_nonce: u64,
    /// Whether the owner has locked this agent out.
    pub revoked: bool,
    /// How many requests this agent has made.
    pub request_count: u64,
}

/// Roll the budget period over when the previous one has ended.
///
/// The times are in seconds since the epoch. See `Policy::period_start`.
pub fn roll_period(policy: &Policy, now: u64) -> (u64, u128) {
    if policy.period_seconds == 0 {
        return (now, 0);
    }
    if now.saturating_sub(policy.period_start) >= policy.period_seconds {
        (now, 0)
    } else {
        (policy.period_start, policy.spent)
    }
}

/// Count the payments in the current rate window.
///
/// The times are in seconds since the epoch. See `Policy::rate_window_start`.
pub fn rate_window(policy: &Policy, now: u64) -> (u64, u64) {
    if now.saturating_sub(policy.rate_window_start) >= 60 {
        (now, 0)
    } else {
        (policy.rate_window_start, policy.rate_count)
    }
}

/// Check one spend request against one policy.
///
/// `now` is the current time in seconds since the epoch, the same unit as
/// `Policy::period_start` and `Policy::rate_window_start`.
///
/// `blocked` is the owner's blocklist decision, which the contract holds on
/// chain. The richer counterparty signals live off chain and reach the
/// contract as a flag on the request.
pub fn evaluate(
    policy: &Policy,
    vendor: &str,
    amount: u128,
    nonce: u64,
    now: u64,
    blocked: bool,
) -> Evaluation {
    let (period_start, spent) = roll_period(policy, now);
    let remaining = policy.budget.saturating_sub(spent);

    if policy.revoked {
        return Evaluation::deny(
            "AgentRevoked",
            "the owner revoked this agent",
            vec![format!("agent {}", policy.agent_id)],
            period_start,
            spent,
            remaining,
        );
    }

    if amount == 0 {
        return Evaluation::deny(
            "InvalidAmount",
            "the amount must be more than zero",
            vec![],
            period_start,
            spent,
            remaining,
        );
    }

    if nonce <= policy.last_nonce {
        return Evaluation::deny(
            "NonceReplay",
            "the nonce was already used by this agent",
            vec![format!("last nonce {}", policy.last_nonce)],
            period_start,
            spent,
            remaining,
        );
    }

    if blocked {
        return Evaluation::deny(
            "CounterpartyBlocked",
            "the receiver is on the blocklist",
            vec![format!("{} is blocked", vendor)],
            period_start,
            spent,
            remaining,
        );
    }

    if !policy.vendors.is_empty() && !policy.vendors.iter().any(|v| v == vendor) {
        let allowed = policy.vendors.join(", ");
        return Evaluation::deny(
            "VendorNotAllowed",
            "the receiver is not on the vendor allowlist",
            vec![format!("allowed: {}", allowed)],
            period_start,
            spent,
            remaining,
        );
    }

    if amount > policy.max_single_spend {
        return Evaluation::deny(
            "SingleSpendExceeded",
            "the amount is above the single spend limit",
            vec![format!("limit {}", policy.max_single_spend)],
            period_start,
            spent,
            remaining,
        );
    }

    let (_, rate_count) = rate_window(policy, now);
    if rate_count >= policy.rate_limit {
        return Evaluation::deny(
            "RateLimited",
            "too many spends in the last minute",
            vec![format!(
                "{} spends in 60s, limit {}",
                rate_count, policy.rate_limit
            )],
            period_start,
            spent,
            remaining,
        );
    }

    if spent.saturating_add(amount) > policy.budget {
        return Evaluation::deny(
            "BudgetExceeded",
            "the spend would exceed the period budget",
            vec![
                format!("spent {} of {}", spent, policy.budget),
                format!("requested {}", amount),
            ],
            period_start,
            spent,
            remaining,
        );
    }

    let spent = spent + amount;
    Evaluation {
        allowed: true,
        reason: String::new(),
        rule: "every policy check passed".to_string(),
        evidence: Vec::new(),
        period_start,
        spent,
        remaining: policy.budget.saturating_sub(spent),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_700_000_000;

    fn policy(overrides: impl FnOnce(&mut Policy)) -> Policy {
        let mut p = Policy {
            agent_id: "agent.testnet".to_string(),
            budget: 1000,
            period_seconds: 3600,
            period_start: NOW,
            spent: 0,
            vendors: vec!["vendor-a.testnet".to_string(), "vendor-b.testnet".to_string()],
            max_single_spend: 600,
            rate_limit: 3,
            rate_window_start: NOW,
            rate_count: 0,
            last_nonce: 0,
            revoked: false,
            request_count: 0,
        };
        overrides(&mut p);
        p
    }

    #[test]
    fn a_clean_spend_inside_every_limit_is_allowed() {
        let p = policy(|_| {});
        let decision = evaluate(&p, "vendor-a.testnet", 100, 1, NOW, false);
        assert!(decision.allowed);
        assert_eq!(decision.remaining, 900);
    }

    #[test]
    fn a_spend_above_the_remaining_budget_is_denied() {
        let p = policy(|p| p.spent = 950);
        let decision = evaluate(&p, "vendor-a.testnet", 100, 1, NOW, false);
        assert!(!decision.allowed);
        assert_eq!(decision.reason, "BudgetExceeded");
        assert_eq!(decision.remaining, 50);
        assert!(decision.evidence.iter().any(|e| e.contains("950")));
    }

    #[test]
    fn a_spend_that_lands_exactly_on_the_budget_is_allowed() {
        let p = policy(|p| p.spent = 900);
        let decision = evaluate(&p, "vendor-a.testnet", 100, 1, NOW, false);
        assert!(decision.allowed);
    }

    #[test]
    fn a_receiver_outside_the_allowlist_is_denied() {
        let p = policy(|_| {});
        let decision = evaluate(&p, "stranger.testnet", 100, 1, NOW, false);
        assert!(!decision.allowed);
        assert_eq!(decision.reason, "VendorNotAllowed");
    }

    #[test]
    fn an_empty_allowlist_means_no_vendor_restriction() {
        let p = policy(|p| p.vendors = vec![]);
        let decision = evaluate(&p, "anyone.testnet", 100, 1, NOW, false);
        assert!(decision.allowed);
    }

    #[test]
    fn a_spend_above_the_single_spend_limit_is_denied() {
        let p = policy(|_| {});
        let decision = evaluate(&p, "vendor-a.testnet", 601, 1, NOW, false);
        assert!(!decision.allowed);
        assert_eq!(decision.reason, "SingleSpendExceeded");
    }

    #[test]
    fn a_non_positive_amount_is_denied() {
        let p = policy(|_| {});
        let decision = evaluate(&p, "vendor-a.testnet", 0, 1, NOW, false);
        assert!(!decision.allowed);
        assert_eq!(decision.reason, "InvalidAmount");
    }

    #[test]
    fn the_rate_limit_denies_the_spend_that_crosses_the_limit() {
        let p = policy(|p| p.rate_count = 3);
        let decision = evaluate(&p, "vendor-a.testnet", 10, 1, NOW, false);
        assert!(!decision.allowed);
        assert_eq!(decision.reason, "RateLimited");
    }

    #[test]
    fn spends_outside_the_rate_window_are_allowed_again() {
        let p = policy(|p| {
            p.rate_count = 3;
            p.rate_window_start = NOW - 61;
        });
        let decision = evaluate(&p, "vendor-a.testnet", 10, 1, NOW, false);
        assert!(decision.allowed);
    }

    #[test]
    fn a_reused_nonce_is_denied() {
        let p = policy(|p| p.last_nonce = 7);
        let decision = evaluate(&p, "vendor-a.testnet", 10, 7, NOW, false);
        assert!(!decision.allowed);
        assert_eq!(decision.reason, "NonceReplay");
    }

    #[test]
    fn a_revoked_agent_cannot_spend() {
        let p = policy(|p| p.revoked = true);
        let decision = evaluate(&p, "vendor-a.testnet", 10, 1, NOW, false);
        assert!(!decision.allowed);
        assert_eq!(decision.reason, "AgentRevoked");
    }

    #[test]
    fn a_blocked_receiver_is_refused_even_when_the_budget_is_nearly_empty() {
        let p = policy(|p| p.spent = 950);
        let decision = evaluate(&p, "vendor-a.testnet", 100, 1, NOW, true);
        assert!(!decision.allowed);
        assert_eq!(decision.reason, "CounterpartyBlocked");
    }

    #[test]
    fn a_blocked_receiver_is_refused_before_the_allowlist_is_checked() {
        let p = policy(|_| {});
        let decision = evaluate(&p, "stranger.testnet", 100, 1, NOW, true);
        assert_eq!(decision.reason, "CounterpartyBlocked");
    }

    #[test]
    fn an_allowed_decision_reports_the_spend_after_the_payment() {
        let p = policy(|p| p.spent = 200);
        let decision = evaluate(&p, "vendor-a.testnet", 100, 1, NOW, false);
        assert!(decision.allowed);
        assert_eq!(decision.spent, 300);
        assert_eq!(decision.remaining, 700);
    }

    #[test]
    fn a_denied_decision_does_not_consume_budget() {
        let p = policy(|p| p.spent = 950);
        let decision = evaluate(&p, "vendor-a.testnet", 100, 1, NOW, false);
        assert!(!decision.allowed);
        assert_eq!(decision.spent, 950);
        assert_eq!(decision.remaining, 50);
    }

    #[test]
    fn the_budget_period_rolls_over_and_resets_the_spend() {
        let p = policy(|p| p.spent = 900);
        assert_eq!(roll_period(&p, NOW + 3600), (NOW + 3600, 0));
        assert_eq!(roll_period(&p, NOW + 3599), (NOW, 900));
    }

    #[test]
    fn every_denial_has_a_rule_attached() {
        let p = policy(|_| {});
        let cases = [
            evaluate(&p, "vendor-a.testnet", 0, 1, NOW, false),
            evaluate(&p, "vendor-a.testnet", 10, 0, NOW, false),
            evaluate(&p, "vendor-a.testnet", 10, 1, NOW, true),
            evaluate(&p, "stranger.testnet", 10, 1, NOW, false),
            evaluate(&p, "vendor-a.testnet", 601, 1, NOW, false),
        ];
        for decision in cases {
            assert!(!decision.allowed);
            assert!(decision.rule.len() > 10);
            assert!(!decision.reason.is_empty());
        }
    }
}

