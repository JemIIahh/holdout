# Holdout: submission

- **Live URL:** https://live-holdout.tyzo.nodeops.app
- **Repository:** https://github.com/JemIIahh/holdout
- **Stripe Projects stack:** https://projects.dev/s#v1:createos~project
- **Stripe account (Projects):** acct_1URdITQ4vfpdXOAJ

## One line

A paid coding agent runs inside a sealed CreateOS microVM against a Stripe authorization hold: a live meter, a fuse that destroys the VM at the cap, and Stripe captures only what was used.

## What the page shows

Recorded run 1 (15:36 PT, real sandboxes, real Stripe-sandbox PaymentIntents): the honest lane is accepted and captures $1.31 of a $5.00 hold; the runaway lane (same agent, one impossible line in the spec) is refused by the fuse at 85.7 s, its VM is destroyed in 441 ms (measured), and $4.76 is captured with $0.24 released.

Setup, env var names and limits are in README.md.
