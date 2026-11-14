/**
 * Which contract method a write may use, and whether the connected account
 * may use it at all.
 *
 * The owner and the runner are read from chain views, never assumed. A pending
 * request may be approved or rejected by the owner or the runner. A flagged
 * (NeedsApproval) request may only be approved or rejected by the owner, with
 * the owner-only methods `owner_approve_request` and `owner_reject_request`.
 * The agent cannot approve or reject its own request.
 */

const PENDING_METHODS = new Set(['approve_request', 'reject_request']);
const OWNER_ONLY_METHODS = new Set(['owner_approve_request', 'owner_reject_request']);

/**
 * @param {'approve'|'reject'} action
 * @param {string|null} status
 * @param {string} caller
 * @param {string|null} owner
 * @param {string|null} runner
 * @param {string} agent
 * @returns {string|null} The contract method to call, or null when not allowed.
 */
export function chooseWriteMethod(action, status, caller, owner, runner, agent) {
  if (!status || !caller || !owner || !runner) return null;
  if (caller === agent) return null; // The agent must not approve its own request.

  const isOwner = caller === owner;
  const isRunner = caller === runner;

  if (status === 'Pending') {
    if (isOwner || isRunner) return action === 'approve' ? 'approve_request' : 'reject_request';
    return null;
  }

  if (status === 'NeedsApproval') {
    if (isOwner) return action === 'approve' ? 'owner_approve_request' : 'owner_reject_request';
    return null;
  }

  return null;
}

/**
 * Whether an acting control may be offered for one request right now.
 *
 * @param {string|null} status
 * @param {string} caller
 * @param {string|null} owner
 * @param {string|null} runner
 * @param {string} agent
 * @returns {{ approve: boolean, reject: boolean }}
 */
export function isActAllowed(status, caller, owner, runner, agent) {
  return {
    approve: Boolean(chooseWriteMethod('approve', status, caller, owner, runner, agent)),
    reject: Boolean(chooseWriteMethod('reject', status, caller, owner, runner, agent)),
  };
}
