/**
 * Give this process (and therefore every child it spawns) a UTF-8 locale on macOS and Linux.
 *
 * Linux tools sanitize bytes they cannot represent in the current locale, and a daemon usually has NO
 * locale at all: `LANG` is unset under systemd, under `docker run`, and in an ssh session that forwards
 * nothing, which leaves `LC_CTYPE` at POSIX. Two measured consequences on Ubuntu 24.04, both silent:
 *
 *   - `tmux list-panes -a -F '#{pane_id}\t#{pane_pid}\t#{pane_current_path}'` returns the TAB separators
 *     as `_` (0x5F, verified with od -c). `parsePanes` splits on \t, so it parses ZERO panes, discovery
 *     has nothing to attach an engine process to, and no agent is ever created. This is exactly the
 *     "tmux + claude makes no agent" report: the engine process was found, the pane was not.
 *   - `ps -axo comm=,args=` returns `⌘ <title>` as `??? <title>`, which kills both halves of the Command
 *     Code marker in engineProcessMatchScore and lets the reaper evict a live pane.
 *
 * Why the whole process rather than per-spawn: the daemon shells out to tmux from several modules
 * (discovery, the backend adapter, pane capture, input injection) and to `ps` from two, and each one
 * would have to remember. Setting it once at entry covers every current and future child.
 *
 * Only when nothing usable is configured — a user with `LANG=en_US.UTF-8` keeps it. `C.UTF-8` is the
 * portable choice (glibc ≥ 2.35, and Ubuntu's own /etc/default/locale ships exactly it); where it does
 * not exist glibc falls back to C, i.e. no worse than doing nothing.
 */
export function ensureUtf8Locale(env: NodeJS.ProcessEnv = process.env): void {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return
  const configured = env.LC_ALL || env.LC_CTYPE || env.LANG
  if (configured && /utf-?8/i.test(configured)) return
  env.LC_ALL = 'C.UTF-8'
}
