# What Harness should learn from developers' daily tools

Research and source audit: 2026-09-12. Recommendation for the existing `app-v2` build.

Harness should make three things excellent: **keep work alive, reach any work instantly, and steer agents without losing concentration.** A developer should be able to spend a whole day here, using their existing agents, shell, editor and commands.

This is a qualitative sample of firsthand accounts and tool authors' documentation, not a survey of all exceptional developers. “World-class” has no objective tool list. Publication dates matter: several authors have changed their workflows. Product documentation establishes advertised behavior; it does not independently establish performance, reliability or developer affection.

## What people actually describe using

| Developer / primary evidence | Tools and behavior in the account | What Harness can learn |
| --- | --- | --- |
| **Mitchell Hashimoto**, [AI adoption journey, February 2026](https://mitchellh.com/writing/my-ai-adoption-journey) | Describes learning Claude Code, later using Amp, giving agents verification tools and keeping background work going. Explicitly turns off agent desktop notifications to protect deep work. | Preserve the developer's control of attention. Make waiting work easy to find voluntarily. Give agents fast access to the project's real verification commands. |
| **ThePrimeagen**, [tmux-sessionizer source and personal mappings](https://github.com/ThePrimeagen/tmux-sessionizer) and [Harpoon](https://github.com/ThePrimeagen/harpoon/tree/harpoon2), inspected September 2026 | Connects tmux, fzf, Vim and zsh mappings. Sessionizer reaches project sessions; Harpoon gives frequently used destinations direct keys. | Search is useful for unfamiliar destinations; repeated movement should become a direct jump. Switching to existing work should not create another copy of it. |
| **Julia Evans**, [fish, September 2024](https://jvns.ca/blog/2024/09/12/reasons-i--still--love-fish/) and [Helix, October 2025](https://jvns.ca/blog/2025/10/10/notes-on-switching-to-helix-from-vim/) | Praises fish's defaults, completion, history and multiline paste. After years of Vim/Neovim, tries Helix because language features work with less configuration. | Excellent defaults matter alongside customization. Keyboard fluency should not require maintaining a large configuration or relearning ordinary text entry. |
| **Peter Steinberger**, [workflow, August 2025](https://steipete.me/posts/2025/optimal-ai-development-workflow) and [updated workflow, December 2025](https://steipete.me/posts/2025/shipping-at-inference-speed) | August: Ghostty, Claude Code, an editor beside it, a few visible agents and CLI tools. December: Codex, queued follow-ups, multiple projects and iterative steering. Reports little need for elaborate orchestration systems. | Make terminal rendering, paste, identifiable sessions and steering dependable. Support a small working set well. A project board or autonomous manager is not a prerequisite. |
| **Simon Willison**, [parallel coding agents, October 2025](https://simonwillison.net/2025/Oct/5/parallel-coding-agents/) and [Git with coding agents](https://simonwillison.net/guides/agentic-engineering-patterns/using-git-with-coding-agents/), inspected September 2026 | Uses several agent products, terminals and isolated checkouts. Describes review as a substantial cognitive burden. Git provides inspection, recovery and context from recent changes. | Keep agents interchangeable, preserve project identity, and make it easy to inspect the result. “Finished generating” is not the same state as “reviewed and accepted.” |
| **Mario Zechner**, [minimal coding agent, November 2025](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) | Explains building Pi after becoming frustrated with changing behavior, unwanted features, flicker and hidden context. Values inspectable interactions, a documented session format and a small core. | Favor stable behavior and explicit actions. Expose useful data and commands for extensions. A generic agent should not need to adopt a proprietary workflow to fit into Harness. |

These accounts do not agree on everything. Hashimoto described one background agent; Steinberger described several projects. Some use worktrees or separate checkouts; others avoid that overhead. Evans values minimal configuration; ThePrimeagen builds personal mappings. Harness should support these choices through a small set of dependable operations.

## Tool behaviors worth carrying forward

The Harness column is a product inference, rather than a claim that the source endorses this app.

| Tool | Specific behavior | Harness application |
| --- | --- | --- |
| [tmux](https://github.com/tmux/tmux) | Terminals outlive an attached screen and can be reattached. | A session owns the work; tabs and panes are views. Closing a view never ends an agent. Reconnection restores the correct session, viewport and focus. Host reboot recovery must be distinguished from a process that never stopped. |
| [fzf](https://github.com/junegunn/fzf) | Fast narrowing, previews, shell integration and programmable actions. | One fast jump interface for agents, swarms and projects, with keyboard preview and clear destinations. Search already-open work without altering membership. |
| [Harpoon](https://github.com/ThePrimeagen/harpoon/tree/harpoon2) | A small chosen working set and direct navigation keys. | Quick return to the last agent and chosen destinations. Build on existing pane index keys and last-focus behavior before adding another favorites system. |
| Vim / Neovim, as used in [Sessionizer](https://github.com/ThePrimeagen/tmux-sessionizer) | Consistent mappings connect editor, shell and multiplexer navigation. | Predictable directional focus, moves and zoom; remappable app commands. Preserve the terminal's own keys and make modal state obvious. A complete second editor is unnecessary. |
| zsh / fish and [fzf shell integration](https://github.com/junegunn/fzf#key-bindings-for-command-line) | Completion and history remain part of the user's shell workflow. | Run the user's real environment. Preserve Ctrl-R, shell editing, aliases, startup files and editor integrations. Do not replace these with a Harness imitation. |
| [Ghostty shell integration](https://ghostty.org/docs/features/shell-integration) | Working-directory inheritance, prompt navigation and command-output selection. | Start related work in the correct folder; make output easy to navigate and copy. Use structured terminal/shell signals where available, with an ordinary terminal fallback. |
| [Mosh](https://mosh.org/) | Roaming, reconnection and local echo address remote interaction latency. | Keep local navigation responsive during network trouble and clearly show connection state. Evaluate prediction separately: an arbitrary agent TUI cannot safely be treated like a simple shell prompt. |
| Git, as described in [Willison's guide](https://simonwillison.net/guides/agentic-engineering-patterns/using-git-with-coding-agents/) | Inspectable changes, history and recovery. | Open the relevant diff, editor or test result from an agent. Preserve existing Git tools and workspace choices. A new Git client is unnecessary for the first version. |

## Superlogical and Herdr

[Superlogical's announcement](https://www.superlogical.com/) describes a terminal multiplexer first, followed by composability and production operation. It emphasizes durable sessions across environments and native scrollback, selection and scrolling. The page still presents a plan and a beta signup; those are not evidence of a shipped, measured experience.

[Herdr's own site](https://herdr.dev/) describes persistent terminals, multiple agents, local and SSH machines, agent state and CLI/socket control. These are product claims checked against its published material, not an independent reliability audit.

The opportunity for Harness is to make movement among real agents across real machines unusually effortless. Matching a feature count is not a useful goal. The daily experience should answer: where was I, what needs me, what changed, and can I get back to work immediately?

## Audit of the current Harness build

| Decision | Existing surface or behavior | Action and reason |
| --- | --- | --- |
| **Keep and finish** | Native Swarm tabs, terminal panes, directional focus, zoom, last-pane and close/reopen | These already support a small working set. Finish native alignment, overflow, accessibility and measured interaction latency. |
| **Keep and harden** | Shared terminal controllers, saved membership, reconnect and local/remote discovery | This is the foundation. Preserve input ownership, scrollback and chosen arrangements through interruption. Validate remote failures on real linked machines; do not infer that a disconnected agent stopped. |
| **Implemented; verify in daily use** | `Cmd+P` jumps to agents and Swarms; `Cmd+Shift+F` opens **Add agent** | Fuzzy search covers name/project/branch/folder/machine context, with recent destinations and shared-view reuse. Existing-view navigation preserves focus/layout and terminal ownership without retrying a stream. No dialog fade or backdrop blur. Unopened agents explicitly offer **Open view** in the captured Swarm. |
| **Improve first** | Notifications dialog shows actual blocked agents | Add direct keyboard access to waiting work and a route back to the previous focus. Use authoritative states and quiet presentation. Offer optional interruption behavior only when warranted. |
| **Preserve compatibility** | Real agent terminals and user shell environments | Verify selection, multiline/image paste, scrollback, nested tmux/Vim and escape/control keys. Before promising a full terminal replacement, verify a straightforward ordinary-shell workflow too; the current New agent UI centers on detected agent engines. |
| **Remove from active work — implemented** | Wallpaper behind populated Swarms | Use `#463746`, matching the selected native tab. Wallpaper fills only an empty New swarm canvas and its decoded cache entry is evicted when that view is disposed. |
| **Reduce prominence** | “Next wallpaper” button, repeated metadata, permanent Settings gear | Keep appearance choices in a secondary location. Keep machine identity legible where needed to distinguish remote work. Settings already has `Cmd+,` and the app menu; consider reclaiming the extra toolbar control. These are proposals, not removed features. |
| **Removed avoidable waiting** | Settings route transitions and section cross-fades | Implemented: Settings now opens/closes and switches sections immediately. Removed the 170/120 ms route and 200/90 ms section fades; existing route/modal checks pass. Reserve animation for feedback that helps understanding. |
| **Keep optional; stop expanding** | Usage ledger and hardware/dial settings | Usage can answer a real cost question; hardware supports existing users. Keep these away from the main work loop. Do not delete capabilities or data merely because they were absent from this small research sample. |
| **Keep absent** | Models/Grid dashboard, permanent workspace sidebar, pane footers | The authenticated V2 shell already removed these. Avoid introducing equivalent clutter through new agent-management panels. |
| **Defer** | Workflow canvases, autonomous manager-of-managers, social features, a plugin marketplace, a full IDE or a new Git client | None is required to prove the first three promises. Add only after repeated daily-use evidence identifies a concrete need. |

Source inspection: `desktop/lib/screens/swarm_screen.dart`, `widgets/swarm_dialogs.dart`, `state/swarm_catalog.dart`, `shortcuts/app_shortcuts.dart`, `settings/settings_screen.dart`, `settings/settings_section.dart`, `widgets/new_agent_dialog.dart`, and `macos/Runner/SwarmTitlebar.swift`. Existing checks and implementation details are recorded in [the handoff](harness-v2-progress.md) and [performance notes](harness-v2-performance.md).

## The next small product milestone

1. **A terminal workspace people trust.** Finish the current native polish and verify typing, paste, selection, scrollback, resize, tab changes, input ownership and reconnect. No lost sessions, duplicate input or hidden layout changes. New swarms can be welcoming; active work stays visually quiet.
2. **One jump to any work.** Reach an agent or project on any connected machine, reuse the existing view, and return to the previous one. No network wait to navigate already-loaded work. Adding an agent remains an explicit action.
3. **A short path through decisions.** Jump to a waiting agent, inspect the real output or diff, give direction and return. Preserve each agent's native interaction and approval semantics. Add structured shortcuts only where its integration can support them accurately.

A modest CLI/API for the same operations can follow these stable primitives. It should compose with existing scripts and editors; the CLI already has daemon/agent mechanisms, so inventory and extend those before inventing a parallel orchestration system.

## How to judge whether this is working

These are proposed acceptance criteria, not measured results or evidence of product-market fit.

- Perform the ordinary loop entirely by keyboard: find an agent, switch, focus, zoom, inspect, answer and return. Navigation must not accidentally create a new view.
- Keep local input/focus/selection work within a display-frame budget on target hardware; measure input-to-display separately from framework CPU time. At 60 Hz a frame is about 16.7 ms, and at 120 Hz about 8.3 ms. Report p50/p95/p99 under output load, including cold and warm paths.
- Show an already-loaded Swarm without reconnecting its terminals or waiting for disk, discovery or a UI transition. Network round-trip time remains distinct from app overhead.
- Close and reopen the desktop client, interrupt a connection and resume without losing the chosen layout or sending input twice. A machine actually going offline must be represented honestly.
- Have experienced terminal users try real projects with several agents across multiple machines. Observe lost focus, hunts, unwanted interruptions and time spent configuring. Use these repeated observations to decide what to remove next; famous developers' preferences are useful starting hypotheses, not substitutes for this trial.

The product should leave a developer thinking: **all my work is here, it stays alive, and I can reach the right thing immediately.**
