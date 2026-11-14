#!/usr/bin/env python3
"""Generate docs/CLAIMS.md and check the historical deployment against it.

Every chain-derived figure in the README comes from this script. Source
constants and test counts are labelled separately. Run it after the last
on-chain transaction and commit what it writes.

    python3 scripts/claims.py            write docs/CLAIMS.md and docs/claims.json
    python3 scripts/claims.py --check    compare the live deployment with
                                         docs/claims.json and exit 1 on a
                                         difference
    python3 scripts/claims.py --record   write the expectations in
                                         docs/claims.json from the live chain

Only the standard library, so it runs anywhere with python3.
"""
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RPC = "https://test.rpc.fastnear.com"
CONTRACT = "bound-testnet-97685.testnet"
AGENT = "bound-agent.testnet"
VENDOR = "bound-vendor.testnet"
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

# The commit whose CI artifact is the wasm on chain. The artifact for this
# commit has the sha256 of the deployed code, which is in the claims below.
WASM_COMMIT = "187fd92843d3a73702e19e95d13a06c36661c8a2"


def b58decode(text):
    number = 0
    for char in text:
        number = number * 58 + ALPHABET.index(char)
    body = number.to_bytes((number.bit_length() + 7) // 8, "big")
    return b"\x00" * (len(text) - len(text.lstrip("1"))) + body


def b58encode(raw):
    number = int.from_bytes(raw, "big")
    out = ""
    while number:
        number, rest = divmod(number, 58)
        out = ALPHABET[rest] + out
    return "1" * (len(raw) - len(raw.lstrip(b"\x00"))) + out


def call(method, params):
    """The RPC wants params as an object, not a list."""
    body = json.dumps({"jsonrpc": "2.0", "id": "1", "method": method, "params": params}).encode()
    request = urllib.request.Request(
        RPC, data=body, headers={"Content-Type": "application/json"}
    )
    last_error = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read())
        except (urllib.error.URLError, ConnectionResetError, TimeoutError) as error:
            last_error = error
            if attempt < 3:
                time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"RPC request failed after four attempts: {last_error}") from last_error


def view(account, method, args):
    payload = {
        "request_type": "call_function",
        "account_id": account,
        "method_name": method,
        "args_base64": base64.b64encode(json.dumps(args).encode()).decode(),
        "finality": "final",
    }
    result = call("query", payload)["result"]["result"]
    raw = bytes(result) if isinstance(result, list) else base64.b64decode(result)
    return json.loads(raw.decode())


def account(account_id):
    return call("query", {"request_type": "view_account", "account_id": account_id, "finality": "final"})["result"]


def keys(account_id):
    result = call("query", {"request_type": "view_access_key_list", "account_id": account_id, "finality": "final"})["result"]
    return result.get("keys", result) if isinstance(result, dict) else result


def receipts():
    total = view(CONTRACT, "get_receipt_count", {})
    out = []
    for receipt_id in range(int(total)):
        out.append(view(CONTRACT, "get_receipt", {"receipt_id": receipt_id}))
    return out


def test_count(path):
    with open(os.path.join(ROOT, path), "r", encoding="utf-8") as handle:
        return len(re.findall(r"^\s*#\[test\]", handle.read(), re.MULTILINE))


def source_test_snapshot_sha256():
    """Identify the source files that define the recorded test counts."""
    digest = hashlib.sha256()
    for path in ("policy/src/lib.rs", "contract/src/tests.rs"):
        with open(os.path.join(ROOT, path), "rb") as handle:
            digest.update(path.encode())
            digest.update(b"\0")
            digest.update(handle.read())
            digest.update(b"\0")
    return digest.hexdigest()


def near(value):
    """yoctoNEAR as a NEAR string, without the float noise."""
    whole = value // 10**24
    frac = value % 10**24
    if frac == 0:
        return f"{whole} NEAR"
    digits = str(frac).zfill(24).rstrip("0")
    return f"{whole}.{digits} NEAR"


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def rpc_curl(params):
    """A one line curl that reads the chain, with no key and no explorer."""
    body = json.dumps(
        {"jsonrpc": "2.0", "id": "1", "method": "query", "params": params},
        separators=(",", ":"),
    )
    return f"curl -s -H 'Content-Type: application/json' {RPC} -d '{body}'"


def call_curl(method_name, args):
    return rpc_curl(
        {
            "request_type": "call_function",
            "account_id": CONTRACT,
            "method_name": method_name,
            "args_base64": base64.b64encode(json.dumps(args).encode()).decode(),
            "finality": "final",
        }
    )


def account_curl(account_id):
    return rpc_curl(
        {"request_type": "view_account", "account_id": account_id, "finality": "final"}
    )


def check_curl(check):
    """The read that shows what the transaction left behind."""
    kind = check.get("kind")
    if kind == "receipt":
        return call_curl("get_receipt", {"receipt_id": check["id"]})
    if kind == "request":
        return call_curl("get_request", {"request_id": check["id"]})
    if kind == "policy":
        return call_curl("get_policy", {"agent_id": AGENT})
    if kind == "kill_switch":
        return call_curl("get_kill_switch", {})
    if kind == "account":
        return account_curl(AGENT if check.get("account") == "agent" else CONTRACT)
    return None


def collect():
    contract = account(CONTRACT)
    agent = account(AGENT)
    agent_keys = keys(AGENT)
    contract_keys = keys(CONTRACT)
    policy = view(CONTRACT, "get_policy", {"agent_id": AGENT})
    rows = receipts()
    code_hash = contract["code_hash"]
    code_sha = b58decode(code_hash).hex()

    outcomes = {}
    for row in rows:
        outcomes[row["outcome"]] = outcomes.get(row["outcome"], 0) + 1

    agent_key = None
    for key in agent_keys:
        permission = key.get("access_key", {}).get("permission", {})
        if isinstance(permission, dict):
            agent_key = key
    agent_permission = (agent_key or {}).get("access_key", {}).get("permission", {})
    function_call = agent_permission.get("FunctionCall", {}) if isinstance(agent_permission, dict) else {}

    contract_key = None
    for key in contract_keys:
        if key.get("access_key", {}).get("permission") == "FullAccess":
            contract_key = key

    transactions = []
    path = os.path.join(ROOT, "demo", "transactions.json")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as handle:
            transactions = json.load(handle)["transactions"]

    return {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "code_hash": code_hash,
        "code_sha256": code_sha,
        "wasm_commit": WASM_COMMIT,
        "contract_balance_yocto": contract["amount"],
        "contract_storage_bytes": contract["storage_usage"],
        "contract_key": (contract_key or {}).get("public_key"),
        "agent_balance_yocto": agent["amount"],
        "agent_key": (agent_key or {}).get("public_key"),
        "agent_key_allowance_yocto": function_call.get("allowance"),
        "agent_key_methods": function_call.get("method_names"),
        "agent_key_receiver": function_call.get("receiver_id"),
        "historical_receipt_count": len(rows),
        "receipt_outcomes": outcomes,
        "policy": policy,
        "policy_budget_yocto": policy["budget"],
        "policy_max_single_yocto": policy["max_single_spend"],
        "policy_rate_limit": policy["rate_limit"],
        "policy_period_seconds": policy["period_seconds"],
        "policy_vendors": policy["vendors"],
        "policy_spent_yocto": policy["spent"],
        "policy_remaining_yocto": policy["remaining"],
        "source_test_functions_policy": test_count("policy/src/lib.rs"),
        "source_test_functions_contract": test_count("contract/src/tests.rs"),
        "source_test_snapshot_sha256": source_test_snapshot_sha256(),
        "receipt_sha256": {str(row["receipt_id"]): sha(json.dumps(row, sort_keys=True)) for row in rows[:12]},
        "transactions": transactions,
    }


CLAIM_ROWS = [
    ("contract code hash", "code_hash", "the chain", "near contract view-account"),
    ("contract code sha256", "code_sha256", "the chain", "near contract view-account"),
    ("the commit the deployed wasm was built from", "wasm_commit", "the CI artifact", "the artifact of this commit in the Actions run"),
    ("contract balance", "contract_balance_yocto", "the chain", "near contract view-account"),
    ("contract storage bytes", "contract_storage_bytes", "the chain", "near contract view-account"),
    ("contract full access key", "contract_key", "the chain", "near contract view-access-key-list"),
    ("agent balance", "agent_balance_yocto", "the chain", "near contract view-account"),
    ("agent key", "agent_key", "the chain", "near contract view-access-key-list"),
    ("agent key allowance", "agent_key_allowance_yocto", "the chain", "near contract view-access-key-list"),
    ("agent key methods", "agent_key_methods", "the chain", "near contract view-access-key-list"),
    ("agent key receiver", "agent_key_receiver", "the chain", "near contract view-access-key-list"),
    ("receipts on the historical deployment", "historical_receipt_count", "the chain", "near contract call-function get_receipt_count"),
    ("approved receipts", "receipt_outcomes.Approved", "the chain", "near contract call-function get_receipt"),
    ("denied receipts", "receipt_outcomes.Denied", "the chain", "near contract call-function get_receipt"),
    ("failed receipts", "receipt_outcomes.Failed", "the chain", "near contract call-function get_receipt"),
    ("policy budget", "policy_budget_yocto", "the chain", "near contract call-function get_policy"),
    ("policy cap on one payment", "policy_max_single_yocto", "the chain", "near contract call-function get_policy"),
    ("policy rate limit", "policy_rate_limit", "the chain", "near contract call-function get_policy"),
    ("policy period seconds", "policy_period_seconds", "the chain", "near contract call-function get_policy"),
    ("policy vendors", "policy_vendors", "the chain", "near contract call-function get_policy"),
    ("policy spent", "policy_spent_yocto", "the chain", "near contract call-function get_policy"),
    ("policy remaining", "policy_remaining_yocto", "the chain", "near contract call-function get_policy"),
    ("policy test functions", "source_test_functions_policy", "policy/src/lib.rs", "cd policy && cargo test --locked"),
    ("contract test functions", "source_test_functions_contract", "contract/src/tests.rs", "cd contract && cargo test --locked"),
    ("source test snapshot sha256", "source_test_snapshot_sha256", "policy/src/lib.rs and contract/src/tests.rs", "python3 scripts/claims.py --check"),
]

VOLATILE = {
    "contract_balance_yocto",
    "policy_spent_yocto",
    "policy_remaining_yocto",
    "agent_balance_yocto",
    "agent_key_allowance_yocto",
    "historical_receipt_count",
    "generated_at",
    "transactions",
}

# Policy fields that legitimately change between reads of the live deployment
# (period advances, spends accumulate, nonces and counters grow). They are
# ignored by --check but reported as rolling so nothing is silently skipped.
ROLLING_POLICY_FIELDS = {
    "period_start",
    "spent",
    "remaining",
    "rate_count",
    "last_nonce",
    "request_count",
}

# Policy invariants that must not drift between the recorded historical claim
# and the live deployment.
INVARIANT_POLICY_FIELDS = {
    "budget",
    "max_single_spend",
    "rate_limit",
    "period_seconds",
    "vendors",
    "revoked",
}


def lookup(data, path):
    if "." in path:
        head, tail = path.split(".", 1)
        value = data.get(head)
        if isinstance(value, dict):
            return value.get(tail)
        return None
    return data.get(path)


def render(data):
    lines = []
    lines.append("# Claims")
    lines.append("")
    lines.append("Generated by `python3 scripts/claims.py`. Every chain-derived figure in the README comes from here.")
    lines.append(f"Read from the chain on {data['generated_at']}.")
    lines.append("")
    lines.append("| Claim | Value | Source of truth | How to check it |")
    lines.append("| --- | --- | --- | --- |")
    for label, path, source, command in CLAIM_ROWS:
        value = lookup(data, path)
        if value is None:
            value = "0"
        if path.endswith("_yocto"):
            value = f"{value} yoctoNEAR ({near(int(value))})"
        elif isinstance(value, (dict, list)):
            value = ", ".join(str(item) for item in value)
        lines.append(f"| {label} | {value} | {source} | `{command}` |")
    lines.append("")
    lines.append("## The first twelve receipts")
    lines.append("")
    lines.append("These are the first twelve receipts retained by the historical deployment.")
    lines.append("Their sha256 values are recomputed from that chain, and")
    lines.append("`python3 scripts/claims.py --check` fails if one of them changed.")
    lines.append("The remediated source is undeployed and retains at most 10,000 receipts.")
    lines.append("")
    lines.append("| Receipt | sha256 |")
    lines.append("| --- | --- |")
    for receipt_id, digest in sorted(data["receipt_sha256"].items(), key=lambda item: int(item[0])):
        lines.append(f"| {receipt_id} | `{digest}` |")
    lines.append("")
    lines.append("## The demo transactions")
    lines.append("")
    lines.append("| What | Transaction | Result |")
    lines.append("| --- | --- | --- |")
    for item in data["transactions"]:
        lines.append(f"| {item['what']} | `{item['hash']}` | {item['result']} |")
    lines.append("")
    lines.append("Each of these has a curl in the evidence table of the README, one read")
    lines.append("of the public testnet RPC that shows what the transaction left behind.")
    lines.append("")
    lines.append("## Where the numbers come from")
    lines.append("")
    lines.append("The historical chain is the source of truth for chain-derived figures. The test")
    lines.append("counts come from the source, and `cargo test` says whether they pass. The")
    lines.append("transactions come from the demo runs recorded in `demo/transactions.json`.")
    lines.append("")
    return "\n".join(lines)


BRANCHES = {
    "the contract is upgraded in place, the state carried over": "testnet only",
    "the agent is given NEAR for gas": "testnet only",
    "the first of two requests for 1 NEAR": "testnet only",
    "the second of two requests for 1 NEAR": "testnet only",
    "the first of the two is approved": "testnet only",
    "the second of the two is approved": "testnet only",
    "the agent asks for 0.5 NEAR": "testnet only",
    "the owner freezes every agent": "testnet only",
    "the owner tries to approve while frozen": "testnet only",
    "the owner lifts the freeze": "testnet only",
    "the owner approves it": "testnet only",
    "the owner adds a vendor that does not exist": "testnet only",
    "the agent asks to pay the vendor that does not exist": "testnet only",
    "the owner removes the vendor that does not exist": "testnet only",
    "the protocol arm runs against the scoped key": "testnet only",
}


def evidence_section(data):
    """The README's evidence table, generated so the hashes cannot drift."""
    lines = []
    lines.append("| What | Transaction | Result | Branch |")
    lines.append("| --- | --- | --- | --- |")
    for item in data["transactions"]:
        link = f"[{item['hash'][:12]}](https://explorer.testnet.near.org/transactions/{item['hash']})"
        result = item["result"]
        check = item.get("check") or {}
        if check.get("code_hash"):
            result = (
                f"deployed, code hash {data['code_hash']}, "
                f"sha256 {data['code_sha256']}"
            )
        lines.append(f"| {item['what']} | {link} | {result} | {BRANCHES.get(item['what'], 'testnet only')} |")
    lines.append("")
    lines.append("Every row can be checked with the public testnet RPC, with no key and no")
    lines.append("explorer. Nearblocks answers a script with a 403, and the public RPC has")
    lines.append("no transaction status method, so each line below reads the state the")
    lines.append("transaction left behind. Run any of them as it is:")
    lines.append("")
    lines.append("```bash")
    for item in data["transactions"]:
        curl = check_curl(item.get("check") or {})
        if not curl:
            continue
        lines.append(f"# {item['what']}")
        lines.append(curl)
        lines.append("")
    lines.append("```")
    lines.append("")
    lines.append("Every one of these is on testnet. Nothing here has been run on mainnet, and")
    lines.append("nothing here can be: there is no mainnet deployment. The branch column says")
    lines.append("which. The mainnet branch of this project is not built.")
    return "\n".join(lines)


def write_evidence(data):
    """Write the README's evidence table.

    The markers are required. A README without them would lose the table
    silently, and the README points at it, so the generator stops instead of
    reporting success while the table is missing.
    """
    path = os.path.join(ROOT, "README.md")
    if not os.path.exists(path):
        raise SystemExit("README.md is missing, the evidence table cannot be written")
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()
    start = "<!-- evidence:start -->"
    end = "<!-- evidence:end -->"
    if start not in text or end not in text:
        raise SystemExit(
            "README.md has no evidence markers, so the evidence table cannot be written. "
            f"Add {start} and {end} around the table."
        )
    head, rest = text.split(start, 1)
    _, tail = rest.split(end, 1)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(head + start + "\n" + evidence_section(data) + "\n" + end + tail)
    return True


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    data = collect()
    claims_path = os.path.join(ROOT, "docs", "claims.json")
    markdown_path = os.path.join(ROOT, "docs", "CLAIMS.md")
    os.makedirs(os.path.dirname(claims_path), exist_ok=True)

    if mode == "--check":
        if not os.path.exists(claims_path):
            print("docs/claims.json is missing, run scripts/claims.py --record first")
            return 1
        with open(claims_path, "r", encoding="utf-8") as handle:
            expected = json.load(handle)
        problems = []
        for key, value in expected.items():
            if key in VOLATILE:
                continue
            if key == "receipt_sha256":
                # Historical immutable receipt hashes: every one must still match.
                for receipt_id, digest in value.items():
                    if data["receipt_sha256"].get(receipt_id) != digest:
                        problems.append(f"receipt {receipt_id} does not match the recorded sha256")
                continue
            if key in {
                "source_test_functions_policy",
                "source_test_functions_contract",
                "source_test_snapshot_sha256",
            }:
                if data.get(key) != value:
                    problems.append(
                        f"{key}: recorded {value!r}, source now has {data.get(key)!r}"
                    )
                continue
            if key == "policy":
                rolling = []
                for field in sorted(ROLLING_POLICY_FIELDS):
                    if field in expected["policy"] or field in data.get("policy", {}):
                        rolling.append(field)
                if rolling:
                    print("rolling policy fields ignored: " + ", ".join(rolling))
                for field in sorted(INVARIANT_POLICY_FIELDS):
                    if expected["policy"].get(field) != data["policy"].get(field):
                        problems.append(
                            f"policy.{field}: recorded {expected['policy'].get(field)!r}, "
                            f"live {data['policy'].get(field)!r}"
                        )
                continue
            if data.get(key) != value:
                problems.append(f"{key}: recorded {value!r}, live {data.get(key)!r}")
        if problems:
            print("the live deployment does not match docs/claims.json")
            for problem in problems:
                print("  " + problem)
            return 1
        source_tests = (
            f"source tests {data['source_test_functions_policy']} policy, "
            f"{data['source_test_functions_contract']} contract"
        )
        print(
            f"the live deployment matches docs/claims.json, "
            f"{data['historical_receipt_count']} receipts, code {data['code_hash']}; "
            f"{source_tests}"
        )
        return 0

    if mode == "--record":
        with open(claims_path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=True)
            handle.write("\n")
        print("wrote docs/claims.json")

    if write_evidence(data):
        print("wrote the evidence table in README.md")
    with open(markdown_path, "w", encoding="utf-8") as handle:
        handle.write(render(data))
    with open(claims_path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(f"wrote docs/CLAIMS.md and docs/claims.json, read {data['generated_at']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
