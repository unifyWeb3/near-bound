/**
 * The requests that are waiting for the owner.
 *
 * Each card shows the request's status, when it was created, when it expires
 * (or "unknown" for legacy requests that carry no expiry), and the actions
 * the connected account's role actually allows. Actions run through an
 * accessible confirmation dialog, never window.prompt, and never fire from a
 * single unlabeled click.
 */

import { el, mount } from '../lib/dom.js';
import { formatNear } from '../lib/format.js';
import { badge, stateLabel, stateWords } from '../components/badge.js';
import { emptyState } from '../components/empty.js';
import { openConfirm } from '../components/confirm.js';
import { href } from '../lib/router.js';
import { isActAllowed } from '../lib/act.js';

/** A page never waits forever for a request that expired off chain. */
const SECOND = 1;

/**
 * When a request was made, when it expires, and whether it is still open.
 *
 * Legacy requests carry no expiry, so expiry is unknown rather than zero.
 *
 * @param {object} request
 * @param {number} now Seconds since the epoch, approximate local time.
 * @returns {{age: string, ageSeconds: number|null, expires: string, expiresAt: number|null, countdown: string|null, expired: boolean, expiryUnknown: boolean}}
 */
export function requestTiming(request, now = Date.now() / 1000) {
  const created = Number(request.created_at ?? 0);
  const ageSeconds = created > 0 ? Math.max(0, now - created) : null;
  const age = ageSeconds === null ? 'unknown' : `${ageInWords(ageSeconds)} ago`;

  const expiresAt = request.expires_at == null ? null : Number(request.expires_at);
  const expiryUnknown = expiresAt === null;
  let expires = 'unknown';
  let countdown = null;
  let expired = false;
  if (!expiryUnknown) {
    expires = new Date(expiresAt * 1000).toLocaleString();
    const remaining = expiresAt - now;
    expired = remaining <= 0;
    countdown = expired ? 'expired' : remaining > 0 ? ageInWords(remaining) : null;
  }
  return { age, ageSeconds, expires, expiresAt, countdown, expired, expiryUnknown };
}

function ageInWords(seconds) {
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * @param {object} state
 * @param {(requestId: number, action: 'approve'|'reject', reason: string) => void} act
 */
export function renderRequests(state, act) {
  const host = document.getElementById('requests-view');
  if (!host) return;
  const countNode = document.getElementById('requests-count');
  const { items, errors, failedIds, complete, fallback, openCount } = state.requests ?? {};

  const now = Date.now() / 1000;
  const open = (items ?? []).filter(
    (request) => request.status === 'Pending' || request.status === 'NeedsApproval',
  );
  const expired = open.filter((request) => requestTiming(request, now).expired);
  const actionable = open.filter((request) => !requestTiming(request, now).expired);

  if (countNode) {
    const oldest = oldestOpenAge(open, now);
    const availableOpen = openCount ?? open.length;
    // When the queue could not be read in full, the count is what was found,
    // not the number of open requests. It says so.
    const counted = complete ? `${availableOpen} open` : `${availableOpen} open found`;
    countNode.textContent = `${counted}${oldest ? ` · oldest opened ${oldest} ago` : ''}`;
  }

  const nodes = [];

  if ((errors ?? 0) > 0) {
    const failed = (failedIds ?? []).slice(0, 10).map((id) => `request #${id}`).join(', ');
    const note = el('p', 'error-summary');
    note.textContent = `Could not read ${errors} request${errors === 1 ? '' : 's'}${
      failed ? ` (${failed})`
      : ''
    }. Showing what could be read, not a complete queue.`;
    nodes.push(note);
  }

  if (open.length === 0) {
    // A queue that was only partly read cannot claim that nothing is waiting.
    nodes.push(
      emptyState(
        complete
          ? 'No request is waiting for the owner.'
          : 'No open request was found in the part of the queue that could be read. Older requests were not read, so an older open request may still be waiting.',
      ),
    );
  } else {
    const header = el('p', 'muted small');
    const notes = [];
    if (fallback) {
      notes.push(
        'Reading requests one at a time (the deployed contract predates the paged request view).',
      );
    }
    if (!complete) {
      notes.push(
        'The queue was cut off after the most recent requests, so an older open request may not be shown.',
      );
    }
    if (notes.length === 0) {
      notes.push('Every open request of this agent.');
    }
    header.textContent = notes.join(' ');
    nodes.push(header);

    for (const request of [...expired, ...actionable]) {
      nodes.push(requestCard(request, now, act, state));
    }
  }

  mount(host, ...nodes);
}

/**
 * @param {object[]} open
 * @param {number} now
 */
function oldestOpenAge(open, now) {
  let oldest = null;
  for (const request of open) {
    const timing = requestTiming(request, now);
    if (timing.ageSeconds != null && (oldest === null || timing.ageSeconds > oldest)) {
      oldest = timing.ageSeconds;
    }
  }
  return oldest == null ? null : ageInWords(oldest);
}

/**
 * One request card.
 *
 * @param {object} request
 * @param {number} now
 * @param {(requestId: number, action: 'approve'|'reject', reason: string) => void} act
 * @param {object} state
 */
function requestCard(request, now, act, state) {
  const card = el('article', 'decision');
  const head = el('div', 'decision-head');
  const timing = requestTiming(request, now);
  const tone = timing.expired ? 'denied' : stateLabel(request.status);
  head.append(badge(stateWords(request.status) + (timing.expired ? ', expired' : ''), tone));
  head.append(el('span', 'decision-id', `request #${request.request_id}`));
  head.append(el('span', 'decision-vendor mono', request.vendor));
  head.append(el('span', 'decision-amount', formatNear(request.amount)));
  card.append(head);

  const meta = el('div', 'decision-meta');
  meta.append(el('span', null, `nonce ${request.nonce}`));
  meta.append(el('span', null, `created ${timing.age}`));
  if (!timing.expiryUnknown) {
    meta.append(el('span', null, `expires ${timing.expires}`));
    if (timing.countdown) meta.append(el('span', null, timing.expired ? 'past expiry' : `in ${timing.countdown}`));
  } else {
    meta.append(el('span', null, 'expires unknown'));
  }
  if (request.memo) meta.append(el('span', 'memo', request.memo));
  card.append(meta);

  const link = el('a', 'decision-link', 'open');
  link.href = href('request', request.request_id);
  card.append(link);

  const actions = el('div', 'decision-actions');
  const busy = Boolean(state.actions?.[Number(request.request_id)]);
  const allowed = isActAllowed(request.status, state.wallet?.accountId ?? null, state.owner, state.runner, state.deployment.agent);

  if (timing.expired) {
    const expiredNote = el('button', 'ghost-button', 'Expired, no action', {
      type: 'button',
      disabled: true,
    });
    actions.append(expiredNote);
  } else {
    if (allowed.approve) {
      const approve = el('button', 'ghost-button', 'Approve', { type: 'button', disabled: busy });
      approve.addEventListener('click', () => {
        openConfirm({
          title: 'Approve this request?',
          requestId: request.request_id,
          amount: formatNear(request.amount),
          vendor: request.vendor,
          consequence:
            'The contract reserves the budget and sends the transfer. The receipt is written when the transfer settles: Approved if the money moved, Failed if it did not.',
          action: 'approve',
          onConfirm: () => act(request.request_id, 'approve', ''),
        });
      });
      actions.append(approve);
    }
    if (allowed.reject) {
      const refuse = el('button', 'ghost-button', 'Reject', { type: 'button', disabled: busy });
      refuse.addEventListener('click', () => {
        openConfirm({
          title: 'Reject this request?',
          requestId: request.request_id,
          amount: formatNear(request.amount),
          vendor: request.vendor,
          consequence: 'The contract refuses the spend and writes a Denied receipt with your reason.',
          action: 'reject',
          reasonPlaceholder: 'the vendor is not on the allowlist',
          onConfirm: (reason) => act(request.request_id, 'reject', reason),
        });
      });
      actions.append(refuse);
    }
    if (!allowed.approve && !allowed.reject) {
      const note = el('button', 'ghost-button', 'No action available', { type: 'button', disabled: true });
      actions.append(note);
    }
  }
  card.append(actions);
  return card;
}
