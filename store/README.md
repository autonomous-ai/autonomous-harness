# The Harness Store's built-in shelf

Every package Autonomous maintains for the Harness Store lives here, one folder each:

```
store/
  agents/<name>/     a harness: an engine plus skills, toolchain, verdict, and usually a pane
  viewers/<name>/    a pane other packages name with viewer.use; never a tile of its own
```

The two kinds follow different contracts (`dsh/spec/README.md`), so the folder says which one a
package keeps. `kind` in its `harness.json` must agree with the folder it sits in.

## The rules a folder keeps

- **The folder is the upstream project's own name**, and the id is `autonomous/<folder>`: `mujoco`,
  `blender`, `text-to-cad`, `autonomous-circuit`. A wrapper never renames what it wraps.
- **A registry entry names the folder**: `dsh/registry/autonomous/<folder>.json` carries
  `"repo": "https://github.com/autonomous-ai/autonomous-harness"`, `"path": "store/<kind>/<folder>"`
  and the same name, kind, engine, category, author and description as the manifest.
  `cli/src/dsh/store.spec.ts` fails the build when the two disagree.
- **`harness dsh check` passes** on the folder as it is committed.
- **Credit travels with the code.** A `LICENSE` for the wrapper, the upstream's licence beside it
  when anything of theirs is in the folder, and a README whose "Credit and stewardship" section says
  whose project it is.
- **Fetch what is not ours to copy.** A compiler, a model zoo, a project's own skills without a
  licence to vendor, another team's repository: `toolchain/setup.sh` fetches it at a pinned version
  (named in the folder's `VERSIONS`) into an ignored directory, never into git.

## Installing one

A user presses Get in the store; the daemon makes a sparse, blob-less clone of this repository,
keeps the one folder, and runs its setup. From a terminal:

```sh
harness dsh install autonomous/typst                              # from the registry
harness dsh install "$PWD/store/agents/typst" --link              # this working tree, for development
HARNESS_STORE_REF=my-branch harness start                         # the shelf from a pushed branch
```

## Leaving

A package that outgrows this folder, or whose upstream maintainers want it, moves to a repository
of its own and its registry entry points there instead (`repo`, no `path`). Nothing else changes for
the people who installed it.
