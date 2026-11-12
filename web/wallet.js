/**
 * The NEAR wallet, for the writes.
 *
 * The console reads the chain on its own. A write needs the reader's wallet:
 * the page asks the wallet to sign a transaction and sends what comes back to
 * the public RPC. Nothing is sent to a server, because there is no server.
 *
 * The transaction is built here, in the page, and signed by the wallet. The
 * Borsh encoding is the one the chain expects for a function call.
 */

import { RPC } from './state.js';

const WALLET = 'https://wallet.testnet.near.org';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decode a base58 string into bytes. */
export function base58Decode(text) {
  let number = 0n;
  for (const char of text) {
    const index = BASE58.indexOf(char);
    if (index < 0) throw new Error(`not base58: ${char}`);
    number = number * 58n + BigInt(index);
  }
  let hex = number.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = hex ? new Uint8Array(hex.match(/../g).map((pair) => parseInt(pair, 16))) : new Uint8Array(0);
  const leading = text.length - text.replace(/^1+/, '').length;
  const out = new Uint8Array(leading + bytes.length);
  out.set(bytes, leading);
  return out;
}

/** Encode bytes as base58. */
export function base58Encode(bytes) {
  let number = 0n;
  for (const byte of bytes) number = number * 256n + BigInt(byte);
  let text = '';
  while (number > 0n) {
    const rest = number % 58n;
    number /= 58n;
    text = BASE58[Number(rest)] + text;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    text = `1${text}`;
  }
  return text || '1';
}

/** The bytes of a base64 string. */
function base64ToBytes(text) {
  const binary = atob(text);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A little Borsh writer, enough for a function call. */
class Writer {
  constructor() {
    this.bytes = [];
  }

  u8(value) {
    this.bytes.push(value & 0xff);
    return this;
  }

  u32(value) {
    this.u8(value);
    this.u8(value >>> 8);
    this.u8(value >>> 16);
    this.u8(value >>> 24);
    return this;
  }

  u64(value) {
    const big = BigInt(value);
    for (let index = 0; index < 8; index += 1) {
      this.bytes.push(Number((big >> BigInt(index * 8)) & 0xffn));
    }
    return this;
  }

  u128(value) {
    const big = BigInt(value);
    for (let index = 0; index < 16; index += 1) {
      this.bytes.push(Number((big >> BigInt(index * 8)) & 0xffn));
    }
    return this;
  }

  /** A length prefixed string. */
  str(value) {
    const encoded = new TextEncoder().encode(value);
    this.u32(encoded.length);
    for (const byte of encoded) this.bytes.push(byte);
    return this;
  }

  /** A length prefixed list of bytes. */
  bytes(value) {
    this.u32(value.length);
    for (const byte of value) this.bytes.push(byte);
    return this;
  }

  /** A variant name, then its fields. */
  variant(name) {
    return this.str(name);
  }
}

/**
 * The bytes of a signed transaction, the way the chain hashes them.
 *
 * @param {object} transaction
 */
export function encodeTransaction(transaction) {
  const writer = new Writer();
  writer.bytes(base64ToBytes(transaction.signature || ''));
  const [kind, key] = transaction.public_key.split(':');
  writer.variant(kind);
  writer.bytes(base64ToBytes(key));
  writer.str(transaction.account_id);
  writer.u64(transaction.nonce);
  writer.str(transaction.receiver_id);
  writer.bytes(base64ToBytes(transaction.block_hash));
  writer.u32(transaction.actions.length);
  for (const action of transaction.actions) {
    writer.variant('FunctionCall');
    writer.str(action.FunctionCall.method_name);
    writer.bytes(base64ToBytes(action.FunctionCall.args));
    writer.u64(action.FunctionCall.gas);
    writer.u128(action.FunctionCall.deposit);
    writer.str(action.FunctionCall.signer_id);
  }
  return new Uint8Array(writer.bytes);
}

/** The args of a function call, Borsh encoded. */
export function encodeArgs(values) {
  const writer = new Writer();
  for (const value of values) {
    if (typeof value === 'boolean') writer.u8(value ? 1 : 0);
    else if (typeof value === 'number' || typeof value === 'bigint') {
      if (BigInt(value) >= 0n && BigInt(value) <= 0xffffffffn) writer.u32(Number(value));
      else writer.u64(value);
    } else if (typeof value === 'string') writer.str(value);
    else throw new Error(`cannot encode ${typeof value}`);
  }
  return new Uint8Array(writer.bytes);
}

/** The account the wallet is connected as, or null. */
export function connectedAccount() {
  const params = new URLSearchParams(window.location.search);
  return params.get('accountId');
}

/**
 * Ask the wallet for an account.
 *
 * The wallet sends the reader back with the account id in the query string.
 */
export function connectWallet() {
  const redirect = new URL(window.location.href);
  redirect.searchParams.delete('allApps');
  redirect.searchParams.delete('accountId');
  redirect.searchParams.set('wallet', 'connect');
  const target = new URL(`${WALLET}/login`);
  target.searchParams.set('redirectUrl', redirect.toString());
  target.searchParams.set('allApps', 'false');
  window.location.href = target.toString();
}

/**
 * Ask the wallet to sign a function call, then send it.
 *
 * @param {object} options
 * @param {string} options.contract The contract to call.
 * @param {string} options.accountId The account that signs.
 * @param {string} options.method The method to call.
 * @param {Array} options.args The arguments, Borsh encoded by encodeArgs.
 * @param {string} options.publicKey The full access public key of the signer.
 */
export async function signAndSend({ contract, accountId, method, args, publicKey }) {
  const state = await readAccountState(accountId);
  const transaction = {
    actions: [
      {
        FunctionCall: {
          method_name: method,
          args: bytesToBase64(encodeArgs(args)),
          gas: '30000000000000',
          deposit: '0',
          signer_id: accountId,
        },
      },
    ],
    block_hash: bytesToBase64(state.blockHash),
    nonce: state.nonce,
    public_key: publicKey,
    receiver_id: contract,
    signature: '',
  };

  const redirect = new URL(window.location.href);
  redirect.searchParams.delete('signedTransactions');
  redirect.searchParams.delete('allApps');
  redirect.searchParams.set('wallet', 'sign');
  const target = new URL(`${WALLET}/sign-transaction`);
  target.searchParams.set('transactions', JSON.stringify([transaction]));
  target.searchParams.set('callbackUrl', redirect.toString());
  window.location.href = target.toString();
  return null;
}

/** The signed transactions the wallet sent back, if it did. */
export function signedTransactions() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('signedTransactions');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Send a signed transaction to the public RPC and wait for the receipt. */
export async function sendSigned(signed) {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'bound',
      method: 'broadcast_tx_commit',
      params: [signed],
    }),
  });
  const json = await response.json();
  if (json.error) {
    const name = json.error.cause?.name ?? json.error.name ?? 'RPC error';
    const info = json.error.cause?.info ?? json.error.data ?? '';
    throw new Error(`${name} ${typeof info === 'string' ? info : JSON.stringify(info)}`.trim());
  }
  return json.result;
}

/**
 * The nonce and the block hash a new transaction needs.
 *
 * The public testnet RPC has no block query, so the block hash comes from
 * view_state, which returns the hash of the block it read.
 */
export async function readAccountState(accountId) {
  const account = await query({ request_type: 'view_account', account_id: accountId, finality: 'final' });
  const state = await query({ request_type: 'view_state', account_id: accountId, finality: 'final' });
  const nonce = Number(account.nonce ?? 0) + 1;
  const blockHash = base58Decode(state.block_hash);
  const key = (account.keys ?? []).find((entry) => entry.access_key?.permission === 'FullAccess');
  return { nonce, blockHash, publicKey: key?.public_key ?? null };
}

/** One RPC query. */
async function query(params) {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'bound', method: 'query', params }),
  });
  const json = await response.json();
  if (json.error) {
    const name = json.error.cause?.name ?? json.error.name ?? 'RPC error';
    const info = json.error.cause?.info ?? json.error.data ?? '';
    throw new Error(`${name} ${typeof info === 'string' ? info : JSON.stringify(info)}`.trim());
  }
  return json.result;
}
