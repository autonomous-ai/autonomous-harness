# Getting listed

What to do once your endpoint implements the profile in `README.md`, and what to expect from us.

---

## 1. What you need first

| | |
|---|---|
| A public HTTPS endpoint | Not an IP address, not a tunnel, not "we'll expose it later". The machine's OWNER types this URL into our web app, so it has to be one you can publish in your own product |
| A test credential | So the checks below run against a real tenant rather than a stub. It travels as `Authorization: Bearer` — there is nothing to configure and nothing to declare |
| A named technical contact | Your endpoint backs every machine connected to it; when it goes down, they all go down at once |

**There is no SDK, and you do not need one.** The whole protocol is eight JSON-RPC methods over
HTTPS — smaller than a client library for it would be. This repository gives you the contract, a
scripted reference implementation, `example-provider/` as copyable prior art, and a runner that tells
you when you are done.

---

## 2. Prove it yourself

```bash
cd reference-provider && npm install
npm run conformance -- --url https://your-endpoint --key <test credential> \
                       --bad-key <deliberately invalid> --ask-phrase "<a prompt that makes it ask>"
```

**Zero failures is the bar.** Warnings and skips are expected, and each prints its reason.

The two extra flags unlock four more checks that need knowledge only you have: a credential you know
to be invalid, and a prompt that reliably makes your agent ask the user something.

If you are debugging your implementation by emailing us, something has gone wrong — the runner is
meant to answer that question without us.

### Read the skips, do not just count them

Six things cannot be verified from outside and become a written question instead. Each is named by
the check that skipped:

| Check | What we will ask you |
|---|---|
| `tenant-isolation` | How a credential is scoped — one credential must not reach another tenant's data |
| `transcript-truncation` | What happens to a transcript over your size ceiling: marked, or silently truncated |
| `no-fabricated-stats` | Whether any statistic is estimated rather than measured — omission is correct, a wrong number is not |
| `credential-not-logged` | Whether the credential we send is written to logs or forwarded anywhere |
| `attachments` | What an image attachment does — the runner can see the turn succeed, but not whether the image was read or quietly dropped |
| `agent-mutations` | Whether tenant scoping is enforced on **every** mutation, not only on the message path. (Declining to mutate at all is fine — answer `invalid_request` with a message we can show the user) |

---

## 3. Send us

- Your endpoint URL and the conformance output.
- Written answers to the four questions above.
- Your technical contact and an escalation path.

We review the endpoint's TLS configuration and how you handle the credential. Expect a conversation about data handling before anything is switched on: a provider
machine is **not end-to-end encrypted** — the plaintext originates on your side, and users are told
so plainly in our UI.

---

## 4. What happens next

1. We stage your endpoint against a small number of machines.
2. We soak it against real traffic — a full turn, cancellation (including a cancel in the first
   moment, which is what a client-minted `turnId` buys), a `turn_input_required` round trip resumed on the same
   `turnId`, a page refresh rebuilding the transcript, your endpoint going away and coming back, and
   a revoked credential reporting as *re-enter credential* rather than an outage.
3. It becomes selectable in the product.

"It worked once" is not a soak. One outage on your side takes down every machine behind it
simultaneously, and that blast radius is why this step exists.

---

## 5. If you stop

Tell us and we will stop offering your endpoint for new machines while existing ones keep working,
notify their owners with a date, and delete the stored credentials at the end of it. Existing
machines are then marked with a specific reason — never a generic failure.

---

## Questions

Open an issue at <https://github.com/autonomous-ai/autonomous-harness/issues>. Anything touching
credentials or a vulnerability goes to the address in `SECURITY.md` instead — not to the issue
tracker.
