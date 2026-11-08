# SpendGuard demo film. Production brief

One sentence: An agent with an empty leash can be talked into paying, and Bound puts the leash on chain where anyone can verify it.

Audience: NEAR Hackathon judges and careful builders who will not open the repo on first sight.

Duration: about 80 seconds. 1280 x 720, 30 fps. Silent with captions, the way the X posts are consumed.

Assets (all real, exported from this repository):

- receipts and protocol errors: exact strings from the chain (`harness/defenses.js` and `README.md`)
- figures: from `results/table.md` and from the live chain, read 2026-11-08
- the policy card: from `bound/web/`, the design the builder approved
- the ledger glyph: the console favicon

What the film must not do: invent a screen that does not exist, invent numbers, or show a transaction we never signed.

Every frame is a deterministic function of (time, shot list, seed). Any operator can rerun the render.
