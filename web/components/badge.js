/**
 * The small coloured labels: an outcome on a receipt, a state on a request.
 */

import { el } from '../lib/dom.js';

const OUTCOMES = {
  Approved: 'approved',
  Denied: 'denied',
  Failed: 'failed',
};

const STATES = {
  Pending: 'pending',
  NeedsApproval: 'flagged',
  ApprovedPending: 'settling',
  Approved: 'approved',
  SettlementFailed: 'failed',
  Denied: 'denied',
};

/**
 * The label of a receipt outcome.
 *
 * @param {string} outcome
 */
export function outcomeLabel(outcome) {
  return OUTCOMES[outcome] ?? 'pending';
}

/**
 * The label of a request state.
 *
 * @param {string} status
 */
export function stateLabel(status) {
  return STATES[status] ?? 'pending';
}

/**
 * The words that go with a request state.
 *
 * @param {string} status
 */
export function stateWords(status) {
  switch (status) {
    case 'Pending':
      return 'Waiting for the owner';
    case 'NeedsApproval':
      return 'Flagged, the owner decides';
    case 'ApprovedPending':
      return 'Approved, the transfer is settling';
    case 'Approved':
      return 'Paid out';
    case 'SettlementFailed':
      return 'The transfer failed';
    case 'Denied':
      return 'Refused by the policy';
    default:
      return status;
  }
}

/**
 * A badge.
 *
 * @param {string} text
 * @param {string} tone One of the outcome or state tones.
 */
export function badge(text, tone) {
  return el('span', `pill ${tone}`, text);
}
