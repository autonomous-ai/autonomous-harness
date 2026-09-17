# Packages that live elsewhere

One JSON file per package whose code is in a repository of its own, at `<owner>/<name>.json`. The
built-in packages are not listed here: each `store/agents/<name>` and `store/viewers/<name>` folder is
its own entry, built from its `harness.json` and `store.json`.

```json
{ "id": "owner/name", "name": "Name", "category": "Thing", "description": "One line.",
  "author": "Who made it", "repo": "https://github.com/owner/name", "ref": "main",
  "engine": "claude", "tier": 2, "verified": false }
```

Optional: `kind` (`viewer` for a pane package), `path` (the package is one folder of `repo`),
`homepage`, `upstream`, `license`, `screenshots`. The schema is `DshRegistryEntrySchema` in
`cli/src/dsh/registry.ts`; an id that is also a built-in folder is refused.
