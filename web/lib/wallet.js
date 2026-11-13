/**
 * The write layer. The reader's own NEAR wallet does the signing.
 *
 * The console reads the chain on its own. A write needs the reader's wallet,
 * so the page asks the wallet to sign a transaction and sends what comes back
 * to the public RPC. Nothing is sent to a server, because there is no server.
 *
 * The wallet list comes from the NEAR wallet selector's manifest, the same
 * list the community keeps, so a reader can pick the wallet they already use.
 */

import { RPC } from './deployment.js';

const CONNECTOR_SRC = './vendor/hot-connect.iife.js';

const MANIFEST_URL = new URL('../vendor/manifest.json', import.meta.url).toString();

const NEAR_WALLET = 'https://wallet.testnet.near.org';

/** The gas one call gets. */
export const GAS = '30000000000000';

let connectorPromise = null;
let manifestPromise = null;

/**
 * Load the wallet selector once.
 *
 * @returns {Promise<object>} The HOTConnect global.
 */
export function loadConnector() {
  if (connectorPromise) return connectorPromise;
  connectorPromise = new Promise((resolve, reject) => {
    if (window.HOTConnect) {
      resolve(window.HOTConnect);
      return;
    }
    const script = document.createElement('script');
    script.src = CONNECTOR_SRC;
    script.async = true;
    script.onload = () => {
      if (window.HOTConnect) resolve(window.HOTConnect);
      else reject(new Error('the wallet selector did not load'));
    };
    script.onerror = () => reject(new Error('the wallet selector could not be fetched'));
    document.head.append(script);
  });
  return connectorPromise;
}

/**
 * Whether a wallet can be used on a network, following the selector's own
 * rule: on testnet, a wallet must declare `features.testnet === true`.
 *
 * The manifest also marks mainnet only wallets with `features.mainnet === true`
 * and `features.testnet === false`, and some wallets declare neither network.
 * Those wallets open, then the wallet itself refuses, which is the failure the
 * reader sees as "not supported on testnet". Filtering here means the picker
 * only offers what the chosen network can actually use.
 *
 * @param {{features?: Record<string, unknown>}} wallet
 * @param {'mainnet'|'testnet'} network
 */
export function isWalletSupported(wallet, network) {
  const features = wallet.features ?? {};
  if (network === 'testnet') return features.testnet === true;
  return features.mainnet === true;
}

/**
 * The wallets a reader can pick from, for a network.
 *
 * @param {'mainnet'|'testnet'} [network]
 * @returns {Promise<{wallets: object[], unavailable: object[], error: string|null}>}
 */
export function listWallets(network = 'testnet') {
  if (manifestPromise) return manifestPromise;
  manifestPromise = (async () => {
    try {
      const response = await fetch(MANIFEST_URL, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`the wallet list answered ${response.status}`);
      const manifest = await response.json();
      const wallets = (manifest.wallets ?? []).filter((wallet) => wallet.id !== 'near-cli');
      return {
        wallets: wallets.filter((wallet) => isWalletSupported(wallet, network)),
        unavailable: wallets.filter((wallet) => !isWalletSupported(wallet, network)),
        error: null,
      };
    } catch (error) {
      return { wallets: [], unavailable: [], error: String(error.message ?? error) };
    }
  })();
  return manifestPromise;
}

let connector = null;

/**
 * The connector, built once.
 *
 * @returns {Promise<any>}
 */
async function getConnector() {
  if (connector) return connector;
  const HOTConnect = await loadConnector();
  connector = new HOTConnect.NearConnector({ network: 'testnet', manifest: MANIFEST_URL });
  return connector;
}

/**
 * The state of the wallet: connected, with the account and the wallet id.
 */
export const walletState = {
  status: 'idle',
  accountId: null,
  walletId: null,
  error: null,
};

/**
 * Ask the reader to pick a wallet and sign in.
 *
 * @param {{walletId?: string}} [options]
 * @returns {Promise<{accountId: string|null, walletId: string|null, error: string|null}>}
 */
export async function connectWallet({ walletId } = {}) {
  walletState.status = 'connecting';
  walletState.error = null;
  try {
    const connector = await getConnector();
    const wallet = await connector.connect(walletId ? { walletId } : {});
    const accounts = await wallet.getAccounts();
    const accountId = accounts?.[0]?.accountId ?? null;
    walletState.status = accountId ? 'connected' : 'idle';
    walletState.accountId = accountId;
    walletState.walletId = walletId ?? walletState.walletId;
    if (!accountId) throw new Error('the wallet returned no account');
    return { accountId, walletId: walletState.walletId, error: null };
  } catch (error) {
    walletState.status = 'idle';
    walletState.error = String(error?.message ?? error);
    return { accountId: null, walletId: null, error: walletState.error };
  }
}

/**
 * Sign out.
 */
export async function disconnectWallet() {
  walletState.status = 'idle';
  walletState.accountId = null;
  walletState.walletId = null;
  walletState.error = null;
}

/* -------------------------------------------------------------------------- */
/* The transaction bytes                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A little Borsh writer, enough for a function call.
 */
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
}

/**
 * The Borsh bytes of the arguments of a contract method.
 *
 * The contract's methods take plain types, so the arguments are Borsh encoded.
 * The wallet signs the bytes, which is what the chain expects.
 *
 * @param {Array<boolean|number|bigint|string>} values
 * @returns {Uint8Array}
 */
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

/**
 * Ask the wallet to sign one call on the contract and send it.
 *
 * @param {object} options
 * @param {{contract: string}} options.deployment
 * @param {string} options.method
 * @param {Array} options.args
 * @param {string} [options.accountId]
 * @returns {Promise<{hash: string|null, error: string|null}>}
 */
export async function signAndSend({ deployment, method, args, accountId }) {
  const signerId = accountId ?? walletState.accountId;
  if (!signerId) return { hash: null, error: 'no wallet is connected' };
  try {
    const connector = await getConnector();
    const wallet = await connector.connect({ walletId: walletState.walletId });
    const outcome = await wallet.signAndSendTransaction({
      signerId,
      receiverId: deployment.contract,
      actions: [
        {
          type: 'FunctionCall',
          params: {
            methodName: method,
            args: encodeArgs(args),
            gas: GAS,
            deposit: '0',
          },
        },
      ],
    });
    return { hash: outcome?.transaction?.hash ?? null, error: null };
  } catch (error) {
    return { hash: null, error: String(error?.message ?? error) };
  }
}

/**
 * The wallet's own sign in page, for a reader whose wallet is not in the
 * selector list. The wallet shows its own list of apps and wallets.
 */
export function openWalletSite() {
  const redirect = new URL(window.location.href);
  redirect.searchParams.delete('accountId');
  redirect.searchParams.delete('allApps');
  const target = new URL(`${NEAR_WALLET}/login`);
  target.searchParams.set('redirectUrl', redirect.toString());
  target.searchParams.set('allApps', 'true');
  window.location.href = target.toString();
}

/**
 * Send a signed transaction to the public RPC and wait for the receipt.
 *
 * @param {object} signed
 */
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
