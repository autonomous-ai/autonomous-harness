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

/**
 * The environment for every `ps` call whose output is parsed.
 *
 * `parseProcessRow` anchors on the `lstart` column because it is the one field with a fixed shape —
 * but that shape is `LC_TIME`'s, not `ps`'s, and only the C and English-US locales produce the
 * `DOW MON DD HH:MM:SS YYYY` the parser expects. Measured on macOS 15.5, same machine, one `ps -axo
 * pid=,ppid=,comm=,lstart=,args=` per locale, counting rows `parseProcessRow` accepts:
 *
 *   C, en_US        592/592   Tue Sep 15 23:54:57 2026
 *   en_GB, en_AU      0/594   Tue 15 Sep 23:54:57 2026          day and month swapped
 *   de_DE, nl_NL      0/592   Di. 15 Sep. 23:54:57 2026         ...and abbreviations carry dots
 *   fr_FR, es_ES      0/592   mar. 15 sept. 23:54:57 2026
 *   ja_JP, zh_CN      0/596   火  9/15 23:54:57 2026            numeric month, no day name
 *   ru_RU             0/593   вторник, 15 сентября 2026 г. 23:54:57   year before the time
 *
 * Zero rows is not a degraded table, it is no table at all, and `processRows` returns `[]` rather than
 * `null` for it — "we looked and nothing is there" — so every caller believes the machine is empty.
 * `resolvePaneEngineProcess` then finds no engine under any pane and `watchCreatedPane` spends its full
 * ten minutes before reporting `START_TIMEOUT`: "<engine> did not expose an engine process within 10
 * minutes", on a pane where the engine is running and answering hooks. Reported against 1.1.32 / CLI
 * 0.2.35 on a Mac with LANG=en_US.UTF-8 and LC_TIME=en_AU.UTF-8 (macOS keeps language and region
 * separate, so this split is a two-click setting, not an exotic one). 13 agents in one session.
 *
 * `ensureUtf8Locale` does not cover it: it returns early whenever a UTF-8 locale is already configured,
 * which on a desktop macOS is always, and it only ever sets `LC_CTYPE`'s category anyway.
 *
 * Widening the parser instead was rejected — `вторник, 15 сентября 2026 г. 23:54:57` and `火  9/15` are
 * not the same grammar with different words, and a regex loose enough for both stops pinning the field
 * boundaries that `comm`-with-spaces needs it to pin.
 *
 * Both categories have to be set explicitly, and `LC_ALL` cleared, because `LC_ALL` outranks both:
 *   - `LC_TIME=C` gives the parser the shape it documents.
 *   - `LC_CTYPE` stays UTF-8 so Linux procps keeps returning raw bytes rather than `?` for every
 *     character it cannot print (see `ensureUtf8Locale` and `repairMangledRows`).
 */
export function psEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const configured = env.LC_ALL || env.LC_CTYPE || env.LANG
  const ctype = configured && /utf-?8/i.test(configured) ? configured : 'C.UTF-8'
  return { ...env, LC_ALL: '', LC_CTYPE: ctype, LC_TIME: 'C' }
}
