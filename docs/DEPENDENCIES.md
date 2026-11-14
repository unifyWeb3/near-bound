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

## Rust toolchain

- **Source:** https://github.com/rust-lang/rust (toolchain file `rust-toolchain.toml`)
- **Version:** 1.99.1
- **License:** MIT / Apache-2.0 (Rust dual license)
- **Used as:** the pinned toolchain for building, testing, formatting, and linting the `bound-contract` and `bound-policy` crates, with targets `wasm32-unknown-unknown` and components `rustfmt`, `clippy`
- **What it does not cover:** the Rust toolchain does not compile the console, run the shell demos, or produce the on-chain deployment. A deployment is not authorized in this work.

## Binaryen (wasm-opt)

- **Source:** https://github.com/WebAssembly/binaryen (release `version_133`)
- **Version:** 133 (`version_133`)
- **License:** MIT
- **Used as:** `wasm-opt`, invoked by `scripts/build-wasm.sh` with fixed flags `-Oz --enable-nontrapping-float-to-int --enable-bulk-memory` to optimize the contract Wasm deterministically
- **Archive sha256:** `2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489` for `binaryen-version_133-x86_64-linux.tar.gz`
- **Optimizer sha256:** `8f25e9fd5db0fc5f210003aaa432922feb2e52d309e430def2f929e34da9466b` for the extracted `wasm-opt`
- **What it does not cover:** Binaryen does not build the contract from source, and its output is not compared to the historical live Wasm hash. The remediation artifact is local only.

## near-sdk

- **Source:** https://github.com/near/near-sdk-rs (tag `5.30.0`)
- **Version:** 5.30.0
- **License:** MIT / Apache-2.0
- **Used as:** the contract framework for `bound-contract`; provides `near(contract_state)`, collections, `AccountId`, `NearToken`, `PromiseError`, and the mocked-chain unit-testing harness
- **What it does not cover:** near-sdk does not implement the policy rules (those live in `bound-policy`), does not run the console, and does not provide the wallet or the operator CLI.

## borsh

- **Source:** https://github.com/near/borsh
- **Version:** 1.8.1 in both lock files. The policy manifest allows the compatible 1.5 series, and the contract names 1.8.1 directly for its sidecar derives.
- **License:** MIT / Apache-2.0
- **Used as:** the serialization format for `bound-policy` state (`Policy`, `Request`, `Receipt`) and for `bound-contract` stored layouts and versioned sidecars; field order and types are part of the on-chain state layout
- **What it does not cover:** borsh does not validate economic policy, does not authenticate callers, and does not version the contract; enum variants must be appended, never inserted, to keep stored discriminants.

## near-parameters

- **Source:** https://github.com/near/near-sdk-rs (near-parameters, version `0.38.x`)
- **Version:** 0.38.x
- **License:** MIT / Apache-2.0
- **Used as:** a near-sdk transitive dependency used by the contract unit tests to rebuild the mocked chain with `RuntimeFeesConfig::test()`
- **What it does not cover:** near-parameters is only a test harness dependency; it is not part of the deployed Wasm and does not affect on-chain behavior.

## cargo-audit (dependency vulnerability check)

- **Source:** https://github.com/rustsec/cargo-audit
- **Version:** 0.23.0, installed with `cargo install --version 0.23.0 --locked` and verified before use
- **License:** MIT / Apache-2.0
- **Used as:** a read-only project step that audits the dependency trees of both crates for known vulnerabilities recorded in the RustSec advisory database
- **Installation:** `scripts/dependency-check.sh` keeps compiler artifacts in `$HOME/.cache/cargo-audit-build` by default and installs the pinned binary in `CARGO_HOME/bin`. Set `CARGO_AUDIT_BUILD_DIR` to override the artifact directory.
- **Advisory database:** the script runs `cargo audit update-db` before each check and treats a database update failure as a failed gate.
- **Failure behavior:** installation, advisory-database fetch and vulnerability findings all fail the gate. Informational outdated-dependency notices do not fail it.
- **What it does not cover:** cargo-audit does not audit the console's vendored JavaScript. It may install the pinned tool and fetch the public advisory database.

### Scoped test-only advisory

`RUSTSEC-2026-0387` affects `crypto-bigint` versions before `0.7.6`. The
contract lock file contains `crypto-bigint 0.5.5` through the unit-test-only
path `near-sdk unit-testing -> near-vm-runner -> p256 -> elliptic-curve`. It
is not present in the production Wasm dependency graph.

`scripts/dependency-check.sh` handles this without hiding a crate or advisory
class:

1. It resolves `cargo tree --locked --target wasm32-unknown-unknown --edges normal,build` and fails if an affected `crypto-bigint` version enters that graph.
2. It audits `bound-policy` without suppressions.
3. It audits `bound-contract` with only the exact advisory ID `RUSTSEC-2026-0387` ignored.
4. Every other contract advisory, a missing production dependency, and any failure to resolve that graph fail the gate.

This is a documented test-harness exception, not a claim that the upstream
crate is fixed. Remove it when the NEAR test stack can resolve a patched
`crypto-bigint` version of `0.7.6` or later.

## shellcheck (shell lint)

- **Source:** https://github.com/koalaman/shellcheck
- **Version:** v0.11.0, Linux x86_64 release archive
- **Archive sha256:** `8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198`
- **License:** GPL-3.0
- **Used as:** a CI step that lints `demo/agent.sh`, `demo/protocol_arm.sh`, `scripts/build-wasm.sh`, `scripts/dependency-check.sh`, `tests/fake-near/run.sh` and `tests/dependency-check/run.sh`
- **What it does not cover:** shellcheck does not execute the scripts, and it does not validate chain state or RPC responses.

## GitHub Actions

The workflow pins every action to an immutable commit:

| Action | Commit | Release |
| --- | --- | --- |
| `actions/checkout` | `11d5960a326750d5838078e36cf38b85af677262` | v4.4.0 |
| `dtolnay/rust-toolchain` | `d124f86f28ff42855784ff3319f48ac182c248f8` | Rust 1.99.1 |
| `actions/setup-node` | `49933ea5288caeca8642d1e84afbd3f7d6820020` | v4.4.0 |

## Console package lock

- **Package:** `certalyn-web-console` 1.0.0
- **Dependencies:** none
- **Lock file:** `web/package-lock.json`
- **Used as:** `npm ci --ignore-scripts` installs the exact empty dependency tree before the Node test suite.
- **What it does not cover:** the lock file does not replace the vendored wallet selector or fonts, whose versions and checksums are listed above.

## The console typefaces

- **Source:** https://github.com/fontsource/fontsource (packages `@fontsource/instrument-serif`, `@fontsource/inter`, `@fontsource/jetbrains-mono`)
- **Version:** the latin 400 and 500 woff2 files of each family, fetched from the pinned jsDelivr path of the package
- **License:** SIL Open Font License 1.1 for all three families
- **Used as:** `web/vendor/fonts/*.woff2`, loaded by `web/style.css`. Instrument Serif for the statements, Inter for the reading, JetBrains Mono for anything the chain produced
- **What it does not cover:** the files carry the latin subset only. A page in another script falls back to the system stack. The fonts add about 110 KB to the page and no request leaves the browser.

## borsh (contract)

- **Source:** https://github.com/near/borsh
- **Version:** 1.8.1, pinned in `contract/Cargo.toml`
- **License:** MIT OR Apache-2.0
- **Used as:** the direct derives for the sidecar structs stored outside the frozen state layout (`PeriodTotals`, `RequestMeta`, `NonceState`, `SchemaMarker`, `MigrationProgress` and `ReceiptIndexState`)
- **What it does not cover:** borsh does not validate economic policy, does not authenticate callers, and does not version the contract. Enum variants are appended, never inserted, so the stored discriminants keep their values.
