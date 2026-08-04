# Getting listed

What to do once your endpoint implements the profile in `README.md`, and what to expect from us.

---

## 1. What you need first

| | |
|---|---|
| A public HTTPS endpoint | HP-010. Not an IP address, not a tunnel, not "we'll expose it later" |
| An Agent Card at `/.well-known/agent-card.json` | HP-020 |
| A test credential | So the checks below run against a real tenant rather than a stub |
| A named technical contact | Your endpoint backs every harness connected to it; when it goes down, they all go down at once |

**You do not need an SDK from us.** A2A v1.0 ships official SDKs for Python, JavaScript, Java, Go and
.NET — use the one for your stack. What this repository gives you instead is the contract, a working
reference implementation, and a runner that tells you when you are done.

---

## 2. Prove it yourself

```bash
cd reference-provider && npm install
npm run conformance -- --url https://your-endpoint --key <test credential> \
                       --bad-key <deliberately invalid> --ask-phrase "<a prompt that makes it ask>"
```

**Zero failures is the bar.** Warnings and skips are expected, and each prints its reason.

The two extra flags unlock three more clauses that need knowledge only you have: a credential you know
to be invalid (HP-013), and a prompt that reliably makes your agent ask the user something
(HP-103, HP-104).

If you are debugging your implementation by emailing us, something has gone wrong — the runner is
meant to answer that question without us.

### Read the skips, do not just count them

Four clauses cannot be verified from outside and become a written question instead:

| Clause | What we will ask you |
|---|---|
| **HP-012** | How a credential is scoped — one credential must not reach another tenant's data |
| **HP-203** | What happens to a transcript over the size ceiling: marked, or silently truncated |
| **HP-220** | Whether any statistic is estimated rather than measured — omission is correct, a wrong number is not |
| **HP-903** | Whether the credential we send is written to logs or forwarded anywhere |

---

## 3. Send us

- Your endpoint URL and the conformance output.
- Written answers to the four questions above.
- Your technical contact and an escalation path.

We review the endpoint's TLS configuration, its declared `securitySchemes`, and how it handles the
credential. Expect a conversation about data handling before anything is switched on: a provider
harness is **not end-to-end encrypted** — the plaintext originates on your side, and users are told
so plainly in our UI.

We will also ask you to plan for a **signed Agent Card** (HP-004). The card is this profile's single
source of truth for capability, so signing it is what makes that trust verifiable.

---

## 4. What happens next

1. We add your endpoint to our provider registry, initially in staging.
2. We soak it against real traffic on a small number of harnesses — a full turn, cancellation, an
   `INPUT_REQUIRED` round trip, a page refresh rebuilding the transcript, your endpoint going away and
   coming back, and a revoked credential reporting as *re-enter credential* rather than an outage.
3. It becomes selectable in the product.

"It worked once" is not a soak. One outage on your side takes down every harness behind it
simultaneously, and that blast radius is why this step exists.

---

## 5. If you stop

Tell us and we will stop offering your endpoint to new harnesses while existing ones keep working,
notify their owners with a date, and delete the stored credentials at the end of it. Existing
harnesses are then marked with a specific reason — never a generic failure.

---

## Questions

Open an issue at <https://github.com/autonomous-ai/autonomous-harness/issues>. Anything touching
credentials or a vulnerability goes to the address in `SECURITY.md` instead — not to the issue
tracker.
