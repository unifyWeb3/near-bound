/**
 * The shell of the console: the router, the reads, the deployment switcher
 * and the wallet.
 */

import {
  getKillSwitch,
  getLedger,
  getPolicy,
  getRequests,
  getTreasuryBalance,
} from './lib/api.js';
import {
  createReceiptCache,
  isAccountId,
  readDeployment,
  writeDeployment,
} from './lib/deployment.js';
import { createRouter, href } from './lib/router.js';
import { createStore } from './lib/store.js';
import { connectWallet, signAndSend } from './lib/wallet.js';
import { el, mount } from './lib/dom.js';
import { setErrorBar } from './components/alert.js';
import { field } from './components/field.js';
import { openWalletPicker } from './components/wallet-picker.js';
import { renderCharts, renderHero, renderProtocolList, renderRecent, renderStats } from './views/overview.js';
import { renderFilters, renderLedger, PAGE_SIZE } from './views/ledger.js';
import { renderPolicy } from './views/policy.js';
import { renderReceipt, renderRequest } from './views/receipt.js';
import { renderRequests } from './views/requests.js';
import { renderEnable } from './views/enable.js';
import { renderJudge } from './views/judge.js';

const deployment = readDeployment();
const cache = createReceiptCache();
cache.load(deployment);

const store = createStore({
  deployment,
  view: 'overview',
  filter: { outcome: 'all', text: '' },
  ledger: { receipts: [], total: 0, errors: 0, unread: 0 },
  policy: null,
  treasury: 0n,
  killSwitch: false,
  requests: [],
  loadedAt: null,
  loading: false,
  error: null,
  stale: false,
  wallet: { status: 'idle', accountId: null, walletId: null, error: null },
  visible: PAGE_SIZE,
  enableNames: { ...deployment },
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
    const [policy, treasury, killSwitch, ledger, requests] = await Promise.all([
      getPolicy(state.deployment),
      getTreasuryBalance(state.deployment),
      getKillSwitch(state.deployment),
      getLedger(state.deployment, cache),
      getRequests(state.deployment),
    ]);
    store.set({
      policy,
      treasury,
      killSwitch,
      ledger,
      requests,
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

/** Paint everything the store holds. */
function paint() {
  const state = store.get();
  renderHero(state);
  renderStats(state);
  renderCharts(state);
  renderRecent(state);
  renderFilters(state, (filter) => {
    store.set({ filter });
    renderFilters(store.get(), (next) => {
      store.set({ filter: next });
      renderFilters(store.get(), () => {});
      renderLedger(store.get());
    });
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
      ? `Read at ${state.loadedAt.toLocaleTimeString()}, ${state.requests.length} requests, ${state.ledger.total} receipts on chain${state.stale ? ' (stale)' : ''}`
      : 'Reading the chain...';
  }
  if (state.ledger.errors > 0) {
    setErrorBar(
      `Some chain calls failed (${state.ledger.errors} of ${state.ledger.total}). Showing what could be read, not a complete ledger.`,
    );
  }
  const label = document.getElementById('deployment-label');
  if (label) label.textContent = state.deployment.contract;
  const agentLabel = document.getElementById('agent-label');
  if (agentLabel) agentLabel.textContent = state.deployment.agent;
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
 * A write: ask the wallet to sign, then read the chain again.
 *
 * @param {number} requestId
 * @param {string} method
 * @param {Array} args
 */
async function act(requestId, method, args) {
  const state = store.get();
  if (!state.wallet?.accountId) {
    openPicker();
    return;
  }
  setErrorBar(null);
  const result = await signAndSend({
    deployment: state.deployment,
    method,
    args,
    accountId: state.wallet.accountId,
  });
  if (result.error) {
    setErrorBar(`The wallet did not send the transaction: ${result.error}`);
    return;
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
        writeDeployment(next);
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
    const next = store.set({ visible: store.get().visible + PAGE_SIZE });
    renderLedger(next);
  });
  document.getElementById('wallet-button')?.addEventListener('click', () => {
    if (store.get().wallet?.accountId) {
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
