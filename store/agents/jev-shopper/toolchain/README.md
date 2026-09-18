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
