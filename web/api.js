/**
 * Read only access to the Bound contract on NEAR testnet.
 *
 * The page never asks for a key and never signs anything. It reads the same
 * public state a judge can read with the NEAR CLI, and it shows the receipt
 * for every decision, including the denials.
 */

export const CONFIG = {
  rpc: 'https://test.rpc.fastnear.com',
  contract: 'bound-testnet-97685.testnet',
  agent: 'bound-agent.testnet',
  vendor: 'bound-vendor.testnet',
  explorer: 'https://testnet.nearblocks.io',
};

/** How long one RPC call may take before it is given up on. */
const RPC_TIMEOUT_MS = 10000;

/** How many times a call is tried before the page gives up on it. */
const RPC_ATTEMPTS = 2;

/** How many receipt reads run at the same time. */
const READ_BATCH = 5;

/**
 * Parse JSON while keeping u128 amounts exact.
 *
 * The contract serialises u128 as a JSON number. JavaScript loses precision
 * above 2^53, so integer literals of 16 digits or more are quoted before the
 * parse and handled as strings afterwards.
 *
 * @param {string} text
 */
export function parseBigJson(text) {
  return JSON.parse(text.replace(/:(\s*)(-?\d{16,})(?=\s*[,}\]])/g, ':$1"$2"'));
}

/**
 * Send one JSON-RPC request, with a timeout and one retry.
 *
 * Without the timeout a stalled RPC leaves the page on "Reading..." forever.
 *
 * @param {object} body
 */
async function rpcCall(body) {
  let lastError;
  for (let attempt = 0; attempt < RPC_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    try {
      const response = await fetch(CONFIG.rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return await response.json();
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/**
 * Call a view method.
 *
 * @param {string} contract
 * @param {string} method
 * @param {object} args
 */
export async function viewFunction(contract, method, args = {}) {
  const argsBase64 = btoa(JSON.stringify(args));
  const body = {
    jsonrpc: '2.0',
    id: 'bound',
    method: 'query',
    params: {
      request_type: 'call_function',
      account_id: contract,
      method_name: method,
      args_base64: argsBase64,
      finality: 'optimistic',
    },
  };
  const json = await rpcCall(body);
  if (json.error) {
    const name = json.error.cause?.name ?? json.error.name ?? 'RPC error';
    const info = json.error.cause?.info ?? json.error.data ?? '';
    throw new Error(`${name} ${typeof info === 'string' ? info : JSON.stringify(info)}`.trim());
  }
  const raw = json.result.result;
  let bytes;
  if (Array.isArray(raw)) {
    bytes = Uint8Array.from(raw);
  } else if (typeof raw === 'string') {
    bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  } else {
    throw new Error('unexpected RPC result shape');
  }
  return parseBigJson(new TextDecoder().decode(bytes));
}

/** Read the policy for the demo agent. */
export function getPolicy() {
  return viewFunction(CONFIG.contract, 'get_policy', { agent_id: CONFIG.agent });
}

/** Read every request id for the demo agent. */
export function getRequestIds() {
  return viewFunction(CONFIG.contract, 'get_request_ids', { agent_id: CONFIG.agent });
}

/** Read one request. */
export function getRequest(requestId) {
  return viewFunction(CONFIG.contract, 'get_request', { request_id: requestId });
}

/** Read one receipt. */
export function getReceipt(receiptId) {
  return viewFunction(CONFIG.contract, 'get_receipt', { receipt_id: receiptId });
}

/**
 * Format yoctoNEAR as NEAR. Keeps small amounts readable.
 *
 * @param {string|number|bigint} yocto
 */
export function formatNear(yocto) {
  const value = BigInt(yocto);
  const unit = 1000000000000000000000000n;
  const whole = value / unit;
  const frac = value % unit;
  if (frac === 0n) return `${whole} NEAR`;
  const digits = frac.toString().padStart(24, '0').replace(/0+$/, '');
  // Whole NEAR balances clamp to 6 fraction digits so the figure fits a
  // small screen; sub-NEAR amounts keep 8, which is all they need.
  const cap = whole === 0n ? 8 : 6;
  return `${whole}.${digits.slice(0, cap)} NEAR`;
}

/**
 * Format yoctoNEAR as an exact integer with separators.
 *
 * @param {string|number|bigint} yocto
 */
export function formatYocto(yocto) {
  return `${BigInt(yocto).toLocaleString('en-US')} yocto`;
}

/**
 * Seconds since the epoch for a timestamp the contract wrote.
 *
 * Receipts written before the block timestamp fix carry nanoseconds. Values
 * above 10^15 are treated as nanoseconds, values above 10^12 as milliseconds,
 * otherwise as seconds.
 *
 * @param {string|number|bigint} value
 */
export function timestampSeconds(value) {
  const raw = BigInt(value);
  if (raw > 1000000000000000n) return Number(raw / 1000000000n);
  if (raw > 1000000000000n) return Number(raw / 1000n);
  return Number(raw);
}

/** Read the treasury balance. */
export function getTreasuryBalance() {
  return viewFunction(CONFIG.contract, 'treasury_balance', {});
}

/** Whether the owner froze every agent. */
export function getKillSwitch() {
  return viewFunction(CONFIG.contract, 'get_kill_switch', {});
}

/**
 * Read every receipt, newest first, for the demo agent.
 *
 * The reads run a few at a time so a page open does not queue one call
 * behind the other. Returns both the receipts that could be read and the
 * number of calls that failed, so the page can say it is showing a partial
 * ledger instead of printing a confident lie when the RPC drops a call.
 */
export async function getReceipts() {
  const count = await viewFunction(CONFIG.contract, 'get_receipt_count', {});
  const total = Number(count);
  const receipts = [];
  let errors = 0;
  const ids = [];
  for (let id = 0; id < total; id += 1) ids.push(id);
  for (let start = 0; start < ids.length; start += READ_BATCH) {
    const batch = ids.slice(start, start + READ_BATCH);
    const read = await Promise.all(
      batch.map(async (id) => {
        try {
          return await viewFunction(CONFIG.contract, 'get_receipt', { receipt_id: id });
        } catch {
          errors += 1;
          return null;
        }
      }),
    );
    for (const receipt of read) {
      if (receipt && receipt.agent_id === CONFIG.agent) receipts.push(receipt);
    }
  }
  return {
    receipts: receipts.sort(
      (a, b) => timestampSeconds(b.created_at) - timestampSeconds(a.created_at),
    ),
    total,
    errors,
  };
}

/**
 * Load the whole readable state in one pass.
 *
 * @param {number} [limit] How many of the newest receipts to keep.
 */
export async function loadState(limit = 20) {
  const [policy, ids, ledger, treasury, killSwitch] = await Promise.all([
    getPolicy(),
    getRequestIds(),
    getReceipts(),
    getTreasuryBalance(),
    getKillSwitch(),
  ]);
  return {
    policy,
    receipts: ledger.receipts,
    shown: ledger.receipts.slice(0, limit),
    totalRequests: ids.length,
    totalReceipts: ledger.receipts.length,
    chainReceipts: ledger.total,
    receiptErrors: ledger.errors,
    treasury,
    killSwitch,
    loadedAt: new Date(),
  };
}

/**
 * The exact strings the protocol returns when the agent key is misused.
 *
 * These are the nearcore messages for the four refusals the protocol makes
 * before the contract is reached. The script demo/protocol_arm.sh runs them
 * and the console shows them as a transcript of that run.
 */
export const PROTOCOL_CHECKS = [
  {
    title: 'Wrong method',
    detail: "Transaction method name <approve_request> isn't allowed by the access key.",
  },
  {
    title: 'Wrong receiver',
    detail: "Transaction for <bound-vendor.testnet> doesn't match the access key for <bound-testnet-97685.testnet>.",
  },
  {
    title: 'Deposit attached',
    detail: 'Having a deposit with a function call action is not allowed with a function call access key.',
  },
  {
    title: 'Allowance too small',
    detail: 'Access Key <ed25519:2Tf...> for account <bound-agent.testnet> does not have enough allowance ... to cover transaction cost ...',
  },
];
