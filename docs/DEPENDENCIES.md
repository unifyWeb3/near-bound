# Third-party dependencies

## @hot-labs/near-connect (wallet selector)

- **Source:** https://github.com/hot-dao/near-selector (tag `v0.12.0`)
- **Commit:** `5385297f1ebd21af648c99fa347eac28ba55d462`
- **Version:** 0.12.0, MIT license
- **Used as:** `web/vendor/hot-connect.iife.js`, a browser IIFE build exposing `window.HOTConnect`
- **Upstream file sha256 (before local MIT header):** `a0fdb22ab0d91d57e11f541a2899a8ec2bc70579e6524649d8320ff21146f59c`
- **What it does:** renders/loads the NEAR wallet selector sandbox, routes wallet calls to each wallet's executor, and lets the console ask the reader's wallet to sign transactions.
- **What it does not cover:** it does not know the Bound contract, does not read the chain, does not hold keys, and does not guarantee that a wallet is installed in the reader's browser or supports a network. Wallet services are operated by their publishers.

## NEAR wallet selector manifest (wallet registry snapshot)

- **Source:** https://github.com/hot-dao/near-selector/tree/v0.12.0/near-connect-main/repository/manifest.json
- **Commit:** `5385297f1ebd21af648c99fa347eac28ba55d462`
- **Version:** manifest 1.1.0, from selector release 0.12.0, MIT license
- **Used as:** `web/vendor/manifest.json` (sha256 `39bfb465417aeee4d2fd032cad963b2bee33e9bbf5f19777edde03543e10f5b1`)
- **What it does:** lists wallet ids, names, icons, websites, versions, permissions and feature flags for each supported wallet.
- **What it does not cover:** wallet availability, uptime, or the implementations loaded later from each wallet's executor URL. Executors and icons referenced inside the manifest are still fetched by the browser from the URLs the registry names. The console filters this snapshot to `features.testnet === true` wallets before offering them on testnet.

Both files are vendored so the console does not depend on a floating `main` branch. Updates must re-pin the tag/commit and repeat the console verification before redeploy.
