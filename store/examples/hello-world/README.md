# Hello World

An agent and a viewer make your first OpenHarness harness. Ask **“Say hello to Ada”** and watch the
agent change the greeting in the Web Viewer beside its terminal.

The three working files are deliberately small:

- `harness.json` selects Codex, the instructions, a workspace template, and the shared Web Viewer.
- `AGENTS.md` teaches the agent to edit the greeting.
- `template/index.html` is the starting page. There is no build step.

From the OpenHarness repository root, with the `harness` CLI installed:

```bash
harness dsh install "$PWD/store/viewers/web-viewer" --link
harness dsh check store/examples/hello-world
harness dsh install "$PWD/store/examples/hello-world" --link
```

Linking the viewer first lets a source checkout use it before it is in a released registry.
Normal Store installations resolve shared viewers automatically.

Open **⌘N → Hello World** (under **More** if needed), choose **New project** on the same machine,
and ask it to say hello. You will need Codex installed and configured; embedded previews currently
require macOS. The package check itself does not need a model or account.

Make a copy, change its name and ID, then teach it another workflow. Start a new project to pick up
changed instructions or template files; existing project files are preserved. See the
[contribution guide](../../../CONTRIBUTING.md#your-first-harness) for how to share it.

## Credit and stewardship

An OpenHarness teaching example, MIT. It depends on the shared Web Viewer, which is reused rather
than installed again for each harness.
