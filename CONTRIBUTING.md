# Contributing

Two kinds of contribution land here, and they have different bars.

**Adding an agent framework** is the code path, and it is welcome — see
[`cli/src/engines/README.md`](cli/src/engines/README.md) for the whole job in dependency order. Open
an issue first with a recorded session from the real binary; that recording decides most of the
design, and it is the difference between an engine that works and one that fails silently.

**Everything about the provider spec** is below, where the most useful contributions are usually not
code at all.

## Conventions across this repository

- **Specs are numbered.** Every normative statement has a stable id, so a failure can point at a
  clause rather than a symptom, and a conformance runner can assert one check per id.
- **Specs are compatibility contracts.** Optional fields may be added; nothing published is renamed,
  removed, retyped or reinterpreted without a new revision served alongside the old one.
- **Reference implementations carry no runtime dependencies.** You should be able to read one end to
  end and know what your own implementation has to do, without installing anything to understand it.

## Found a gap in the spec?

Say so. The profile is written against one product's needs, and the first partners to implement it
will find things it does not answer. An operation that is neither Tier 0, nor a named extension, nor
explicitly out of scope is a **gap**, not an implicit "no" — Appendix C of `spec/README.md` is the
audit that is supposed to catch those, and it is not infallible.

Open an issue quoting the clause id (`HP-xxx`), or the absence of one.

## Found a clause the runner cannot actually check?

Even more useful. A conformance suite that reports PASS for something it never tested is worse than
one that admits it cannot. If a check is green for the wrong reason, that is a bug in the runner.

## Changing the spec

It is a compatibility contract, and the rules in §12 are binding:

- Optional fields **may** be added to a published revision.
- A published field **must not** be renamed, removed, retyped, or reinterpreted.
- Anything else needs a new revision, served alongside its predecessor for a deprecation window.

Every normative statement gets a stable `HP-xxx` id, and a new one needs a matching check in
`reference-provider/src/conformance.ts` — or an explicit SKIP saying why it cannot be verified from
outside. Silence is not an option; that rule is the reason the suite is trustworthy.

## Code

```bash
cd reference-provider && npm install && npm run typecheck && npm test
```

Both packages have **no runtime dependencies** and that is a constraint, not an accident: a partner
should be able to read the reference implementation end to end without installing anything to
understand it. A pull request that adds one needs to argue for it.

`example-provider` needs a real `claude` CLI and a live model, so CI runs its typecheck and unit
tests only — never its end-to-end path. Its unit tests replay a **recorded** turn; do not replace
those fixtures with hand-written JSON. Two real bugs in that mapper were invisible to invented
fixtures and obvious the moment a real turn was replayed.
