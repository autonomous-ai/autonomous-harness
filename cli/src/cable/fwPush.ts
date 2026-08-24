// Pushing a firmware image to the dial over the cable it is already talking on.
//
// The dial has no WiFi, so it cannot fetch its own updates any more. The daemon does it instead: it reads
// the SAME published manifest the device used to poll (`harness/esp32/ota/metadata.json` on GCS), caches
// the image, and offers it over the wire. Nothing about the release pipeline changes — `make
// upload-circle` still publishes, and this only changes WHO downloads.
//
// Deliberately NOT bundled into this CLI's own build. The sibling product does bundle its panel image, and
// it bought a trap with it: "different from mine" is a comparison, not an ordering, so an app build from
// two days earlier silently flashed a freshly-built panel BACK to the older image, twice, before anyone
// noticed. Reading the published manifest makes the newest release the reference for everyone.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** What the manifest says about one board's current release. */
export interface FirmwareRelease {
  version: string
  url: string
  sha256: string
  size: number
}

/** The dial's key in the shared manifest. Other boards and the CLI itself live in the same file. */
export const CIRCLE_OTA_KEY = 'commander'

/**
 * Whether `published` should be offered to a dial running `running`.
 *
 * Two rules, both learned from the sibling firmware:
 *
 *  - **A dev build is never touched.** ESP-IDF stamps `git describe` when a project sets no PROJECT_VER,
 *    so a locally-flashed image self-describes as something like `v0.3.38-36-gbc64073-dirty`. Offering the
 *    published image to that is the "flashed back to yesterday's build and nothing looked broken" failure:
 *    `idf.py flash` says Done, and seconds later the dial is running the release again.
 *  - **Strictly newer only.** Equal is nothing to do; older is someone else's decision to roll back, made
 *    by publishing, not by whichever daemon happens to be plugged in.
 */
export function shouldOffer(running: string, published: string): boolean {
  const clean = /^v?(\d+)\.(\d+)\.(\d+)$/
  const a = clean.exec(running.trim())
  const b = clean.exec(published.trim())
  if (!a || !b) return false
  for (let i = 1; i <= 3; i++) {
    const mine = Number(a[i])
    const theirs = Number(b[i])
    if (theirs > mine) return true
    if (theirs < mine) return false
  }
  return false
}

/** Read the published release for the dial, or null when the manifest is unreachable or has no entry. */
export async function fetchRelease(manifestUrl: string, key = CIRCLE_OTA_KEY): Promise<FirmwareRelease | null> {
  try {
    // A cached copy is exactly the thing that makes a release look like it did not happen, and this
    // runtime's fetch has no `cache` option — so the URL carries the buster instead.
    const bust = manifestUrl.includes('?') ? '&' : '?'
    const res = await fetch(`${manifestUrl}${bust}t=${Date.now()}`)
    if (!res.ok) return null
    const all = (await res.json()) as Record<string, Partial<FirmwareRelease>>
    const entry = all?.[key]
    if (!entry?.version || !entry.url || !entry.sha256 || !entry.size) return null
    return { version: entry.version, url: entry.url, sha256: entry.sha256, size: entry.size }
  } catch {
    return null
  }
}

/**
 * Fetch the image, from the cache when it is already there and verified.
 *
 * The hash is checked on every load, not only after a download: a truncated file on disk (a laptop that
 * slept mid-download) would otherwise be pushed to the dial, which would then reject it after spending
 * three minutes and an erase cycle receiving it.
 */
export async function loadImage(release: FirmwareRelease, cacheDir: string): Promise<Buffer | null> {
  const path = join(cacheDir, `${release.version}.bin`)
  const verify = (buf: Buffer) =>
    buf.length === release.size && createHash('sha256').update(buf).digest('hex') === release.sha256

  const cached = await readFile(path).catch(() => null)
  if (cached && verify(cached)) return cached

  const res = await fetch(release.url).catch(() => null)
  if (!res?.ok) return null
  const fresh = Buffer.from(await res.arrayBuffer())
  if (!verify(fresh)) return null

  await mkdir(cacheDir, { recursive: true }).catch(() => {})
  await writeFile(path, fresh).catch(() => {})
  return fresh
}

/**
 * One transfer in flight: slices, and the credit the dial's acks release.
 *
 * THE THREE NUMBERS ARE ONE DECISION — see docs/specs/cable-protocol.md §7 in autonomous-code. The
 * ESP32-S3 USB Serial/JTAG peripheral has NO back-pressure: its ISR drains the hardware FIFO
 * unconditionally and drops whatever does not fit its ring, silently, with no NAK and no short write.
 * Sending faster than the dial reads does not slow this side down, it shreds the stream. The dial's reader
 * task is also its flash writer, so it is blocked for ~16 ms per slice with nothing draining the port.
 *
 * Measured on hardware by the sibling firmware: a 128 KB window with an ack every 64 KB wrote 0 of
 * 1,342,160 bytes.
 */
export const FW_SLICE_BYTES = 8192
export const FW_WINDOW_BYTES = 16 * 1024

export class FirmwareTransfer {
  private acked = 0
  private offset = 0
  private done = false

  constructor(
    private readonly image: Buffer,
    readonly version: string,
    private readonly sendSlice: (slice: Buffer) => Promise<void>,
    private readonly log: (line: string) => void,
  ) {}

  get isDone(): boolean {
    return this.done
  }

  /** Push as much as the credit window allows. Called on accept and again on every `fw.progress`. */
  async pump(): Promise<void> {
    while (!this.done && this.offset < this.image.length && this.offset - this.acked < FW_WINDOW_BYTES) {
      const end = Math.min(this.offset + FW_SLICE_BYTES, this.image.length)
      await this.sendSlice(this.image.subarray(this.offset, end))
      this.offset = end
    }
  }

  /** The dial acknowledged `written` bytes in flash. That ack IS the credit. */
  async onProgress(written: number): Promise<void> {
    this.acked = written
    await this.pump()
  }

  finish(reason: string): void {
    if (this.done) return
    this.done = true
    this.log(`cable: firmware ${this.version} ${reason} (${this.acked}/${this.image.length} B)`)
  }
}
