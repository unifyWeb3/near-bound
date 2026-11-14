#!/usr/bin/env python3
"""Build and check the NEAR HACKATHON submission payload.

The event rules put the personal values, the consent and the sending in the
human's hands. This script never sends anything and never guesses a value.
It builds the payload, checks every field against the rules in the official
file, and prints it for the human to read before they send it themselves.

    python3 scripts/submission-payload.py --check
    python3 scripts/submission-payload.py --lead-name "Ada Lovelace" \
        --email "ada@example.com" --near-address "ada.near" --consent

The check mode reads the static fields from the repository and is safe to
run in CI. The full mode needs the three personal values and the consent,
and it prints the payload and the curl command. It never calls the API.

The rules: https://nearhackathon.com/HACKATHON.md
"""
import argparse
import json
import os
import re
import sys
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PROJECT_NAME = "Certalyn"
PROJECT_URL = "https://github.com/unifyWeb3/near-bound"
SIZE = "1"
TRACKS = ["security", "agents"]
ALLOWED_SIZES = {"1", "2 - 4", "4 - 6", "6 - 8", "8+"}
ALLOWED_TRACKS = {
    "defi", "thesis", "privacy", "business", "swarms", "security", "agents",
    "realworld", "games", "nfts", "memecoins", "social", "open",
}
NEAR_ADDRESS = re.compile(r"^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$")
IDEA = (
    "An agent that can pay for APIs, data and compute has no ceiling on what it "
    "spends, and the ceiling it does have lives in a prompt, where it can be "
    "argued with. Certalyn moves that ceiling into a NEAR contract.\n\n"
    "The owner holds the money and sets a budget per period, a cap on one "
    "payment, a rate limit, the receivers the agent may pay and a kill "
    "switch. The agent holds a function call key that can only ask the "
    "contract to spend, and the contract decides. Every decision, allowed or "
    "refused, is written as a receipt with the rule that decided it, so a "
    "reader can check what happened without trusting the agent or the "
    "console.\n\n"
    "NEAR is the enforcement point. A protocol scoped key is what stops the "
    "agent from moving the money itself, even if the contract allowed it, and "
    "a shared ledger holds the money and the rules in the same place, so an "
    "agent that cannot change the rules cannot get around them. The "
    "contract, the console and the audit that closed the findings are open on "
    "testnet."
)


def read_demo_url():
    """The demo post the builder published, from the packet."""
    path = os.path.join(ROOT, "docs", "SUBMISSION.md")
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()
    match = re.search(r"https://x\.com/[^\s`)]+/status/\d+", text)
    return match.group(0) if match else ""


def check_static(demo_url):
    """Every field that does not need the human."""
    problems = []
    if not 2 <= len(PROJECT_NAME) <= 80:
        problems.append(f"projectName is {len(PROJECT_NAME)} characters")
    if SIZE not in ALLOWED_SIZES:
        problems.append(f"size {SIZE!r} is not one of the six sizes")
    for track in TRACKS:
        if track not in ALLOWED_TRACKS:
            problems.append(f"track {track!r} is not in the track table")
    if len(set(TRACKS)) != len(TRACKS):
        problems.append("a track is listed twice")
    if len(PROJECT_URL) > 300 or not PROJECT_URL.startswith("https://"):
        problems.append("projectUrl is not an http(s) URL of at most 300 characters")
    if not 20 <= len(IDEA) <= 2000:
        problems.append(f"the idea is {len(IDEA)} characters, the field takes 20 to 2000")
    if not demo_url:
        problems.append("no demo post link was found in docs/SUBMISSION.md")
    elif len(demo_url) > 300 or not demo_url.startswith("https://"):
        problems.append("demoUrl is not an http(s) URL of at most 300 characters")
    return problems


def check_personal(lead_name, email, near_address):
    problems = []
    if not 2 <= len(lead_name) <= 80:
        problems.append(f"leadName is {len(lead_name)} characters, the field takes 2 to 80")
    if not email or len(email) > 160 or "@" not in email or email.startswith("@") or email.endswith("@"):
        problems.append("email is not a valid address of at most 160 characters")
    if not 2 <= len(near_address) <= 64:
        problems.append(f"nearAddress is {len(near_address)} characters, the field takes 2 to 64")
    elif not NEAR_ADDRESS.match(near_address):
        problems.append("nearAddress is not a lowercase NEAR account name")
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="check the fields that need no human")
    parser.add_argument("--lead-name", help="the team lead's name")
    parser.add_argument("--email", help="the contact email")
    parser.add_argument("--near-address", help="the mainnet account for the prize")
    parser.add_argument("--demo-url", help="the demo post, when it differs from the packet")
    parser.add_argument("--request-id", help="the request id, generated once and reused")
    parser.add_argument(
        "--consent",
        action="store_true",
        help="the builder agreed to the contact notice",
    )
    args = parser.parse_args()

    demo_url = args.demo_url or read_demo_url()
    problems = check_static(demo_url)

    if args.check:
        if problems:
            print("the payload has problems:")
            for problem in problems:
                print("  " + problem)
            return 1
        print(
            "the static fields hold: projectName, size, tracks, projectUrl, "
            f"demoUrl, and an idea of {len(IDEA)} characters"
        )
        print("the lead name, the email, the payout account and the consent are the builder's")
        return 0

    missing = [
        name
        for name, value in [
            ("--lead-name", args.lead_name),
            ("--email", args.email),
            ("--near-address", args.near_address),
        ]
        if not value
    ]
    if missing:
        print("these values are the builder's and were not given: " + ", ".join(missing))
        print("the rules say never to guess them")
        return 2
    if not args.consent:
        print(
            "the consent notice has to be read to the builder first:\n"
            "  I agree that the organizers may use these details to review our "
            "submission and contact us about this hackathon."
        )
        return 2

    problems.extend(check_personal(args.lead_name, args.email, args.near_address))
    if problems:
        print("the payload has problems:")
        for problem in problems:
            print("  " + problem)
        return 1

    request_id = args.request_id or str(uuid.uuid4())
    payload = {
        "requestId": request_id,
        "projectName": PROJECT_NAME,
        "leadName": args.lead_name,
        "email": args.email,
        "size": SIZE,
        "tracks": TRACKS,
        "nearAddress": args.near_address,
        "projectUrl": PROJECT_URL,
        "demoUrl": demo_url,
        "idea": IDEA,
        "consent": True,
    }
    print("the payload, exactly as it would be sent:")
    print(json.dumps(payload, indent=2))
    print()
    print("the request id is generated once. Keep it, and reuse it for a retry:")
    print(f"  {request_id}")
    print()
    print("the command the builder runs, after reading the payload above:")
    print(
        "  curl -sS -X POST https://nearhackathon.com/api/applications \\\n"
        "    -H 'Content-Type: application/json' \\\n"
        f"    -d '{json.dumps(payload, separators=(',', ':'))}'"
    )
    print()
    print("nothing was sent by this script, and the window is closed:")
    print("  the API answers 403 outside 2026-11-01T00:00:00Z to 2026-11-14T23:59:00Z")
    return 0


if __name__ == "__main__":
    sys.exit(main())
