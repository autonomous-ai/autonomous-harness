"""The marimo pane: `marimo edit --watch` on the workspace notebook, tuned for a pane beside an agent.

marimo is started exactly as `marimo edit` starts it, with three settings layered over whatever the
user's own marimo config says, for this server only (nothing is written to disk):

- runtime.auto_instantiate = true   the notebook runs when the pane opens, so the reader sees
                                     outputs, charts and tables, not a column of stale code cells.
- runtime.watcher_on_save = autorun the agent's saves re-run the cells they changed, in place:
                                     the pane follows the work without a reload, and the user keeps
                                     their scroll position and the values of the sliders they moved.
- save.autosave = off               the agent owns notebook.py. Poking at the pane never rewrites
                                     the file under the agent's feet; Cmd-S still saves on purpose.

The overrides go in through marimo's own `MarimoConfigManager.with_overrides`, the same mechanism
marimo uses for its CLI flags, by wrapping the config-manager factory `marimo._server.start` calls.
MARIMO_VERSION pins the marimo this is written against; if a newer marimo moves the factory, the pane
still starts, with marimo's defaults, and says so on stderr.
"""
from __future__ import annotations

import os
import sys

PANE_CONFIG = {
    "runtime": {"auto_instantiate": True, "watcher_on_save": "autorun"},
    "save": {"autosave": "off"},
}


def tune() -> None:
    try:
        import marimo._server.start as start

        factory = start.get_default_config_manager

        def pane_config_manager(*args, **kwargs):
            return factory(*args, **kwargs).with_overrides(PANE_CONFIG)

        start.get_default_config_manager = pane_config_manager
    except Exception as error:  # pragma: no cover - only on a marimo that moved things
        print(f"[marimo pane] running with marimo's defaults ({error})", file=sys.stderr)


def main() -> None:
    port = os.environ["HARNESS_VIEWER_PORT"]
    workspace = os.environ["HARNESS_WORKSPACE"]
    notebook = os.environ.get("MARIMO_PANE_NOTEBOOK", "notebook.py")
    os.chdir(workspace)
    tune()
    from marimo._cli.cli import main as marimo

    marimo(
        prog_name="marimo",
        args=["edit", "--headless", "--host", "127.0.0.1", "--port", port, "--no-token", "--watch",
              "--skip-update-check", notebook],
    )


if __name__ == "__main__":
    main()
