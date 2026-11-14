import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  viewFunction,
  getLedger,
  getOpenRequests,
  getReceiptSafe,
} from '../lib/api.js';

const AGENT = 'bound-agent.testnet';
const OTHER = 'someone-else.testnet';

const receipts = {
  '0': { receipt_id: 0, agent_id: AGENT, vendor: 'vendor.testnet', amount: '1000000000000000000000000', outcome: 'Approved' },
  '1': { receipt_id: 1, agent_id: OTHER, vendor: 'vendor.testnet', amount: '500000000000000000000000', outcome: 'Denied' },
  '2': { receipt_id: 2, agent_id: AGENT, vendor: 'vendor.testnet', amount: '100000000000000000000000', outcome: 'Failed' },
};

function installFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => handler(init);
  return () => {
    globalThis.fetch = original;
  };
}

function argsOf(parsed) {
  return JSON.parse(Buffer.from(parsed.params.args_base64, 'base64').toString());
}

function rpcResponse(value) {
  return { json: async () => value };
}

function rpcResult(value) {
  return rpcResponse({ jsonrpc: '2.0', id: 'certalyn', result: { result: Buffer.from(JSON.stringify(value)).toString('base64') } });
}

function rpcError(name, info) {
  return rpcResponse({ jsonrpc: '2.0', id: 'certalyn', error: { cause: { name, info } } });
}

afterEach(() => {});

test('viewFunction uses finality final and base64 JSON arguments', async () => {
  const calls = [];
  const restore = installFetch(async (init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.params.method_name === 'get_policy') return rpcResult({ budget: '100' });
    return rpcError('MethodNotFound', 'no such method');
  });
  try {
    const policy = await viewFunction('contract.testnet', 'get_policy', { agent_id: AGENT });
    assert.strictEqual(policy.budget, '100');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].params.finality, 'final');
    assert.strictEqual(argsOf(calls[0]).agent_id, AGENT);
  } finally {
    restore();
  }
});

test('getLedger on the historical contract falls back to per-receipt reads', async () => {
  const restore = installFetch(async (init) => {
    const body = JSON.parse(init.body);
    const method = body.params.method_name;
    if (method === 'get_receipt_count') return rpcResult(3);
    if (method === 'get_agent_receipts') return rpcError('MethodNotFound', 'method not found');
    if (method === 'get_receipt') return rpcResult(receipts[String(argsOf(body).receipt_id ?? argsOf(body).request_id)]);
    return rpcError('MethodNotFound', 'method not found');
  });
  try {
    const ledger = await getLedger({ contract: 'historic.testnet', agent: AGENT });
    assert.strictEqual(ledger.globalTotal, 3);
    assert.strictEqual(ledger.agentTotal, 2);
    assert.deepStrictEqual(ledger.receipts.map((r) => r.receipt_id), [2, 0]);
    assert.ok(ledger.fallback);
    assert.strictEqual(ledger.errors, 0);
    assert.deepStrictEqual(ledger.failedIds, []);
  } finally {
    restore();
  }
});

test('getLedger surfaces exact failed ids instead of dropping them', async () => {
  const restore = installFetch(async (init) => {
    const body = JSON.parse(init.body);
    const method = body.params.method_name;
    if (method === 'get_receipt_count') return rpcResult(3);
    if (method === 'get_agent_receipts') return rpcError('MethodNotFound', 'method not found');
    if (method === 'get_receipt') {
      if (argsOf(body).receipt_id === 2) return rpcError('LookupError', 'no receipt with that id');
      return rpcResult(receipts[String(argsOf(body).receipt_id ?? argsOf(body).request_id)]);
    }
    return rpcError('MethodNotFound', 'method not found');
  });
  try {
    const ledger = await getLedger({ contract: 'historic.testnet', agent: AGENT });
    assert.strictEqual(ledger.errors, 1);
    assert.deepStrictEqual(ledger.failedIds, [2]);
    assert.ok(!ledger.complete);
    assert.strictEqual(ledger.globalTotal, 3);
    assert.deepStrictEqual(ledger.receipts.map((r) => r.receipt_id), [0]);
  } finally {
    restore();
  }
});

test('getLedger on a paged contract uses the agent page view and reports real denominators', async () => {
  const restore = installFetch(async (init) => {
    const body = JSON.parse(init.body);
    if (body.params.method_name === 'get_receipt_count') return rpcResult(3);
    if (body.params.method_name === 'get_agent_receipts')
      return rpcResult([receipts['2'], receipts['0']]);
    if (body.params.method_name === 'get_agent_receipt_count') return rpcResult(2);
    return rpcError('MethodNotFound', 'method not found');
  });
  try {
    const ledger = await getLedger({ contract: 'modern.testnet', agent: AGENT });
    assert.ok(!ledger.fallback);
    assert.strictEqual(ledger.globalTotal, 3);
    assert.strictEqual(ledger.agentTotal, 2);
    assert.ok(ledger.complete);
  } finally {
    restore();
  }
});

test('getReceiptSafe falls back to get_receipt when get_receipt_safe is unavailable', async () => {
  const restore = installFetch(async (init) => {
    const body = JSON.parse(init.body);
    if (body.params.method_name === 'get_receipt_safe') return rpcError('MethodNotFound', 'method not found');
    if (body.params.method_name === 'get_receipt') return rpcResult(receipts['0']);
    return rpcError('MethodNotFound', 'method not found');
  });
  try {
    const result = await getReceiptSafe({ contract: 'modern.testnet' }, 0);
    assert.deepStrictEqual(result, { receipt: receipts['0'], error: null });
  } finally {
    restore();
  }
});


test('getOpenRequests uses the page view when the contract has it', async () => {
  const requests = {
    '0': { request_id: 0, status: 'Pending', agent_id: AGENT },
    '2': { request_id: 2, status: 'NeedsApproval', agent_id: AGENT },
  };
  const restore = installFetch(async (init) => {
    const body = JSON.parse(init.body);
    if (body.params.method_name === 'get_open_requests') return rpcResult([requests['0'], requests['2']]);
    return rpcError('MethodNotFound', 'method not found');
  });
  try {
    const open = await getOpenRequests({ contract: 'modern.testnet', agent: AGENT });
    assert.ok(!open.fallback);
    assert.deepStrictEqual(open.items.map((r) => r.request_id), [2, 0]);
    assert.strictEqual(open.errors, 0);
    assert.strictEqual(open.total, 2);
    assert.strictEqual(open.complete, true);
  } finally {
    restore();
  }
});

test('getOpenRequests reports truncation and preserves the available open count', async () => {
  const requests = Array.from({ length: 51 }, (_, requestId) => ({
    request_id: requestId,
    status: 'Pending',
    agent_id: AGENT,
  }));
  const restore = installFetch(async (init) => {
    const body = JSON.parse(init.body);
    if (body.params.method_name === 'get_open_requests') return rpcResult(requests);
    return rpcError('MethodNotFound', 'method not found');
  });
  try {
    const open = await getOpenRequests({ contract: 'truncated.testnet', agent: AGENT });
    assert.strictEqual(open.items.length, 50);
    assert.strictEqual(open.items[0].request_id, 50);
    assert.strictEqual(open.total, 51);
    assert.strictEqual(open.complete, false);
    assert.strictEqual(open.errors, 0);
  } finally {
    restore();
  }
});

test('getReceiptSafe reports a missing receipt as an error, not nothing', async () => {
  const restore = installFetch(async (init) => {
    const body = JSON.parse(init.body);
    if (body.params.method_name === 'get_receipt_safe') return rpcError('MethodNotFound', 'method not found');
    if (body.params.method_name === 'get_receipt') return rpcError('LookupError', 'no receipt with that id');
    return rpcError('MethodNotFound', 'method not found');
  });
  try {
    const result = await getReceiptSafe({ contract: 'modern.testnet' }, 9);
    assert.strictEqual(result.receipt, null);
    assert.ok(result.error);
  } finally {
    restore();
  }
});

test('getOpenRequests falls back to reading each request id', async () => {
  const requests = {
    '0': { request_id: 0, status: 'Pending', agent_id: AGENT, amount: '10' },
    '2': { request_id: 2, status: 'NeedsApproval', agent_id: AGENT, amount: '20' },
  };
  const restore = installFetch(async (init) => {
    const body = JSON.parse(init.body);
    if (body.params.method_name === 'get_request_ids') return rpcResult([2, 0]);
    if (body.params.method_name === 'get_open_requests') return rpcError('MethodNotFound', 'method not found');
    if (body.params.method_name === 'get_request') return rpcResult(requests[String(argsOf(body).request_id)]);
    return rpcError('MethodNotFound', 'method not found');
  });
  try {
    const open = await getOpenRequests({ contract: 'historic.testnet', agent: AGENT });
    assert.strictEqual(open.total, 2);
    assert.deepStrictEqual(open.items.map((r) => r.request_id), [2, 0]);
    assert.ok(open.fallback);
    assert.strictEqual(open.errors, 0);
    assert.strictEqual(open.complete, true);
  } finally {
    restore();
  }
});
