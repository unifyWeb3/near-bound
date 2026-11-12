/**
 * Which deployment the console is looking at, and the small client side store
 * the views read from.
 *
 * The deployment comes from the URL first, then from the last visit, then from
 * the demo. That is what lets a third party point the console at their own
 * contract, and what makes a link to one receipt work on any machine.
 */

export const RPC = 'https://test.rpc.fastnear.com';

export const EXPLORER = 'https://testnet.nearblocks.io';

export const DEFAULT_DEPLOYMENT = {
  contract: 'bound-testnet-97685.testnet',
  agent: 'bound-agent.testnet',
  vendor: 'bound-vendor.testnet',
};

/** Where the last visited deployment is remembered. */
const STORAGE_KEY = 'spendguard.deployment';

/**
 * A NEAR account id: lower case letters, digits and the separators NEAR allows.
 * The console checks the shape before it spends an RPC call on it.
 */
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isAccountId(value) {
  return typeof value === 'string' && value.length >= 2 && value.length <= 64 && ACCOUNT_RE.test(value);
}

/**
 * The deployment the visitor asked for.
 *
 * @param {string} [search] A query string, without the question mark.
 */
export function readDeployment(search = window.location.search) {
  const params = new URLSearchParams(search);
  const stored = readStored();
  const contract = params.get('contract') || stored?.contract || DEFAULT_DEPLOYMENT.contract;
  const agent = params.get('agent') || stored?.agent || DEFAULT_DEPLOYMENT.agent;
  const vendor = params.get('vendor') || stored?.vendor || DEFAULT_DEPLOYMENT.vendor;
  return {
    contract: isAccountId(contract) ? contract : DEFAULT_DEPLOYMENT.contract,
    agent: isAccountId(agent) ? agent : DEFAULT_DEPLOYMENT.agent,
    vendor: isAccountId(vendor) ? vendor : DEFAULT_DEPLOYMENT.vendor,
  };
}

function readStored() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Remember a deployment and put it in the URL, so the address bar always
 * says which contract the page is showing.
 *
 * @param {object} deployment
 */
export function writeDeployment(deployment) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(deployment));
  } catch {
    // A private browser can refuse storage. The URL still carries it.
  }
  const params = new URLSearchParams(window.location.search);
  params.set('contract', deployment.contract);
  params.set('agent', deployment.agent);
  const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
  window.history.replaceState({}, '', next);
}

/**
 * A tiny store. The views subscribe to it, the shell writes to it.
 */
export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get() {
      return state;
    },
    set(patch) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state);
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The receipts already read, kept so a returning reader does not read the
 * whole ledger again.
 *
 * The chain has no index of one agent's receipts, so the only way to know them
 * all is to read them once. This keeps them, keyed by the deployment, and
 * reads only what is new on the next visit.
 */
export function createReceiptCache() {
  const key = 'spendguard.receipts';
  let memory = new Map();

  const load = (deployment) => {
    try {
      const raw = window.localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : null;
      const store = parsed && parsed.deployment === cacheKey(deployment) ? parsed.receipts : {};
      memory = new Map(Object.entries(store).map(([id, receipt]) => [Number(id), receipt]));
    } catch {
      memory = new Map();
    }
  };

  const save = (deployment) => {
    try {
      const receipts = Object.fromEntries(memory);
      window.localStorage.setItem(
        key,
        JSON.stringify({ deployment: cacheKey(deployment), receipts }),
      );
    } catch {
      // Storage is full or refused. The page still works, it just reads again.
    }
  };

  return {
    load,
    save,
    get size() {
      return memory.size;
    },
    has(id) {
      return memory.has(Number(id));
    },
    get(id) {
      return memory.get(Number(id));
    },
    set(id, receipt) {
      memory.set(Number(id), receipt);
    },
    values() {
      return [...memory.values()];
    },
    /** The ids that are not in the cache yet. */
    missing(ids) {
      return ids.filter((id) => !memory.has(Number(id)));
    },
  };
}

function cacheKey(deployment) {
  return `${deployment.contract}/${deployment.agent}`;
}
