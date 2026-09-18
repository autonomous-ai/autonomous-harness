# Keyboard

Every action has a key or a palette entry, and every key can be remapped.

The defaults, in the workspace:

| Keys | Action |
|---|---|
| ⌘N | New Harness |
| ⌘O | Open Harness — search sessions, tabs, machines, history; `>` for commands |
| ⇧⌘P | Command palette |
| ⌘B | Boss mode: describe a task, it picks the agent |
| ⌘P | Orchestrator: describe a project, coordinate background harnesses and live viewers |
| ⌘T · ⌘W · ⇧⌘T · ⇧⌘R | New tab · close tab · reopen last closed · rename tab |
| ⌘1 … ⌘9 | Select tab by position |
| ⇧⌘] · ⇧⌘[ · ⌃Tab · ⌃⇧Tab | Next · previous tab |
| ⌘] · ⌘[ · ⌘Y | Forward · back through visited agents · full history |
| ⌘H ⌘J ⌘K ⌘L · ⌘arrows | Focus the pane left · below · above · right |
| ⇧⌘arrows | Move the focused pane |
| ⌘R · ⌘D | Split right · split down |
| ⌘⏎ · ⌘; · ⇧⌘W | Zoom or restore · last pane · close pane |
| ⌘S | Layout palette |
| ⌘F · ⌘G · ⇧⌘G | Find in terminal · next · previous match |
| ⇧⌘I | Agents needing input |
| ⌘, · ⌘/ | Settings · keyboard shortcuts |

In a picker: ↓ ⌃N ⌃J and ↑ ⌃P ⌃K move, ⏎ opens, ⌘⏎ adds the result as a pane here, Esc or ⌃G closes.
The terminal keeps ⌘C, ⌘V, ⌘A, Esc, ⌥⏎ and ⌃C for itself. `pane.pin`, `pane.focus_1…9`,
`pane.resize`, `pane.reset_sizes`, `machine.link` and a few others ship unbound and are in the palette.

Remap anything in `~/.config/harness/keybindings.jsonc` (`$XDG_CONFIG_HOME` respected). The file is
JSONC: `{ "version": 1, "bindings": [{ "keys": "cmd+k cmd+l", "command": "pane.focus_right",
"when": "workspace" }] }`. Sequences are one to four strokes; `"command": null` unbinds a key or a
whole prefix; `when` is `workspace`, `terminal` or `picker`. The file is watched and reloaded on save;
a bad edit keeps the last good keymap and says what was wrong. **Keyboard shortcuts (⌘/)** lists the
effective bindings and **Open keyboard config** writes a commented template with every command id.
