/**
 * The shell of the console: the router, the reads, the deployment switcher
 * and the wallet.
 */

import {
  getKillSwitch,
  getLedger,
  getOpenRequests,
  getOwner,
  getPolicy,
  getRunner,
  getTreasuryBalance,
} from './lib/api.js';
import {
  createReceiptCache,
  deploymentSame,
  isAccountId,
  readDeployment,
  writeDeployment,
} from './lib/deployment.js';
import { createRouter, href } from './lib/router.js';
import { createStore } from './lib/store.js';
import { disconnectWallet, signAndSend } from './lib/wallet.js';
import { el, mount } from './lib/dom.js';
import { formatNear } from './lib/format.js';
import { setErrorBar } from './components/alert.js';
import { field } from './components/field.js';
import { openWalletPicker } from './components/wallet-picker.js';
import { openConfirm } from './components/confirm.js';
import {
  renderCharts,
  renderHero,
  renderProtocolList,
  renderRecent,
  renderStats,
} from './views/overview.js';
import { renderFilters, renderLedger, PAGE_LIMIT } from './views/ledger.js';
import { renderPolicy } from './views/policy.js';
import { renderReceipt, renderRequest } from './views/receipt.js';
import { renderRequests } from './views/requests.js';
import { renderEnable, DEFAULT_ENABLE_NAMES } from './views/enable.js';
import { renderJudge } from './views/judge.js';
import { chooseWriteMethod } from './lib/act.js';

const deployment = readDeployment();
const cache = createReceiptCache();
cache.load(deployment);

const store = createStore({
  deployment,
  view: 'overview',
  filter: { outcome: 'all', text: '' },
  ledger: { receipts: [], agentTotal: 0, globalTotal: 0, errors: 0, failedIds: [], complete: false, fallback: false, pageSize: PAGE_LIMIT, offset: 0 },
  policy: null,
  treasury: 0n,
  killSwitch: false,
  requests: { items: [], owner: null, runner: null, errors: 0, failedIds: [], complete: false, fallback: false, openCount: 0, oldestOpenAge: null },
  owner: null,
  runner: null,
  loadedAt: null,
  loading: false,
  error: null,
  stale: false,
  wallet: { status: 'idle', accountId: null, walletId: null, error: null },
  visible: PAGE_LIMIT,
  enableNames: { ...DEFAULT_ENABLE_NAMES },
  actions: {},
});

const ROUTES = {
  overview: 'view-overview',
  policy: 'view-policy',
  requests: 'view-requests',
  ledger: 'view-ledger',
  receipt: 'view-receipt',
  request: 'view-receipt',
  enable: 'view-enable',
  judge: 'view-judge',
};

/** Read the chain and paint what came back. */
async function refresh() {
  const state = store.get();
  store.set({ loading: true });
  const button = document.getElementById('refresh');
  if (button) {
    button.disabled = true;
    button.textContent = 'Reading...';
  }
  try {
    const [policy, treasury, killSwitch, owner, runner, ledger, requests] = await Promise.all([
      getPolicy(state.deployment),
      getTreasuryBalance(state.deployment),
      getKillSwitch(state.deployment),
      getOwner(state.deployment),
      getRunner(state.deployment),
      getLedger(state.deployment, cache),
      getOpenRequests(state.deployment),
    ]);
    store.set({
      policy,
      treasury,
      killSwitch,
      owner,
      runner,
      ledger,
      requests: { ...requests, openCount: requests.total ?? requests.items.length },
      loadedAt: new Date(),
      loading: false,
      error: null,
      stale: false,
    });
    setErrorBar(null);
  } catch (error) {
    const message = String(error?.message ?? error);
    store.set({ loading: false, error: message, stale: Boolean(store.get().loadedAt) });
    setErrorBar(
      store.get().stale
        ? `Could not refresh: ${message}. Showing the last successful read.`
        : `Could not read the contract: ${message}`,
    );
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Refresh';
    }
    paint();
  }
}

/** The filter callback, the same in the shell and in the route. */
function onFilter(filter) {
  store.set({ filter });
  renderFilters(store.get(), onFilter);
  renderLedger(store.get());
}

/** Paint everything the store holds. */
function paint() {
  const state = store.get();
  renderHero(state);
  renderStats(state);
  renderCharts(state);
  renderRecent(state);
  renderFilters(state, (filter) => {
    store.set({ filter });
    renderFilters(store.get(), onFilter);
    renderLedger(store.get());
  });
  renderLedger(state);
  renderPolicy(state);
  renderRequests(state, act);
  renderEnable(state, (names) => {
    store.set({ enableNames: names });
    renderEnable(store.get(), () => {});
  });
  renderJudge(state);

  const stamp = document.getElementById('loaded');
  if (stamp) {
    stamp.textContent = state.loadedAt
      ? `Read at ${state.loadedAt.toLocaleTimeString()}, ${state.requests.openCount ?? state.requests.items.length} open requests, ${state.ledger.globalTotal ?? '?'} receipts on chain${state.stale ? ' (stale)' : ''}`
      : 'Reading the chain...';
  }
  if (state.ledger.errors > 0) {
    setErrorBar(
      `Some chain calls failed (${state.ledger.errors}). Showing what could be read, not a complete ledger.`,
    );
  }
  if (state.requests.errors > 0) {
    setErrorBar(
      `Some request reads failed (${state.requests.errors}). Showing what could be read, not a complete request queue.`,
    );
  }
  const label = document.getElementById('deployment-label');
  if (label) label.textContent = state.deployment.contract;
  const agentLabel = document.getElementById('agent-label');
  if (agentLabel) agentLabel.textContent = state.deployment.agent;

  const sideAgent = document.getElementById('side-agent');
  if (sideAgent) sideAgent.textContent = state.deployment.agent;
  const sideRemaining = document.getElementById('side-remaining');
  if (sideRemaining) {
    sideRemaining.textContent = state.policy
      ? `${formatNear(state.policy.remaining)} left`
      : 'reading the policy';
  }
  const sideState = document.getElementById('side-state');
  if (sideState) {
    sideState.textContent = state.killSwitch
      ? 'every agent is frozen'
      : state.stale
        ? 'showing the last good read'
        : 'the last read is on screen';
  }

  paintWallet(state);
}

/** The wallet button. */
function paintWallet(state) {
  const button = document.getElementById('wallet-button');
  if (!button) return;
  const wallet = state.wallet ?? {};
  if (wallet.accountId) {
    button.textContent = wallet.accountId;
    button.classList.add('connected');
    button.setAttribute('aria-label', `The connected wallet ${wallet.accountId}. Click to disconnect.`);
  } else {
    button.textContent = wallet.status === 'connecting' ? 'Connecting...' : 'Connect wallet';
    button.classList.remove('connected');
    button.setAttribute('aria-label', 'Connect a NEAR wallet');
  }
  button.disabled = wallet.status === 'connecting';
}

/** Open the wallet picker. */
function openPicker() {
  openWalletPicker({
    onConnected: (result) => {
      store.set({ wallet: { status: 'connected', accountId: result.accountId, walletId: result.walletId, error: null } });
      paint();
    },
  });
}

/**
 * A write: decide which contract method matches the request status and the
 * connected account's role, ask the wallet to sign, then read the chain again.
 *
 * @param {number} requestId
 * @param {'approve'|'reject'} action
 * @param {string} reason
 */
async function act(requestId, action, reason) {
  const state = store.get();
  if (!state.wallet?.accountId) {
    openPicker();
    return;
  }
  if (state.actions?.[requestId]) return; // A transaction for this request is in flight.

  const request = state.requests.items.find((item) => Number(item.request_id) === Number(requestId));
  const caller = state.wallet.accountId;
  const agent = state.deployment.agent;

  const method = chooseWriteMethod(
    action,
    request ? request.status : null,
    caller,
    state.owner,
    state.runner,
    agent,
  );
  if (!method) {
    setErrorBar(`This account cannot ${action} request #${requestId}.`);
    return;
  }

  const args = action === 'reject' ? { request_id: requestId, reason } : { request_id: requestId };

  store.set({ actions: { ...state.actions, [requestId]: 'submitting' } });
  setErrorBar(null);
  try {
    const result = await signAndSend({
      deployment: state.deployment,
      method,
      args,
      accountId: caller,
    });
    if (result.error) {
      setErrorBar(`The wallet did not send the transaction: ${result.error}`);
      store.set({ actions: { ...state.actions, [requestId]: null } });
      return;
    }
  } finally {
    store.set({ actions: { ...state.actions, [requestId]: null } });
  }
  setErrorBar(null);
  await refresh();
}

/** The deployment switcher. */
function renderDeploymentPanel() {
  const state = store.get();
  const host = document.getElementById('deployment-form');
  if (!host) return;
  const fields = [
    ['contract', 'Contract account'],
    ['agent', 'Agent account'],
    ['vendor', 'Vendor account'],
  ].map(([key, label]) =>
    field({
      label,
      value: state.deployment[key],
      onCommit: (value) => {
        if (!isAccountId(value)) {
          setErrorBar(`${value} is not a NEAR account id.`);
          return;
        }
        const next = { ...state.deployment, [key]: value };
        if (!deploymentSame(next, state.deployment)) {
          writeDeployment(next);
          cache.load(next);
          cache.save(next);
        }
        window.location.reload();
      },
    }).wrapper,
  );
  mount(host, ...fields);
}

/** The routes. */
const router = createRouter(ROUTES, async (route) => {
  const state = store.get();
  if (route.name === 'receipt') await renderReceipt(state, route.params[0]);
  else if (route.name === 'request') await renderRequest(state, route.params[0]);
  else if (route.name === 'policy') renderPolicy(state);
  else if (route.name === 'requests') renderRequests(state, act);
  else if (route.name === 'ledger') {
    renderFilters(state, (filter) => {
      store.set({ filter });
      renderFilters(store.get(), () => {});
      renderLedger(store.get());
    });
    renderLedger(state);
  } else if (route.name === 'enable') {
    renderEnable(state, (names) => {
      store.set({ enableNames: names });
      renderEnable(store.get(), () => {});
    });
  } else if (route.name === 'judge') renderJudge(state);
  else {
    renderHero(state);
    renderStats(state);
    renderCharts(state);
  }
});

/** Wire the buttons. */
function wire() {
  document.getElementById('refresh')?.addEventListener('click', () => refresh());
  document.getElementById('ledger-more')?.addEventListener('click', () => {
    const next = store.set({ visible: store.get().visible + PAGE_LIMIT });
    renderLedger(next);
  });
  document.getElementById('wallet-button')?.addEventListener('click', async () => {
    if (store.get().wallet?.accountId) {
      // The wallet session ends too, so the next visit does not silently
      // sign the reader back in.
      await disconnectWallet();
      store.set({ wallet: { status: 'idle', accountId: null, walletId: null, error: null } });
      paint();
      return;
    }
    openPicker();
  });
  document.getElementById('deployment-toggle')?.addEventListener('click', () => {
    const panel = document.getElementById('deployment-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderDeploymentPanel();
  });
  document.getElementById('deployment-panel')?.addEventListener('click', (event) => {
    if (event.target.id === 'deployment-panel') {
      document.getElementById('deployment-panel').hidden = true;
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const state = store.get();
    if (!state.loadedAt || Date.now() - state.loadedAt.getTime() > 60000) refresh();
  });
}

renderProtocolList();
renderDeploymentPanel();
wire();
router.start();
refresh();

// The link to the ledger in the hero.
document.getElementById('hero-ledger-link')?.setAttribute('href', href('ledger'));
