/**
 * Which deployment the console is reading, and the receipts already read.
 *
 * The deployment comes from the URL first, then from the last visit, then from
 * the demo. That is what lets a third party point the console at their own
 * contract, and what makes a link to one receipt work on any machine.
 *
 * Every storage key is namespaced with `certalyn` and bound to the contract,
 * agent and vendor, so switching deployment never shows another deployment's
 * cached receipts.
 */

export const RPC = 'https://test.rpc.fastnear.com';

export const EXPLORER = 'https://testnet.nearblocks.io';

export const DEFAULT_DEPLOYMENT = {
  contract: 'bound-testnet-97685.testnet',
  agent: 'bound-agent.testnet',
  vendor: 'bound-vendor.testnet',
};

const DEPLOYMENT_STORAGE_KEY = 'certalyn.deployment';
const RECEIPT_CACHE_STORAGE_KEY = 'certalyn.receipts';

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

/**
 * @param {{contract?: unknown, agent?: unknown, vendor?: unknown}} value
 * @returns {value is {contract: string, agent: string, vendor: string}}
 */
export function isDeployment(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    isAccountId(value.contract) &&
    isAccountId(value.agent) &&
    isAccountId(value.vendor)
  );
}

function readStored() {
  try {
    const raw = window.localStorage.getItem(DEPLOYMENT_STORAGE_KEY);
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
  const stored = isDeployment(readStored()) ? readStored() : null;
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
  if (!isDeployment(deployment)) {
    throw new Error('refusing to store an invalid deployment');
  }
  try {
    window.localStorage.setItem(DEPLOYMENT_STORAGE_KEY, JSON.stringify(deployment));
  } catch {
    // A private browser can refuse storage. The URL still carries it.
  }
  const params = new URLSearchParams(window.location.search);
  params.set('contract', deployment.contract);
  params.set('agent', deployment.agent);
  params.set('vendor', deployment.vendor);
  const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
  window.history.replaceState({}, '', next);
}

/**
 * The receipts already read, so a returning reader does not read the whole
 * ledger again.
 *
 * The cache is bound to the full deployment identity (contract, agent and
 * vendor). A receipt read for one deployment is never returned for another.
 */
/**
 * Two deployments are the same only when the contract, the agent and the
 * vendor all match. Any other combination is a different deployment.
 *
 * @param {{contract: string, agent: string, vendor: string}} a
 * @param {{contract: string, agent: string, vendor: string}} b
 */
export function deploymentSame(a, b) {
  return a.contract === b.contract && a.agent === b.agent && a.vendor === b.vendor;
}

export function createReceiptCache() {
  const key = RECEIPT_CACHE_STORAGE_KEY;
  let memory = new Map();

  /**
   * @param {{contract: string, agent: string, vendor: string}} deployment
   * @returns {string}
   */
  const cacheKey = (deployment) =>
    `${deployment.contract}\0${deployment.agent}\0${deployment.vendor}`;

  return {
    /**
     * @param {{contract: string, agent: string, vendor: string}} deployment
     */
    load(deployment) {
      try {
        const raw = window.localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : null;
        const entries = parsed && typeof parsed.receipts === 'object' ? parsed.receipts : null;
        const stored = parsed && isDeployment(parsed.deployment) ? parsed.deployment : null;
        if (stored && entries && deploymentSame(stored, deployment)) {
          memory = new Map(Object.entries(entries).map(([id, receipt]) => [Number(id), receipt]));
        } else {
          memory = new Map();
        }
      } catch {
        memory = new Map();
      }
    },
    /**
     * @param {{contract: string, agent: string, vendor: string}} deployment
     */
    save(deployment) {
      if (!isDeployment(deployment)) return;
      try {
        window.localStorage.setItem(
          key,
          JSON.stringify({ deployment, receipts: Object.fromEntries(memory) }),
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
    /**
     * Drop the receipts that the chain cannot have any more.
     *
     * A deployment that was wiped starts its receipt ids at zero again. A
     * cached receipt with an id the chain no longer has is a receipt from a
     * state that is gone, so it is dropped rather than shown.
     *
     * @param {number} total How many receipts the contract holds now.
     * @returns {number} How many cached receipts were dropped.
     */
    pruneBeyond(total) {
      let dropped = 0;
      for (const id of [...memory.keys()]) {
        if (id >= total) {
          memory.delete(id);
          dropped += 1;
        }
      }
      return dropped;
    },
  };
}
