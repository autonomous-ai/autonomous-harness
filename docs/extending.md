# Extending Harness

Every layer has a contract, a starter and a check. Domain harnesses have their own guide:
[`dsh/README.md`](../dsh/README.md), which also covers the second kind of package, a **viewer** —
a pane any number of agents point at with `viewer.use` — and the `author` every package names.

## Add your agent

Two paths. Both are first-class and both are in this repo.

|  | **CLI engine** | **API provider** |
|---|---|---|
| Your agent is | a command you run, anywhere `harness login` runs | a service on your own infrastructure |
| You write | a normalizer in TypeScript, here | an HTTP endpoint, in any language |
| You ship it | as a pull request to this repo | by deploying it yourself |
| Start at | [`cli/src/engines/README.md`](cli/src/engines/README.md) | [`provider/`](provider/README.md) |

A CLI engine touches about twenty shared files, and the engines README is that list in dependency
order. The one rule: every field name, event kind and tool name comes from a real recorded session of
the real binary, never inferred from another engine. If your agent writes nothing to disk, look at Amp:
its plugin writes the transcript, and from there it is an ordinary engine.

```bash
cd cli && npm install && npm run typecheck && npm test        # replay the recorded-session fixtures
```

An API provider implements eight JSON-RPC 2.0 methods over HTTPS with SSE for the one that streams:
`agent.list`, `agent.send`, `agent.history`, `turn.cancel`, `agent.create`, `agent.rename`,
`agent.delete`, `agent.recap`. No SDK, no discovery, no capability negotiation. The reference
implementation ships the conformance runner; zero failures is the bar.

```bash
cd provider/reference-provider && npm install && npm run dev            # http://127.0.0.1:4319
npm run conformance -- --url https://your-endpoint --key <credential>
```

## Add a terminal multiplexer

Harness watches tmux with nothing to configure. A second multiplexer is added beside tmux, not in
place of it. Before writing code, confirm two things: a process inside a pane can identify that pane
with a stable, multiplexer-namespaced id, and your tool's presence is detectable without running it,
so a machine that lacks it pays nothing. Then implement: list panes with PID and working directory,
send literal text and keys, capture a pane, display a message, create and kill sessions. Carry the new
pane identity through process discovery, registry persistence and hooks, and scrub it from recap
workers so they cannot register as phantom agents. The retired Herdr backend is still in the tree
(`cli/src/lib/herdrBackend.ts`) as the worked example of the contract; see
[Adding a multiplexer](CONTRIBUTING.md#adding-a-multiplexer).

```bash
cd cli && npm run test:tmux-real       # the real multiplexer discovery suite
```

## Palettes and appearance

Six palettes ship — graphite, dusk, midnight, slate, forest, ember — and each coordinates the
workspace chrome with the terminal defaults. They are values of `HarnessPalette` in
[`desktop/lib/shared/theme/color_palette.dart`](../desktop/lib/shared/theme/color_palette.dart); a
new one is one more value there, and it appears in Settings ▸ Appearance on its own. Terminal
colour schemes are `TerminalTheme` values in
[`desktop/lib/terminal/terminal_theme.dart`](../desktop/lib/terminal/terminal_theme.dart). Fonts and
sizes are settings, not code. `cd desktop && flutter test` is the bar.

## Keys

No code: `~/.config/harness/keybindings.jsonc`, watched and reloaded on save. [keyboard.md](keyboard.md)
has the format and the command ids.

## Automation

Anything on the same computer can drive the daemon over its loopback socket, with the same frames the
app and the web client use. [cli.md](cli.md#automation) lists them.
