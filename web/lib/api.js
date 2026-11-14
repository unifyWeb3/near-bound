/**
 * The read layer. One function per view method of the contract.
 *
 * The page never asks for a key and never signs anything here. It reads the
 * same public state a judge can read with the NEAR CLI.
 *
 * Every call goes through one JSON-RPC adapter with finality `final`, and no
 * failed read is ever silent: results carry the ids that failed and whether
 * the page is complete.
 */

import { RPC } from './deployment.js';

/** How long one RPC call may take before it is given up on. */
const RPC_TIMEOUT_MS = 10000;

/** How many times a call is tried before the page gives up on it. */
const RPC_ATTEMPTS = 2;

/** How many receipt reads run at the same time. */
const READ_BATCH = 6;

/** Conservative page size: never read the whole ledger in one visit. */
export const PAGE_LIMIT = 25;

/** The most open requests the console will read before calling it incomplete. */
const OPEN_REQUEST_LIMIT = 50;

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
  const parts = text.split(/("(?:[^"\\]|\\.)*")/g);
  const quoted = parts.map((part, index) =>
    index % 2 === 1 ? part : part.replace(/-?\d{16,}/g, (digits) => `"${digits}"`),
  );
  return JSON.parse(quoted.join(''));
}

/**
 * Base64 of UTF-8 text, without the Latin-1 limit of `btoa`.
 *
 * @param {string} text
 * @returns {string}
 */
export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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
 * Call a view method. Always finality `final`.
 *
 * @param {string} contract
 * @param {string} method
 * @param {object} args
 */
export async function viewFunction(contract, method, args = {}) {
  const argsBase64 = toBase64(JSON.stringify(args));
  const json = await rpcCall({
    jsonrpc: '2.0',
    id: 'certalyn',
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
  // A call to a method the contract does not have comes back as a result
  // with an error inside it, not as a JSON-RPC error.
  if (json.result?.error) {
    throw new Error(String(json.result.error));
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
 * Whether one contract method exists, remembered per contract.
 *
 * Used to feature-detect optional views (`get_receipt_safe`,
 * `get_agent_receipts`, `get_agent_receipt_count` and `get_open_requests`)
 * so the console keeps working against the historical contract, which only
 * has `get_receipt_count`, `get_receipt` and `get_request_ids`.
 *
 * @param {string} contract
 * @param {string} method
 * @param {object} [args]
 */
const capabilityCache = new Map();

export async function methodAvailable(contract, method, args = {}) {
  const byContract = capabilityCache.get(contract) ?? {};
  if (method in byContract) return byContract[method];
  let available = false;
  try {
    await viewFunction(contract, method, args);
    available = true;
  } catch (error) {
    available = !/method ?not ?found|MethodNotFound|does not exist|Unknown method/i.test(
      String(error?.message ?? error),
    );
  }
  byContract[method] = available;
  capabilityCache.set(contract, byContract);
  return available;
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
 * The account that owns the contract.
 *
 * @param {{contract: string}} deployment
 */
export function getOwner(deployment) {
  return viewFunction(deployment.contract, 'get_owner', {});
}

/**
 * The account that makes the counterparty decisions.
 *
 * @param {{contract: string}} deployment
 */
export function getRunner(deployment) {
  return viewFunction(deployment.contract, 'get_runner', {});
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
 * One receipt, read through the safe view when the contract has it.
 *
 * @param {{contract: string}} deployment
 * @param {number} receiptId
 * @returns {Promise<{receipt: object|null, error: string|null}>}
 */
export async function getReceiptSafe(deployment, receiptId) {
  try {
    if (await methodAvailable(deployment.contract, 'get_receipt_safe', { receipt_id: receiptId })) {
      const receipt = await viewFunction(deployment.contract, 'get_receipt_safe', {
        receipt_id: receiptId,
      });
      return { receipt: receipt ?? null, error: null };
    }
  } catch {
    // Fall through to get_receipt, which panises on a missing id and is
    // reported as a failure below.
  }
  try {
    const receipt = await getReceipt(deployment, receiptId);
    return { receipt, error: null };
  } catch (error) {
    return { receipt: null, error: String(error.message ?? error) };
  }
}

/**
 * Read a set of receipt ids, a few at a time, never silently dropping failures.
 *
 * @param {{contract: string}} deployment
 * @param {number[]} ids
 * @returns {Promise<{receipts: object[], errors: number, failedIds: number[]}>}
 */
export async function readReceipts(deployment, ids) {
  const receipts = [];
  const failedIds = [];
  let errors = 0;
  for (let start = 0; start < ids.length; start += READ_BATCH) {
    const batch = ids.slice(start, start + READ_BATCH);
    const read = await Promise.all(
      batch.map(async (id) => {
        try {
          return await getReceipt(deployment, id);
        } catch {
          failedIds.push(id);
          errors += 1;
          return null;
        }
      }),
    );
    for (const receipt of read) if (receipt) receipts.push(receipt);
  }
  return { receipts, errors, failedIds };
}

/**
 * The ledger of one agent: a bounded newest-first page, with real denominators.
 *
 * Reads a bounded window of receipt ids newest first, consulting the receipt
 * cache so a returning reader does not re-read what it already has. Returns
 * the agent's receipts on this page, the global receipt count on chain, and
 * exactly which reads failed. The agent count is never compared with itself,
 * so the page never renders "N of N".
 *
 * @param {{contract: string, agent: string}} deployment
 * @param {object} cache
 * @param {{offset?: number, limit?: number}} options
 * @returns {Promise<{receipts: object[], agentTotal: number, globalTotal: number|null, errors: number, failedIds: number[], complete: boolean, fallback: boolean, pageSize: number, offset: number}>}
 */
export async function getLedger(deployment, cache, { offset = 0, limit = PAGE_LIMIT } = {}) {
  let globalTotal = null;
  try {
    globalTotal = Number(await getReceiptCount(deployment));
  } catch {
    globalTotal = null;
  }

  const receipts = [];
  const failedIds = [];
  let errors = 0;
  let complete = true;
  let fallback = false;

  if (globalTotal !== null && cache) {
    // A wiped deployment starts its ids again. The cached receipts that the
    // chain cannot have any more are dropped here.
    if (cache.pruneBeyond(globalTotal) > 0) cache.save(deployment);
  }

  if (globalTotal !== null) {
    const paged = await methodAvailable(deployment.contract, 'get_agent_receipts', {
      agent_id: deployment.agent,
      offset: 0,
      limit: 1,
    });
    if (paged) {
      try {
        const page = await viewFunction(deployment.contract, 'get_agent_receipts', {
          agent_id: deployment.agent,
          offset,
          limit,
        });
        for (const receipt of Array.isArray(page) ? page : []) {
          if (cache) cache.set(receipt.receipt_id, receipt);
          receipts.push(receipt);
        }
        complete = true;
      } catch (error) {
        errors += 1;
        failedIds.push('page');
        complete = false;
      }
    } else {
      // Historical contract: read the bounded newest-first window one receipt
      // at a time, consulting the cache so a returning reader re-reads less.
      fallback = true;
      const start = Math.max(0, globalTotal - limit - offset);
      const ids = [];
      for (let id = start; id < globalTotal; id += 1) ids.push(id);
      const newestFirst = ids.reverse();
      const cached = cache
        ? newestFirst.map((id) => cache.get(id)).filter((receipt) => receipt !== undefined)
        : [];
      const missing = cache ? cache.missing(newestFirst) : newestFirst;
      const fetched = missing.length
        ? await readReceipts(deployment, missing)
        : { receipts: [], errors: 0, failedIds: [] };
      receipts.push(...cached);
      for (const receipt of fetched.receipts) {
        if (cache) cache.set(receipt.receipt_id, receipt);
        receipts.push(receipt);
      }
      errors += fetched.errors;
      failedIds.push(...fetched.failedIds);
      complete = fetched.failedIds.length === 0;
      if (cache && fetched.receipts.length > 0) cache.save(deployment);
    }
  } else {
    errors += 1;
    complete = false;
    failedIds.push('count');
  }

  const agentReceipts = receipts
    .filter((receipt) => receipt.agent_id === deployment.agent)
    .sort((a, b) => Number(b.receipt_id) - Number(a.receipt_id));

  let agentTotal = agentReceipts.length;
  if (!fallback) {
    try {
      if (
        await methodAvailable(deployment.contract, 'get_agent_receipt_count', {
          agent_id: deployment.agent,
        })
      ) {
        agentTotal = Number(
          await viewFunction(deployment.contract, 'get_agent_receipt_count', {
            agent_id: deployment.agent,
          }),
        );
      }
    } catch {
      // The page count stays the count of what was read.
    }
  }

  return {
    receipts: agentReceipts,
    agentTotal,
    globalTotal,
    errors,
    failedIds,
    complete: complete && globalTotal !== null,
    fallback,
    pageSize: limit,
    offset,
  };
}

/**
 * The open requests of one agent, newest first.
 *
 * Prefers `get_open_requests(agent_id)`. Falls back to `get_request_ids` and
 * reading each request, bounded so a long request list cannot become N
 * unbounded RPC calls.
 *
 * @param {{contract: string, agent: string}} deployment
 * @returns {Promise<{items: object[], errors: number, failedIds: number[], complete: boolean, fallback: boolean, total?: number}>} `total` is the known open count; the paged path preserves the full count available before the browser cap.
 */
export async function getOpenRequests(deployment) {
  const requests = [];
  const failedIds = [];
  let errors = 0;
  let complete = true;
  let fallback = false;
  let total;

  try {
    if (await methodAvailable(deployment.contract, 'get_open_requests', {
      agent_id: deployment.agent,
    })) {
      const page = await viewFunction(deployment.contract, 'get_open_requests', {
        agent_id: deployment.agent,
      });
      if (!Array.isArray(page)) {
        errors += 1;
        failedIds.push('page');
        return { items: requests, errors, failedIds, complete: false, fallback: false };
      }
      const openCount = page.length;
      const pageRequests = page
        .slice()
        .sort((a, b) => Number(b.request_id) - Number(a.request_id))
        .slice(0, OPEN_REQUEST_LIMIT);
      return {
        items: pageRequests,
        errors: 0,
        failedIds: [],
        complete: openCount <= OPEN_REQUEST_LIMIT,
        fallback: false,
        total: openCount,
      };
    }
    fallback = true;
  } catch (error) {
    errors += 1;
    complete = false;
    failedIds.push('page');
    return { items: requests, errors, failedIds, complete: false, fallback: false };
  }

  if (fallback) {
    try {
      const ids = await viewFunction(deployment.contract, 'get_request_ids', {
        agent_id: deployment.agent,
      });
      if (!Array.isArray(ids)) {
        throw new Error('unexpected request id list');
      }
      const bounded = ids.slice().reverse().slice(0, OPEN_REQUEST_LIMIT);
      complete = ids.length <= OPEN_REQUEST_LIMIT;
      for (const id of bounded) {
        try {
          const request = await getRequest(deployment, id);
          if (request.status === 'Pending' || request.status === 'NeedsApproval') {
            requests.push(request);
          }
        } catch {
          failedIds.push(id);
          errors += 1;
          complete = false;
        }
      }
      total = requests.length;
    } catch {
      complete = false;
    }
  }

  requests.sort((a, b) => Number(b.request_id) - Number(a.request_id));
  return { items: requests, errors, failedIds, complete, fallback, total };
}

/**
 * Every request id of one agent, kept for the historical fallback.
 *
 * @param {{contract: string, agent: string}} deployment
 */
export function getRequestIds(deployment) {
  return viewFunction(deployment.contract, 'get_request_ids', { agent_id: deployment.agent });
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
