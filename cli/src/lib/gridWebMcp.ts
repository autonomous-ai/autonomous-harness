/**
 * The grid's web tools, and how each harness is told where to find them.
 *
 * Its own module rather than more of `gridLaunch.ts` because it answers a different question: that
 * file decides where an agent's INFERENCE goes, this one decides what the agent can reach while it
 * thinks. They meet only in the engine contracts.
 *
 * A grid already pays for web search and already meters it, and grid ADR 0041 mounted it on the
 * CONTROL PLANE (`/v1/grid/web-mcp`) precisely so a harness can reach it while the grid itself is
 * asleep. What that ADR could not do is put it in front of an agent nobody configured by hand — so
 * this does, for an agent the desktop launches onto a grid. The credential is the one already in
 * `GridLaunchOverride.apiKey`: ADR 0041 D-b asks for the per-grid access token and requires no scope
 * of it, `consumer` included, which is exactly what the desktop mints.
 *
 * The same three harnesses `grid mcp config` prints for, and for the same reason — these are the
 * ones whose header handling was measured on the wire rather than read off a vendor page. An engine
 * with no wiring here launches on the grid exactly as it did before, with no web tools.
 *
 * ⚠️ **The key still never reaches a file or an argv**, which is `gridLaunch.ts`'s rule and NOT ADR
 * 0041's. That ADR rejects the environment outright, and it is right about the caller it was written
 * for: a person pasting a block into their own dotfile has no environment to reference, and a
 * 365-day token in an interactive shell is readable by every child of it. Here the daemon owns both
 * ends — the variable exists only in the pane's own environment, put there by `tmux new-session -e`
 * — and every harness measured offers a reference:
 *
 *   * Claude Code expands `${VAR}` inside `--mcp-config`, in the JSON-STRING form too, so it needs
 *     no file at all and its argv carries the variable's NAME.
 *   * Codex reads `env_http_headers`, settable entirely through `-c`.
 *   * opencode expands `{env:VAR}` in `headers`, in the config file the launch already writes it.
 *
 * Measured 2026-09-08 against a header-logging listener on loopback — Claude Code 2.1.263, Codex
 * 0.144.6, opencode 1.18.29, the first two being the versions ADR 0041 itself measured. Each sent
 * `Authorization: Bearer <the variable's value>` on every request, the GET discovery included.
 */

/**
 * What the server is called in the harness's own listing — an agent sees
 * `mcp__grid-web__web_search`.
 *
 * ↔ `SERVER_NAME` in autonomous-grid's `cli/mcp_config.py`. Same name on purpose: a person who has
 * run `grid mcp config` by hand and an agent launched from the desktop should be looking at one
 * server, not two that do the same thing under different names.
 */
export const GRID_MCP_SERVER_NAME = 'grid-web'

/**
 * Codex's spelling of that name. Its config keys are TOML paths and `-` is not a bare TOML key,
 * which is why `grid mcp config` prints `[mcp_servers.grid_web]` too.
 */
const GRID_MCP_CODEX_KEY = GRID_MCP_SERVER_NAME.replace(/-/g, '_')

/**
 * The variable Codex reads its header out of.
 *
 * Its own rather than the launch's key variable, because `env_http_headers` holds the WHOLE header
 * value while every other reference here wants the bare key — ADR 0041 D-d calls confusing the two
 * "a silent 401". `bearer_token_env_var` does take the bare key and would need no second variable;
 * it is rejected for the reason that ADR gives beside it, that it sends no header at all during
 * discovery.
 */
export const GRID_MCP_AUTH_VAR = 'GRID_MCP_AUTHORIZATION'

/** The header value [GRID_MCP_AUTH_VAR] carries — the whole of it, not the key. */
export function mcpAuthorizationHeader(apiKey: string): string {
  return `Bearer ${apiKey}`
}

/**
 * Claude Code's `--mcp-config`, as a JSON string rather than a file.
 *
 * `${…}` is Claude Code's own expansion, performed when it reads the config, so this names [keyVar]
 * and never the key itself — and nothing is written to disk. That variable belongs to the launch,
 * which is why it arrives as an argument rather than being imported: this module is about what an
 * agent can reach, not about the key it reaches with.
 *
 * Deliberately NOT accompanied by `--strict-mcp-config`, which would drop every MCP server the user
 * configured for themselves. Picking a grid adds web tools; it does not take an agent's own tools
 * away.
 */
export function claudeMcpConfig(mcpUrl: string, keyVar: string): string {
  return JSON.stringify({
    mcpServers: {
      [GRID_MCP_SERVER_NAME]: {
        type: 'http',
        url: mcpUrl,
        headers: { Authorization: `Bearer \${${keyVar}}` },
      },
    },
  })
}

/**
 * The same server as Codex `-c` overrides, which is how its provider is configured too — so this
 * needs no config file either. Values are quoted as JSON because a `-c` value is parsed as TOML.
 */
export function codexMcpArgs(mcpUrl: string): string[] {
  return [
    '-c', `mcp_servers.${GRID_MCP_CODEX_KEY}.url=${JSON.stringify(mcpUrl)}`,
    '-c', `mcp_servers.${GRID_MCP_CODEX_KEY}.env_http_headers.Authorization=${JSON.stringify(GRID_MCP_AUTH_VAR)}`,
  ]
}

/**
 * Hermes keeps its MCP servers in one place — `mcp_servers` in `~/.hermes/config.yaml`
 * (`tools/mcp_tool_config.py`) — and offers no per-invocation flag for them. What it does offer is
 * a **managed-scope overlay**: `HERMES_MANAGED_DIR` names a directory whose `config.yaml` is
 * `_deep_merge`d over the user's (`hermes_cli/managed_scope.get_managed_dir`,
 * `hermes_cli/config._merge_managed_overlay`). That merge recurses dict-over-dict, so pinning
 * `mcp_servers.grid-web` leaves every server the user configured for themselves in place — the same
 * promise `--strict-mcp-config`'s absence makes for Claude Code.
 *
 * Two things were checked before choosing it over `HERMES_HOME`, which also redirects config:
 *
 *  * `HERMES_HOME` moves the WHOLE home — `auth.json`, sessions, memory, skills — so an agent
 *    launched under one would come up unauthenticated and amnesiac. That is a far worse trade than
 *    having no web tools.
 *  * A managed DIRECTORY is not a managed INSTALL: `config.get_managed_system()` reads
 *    `HERMES_MANAGED` or a `.managed` marker file and never consults this variable, so nothing here
 *    makes Hermes think a package manager owns it and start refusing its own updates.
 *
 * ⚠️ **The overlay REPLACES a system scope rather than adding to it** — `get_managed_dir` prefers
 * this variable over `/etc/hermes`. On a machine where an administrator pinned settings there, this
 * directory would silently take their policy away for the agent's lifetime, so the caller drops it
 * on such a machine and the agent launches without web tools instead. That check belongs where
 * machine facts are read; see `cli.ts`.
 *
 * Emitted as JSON, which is a subset of YAML: Hermes parses this file with a YAML loader, and
 * hand-rolling YAML quoting for a URL and a `${VAR}` is a way to be subtly wrong for free.
 */
export const HERMES_MANAGED_DIR_VAR = 'HERMES_MANAGED_DIR'

/**
 * Where Hermes looks for a managed scope when [HERMES_MANAGED_DIR_VAR] is unset
 * (`managed_scope._DEFAULT_MANAGED_DIR`).
 *
 * Exported so the caller can see whether an administrator got here first. Not consulted in this
 * module: a contract that stats the filesystem answers differently on two machines, and its spec
 * would pass or fail depending on which one ran it.
 */
export const HERMES_SYSTEM_MANAGED_DIR = '/etc/hermes'

/** The one file [HERMES_MANAGED_DIR_VAR] is read for. */
export const HERMES_MANAGED_CONFIG_FILE = 'config.yaml'

/** Hermes' overlay: the grid's web tools, and nothing else. */
export function hermesManagedConfig(mcpUrl: string, keyVar: string): string {
  return `${JSON.stringify({
    mcp_servers: {
      [GRID_MCP_SERVER_NAME]: {
        url: mcpUrl,
        // Hermes interpolates `${VAR}` Cursor-style against the process environment
        // (`tools/mcp_tool_config._ENV_VAR_PATTERN`), so the key stays out of this file too.
        headers: { Authorization: `Bearer \${${keyVar}}` },
      },
    },
  }, null, 2)}\n`
}
