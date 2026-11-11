#!/usr/bin/env python3
"""Generate docs/CLAIMS.md and check the live deployment against it.

Every number in the README comes from this script. Run it after the last
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
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RPC = "https://test.rpc.fastnear.com"
CONTRACT = "bound-testnet-97685.testnet"
AGENT = "bound-agent.testnet"
VENDOR = "bound-vendor.testnet"
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


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
    body = json.dumps({"jsonrpc": "2.0", "id": "1", "method": method, "params": params}).encode()
    request = urllib.request.Request(
        RPC, data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read())


def view(account, method, args):
    payload = {
        "request_type": "call_function",
        "account_id": account,
        "method_name": method,
        "args_base64": base64.b64encode(json.dumps(args).encode()).decode(),
        "finality": "final",
    }
    result = call("query", [payload])["result"]["result"]
    raw = bytes(result) if isinstance(result, list) else base64.b64decode(result)
    return json.loads(raw.decode())


def account(account_id):
    return call("query", ["view_account", account_id, {"finality": "final"}])["result"]


def keys(account_id):
    result = call("query", ["view_access_key_list", account_id, {"finality": "final"}])["result"]
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
        "contract_balance_yocto": contract["amount"],
        "contract_storage_bytes": contract["storage_usage"],
        "contract_key": (contract_key or {}).get("public_key"),
        "agent_balance_yocto": agent["amount"],
        "agent_key": (agent_key or {}).get("public_key"),
        "agent_key_allowance_yocto": function_call.get("allowance"),
        "agent_key_methods": function_call.get("method_names"),
        "agent_key_receiver": function_call.get("receiver_id"),
        "receipt_count": len(rows),
        "receipt_outcomes": outcomes,
        "policy": policy,
        "policy_budget_yocto": policy["budget"],
        "policy_max_single_yocto": policy["max_single_spend"],
        "policy_rate_limit": policy["rate_limit"],
        "policy_period_seconds": policy["period_seconds"],
        "policy_vendors": policy["vendors"],
        "policy_spent_yocto": policy["spent"],
        "policy_remaining_yocto": policy["remaining"],
        "test_functions_policy": test_count("policy/src/lib.rs"),
        "test_functions_contract": test_count("contract/src/tests.rs"),
        "receipt_sha256": {str(row["receipt_id"]): sha(json.dumps(row, sort_keys=True)) for row in rows[:12]},
        "transactions": transactions,
    }


CLAIM_ROWS = [
    ("contract code hash", "code_hash", "the chain", "near contract view-account"),
    ("contract code sha256", "code_sha256", "the chain", "near contract view-account"),
    ("contract balance", "contract_balance_yocto", "the chain", "near contract view-account"),
    ("contract storage bytes", "contract_storage_bytes", "the chain", "near contract view-account"),
    ("contract full access key", "contract_key", "the chain", "near contract view-access-key-list"),
    ("agent balance", "agent_balance_yocto", "the chain", "near contract view-account"),
    ("agent key", "agent_key", "the chain", "near contract view-access-key-list"),
    ("agent key allowance", "agent_key_allowance_yocto", "the chain", "near contract view-access-key-list"),
    ("agent key methods", "agent_key_methods", "the chain", "near contract view-access-key-list"),
    ("agent key receiver", "agent_key_receiver", "the chain", "near contract view-access-key-list"),
    ("receipts on chain", "receipt_count", "the chain", "near contract call-function get_receipt_count"),
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
    ("policy test functions", "test_functions_policy", "policy/src/lib.rs", "cd policy && cargo test --locked"),
    ("contract test functions", "test_functions_contract", "contract/src/tests.rs", "cd contract && cargo test --locked"),
]

VOLATILE = {
    "contract_balance_yocto",
    "policy_spent_yocto",
    "policy_remaining_yocto",
    "agent_balance_yocto",
    "agent_key_allowance_yocto",
    "receipt_count",
    "generated_at",
    "transactions",
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
    lines.append("Generated by `python3 scripts/claims.py`. Every number in the README comes from here.")
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
    lines.append("These are the receipts that were on chain before the contract was upgraded on 2026-11-11.")
    lines.append("Their sha256 is over the receipt as the chain returns it, with the keys in order.")
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
    lines.append("## Where the numbers come from")
    lines.append("")
    lines.append("The chain is the source of truth for every figure. The test counts come from the")
    lines.append("source, and `cargo test` says whether they pass. The transactions come from the")
    lines.append("demo runs recorded in `demo/transactions.json`.")
    lines.append("")
    return "\n".join(lines)


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
                for receipt_id, digest in value.items():
                    if data["receipt_sha256"].get(receipt_id) != digest:
                        problems.append(f"receipt {receipt_id} does not match the recorded sha256")
                continue
            if key == "policy":
                continue
            if data.get(key) != value:
                problems.append(f"{key}: recorded {value!r}, live {data.get(key)!r}")
        for key in ("budget", "max_single_spend", "rate_limit", "period_seconds", "vendors"):
            if expected["policy"].get(key) != data["policy"].get(key):
                problems.append(f"policy.{key}: recorded {expected['policy'].get(key)!r}, live {data['policy'].get(key)!r}")
        if problems:
            print("the live deployment does not match docs/claims.json")
            for problem in problems:
                print("  " + problem)
            return 1
        print(f"the live deployment matches docs/claims.json, {data['receipt_count']} receipts, code {data['code_hash']}")
        return 0

    if mode == "--record":
        with open(claims_path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=True)
            handle.write("\n")
        print("wrote docs/claims.json")

    with open(markdown_path, "w", encoding="utf-8") as handle:
        handle.write(render(data))
    with open(claims_path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(f"wrote docs/CLAIMS.md and docs/claims.json, read {data['generated_at']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
