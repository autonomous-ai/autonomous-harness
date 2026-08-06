# Cross-implementation end-to-end

Two questions this answers that neither package can answer alone:

1. **Is the spec implementable, or merely self-consistent?** The conformance runner is run against
   `reference-provider` *and* `example-provider` — two independently written servers. A spec that only
   its own author's implementation satisfies has not been tested.
2. **Do the whole-stream properties hold?** A clause check sees one request. These see a turn:
   exactly one terminal frame, live events equal to history events, an `input_required` round trip, a
   cancel that lands before the turn starts, and a bad credential failing every method the same way.

```bash
npm install && npm test
```

`example-provider` is booted against a **fake `claude`** — a shell script emitting recorded
stream-json — so this needs no model, no network and no API key.
