# Holdout

Holdout runs a paid coding agent inside a sealed CreateOS microVM, against a Stripe authorization hold.

- **The hold is the cost cap.** Before any machine exists, Stripe authorizes a $5.00 hold for each lane. No hold, no machine.
- **A live meter** bills sandbox-seconds and model tokens at posted demo rates while the agent works.
- **A fuse** refuses the next model call if it could push the bill past the hold, then destroys the VM at once.
- **Stripe captures only what was used** and releases the rest of the hold. Under 50 cents, the whole hold is released.

Live page: https://live-holdout.tyzo.nodeops.app (it opens on recorded run 1, labelled as a recording).

## What recorded run 1 shows (15:36 PT, real sandboxes, real Stripe-sandbox PaymentIntents)

One sealed VM, two lanes in turn (Free plan: one microVM at a time).

| Lane | Contractor | What happened | Stripe |
|---|---|---|---|
| A | honest: Claude Opus 5.5 through the 0G router | wrote `solution.py`, host check 3/3, accepted after 23.0 s metered | captured $1.31, released $3.69 |
| B | runaway: the same agent, model and prompt, plus one impossible line in the spec ("finish in under 0.5 ms") | rejected by the host check twice; the fuse refused its next call at 85.7 s (the next step was priced at $1.30); VM destroyed in 441 ms, measured | captured $4.76, released $0.24 |

Seal, as recorded: egress rule `192.0.2.1/32` set at create and read back verbatim; the first command's probes exited non-zero (https 28, raw_ip 7, dns 2).

## How it works

1. **Hold.** `stripe.paymentIntents.create` with `capture_method: "manual"` per lane, then `retrieve` must show `requires_capture`.
2. **Seal.** `Sandbox.create` with `egress: ["192.0.2.1/32"]` (a blackhole), readback, then a probe of three outbound paths as the first command. A box that fails the proof is destroyed before any agent byte reaches it.
3. **Work.** The model runs on our server; the VM is only its hands (`run_command`, `submit`). Agent commands run under `unshare -n` with a 25 s limit.
4. **Host check.** `submit` triggers our own check (visible examples plus fresh random inputs). Fail: the log goes back to the model. Pass: the lane is accepted.
5. **Fuse.** A 250 ms watchdog checks cost and time; before every model call a reservation (input estimate + max output + 10 s of sandbox) must fit inside the hold.
6. **Settle.** Capture the metered amount (rounded down), or cancel. A receipt (canonical JSON, SHA-256) goes into the PaymentIntent metadata as `receipt_sha256`; the page shows Stripe's own status from `retrieve`.

On the Free plan the run uses one VM: lane A works and settles, then `/work` is wiped and re-probed for lane B. If lane A trips, lane B is not run and its hold is cancelled.

## Posted demo rates (rc2)

At list prices a fuse cannot be shown in two minutes, so the meter bills a posted client price list, calibrated once on a dev VM (3 honest runs, 1 busy-loop run, 2 runaway runs):

| Item | Posted demo rate | List price, shown beside it (never billed) |
|---|---|---|
| Sandbox-second | $0.048 | CreateOS s-1vcpu-1gb, about $0.0000133 |
| Input tokens | $36 per million | Opus 5.5 first-party list, $4 per million |
| Output tokens | $180 per million | Opus 5.5 first-party list, $20 per million |

Caps: hold $5.00 per lane, time cap 120 s (busy-loop fixture: 40 s).

## Setup

Node 20. `npm install`, then create `.env.local` from `.env.example` (never commit it). Variable names:

`ROUTER_API_KEY`, `ROUTER_BASE_URL`, `MODEL`, `FALLBACK_MODEL`, `STRIPE_SECRET_KEY` (a Stripe sandbox secret key), `CREATEOS_SANDBOX_API_KEY`, `CREATEOS_SANDBOX_BASE_URL`, `ADMIN_TOKEN`, `HIDDEN_SEED`, `SEAL_RULE` (`192.0.2.1/32` or `240.0.0.0/4`; the server refuses to boot on anything else), `VM_MODE` (`fresh` or `reuse` with `DEV_VM_ID`), `CONCURRENCY`, `NOTARY`, `RUNAWAY`, `ON_TRIP`, `RATE_CARD`, `CREATE_CAP`, `FORCE_CREATE`, `PORT`.

```
npm test                 # 254 tests: VM adapter, agent loop, money, jobs, server, orchestrator (all on fakes)
npm run typecheck
npm start                # tsx src/server.ts on PORT (8080 when unset)
npx tsx scripts/run-cli.ts --url http://localhost:8787 --lanes honest,runaway   # one live run (admin token from .env.local)
npx tsx scripts/export-replay.ts <runId> --feature                              # label and feature a finished live run
bash scripts/deploy.sh   # deploys the committed tree (git archive HEAD) to CreateOS and promotes it
```

## Layout

`src/vm.ts` (the only CreateOS caller: seal, probe, exec, destroy, create ledger) · `src/agent.ts` and `src/contractors/` (tool loop and contractors) · `src/stripe.ts`, `src/meter.ts`, `src/fuse.ts`, `src/settle.ts` (hold, meter, fuse, capture math) · `src/jobs.ts` and `jobs/` (the CSV reconcile job and host check) · `src/run.ts` and `src/receipt.ts` (orchestrator and receipts) · `src/server.ts` and `src/bus.ts` (HTTP and events) · `public/` (dashboard) · `replays/` (recorded runs).

## Limits (what we observed and what we did not)

- **Stripe sandbox only.** Every PaymentIntent is in a Stripe sandbox account; no real money moves. The card is Stripe's `pm_card_visa`.
- **Two Stripe accounts.** The Stripe Projects stack (CreateOS project) is linked under account `acct_1URdITQ4vfpdXOAJ`; the authorization holds and captures run on a separate Stripe sandbox account.
- **Posted demo rates, not list prices.** The router's own token price is unverified; list prices are shown for comparison.
- **The seal proof covers what it probes.** Three outbound paths fail from inside the VM after the egress rule is set. It does not prove that no other channel exists. On the dev VM the cloud metadata address answered from the VM's own network namespace; agent commands run under `unshare -n`, where it did not (exit 7).
- **Timing varies with the router.** Single model turns took 5 to 30 s tonight, so the runaway's trip lands anywhere from about 58 s to 86 s of work in our runs; the 120 s time cap is the backstop.
- **Tokens of a call aborted in flight are not billed**, and teardown time is never billed.
- **Free plan:** one sealed VM per run, lanes in turn. With `CONCURRENCY=2` each lane gets its own VM (tested on fakes only).
- **Pay-on-proof (a second sealed VM that runs the artifact on hidden inputs before any capture) is designed but not built.**
- Recorded runs are labelled on the page; a replay is never shown as live.
