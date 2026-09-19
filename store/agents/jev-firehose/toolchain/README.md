# Toolchain

`jev.mjs` is the shared Jev client: a tiny, dependency-free wrapper for TypeSafe AI's "System One"
decision model (`POST /v1/systemone`), with a deterministic mock fallback so everything runs offline
and in tests.

- Without `TYPESAFE_API_KEY`, `evaluate()` returns deterministic, stable answers from a local mock —
  it exercises the plumbing (typed questions, probability shaping, confidence) exactly as live Jev
  would, but is **not** a stand-in for Jev's judgement.
- With `TYPESAFE_API_KEY` set, the same call hits the real model.

Three question types (see `jev.mjs` builders):

- `jev.noul("...")` — a yes/no probability (0..1).
- `jev.choice(options, "...")` — 1 of up to 255 options, plus per-option probabilities + confidence.
- `jev.score(legend, "...")` — a position on a 2..10 level scale.

`evaluate({ state, questions, key, model, salt })` returns `{ answers, model, client, usage }`,
with `answers[questionId]` shaped by question type. Use it to audition your piece design before you
commit to it — the viewer and any direct calls share the same client.

## Firehose tools

- `check.mjs` validates `firehose.json`: 2 to 24 teams, each with a description and at least 4
  phrases, and every number in range. It also warns about wording that will be hard to route, for
  example a phrase that shares more words with another team's description than with its own. It
  exits 1 on errors.
- `measure.mjs` scores a desk without the pane. It uses the same generator and the same five
  questions as the viewer, and prints accuracy and escalations at a range of thresholds, the lowest
  threshold that meets `targetAccuracy`, and the most confused team pairs. Flags: `--n 600`,
  `--noise 0.3`. Without a key it is free. With a key, each message is one real call.

Both tools accept `"source"` (the person's own messages). `check.mjs` then loads the file the way the
viewer will and reports the text column, the id column and the message count. `measure.mjs` samples
the file and prints the split at each threshold and the ids of the least confident messages. It
prints ids, never the text, and no accuracy, because there is no answer key.

Without `source`, all data these tools make is synthetic.

## Going live

Without a key everything runs on the offline stand-in and the pane says `MOCK`. For the real model,
give the harness a key. The viewer is started by the Harness daemon, which does not see variables
you export in a shell, so the reliable place is a small file in your home folder:

```sh
mkdir -p ~/.config/typesafe && chmod 700 ~/.config/typesafe
printf 'TYPESAFE_API_KEY=%s\n' 'paste-your-key-here' > ~/.config/typesafe/credentials
chmod 600 ~/.config/typesafe/credentials
```

Two routes work, and both speak the same question format:

| route | what goes in the file | where to get it |
|---|---|---|
| TypeSafe direct | `TYPESAFE_API_KEY=...` | https://console.typesafe.ai/keys (there may be a waitlist) |
| Cloudflare Workers AI | `CLOUDFLARE_ACCOUNT_ID=...` and `CLOUDFLARE_API_TOKEN=...` | a Cloudflare API token with Workers AI permission, no TypeSafe waitlist |

Environment variables of the same names win over the file. Restart the harness after changing the
file. `toolchain/doctor.sh` prints which route is active and never prints the key. One file serves
every Jev harness on the machine. Never paste a key into the chat, and never save one in the
workspace. Under `node --test`, or with `JEV_OFFLINE=1`, a key is ignored so tests stay deterministic.
