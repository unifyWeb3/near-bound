/**
 * Which deployment the console is reading, and the receipts already read.
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

const STORAGE_KEY = 'spendguard.deployment';

/**
 * A NEAR account id: lower case letters, digits and the separators NEAR allows.
 */
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/**
 * @param {unknown} value
 */
export function isAccountId(value) {
  return typeof value === 'string' && value.length >= 2 && value.length <= 64 && ACCOUNT_RE.test(value);
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
 * The deployment the visitor asked for.
 *
 * @param {string} [search] A query string without the question mark.
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

/**
 * Remember a deployment and put it in the URL, so the address bar always says
 * which contract the page is showing.
 *
 * @param {{contract: string, agent: string, vendor: string}} deployment
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
 * The receipts already read, so a returning reader does not read the whole
 * ledger again.
 *
 * The chain counts every receipt the contract holds, for every agent, and it
 * does not index them by agent. So the ledger is read once, and after that only
 * the receipts that are new.
 */
export function createReceiptCache() {
  const key = 'spendguard.receipts';
  let memory = new Map();

  const cacheKey = (deployment) => `${deployment.contract}/${deployment.agent}`;

  return {
    /**
     * @param {{contract: string, agent: string}} deployment
     */
    load(deployment) {
      try {
        const raw = window.localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : null;
        const store = parsed && parsed.deployment === cacheKey(deployment) ? parsed.receipts : {};
        memory = new Map(Object.entries(store).map(([id, receipt]) => [Number(id), receipt]));
      } catch {
        memory = new Map();
      }
    },
    /**
     * @param {{contract: string, agent: string}} deployment
     */
    save(deployment) {
      try {
        window.localStorage.setItem(
          key,
          JSON.stringify({ deployment: cacheKey(deployment), receipts: Object.fromEntries(memory) }),
        );
      } catch {
        // Storage is full or refused. The page still works, it just reads again.
      }
    },
    /** @param {number} id */
    has(id) {
      return memory.has(Number(id));
    },
    /** @param {number} id */
    get(id) {
      return memory.get(Number(id));
    },
    /** @param {number} id @param {object} receipt */
    set(id, receipt) {
      memory.set(Number(id), receipt);
    },
    values() {
      return [...memory.values()];
    },
    /** @param {number[]} ids */
    missing(ids) {
      return ids.filter((id) => !memory.has(Number(id)));
    },
  };
}
