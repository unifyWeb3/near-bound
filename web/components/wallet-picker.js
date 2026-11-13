/**
 * The wallet picker.
 *
 * The list comes from the NEAR wallet selector's manifest, filtered to the
 * wallets that support the network in use, so the reader is only offered
 * wallets that can actually work there. Wallets that only support the other
 * network are shown as unavailable instead of failing on click.
 */

import { el } from '../lib/dom.js';
import { listWallets, connectWallet, openWalletSite } from '../lib/wallet.js';
import { openModal } from './modal.js';

/**
 * @typedef {object} Wallet
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {string} [icon]
 * @property {boolean} [disabled]
 * @property {string} [note]
 */

/**
 * Build one wallet button.
 *
 * @param {Wallet} wallet
 * @param {HTMLElement} grid The grid, for disabling siblings while connecting.
 * @param {{ setStatus: (text: string) => void, close: () => void }} modal
 * @param {(result: object) => void} onConnected
 */
function walletButton(wallet, grid, modal, onConnected) {
  const button = el('button', 'wallet-option', undefined, { type: 'button' });
  if (wallet.disabled) {
    button.disabled = true;
    button.classList.add('unavailable');
    button.setAttribute('aria-disabled', 'true');
  }
  const icon = el('img', 'wallet-icon');
  icon.src = wallet.icon ?? '';
  icon.alt = '';
  icon.loading = 'lazy';
  button.append(icon);
  const text = el('span', 'wallet-text');
  text.append(el('span', 'wallet-name', wallet.name));
  if (wallet.description) text.append(el('span', 'wallet-description', wallet.description));
  if (wallet.note) text.append(el('span', 'wallet-note', wallet.note));
  button.append(text);

  button.addEventListener('click', async () => {
    if (wallet.disabled) {
      modal.setStatus(`${wallet.name} ${wallet.note ?? 'is not available on this network'}.`);
      return;
    }
    button.classList.add('working');
    for (const other of grid.querySelectorAll('button:not(.unavailable)')) other.disabled = true;
    modal.setStatus(`Connecting to ${wallet.name}...`);
    const result = await connectWallet({ walletId: wallet.id });
    button.classList.remove('working');
    for (const other of grid.querySelectorAll('button:not(.unavailable)')) other.disabled = false;
    if (result.error) {
      modal.setStatus(`${wallet.name} could not connect: ${result.error}`);
      return;
    }
    modal.close();
    onConnected(result);
  });
  return button;
}

/**
 * Open the picker.
 *
 * @param {object} props
 * @param {(result: {accountId: string|null, walletId: string|null, error: string|null}) => void} props.onConnected
 * @param {'mainnet'|'testnet'} [props.network] The network the wallets should use.
 */
export function openWalletPicker({ onConnected, network = 'testnet' }) {
  const modal = openModal({
    title: 'Connect a NEAR wallet',
    description: `Pick the wallet you use on ${network}. The page never sees your keys.`,
    render: (body) => {
      body.append(el('p', 'muted small', 'Loading the wallet list...'));
    },
  });

  const render = async () => {
    const { wallets, unavailable, error } = await listWallets(network);
    modal.body.replaceChildren();

    if (wallets.length === 0 && unavailable.length === 0) {
      modal.body.append(
        el(
          'p',
          'error',
          `The wallet list could not be loaded${error ? `: ${error}` : ''}. You can still use the NEAR wallet site.`,
        ),
      );
      const fallback = el('button', 'button primary', 'Open the NEAR wallet site');
      fallback.addEventListener('click', () => {
        modal.close();
        openWalletSite();
      });
      modal.body.append(fallback);
      return;
    }

    const grid = el('div', 'wallet-grid');
    for (const wallet of wallets) {
      grid.append(walletButton(wallet, grid, modal, onConnected));
    }
    modal.body.append(grid);

    if (unavailable.length > 0) {
      const heading = el('h3', 'wallet-subtitle', `Not usable on ${network}`);
      modal.body.append(heading);
      const disabledGrid = el('div', 'wallet-grid wallet-grid-unavailable');
      for (const wallet of unavailable) {
        const note = wallet.features?.mainnet === true && wallet.features?.testnet === false
          ? 'mainnet only'
          : 'no testnet support';
        disabledGrid.append(walletButton({ ...wallet, disabled: true, note }, disabledGrid, modal, onConnected));
      }
      modal.body.append(disabledGrid);
    }

    modal.setStatus(`${wallets.length} wallets available on ${network}. The list comes from the NEAR wallet selector.`);
  };

  render();
  return modal;
}
