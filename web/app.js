/**
 * The shell of the console: the router, the reads, the deployment switcher.
 */

import {
  PAGE_SIZE,
  getKillSwitch,
  getLedger,
  getPolicy,
  getRequests,
  getTreasuryBalance,
} from './api.js';
import {
  createReceiptCache,
  createStore,
  isAccountId,
  readDeployment,
  writeDeployment,
} from './state.js';
import {
  connectWallet,
  connectedAccount,
  readAccountState,
  sendSigned,
  signAndSend,
  signedTransactions,
} from './wallet.js';
import { $, el } from './ui.js';
import {
  renderCharts,
  renderEnable,
  renderHero,
  renderJudge,
  renderLedger,
  renderLedgerFilters,
  renderPolicy,
  renderProtocolList,
  renderReceiptView,
  renderRequestView,
  renderRequests,
  renderStats,
} from './views.js';

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
  wallet: null,
  actions: {
    approve: (requestId) => signCall('approve_request', [requestId]),
    reject: (requestId, reason) => signCall('reject_request', [requestId, reason]),
  },
});

/** The views the router knows, and the element each one lives in. */
const VIEWS = {
  overview: 'view-overview',
  policy: 'view-policy',
  requests: 'view-requests',
  ledger: 'view-ledger',
  receipt: 'view-receipt',
  request: 'view-receipt',
  enable: 'view-enable',
  judge: 'view-judge',
};

function parseRoute() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [name, param] = hash.split('/');
  if (!name) return { view: 'overview' };
  if (!VIEWS[name]) return { view: 'overview' };
  return { view: name, param };
}

function showView(view) {
  // A route can share an element with another route, so the visible set is
  // worked out first and the elements are then shown or hidden once.
  const visible = new Set(
    Object.entries(VIEWS)
      .filter(([name]) => name === view)
      .map(([, id]) => id),
  );
  for (const id of new Set(Object.values(VIEWS))) {
    const node = document.getElementById(id);
    if (node) node.hidden = !visible.has(id);
  }
  for (const link of document.querySelectorAll('[data-route]')) {
    const active = link.getAttribute('data-route') === view;
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function onRoute() {
  const route = parseRoute();
  store.set({ view: route.view });
  showView(route.view === 'receipt' ? 'receipt' : route.view);
  if (route.view === 'receipt') {
    await renderReceiptView(store.get(), route.param);
  } else if (route.view === 'request') {
    await renderRequestView(store.get(), route.param);
  } else if (route.view === 'policy') {
    renderPolicy(store.get());
  } else if (route.view === 'requests') {
    renderRequests(store.get());
  } else if (route.view === 'ledger') {
    renderLedgerFilters(store.get());
    renderLedger(store.get());
  } else if (route.view === 'enable') {
    renderEnable(store.get());
  } else if (route.view === 'judge') {
    renderJudge(store.get());
  } else if (route.view === 'overview') {
    renderHero(store.get());
    renderStats(store.get());
    renderCharts(store.get());
  }
}

/** Read the chain and paint what came back. */
async function refresh({ more = false } = {}) {
  const state = store.get();
  store.set({ loading: true });
  $('refresh').disabled = true;
  try {
    const [policy, treasury, killSwitch, ledger, requests] = await Promise.all([
      getPolicy(state.deployment),
      getTreasuryBalance(state.deployment),
      getKillSwitch(state.deployment),
      getLedger(state.deployment, cache, more ? PAGE_SIZE * 4 : PAGE_SIZE),
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
    $('error-bar').hidden = true;
  } catch (error) {
    store.set({
      loading: false,
      error: String(error.message ?? error),
      stale: Boolean(store.get().loadedAt),
    });
    $('error-bar').hidden = false;
    $('error-bar').textContent = store.get().stale
      ? `Could not refresh: ${error.message ?? error}. Showing the last successful read.`
      : `Could not read the contract: ${error.message ?? error}`;
  } finally {
    $('refresh').disabled = false;
    $('refresh').textContent = 'Refresh';
    paint();
  }
}

function paint() {
  const state = store.get();
  renderHero(state);
  renderStats(state);
  renderCharts(state);
  renderLedgerFilters(state);
  renderLedger(state);
  renderPolicy(state);
  renderRequests(state);
  renderJudge(state);
  const stamp = state.loadedAt
    ? `Read at ${state.loadedAt.toLocaleTimeString()}, ${state.requests.length} requests, ${state.ledger.total} receipts on chain${state.stale ? ' (stale)' : ''}`
    : 'Reading the chain...';
  $('loaded').textContent = stamp;
  if (state.ledger.errors > 0) {
    $('error-bar').hidden = false;
    $('error-bar').textContent = `Some chain calls failed (${state.ledger.errors} of ${state.ledger.total}). Showing what could be read, not a complete ledger.`;
  }
  $('deployment-label').textContent = state.deployment.contract;
  $('agent-label').textContent = state.deployment.agent;
  $('hero-agent').textContent = state.deployment.agent.replace(/\.testnet$/, '');
  const walletButton = $('wallet-button');
  if (state.wallet?.accountId) {
    walletButton.textContent = state.wallet.accountId;
    walletButton.classList.add('connected');
  } else {
    walletButton.textContent = 'Connect wallet';
    walletButton.classList.remove('connected');
  }
}

/**
 * The wallet, and the writes it signs.
 *
 * The console reads on its own. A write goes through the reader's wallet:
 * the page asks it to sign a function call and sends what comes back to the
 * public RPC.
 */
async function handleWallet() {
  const signed = signedTransactions();
  if (signed && signed.length) {
    try {
      const result = await sendSigned(signed[0]);
      store.set({ wallet: { accountId: connectedAccount(), lastTx: result?.transaction?.hash ?? null } });
      $('error-bar').hidden = true;
    } catch (error) {
      $('error-bar').hidden = false;
      $('error-bar').textContent = `The wallet sent a transaction the chain refused: ${error.message ?? error}`;
    }
    // The signed transactions are in the address bar now. Take them out.
    const clean = new URL(window.location.href);
    clean.searchParams.delete('signedTransactions');
    clean.searchParams.delete('allApps');
    clean.searchParams.delete('wallet');
    window.history.replaceState({}, '', clean.toString());
    await refresh();
    return;
  }

  const account = connectedAccount();
  if (!account) {
    connectWallet();
    return;
  }
  try {
    const accountState = await readAccountState(account);
    store.set({ wallet: { accountId: account, publicKey: accountState.publicKey, lastTx: null } });
  } catch (error) {
    store.set({ wallet: { accountId: account, publicKey: null, lastTx: null } });
    $('error-bar').hidden = false;
    $('error-bar').textContent = `The wallet is connected, but the account could not be read: ${error.message ?? error}`;
  }
  paint();
}

/** Ask the wallet to sign one call on the contract. */
async function signCall(method, args) {
  const state = store.get();
  const wallet = state.wallet;
  if (!wallet?.accountId) {
    connectWallet();
    return;
  }
  try {
    await signAndSend({
      contract: state.deployment.contract,
      accountId: wallet.accountId,
      method,
      args,
      publicKey: wallet.publicKey,
    });
  } catch (error) {
    $('error-bar').hidden = false;
    $('error-bar').textContent = `Could not build the transaction: ${error.message ?? error}`;
  }
}

/** The deployment switcher. */
function renderDeploymentPanel() {
  const state = store.get();
  const host = $('deployment-form');
  host.replaceChildren();
  const fields = [
    ['contract', 'Contract account'],
    ['agent', 'Agent account'],
    ['vendor', 'Vendor account'],
  ];
  for (const [key, label] of fields) {
    const wrapper = el('label', 'field');
    wrapper.append(el('span', 'field-label', label));
    const input = el('input', 'field-input');
    input.type = 'text';
    input.value = state.deployment[key];
    input.spellcheck = false;
    input.addEventListener('change', () => {
      if (!isAccountId(input.value)) {
        input.setCustomValidity('A NEAR account id has lower case letters, digits and one dot');
        input.reportValidity();
        return;
      }
      input.setCustomValidity('');
      const next = { ...state.deployment, [key]: input.value };
      writeDeployment(next);
      window.location.reload();
    });
    wrapper.append(input);
    host.append(wrapper);
  }
}

/** Wire the buttons. */
function wire() {
  $('refresh').addEventListener('click', () => refresh());
  $('ledger-more').addEventListener('click', () => refresh({ more: true }));
  $('wallet-button').addEventListener('click', () => handleWallet());
  $('deployment-toggle').addEventListener('click', () => {
    const panel = $('deployment-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderDeploymentPanel();
  });
  $('deployment-panel').addEventListener('click', (event) => {
    if (event.target.id === 'deployment-panel') $('deployment-panel').hidden = true;
  });
  window.addEventListener('hashchange', onRoute);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const state = store.get();
    if (!state.loadedAt || Date.now() - state.loadedAt.getTime() > 60000) refresh();
  });
}

renderProtocolList();
renderDeploymentPanel();
renderEnable(store.get());
wire();
showView('overview');
onRoute();
refresh();
