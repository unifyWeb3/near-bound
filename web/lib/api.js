/**
 * The read layer. One function per view method of the contract.
 *
 * The page never asks for a key and never signs anything here. It reads the
 * same public state a judge can read with the NEAR CLI.
 */

import { RPC } from './deployment.js';
import { timestampSeconds } from './format.js';

/** How long one RPC call may take before it is given up on. */
const RPC_TIMEOUT_MS = 10000;

/** How many times a call is tried before the page gives up on it. */
const RPC_ATTEMPTS = 2;

/** How many receipt reads run at the same time. */
const READ_BATCH = 6;

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
 * @param {object} body
 */
async function rpcCall(body) {
  let lastError;
  for (let attempt = 0; attempt < RPC_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    try {
      const response = await fetch(RPC, {
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
  const json = await rpcCall({
    jsonrpc: '2.0',
    id: 'bound',
    method: 'query',
    params: {
      request_type: 'call_function',
      account_id: contract,
      method_name: method,
      args_base64: argsBase64,
      finality: 'final',
    },
  });
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

/**
 * The policy of one agent.
 *
 * @param {{contract: string, agent: string}} deployment
 */
export function getPolicy(deployment) {
  return viewFunction(deployment.contract, 'get_policy', { agent_id: deployment.agent });
}

/**
 * Every request id of one agent.
 *
 * @param {{contract: string, agent: string}} deployment
 */
export function getRequestIds(deployment) {
  return viewFunction(deployment.contract, 'get_request_ids', { agent_id: deployment.agent });
}

/**
 * One request.
 *
 * @param {{contract: string}} deployment
 * @param {number} requestId
 */
export function getRequest(deployment, requestId) {
  return viewFunction(deployment.contract, 'get_request', { request_id: requestId });
}

/**
 * One receipt.
 *
 * @param {{contract: string}} deployment
 * @param {number} receiptId
 */
export function getReceipt(deployment, receiptId) {
  return viewFunction(deployment.contract, 'get_receipt', { receipt_id: receiptId });
}

/**
 * How many receipts the contract holds, for every agent.
 *
 * @param {{contract: string}} deployment
 */
export function getReceiptCount(deployment) {
  return viewFunction(deployment.contract, 'get_receipt_count', {});
}

/**
 * The treasury balance.
 *
 * @param {{contract: string}} deployment
 */
export function getTreasuryBalance(deployment) {
  return viewFunction(deployment.contract, 'treasury_balance', {});
}

/**
 * Whether the owner froze every agent.
 *
 * @param {{contract: string}} deployment
 */
export function getKillSwitch(deployment) {
  return viewFunction(deployment.contract, 'get_kill_switch', {});
}

/**
 * Read a set of receipt ids, a few at a time.
 *
 * @param {{contract: string}} deployment
 * @param {number[]} ids
 */
export async function readReceipts(deployment, ids) {
  const receipts = [];
  let errors = 0;
  for (let start = 0; start < ids.length; start += READ_BATCH) {
    const batch = ids.slice(start, start + READ_BATCH);
    const read = await Promise.all(
      batch.map(async (id) => {
        try {
          return await getReceipt(deployment, id);
        } catch {
          errors += 1;
          return null;
        }
      }),
    );
    for (const receipt of read) if (receipt) receipts.push(receipt);
  }
  return { receipts, errors };
}

/**
 * The ledger of one agent, newest first.
 *
 * The counts on the page have to be the whole ledger's counts, so the whole
 * ledger is read. The cache means a second visit reads only what is new.
 *
 * @param {{contract: string, agent: string}} deployment
 * @param {object} cache
 */
export async function getLedger(deployment, cache) {
  const total = Number(await getReceiptCount(deployment));
  const ids = [];
  for (let id = 0; id < total; id += 1) ids.push(id);

  const missing = cache.missing(ids).sort((a, b) => b - a);
  const { receipts, errors } = missing.length
    ? await readReceipts(deployment, missing)
    : { receipts: [], errors: 0 };
  for (const receipt of receipts) cache.set(receipt.receipt_id, receipt);
  cache.save(deployment);

  const all = cache
    .values()
    .filter((receipt) => receipt.agent_id === deployment.agent)
    .sort((a, b) => timestampSeconds(b.created_at) - timestampSeconds(a.created_at));

  return { receipts: all, total, errors, unread: cache.missing(ids).length };
}

/**
 * The requests of one agent, newest first.
 *
 * @param {{contract: string, agent: string}} deployment
 */
export async function getRequests(deployment) {
  const ids = await getRequestIds(deployment);
  const requests = [];
  for (const id of ids) {
    try {
      requests.push(await getRequest(deployment, id));
    } catch {
      // A request that cannot be read is left out rather than shown as broken.
    }
  }
  return requests.sort((a, b) => Number(b.request_id) - Number(a.request_id));
}

/**
 * The exact strings the protocol returns when the agent key is misused.
 *
 * These are the nearcore messages for the four refusals the protocol makes
 * before the contract is reached. The script demo/protocol_arm.sh runs them and
 * the console shows them as a transcript of that run.
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
