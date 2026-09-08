# Video script

**2 to 4 minutes.** The platform rejects anything over four. Alex's own voice — AI narration is
banned, asked and answered in Discord on 6 September. No music. No speeding up video or audio; that
is an automatic disqualification.

**The kill is the demo. Everything else is setup.** Budget the time accordingly: about 40 seconds of
problem, then the rest is one continuous unbroken shot of the thing working.

---

## Before you record

- [ ] Wake the API — `curl https://deadman-server.onrender.com/health` — and **keep it warm**. Free
      tier sleeps after 15 minutes. A cold start mid-take looks exactly like the failure we claim to
      survive, which is the worst possible confusion to introduce.
- [ ] Check the seller and escrow balances. A hold costs the seller ~1.9 HBAR and the escrow needs
      float to execute refunds; running dry mid-take produces a revert that reads like a contract bug.
- [ ] Set the claim delay so you have a window to kill the server in:
      ```
      curl -X POST https://deadman-server.onrender.com/admin/dark \
        -H 'content-type: application/json' -H 'X-Admin-Token: <token>' \
        -d '{"on":false,"claimDelaySeconds":45}'
      ```
      `on:false` matters — the seller must be **willing**. Killing an unwilling seller proves nothing.
- [ ] Board open at https://deadman-board.onrender.com, large type, full screen.
- [ ] Render dashboard open in a second tab, on the `deadman-server` page, **Suspend** in reach.
- [ ] Keep the admin token out of frame.

---

## 0:00–0:20 — the problem, in one sentence

> "AI agents pay for API calls by themselves now, using x402. The agent pays, the server does the
> work, and returns the result. x402 protects the buyer right up until the moment of settlement —
> and then the seller has the money and there is no chargeback and nobody to complain to."

## 0:20–0:40 — why every existing answer needs a person

> "Every x402 escrow that exists has the same shape: if the seller doesn't deliver, somebody has to
> call a timeout. The buyer submits a receipt, or an auditor decides, or 'anyone can trigger it',
> which means someone must. We took that person out."
>
> "The payment settles into a hold. The hold books its own refund with the Hedera network. If the
> seller reveals the key they get paid and the refund is cancelled. If they don't — **nobody does
> anything**, and the network executes the refund itself."

Say the precise novelty here, or a Hedera judge will draw the comparison for you:

> "Hedera has had network-executed scheduled transfers since HIP-423. What's new is that a contract
> arms its own refund from inside the EVM, in the transaction that takes the money."

## 0:40–1:15 — one honest purchase

Run the agent. On screen: the 402, the payment, the hold appearing on the board.

> "The agent asks for a paid resource, gets a 402, pays five HBAR — and note the money goes to the
> escrow contract, not to me. The escrow immediately arms a refund sixty seconds out. The agent has
> the ciphertext and does not have the key."

Then the seller reveals:

> "I reveal the key on-chain, I get paid, and the refund is cancelled. That's the happy path."

## 1:15–2:30 — the kill. This is the demo.

Start a second purchase. As soon as the hold appears on the board:

> "Same again. The agent has paid, the refund is armed, and the countdown is running. My server is
> alive right now and it fully intends to reveal that key in forty-five seconds."

**Now hit Suspend in the Render dashboard, on camera.** Wait for the service to actually go down —
show it. Optionally curl the endpoint and let it fail on screen.

> "That's my server. It's gone. There is no backend, no cron job, no keeper, nothing of mine running
> anywhere."

Then say nothing and let the countdown run out. Silence is the right choice here; do not narrate over
it. The board keeps updating because it reads the Hedera mirror node directly from the browser and
never touched my server at all.

When the refund lands:

> "The network executed the refund. Signatures: empty. Nobody signed it, nobody submitted it, nobody
> pushed a button. The buyer has their money back and my infrastructure is still switched off."

Hold on `signatures: []` for a beat. **That field is the entire product.**

## 2:30–3:00 — the limits, said out loud

Volunteering limits is rewarded at this event; hiding them is not. This costs twenty seconds and
buys credibility for everything before it.

> "Three things we're not hiding. We guarantee delivery, not correctness — a seller can encrypt
> garbage, commit to the hash of that garbage, and get paid; we ship a tool that proves which
> commitment they broke, but it can't judge the content. Second, a hold costs about nine cents in
> gas, so this works for API calls worth a dollar and not for micro-payments. Third, the refund is
> armed one transaction after the money lands, not atomically — x402 on Hedera can't settle into a
> contract call, and we found that the hard way. All three are on the first screen of the README."

## 3:00 — close

> "Every x402 escrow needs someone to push a button. Ours is the only one where the protocol pushes
> it."

---

## Shooting notes

- **One continuous take for the kill.** Cutting between the suspend and the refund is the one edit
  that would make a judge doubt the whole thing.
- The visible clock on the board and the per-second countdown are there so the footage reads as real
  time. Do not crop them out.
- If the refund is slow, wait. Dead air is far better than a cut.
- Do not zoom or speed anything up. Automatic disqualification.
- Record the terminal and the board together if the resolution allows, or cut to the board once the
  purchase is made and stay there.
