/**
 * Writing image bytes into the HOST OS's native clipboard — the machine this process itself runs
 * on, which for a relayed session is the remote machine, not the desktop client's. This is the
 * other half of native image paste: the engine attached to the tmux pane (Claude Code, Codex CLI,
 * ...) already reads its OWN OS clipboard on a paste keystroke — see terminalStreamManager.ts's
 * `pasteImage()` — so writing the clipboard here and then replaying that keystroke is all that's
 * needed; no OS-level keystroke synthesis is involved.
 */
import { execFile, spawn } from 'node:child_process'
import { binaryOnPath } from './binaryOnPath.js'

export type OsClipboardImageResult =
  | { state: 'written' }
  /** No clipboard reachable at all right now (tool missing, or genuinely no X11/Wayland session) —
   *  not an error, just nothing to write to. Caller falls back to pasting a file path instead. */
  | { state: 'unavailable'; reason: string }
  /** The clipboard mechanism is present but the write itself failed. */
  | { state: 'failed'; reason: string }

function runWithStdin(command: string, args: string[], input: Uint8Array): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, message: error instanceof Error ? error.message : String(error) })
      return
    }
    let stderr = ''
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', (error) => resolve({ ok: false, message: error.message }))
    // 'exit', NOT 'close': both xclip and wl-copy load the clipboard data and then fork into a
    // background process that STAYS ALIVE to serve paste requests (X11/Wayland clipboard ownership
    // has no concept of "set once" — someone has to keep answering selection requests) — and that
    // forked process inherits this one's stdio pipes. Node's 'close' waits for every stdio stream to
    // close too, which then never happens: confirmed live against real xclip on Ubuntu, where a
    // `close` listener here hung indefinitely even though the write itself completes in milliseconds.
    // 'exit' only waits on the process we actually spawned, which is what answers "did the write
    // succeed" — whatever it forked into afterwards is background clipboard-owner housekeeping we
    // don't need to wait on.
    child.once('exit', (code) => {
      // The stdio PIPE handles this process handed to the child may still be held open by whatever
      // it forked into (see above), and each is its own libuv handle independent of the child
      // process handle — `child.unref()` alone measurably left the pipes still keeping the event
      // loop alive (reproduced live: the write completed but the process needed a hard timeout to
      // return). `stdin`/`stderr` are `net.Socket`s for pipe-based stdio, which do have `.unref()` at
      // runtime even though the general `Writable`/`Readable` types TypeScript sees here don't
      // declare it — hence the cast.
      type Unrefable = { unref?: () => void }
      (child.stdin as unknown as Unrefable | null)?.unref?.()
      ;(child.stderr as unknown as Unrefable | null)?.unref?.()
      child.unref()
      resolve(code === 0 ? { ok: true } : { ok: false, message: stderr.trim() || `exited with code ${code}` })
    })
    child.stdin?.end(Buffer.from(input))
  })
}

/** macOS: `osascript` ships with the OS, nothing to detect. Reads the PNG bytes back off disk (the
 *  `read … as «class PNGf»` idiom needs a POSIX file path, not stdin) — `pngPath` must already hold
 *  `pngBytes`. */
function writeMacClipboard(pngPath: string): Promise<OsClipboardImageResult> {
  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-e', `set the clipboard to (read (POSIX file ${JSON.stringify(pngPath)}) as «class PNGf»)`],
      { timeout: 5_000 },
      (error, _stdout, stderr) => {
        resolve(error
          ? { state: 'failed', reason: (typeof stderr === 'string' && stderr.trim()) || error.message }
          : { state: 'written' })
      },
    )
  })
}

/** Linux: which clipboard tool applies depends on the ACTIVE session, not the distro, so this is
 *  checked per-call rather than once at startup — `$WAYLAND_DISPLAY`/`$DISPLAY` reflect the
 *  session the daemon is currently running under. Neither set means no display server at all
 *  (a genuinely headless box), which no clipboard tool can fix. */
async function writeLinuxClipboard(pngBytes: Uint8Array): Promise<OsClipboardImageResult> {
  if (process.env.WAYLAND_DISPLAY) {
    if (!binaryOnPath('wl-copy')) {
      return { state: 'unavailable', reason: 'wl-copy not found (install the wl-clipboard package)' }
    }
    const result = await runWithStdin('wl-copy', ['--type', 'image/png'], pngBytes)
    return result.ok ? { state: 'written' } : { state: 'failed', reason: result.message ?? 'wl-copy failed' }
  }
  if (process.env.DISPLAY) {
    if (!binaryOnPath('xclip')) {
      return { state: 'unavailable', reason: 'xclip not found (install the xclip package)' }
    }
    const result = await runWithStdin('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i'], pngBytes)
    return result.ok ? { state: 'written' } : { state: 'failed', reason: result.message ?? 'xclip failed' }
  }
  return { state: 'unavailable', reason: 'no X11 or Wayland display on this machine' }
}

/** Writes `pngBytes` (already saved at `pngPath`) into this machine's native OS clipboard. */
export async function writeImageToOsClipboard(pngPath: string, pngBytes: Uint8Array): Promise<OsClipboardImageResult> {
  if (process.platform === 'darwin') return writeMacClipboard(pngPath)
  if (process.platform === 'linux') return writeLinuxClipboard(pngBytes)
  return { state: 'unavailable', reason: `no clipboard writer for ${process.platform}` }
}
