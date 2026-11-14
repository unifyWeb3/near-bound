# The submission packet

Everything the NEAR HACKATHON entry needs, written and checked in this
repository. Nothing here was sent. The rules put the sending, the posting
and the three personal values in the builder's hands.

The rules live in the official file, which was read again on 2026-11-15:
<https://nearhackathon.com/HACKATHON.md>.

## The window has closed

| Fact | Value |
| --- | --- |
| Development ends, and the submission window closes | 2026-11-14T23:59:00Z |
| The time this packet was written | 2026-11-15T17:16Z |
| Judging starts | 2026-11-16T00:00:00Z |
| What the API does outside the window | It answers 403 and explains why, and the rules say to tell the human rather than retry |

No submission was made, and none was attempted. The window closed about
seventeen hours before this packet was written, so the builder has to ask
the organizers whether a late entry is possible. The form is at
<https://nearhackathon.com/#apply> and the request changes page, for an
entry that already exists, is at <https://nearhackathon.com/request-changes>.

Everything below is ready for that moment: the copy, the post and the
payload. Only three values and one line are missing, and all four are the
builder's to give.

## The idea field

The field takes twenty to two thousand characters. It asks for the problem,
the product and how NEAR fits in.

> An agent that can pay for APIs, data and compute has no ceiling on what it
> spends, and the ceiling it does have lives in a prompt, where it can be
> argued with. Certalyn moves that ceiling into a NEAR contract.
>
> The owner holds the money and sets a budget per period, a cap on one
> payment, a rate limit, the receivers the agent may pay and a kill switch.
> The agent holds a function call key that can only ask the contract to
> spend, and the contract decides. Every decision, allowed or refused, is
> written as a receipt with the rule that decided it, so a reader can check
> what happened without trusting the agent or the console.
>
> NEAR is the enforcement point. A protocol scoped key is what stops the
> agent from moving the money itself, even if the contract allowed it, and a
> shared ledger holds the money and the rules in the same place, so an agent
> that cannot change the rules cannot get around them. The contract, the
> console and the audit that closed the findings are open on testnet.

Counted: 987 characters, inside the twenty to two thousand the field
takes. The payload script checks the count of the text it sends.

## The demo post

The rules say the post says the project was built at NEAR HACKATHON, tags
@NEARProtocol and #NEARHackathon, and carries the demo video or
screenshots. The human publishes it. This is the draft, ready to post:

> I let an agent buy things. Then I checked the bill.
>
> Certalyn is a spend limit for an agent that pays. The owner holds the
> NEAR in a contract and sets a budget per hour, a cap on one payment, a
> rate limit and the receivers the agent may pay. The agent holds a key that
> can only ask. The contract decides, and every decision is a receipt you
> can read from the chain.
>
> One minute, one spend: the agent asks for 0.1 NEAR, the owner approves
> it, the transfer settles, and receipt 30 on testnet says Approved with the
> rule that decided it. Then a vendor that is not on the list is refused,
> and the money never moves.
>
> NEAR is what makes it stick. The agent's key is scoped by the protocol to
> one method, one receiver and a small allowance, so it cannot move money
> even if the contract allowed it. The money and the rules live in the same
> contract, so an agent that cannot change the rules cannot get around
> them.
>
> The live console, the source and every figure with the read that proves
> it: https://near-bound.vercel.app and
> https://github.com/unifyWeb3/near-bound
>
> Built at NEAR HACKATHON. @NEARProtocol #NEARHackathon
>
> One question for the people who have run agents with a real budget: what
> did you find the hard way, the cap on one payment or the rate? I would
> like to know which limit you would set first.

What the draft follows, and where it comes from:

| Rule from the event file | Where the draft answers it |
| --- | --- |
| Lead with the user problem, in a first line a stranger understands | "I let an agent buy things. Then I checked the bill." |
| Show one complete moment, a real action to a visible result | The agent asks, the owner approves, the transfer settles, receipt 30 says Approved |
| Explain NEAR's role concretely, not "powered by NEAR" | The protocol scoped key and the contract holding the money and the rules together |
| Give a next step and ask a genuine question | The console and the repository, then a question about which limit comes first |
| Tag @NEARProtocol and #NEARHackathon | The last line |

The video attaches to the post. The published video is
<https://youtu.be/MkUzLlyw50E>, and it was recorded before the design pass,
so it shows the console as it was then: the same product, the same palette
and the same flow, but not the current typography, the phase rail or the
state colours. That is a choice for the builder. Either the video stays
and the post says nothing about how the console looks, which it does not
now, or a new recording is made against the live console and the post
carries it. The earlier video, <https://youtu.be/E9JbF9TlKs4>, is titled
for the old name and is not used.

A recording of the console as it is now has been made, so the builder does
not have to make one by hand. It is 26 seconds of the live console at
1440 by 900, walking the six routes with a slow drift down each one, and
it was checked frame by frame: the sentence case labels, the state colour
on the margin rule, the phase rail and the corrected Evidence view are all
in it. The file is not in the repository, because the repository ignores
the video directory, and nothing was uploaded anywhere. The builder
attaches it to the post themselves.

To record it again, against a console that has changed since:

```bash
cd /path/to/near-bound
NODE_PATH=/tmp/certalyn-browser/node_modules node tests/browser/record.js
```

It writes `video/certalyn-console-demo.mp4` and publishes nothing.

## The payload

The rules say to send exactly these fields and nothing else, and never to
commit the payload because it carries personal data. The shape is below
with the values that are ready, the three that are the builder's, and the
one line that has to be agreed.

```json
{
  "requestId": "generated once with `uuidgen | tr A-Z a-z`, kept for a retry",
  "projectName": "Certalyn",
  "leadName": "the builder's name, 2 to 80 characters",
  "email": "the builder's address, at most 160 characters",
  "size": "1",
  "tracks": ["security", "agents"],
  "nearAddress": "the builder's mainnet account, 2 to 64 characters, lowercase",
  "projectUrl": "https://github.com/unifyWeb3/near-bound",
  "demoUrl": "https://x.com/oxunify/status/2120085871852478803",
  "idea": "the copy above",
  "consent": "true, after the builder agrees to the notice below"
}
```

The payload is built and checked by a script, which never sends anything and
never guesses a value:

```bash
python3 scripts/submission-payload.py --check
python3 scripts/submission-payload.py --lead-name "..." --email "..." \
  --near-address "..." --consent
```

The check mode reads the fields that need no human and is part of CI. The
full mode prints the payload and the command, for the builder to read before
they send it.

Every field is checked against the rules in the official file:

| Field | Value | Rule | Status |
| --- | --- | --- | --- |
| requestId | generated once | a UUID, reused on a retry | Ready to generate |
| projectName | Certalyn | 2 to 80 characters | Ready |
| leadName | open | 2 to 80 characters | The builder's |
| email | open | a valid address, at most 160 characters | The builder's |
| size | 1 | one of the six sizes | Ready, the team is one |
| tracks | security, agents | from the track table, each once | Ready, both fit |
| nearAddress | open | a mainnet account, 2 to 64 characters, lowercase | The builder's. Never create one for them |
| projectUrl | https://github.com/unifyWeb3/near-bound | an http(s) URL, at most 300 characters | Ready, the repository is public |
| demoUrl | the post the builder publishes | an http(s) URL, at most 300 characters | Ready once the post is up |
| idea | the copy above | 20 to 2000 characters | Ready, 987 characters |
| consent | true | only after the builder agrees to the notice | The builder's |

The consent notice, to be read to the builder word for word:

> I agree that the organizers may use these details to review our submission
> and contact us about this hackathon.

## What is left, and who owns it

| Item | Owner | Why it cannot be done here |
| --- | --- | --- |
| leadName | Builder | The rules say never to guess a personal value |
| email | Builder | The rules say never to guess a personal value. The builder said they would type it |
| nearAddress | Builder | The rules say never to create or invent a payout account |
| consent | Builder | The rules say the human has to agree to the notice |
| The post | Builder | The rules say the human publishes it. The draft is ready |
| The window | Builder | It closed at 2026-11-14T23:59:00Z. The builder asks the organizers |
