# Product name decision

Date: 2026-11-13

## Decision

The public product name is **Certalyn**.

The repository, crates, NEAR accounts, and deployed contract keep their technical identifiers:

- repository: `unifyWeb3/near-bound`
- crates: `bound-contract` and `bound-policy`
- contract and owner account: `bound-testnet-97685.testnet`
- agent account: `bound-agent.testnet`
- counterparty account: `bound-vendor.testnet`

The old public product name, SpendGuard, must not remain in current product copy. Historical source commits, the `submission-v1` tag, and old audit records keep their original names because changing history would damage the evidence chain.

## Uniqueness check

VERIFIED on 2026-11-13:

| Namespace | Query | Result |
| --- | --- | --- |
| GitHub repositories | `certalyn in:name` | 0 results |
| npm | `https://registry.npmjs.org/certalyn` | 404, no package |
| PyPI | `https://pypi.org/pypi/certalyn/json` | 404, no project |
| crates.io | `https://crates.io/api/v1/crates/certalyn` | 404, no crate |
| `.com` domains | Verisign RDAP for `certalyn.com` | 404, no registration record |

INFERRED: Certalyn has enough separation from the names checked to be a safer public project name. These checks do not establish trademark rights, search-engine uniqueness across every language, or future availability. A trademark search remains outside this check.

## Naming boundary

The rename applies to:

- README, docs, page titles, metadata, interface labels, and explanatory copy
- local cache namespaces such as `certalyn.deployment` and `certalyn.receipts`
- project descriptions and event submission copy

The rename does not apply to:

- Git history, old tags, or historical audit evidence
- deployed account and contract identifiers
- crate and package names that identify the implementation rather than the product
- historical hashes and transaction identifiers

## Reason

SpendGuard describes a common security-product category and has several unrelated projects using the same name. Certalyn is a distinct coined name that still fits the product's role as a control plane for agent spending. The technical `bound` identifiers explain the implementation without forcing a live deployment or account migration.
