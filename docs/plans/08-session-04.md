# Session 04 — Alex is now doing the frontend and the review work himself

Read `docs/CODEMAP.md` and `STATUS.md` first. The contract, the x402 server, the
paying agent and `verify.ts` all work end to end on Hedera testnet. What follows is
everything that is left, in the order it has to happen.

The team changed. There is no frontend developer and no separate reviewer. Alex is
doing both. So the frontend has to be small enough for one person who is also
finishing the contract work, and the adversarial tests have to be written by the
same person who wrote the code — which means they must be written as attempts to
break it, not as confirmations that it works. Every test in section 4 must fail
first against a deliberately broken version before it counts.

Deadline: submission Sunday 13 September, 12:00 PM ET. Check-in #2 due Friday 11
September 05:59. Today is Tuesday.

---

## 1. Deploy the server publicly. Do this before anything else.

A live public deployment is a qualification gate for the Hedera track and for the
finalist track. `render.yaml` exists and has never been applied. A Dockerfile is
not a deployment. Right now the entire demo runs on Alex's laptop, which means at
this moment the project does not qualify.

- Apply the blueprint on Render, set the four `sync:false` secrets in the
  dashboard, deploy, confirm `/health` answers on the public URL.
- Run the full three-scenario suite against the public URL, not localhost: seller
  delivers, seller goes dark, server killed mid-hold. New hold ids, new schedule
  ids, recorded in `STATUS.md` with HashScan links.
- The kill test on the public host is the one that matters most, because it is the
  only version of it that is not "he stopped a process on his own machine". Use
  Render's own suspend, not a local kill.
- If Render's free tier cold-starts and breaks a timing assumption, find that now
  and not on Sunday. Write down what the cold start does to a 60-second deadline.
- Put the public URL in `README.md` and in `docs/checkins/02.md`.

Do not start section 2 until `/health` answers publicly.

## 2. `/web` — the live board

`/web` is an empty directory with a `.gitkeep`. It has to become the thing a judge
looks at while the demo runs.

The single most important design constraint: **the page must read the Hedera mirror
node directly from the browser.** No calls to our own backend, no server-side
rendering, nothing that goes through the resource server. The demo is killing our
own infrastructure and watching the buyer get refunded anyway. If the board dies
when the server dies, the demo destroys its own evidence. Static hosting only —
Vercel, Netlify, or GitHub Pages.

What it shows, per hold:

- hold id, state (OPEN / CLAIMED / REFUNDED), amount, deadline as a live countdown
- the armed schedule id, linked to HashScan
- when it resolved, and **by whom**: the refund line must say the network executed
  it, with `signatures: []` visible or linked. That field is the whole product.
- the commitments from `HoldOpened`, and the key from `Claimed` when it exists

Data path, and this is a trap that spike 8 already found: network-executed calls do
**not** appear under `/api/v1/contracts/{address}/results`. A refund that fired is
invisible there. The board must read the schedule record, take `executed_timestamp`,
then fetch `/api/v1/transactions?timestamp=`. Getting this wrong makes every refund
look like it never happened, which is the exact opposite of what the page is for.

Keep it one HTML file with inline JS if that is faster. Polling every few seconds
is fine. Do not build a framework app. Do not add a design system. It needs to be
legible in a screen recording at 720p, which means large type and high contrast,
and it needs a visible clock so the countdown reads as real time.

## 3. Privy

Second partner technology, and the smaller of the two integrations. Chain 296 is
not in viem's chain list, so `defineChain` it. Hedera accounts need an ECDSA key
and need activating before they have an EVM alias — the first transaction from a
fresh account costs ~2M gas, which is already measured in the spikes. Budget for
that in the funding step or the first purchase fails for a reason that has nothing
to do with our code.

- Privy server wallet as the buying agent's wallet, replacing the raw private key
  in `agent/`.
- A spend policy: cap per transaction at slightly above the 5 HBAR price plus gas.
  The policy is the point — an autonomous agent with a bounded wallet is the story
  Privy wants to hear, and it is also honest about what Deadman is for.
- Record in `STATUS.md` what activation actually cost and how long it took.

If Privy's server wallets cannot sign for chain 296 within an hour of trying, stop
and use an embedded wallet in the board instead. Do not spend a day on it. Write
down which one you used and why.

## 4. The adversarial tests Igor was going to write

These are the ones nobody has run. Write each as a test that fails against a
deliberately broken build first.

- **Claim and refund in the same second.** The open question carried since session
  01. Arm a hold, then have the seller call `claim` at the exact second the network
  fires the refund. Both paths must not pay. Prove which one wins and prove the
  loser cannot re-enter. This is the one that would embarrass us on stage.
- **The sweep path must never reach an open hold.** `free = balance - totalLocked -
  totalWithdrawable` is an attribution, not a lock. Prove with a test that a sweep
  cannot take a tinybar of a hold that is still open, including in the window
  between settlement crediting the contract and `openHold` running.
- **`refund` cannot revert after its state transition.** Force every failure mode
  in the payout: a recipient that reverts, a recipient that consumes all gas, a
  recipient that is a contract with no `receive`. Each must land in the credit
  fallback, and the hold must still be REFUNDED.
- **Double payout via a REFUSED `deleteSchedule`.** Spike 4 found that a rejected
  delete returns SUCCESS at the transaction level and reports refusal only in the
  return code. There is a guard. Prove the guard by removing it and watching the
  test fail.
- **The capacity-saturation branch on a real network has still never run.** It is
  covered by the mock only. Say so plainly in the README rather than implying
  coverage we do not have.
- **Reorder the seven-step server flow** and show each reordering breaks something
  specific. That is the argument for why `@x402/express` is unusable, and it should
  be a test, not a paragraph.

## 5. HCS receipts

Only if sections 1 through 4 are done. Write each hold's lifecycle to a Consensus
Service topic: opened, resolved, by whom. It strengthens the Hedera story and gives
the board a second data source. It is a nice-to-have and it is the first thing to
cut.

## 6. Submission material

- `docs/checkins/02.md` written **Thursday night**, not Friday morning. Due 05:59.
- README: the one-liner at the top, the public URL, the limits section (the ~$0.09
  per hold that rules out micro-payments, the correctness-vs-delivery scope, the
  one-transaction window where money is escrowed with no refund armed). Do not
  soften any of them. The limits section is the strongest evidence that the rest is
  measured.
- The prior-art table: x402 `upto` and `batch-settlement`, aegis-protocol, Pranesh's
  bonded escrow, Aegis402, Reckon402, Pinout — each with what it does and the fact
  that in every one of them a human or a service must call the timeout. Then
  Deadman: nobody.
- Video script, 2 to 4 minutes. Alex's own voice, no AI narration, no music, no
  speed-up. Structure: the problem in one sentence, the board on screen, kill the
  server on camera, watch the refund land with `signatures: []`, done. The kill is
  the demo. Everything else is setup.

## Working rules

- Commit as you go with real messages. The commit history is judged.
- Any plan you generate goes in `docs/plans/` and is committed before the code it
  describes.
- Append to `STATUS.md` at the end of every working session. It is the build log.
- When a measurement contradicts something in the docs, correct the docs in the
  same commit. Do not leave a softened version standing.
