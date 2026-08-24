// The serial port under the cable protocol: finding the dial, opening it raw, reading and writing bytes.
//
// No native dependency, deliberately. This CLI ships as one bundled JavaScript file with seven pure-JS
// dependencies; a serial library would be its first native module and would drag node-gyp, prebuilds and
// a per-platform release matrix into a distribution that is currently a download. A tty is a file, `stty`
// puts it in raw mode, and that is the whole of what this needs.
import { exec } from 'node:child_process'
import { constants, existsSync, readFileSync, readdirSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFile = promisify(exec)

/** The SoC's own USB peripheral. The dial exposes this and nothing else — measured, see findDialPort. */
export const DIAL_VENDOR_ID = 0x303a
export const DIAL_PRODUCT_ID = 0x1001

export interface DialPort {
  path: string
  vendorId: number
  productId: number
}

/**
 * Find the dial's tty, matching on the USB id and nothing else.
 *
 * Never by name and never by "the only one there": names are localised and unstable, and a laptop has
 * other serial devices — this machine answers with `/dev/cu.debug-console` before anything else, which a
 * loose match happily returns.
 *
 * On macOS the ids and the device path live on DIFFERENT nodes of the `ioreg` tree: the USB device node
 * carries idVendor/idProduct, and IOCalloutDevice hangs several levels below it under the CDC driver. So
 * this arms a subtree at the matching node's indentation and takes the first path inside it. A flat scan
 * pairs a vendor id with whatever path happens to come next in the dump, which is a different device.
 */
export async function findDialPort(): Promise<DialPort | null> {
  if (process.platform === 'darwin') return findDarwin()
  if (process.platform === 'linux') return findLinux()
  return null
}

/** Indentation column of an ioreg line — the tree's only structure. */
function depthOf(line: string): number {
  const m = line.match(/^[\s|+-]*/)
  return m ? m[0].length : 0
}

async function findDarwin(): Promise<DialPort | null> {
  let dump: string
  try {
    const { stdout } = await execFile('ioreg -p IOService -w0 -l', { maxBuffer: 64 * 1024 * 1024 })
    dump = stdout
  } catch {
    return null
  }

  const lines = dump.split('\n')
  let armedAt: number | null = null
  let sawVendor = false
  let sawProduct = false
  let nodeDepth = 0

  for (const line of lines) {
    // A new node resets what we have seen about the current one. `+-o` opens a node in this dump.
    if (line.includes('+-o')) {
      const d = depthOf(line)
      if (armedAt !== null && d <= armedAt) armedAt = null // left the armed subtree without a path
      nodeDepth = d
      sawVendor = false
      sawProduct = false
      continue
    }

    if (line.includes('"idVendor"')) sawVendor = Number(line.split('=')[1]?.trim()) === DIAL_VENDOR_ID
    if (line.includes('"idProduct"')) sawProduct = Number(line.split('=')[1]?.trim()) === DIAL_PRODUCT_ID
    if (sawVendor && sawProduct && armedAt === null) armedAt = nodeDepth

    if (armedAt !== null && line.includes('"IOCalloutDevice"')) {
      const path = line.split('=')[1]?.trim().replace(/^"|"$/g, '')
      if (path) return { path, vendorId: DIAL_VENDOR_ID, productId: DIAL_PRODUCT_ID }
    }
  }
  return null
}

function findLinux(): DialPort | null {
  // /sys is the id, /dev/ttyACM* is the path, and the symlink between them is the only honest pairing.
  const base = '/sys/class/tty'
  if (!existsSync(base)) return null
  for (const name of readdirSync(base)) {
    if (!name.startsWith('ttyACM') && !name.startsWith('ttyUSB')) continue
    // The ids live on the USB device, a few directories up from the tty's own node.
    let dir = `${base}/${name}/device`
    for (let hop = 0; hop < 4; hop++) {
      try {
        const vid = parseInt(readFileSync(`${dir}/idVendor`, 'utf8').trim(), 16)
        const pid = parseInt(readFileSync(`${dir}/idProduct`, 'utf8').trim(), 16)
        if (vid === DIAL_VENDOR_ID && pid === DIAL_PRODUCT_ID) {
          return { path: `/dev/${name}`, vendorId: vid, productId: pid }
        }
        break
      } catch {
        dir = `${dir}/..`
      }
    }
  }
  return null
}

/**
 * An open port, in raw mode, with a read loop.
 *
 * The port coming and going — a flash, a crash, a nudged cable, the dial rebooting into a new image — is
 * the NORMAL case here, not the failure case. Everything about this class is written so that closing and
 * reopening is cheap and safe.
 */
export class SerialLink {
  private constructor(
    readonly path: string,
    private handle: FileHandle,
    private readonly onData: (chunk: Buffer) => void,
    private readonly onClosed: (why: string) => void,
  ) {}

  private closed = false

  static async open(
    path: string,
    onData: (chunk: Buffer) => void,
    onClosed: (why: string) => void,
  ): Promise<SerialLink> {
    // Raw mode is not optional. Left in the default line discipline the tty maps CR to NL, strips the
    // eighth bit on some paths and echoes what we write back at us — and a mangled frame is
    // indistinguishable from a bad cable at the far end.
    //
    // `clocal` belongs with it: it tells the line discipline to ignore modem control lines, so losing
    // carrier — which is what unplugging a USB serial device looks like — does not hang the port up
    // underneath us.
    const flag = process.platform === 'darwin' ? '-f' : '-F'
    await execFile(`stty ${flag} ${JSON.stringify(path)} raw clocal -echo -echoe -echok -echoctl -echoke`)

    // O_NOCTTY IS LOAD-BEARING, AND ITS ABSENCE KILLED THE DAEMON.
    //
    // The daemon is spawned detached, which makes it a session leader. A session leader that opens a tty
    // without this flag ACQUIRES it as its controlling terminal — and when the USB device is unplugged the
    // kernel sends SIGHUP to that terminal's process group. Default disposition for SIGHUP is terminate,
    // so pulling the cable killed the process outright: no exception, no stack, nothing for the
    // unhandledRejection guard to catch, and a log that simply stops mid-second.
    //
    // Measured 2026-08-24: the daemon died at the exact second the cable came out, every time, and the
    // dial then greeted an empty room until it timed out and showed no agents.
    const handle = await open(path, constants.O_RDWR | constants.O_NOCTTY)
    const link = new SerialLink(path, handle, onData, onClosed)
    void link.readLoop()
    return link
  }

  private async readLoop(): Promise<void> {
    const buf = Buffer.allocUnsafe(4096)
    while (!this.closed) {
      try {
        const { bytesRead } = await this.handle.read(buf, 0, buf.length, null)
        if (bytesRead > 0) this.onData(Buffer.from(buf.subarray(0, bytesRead)))
        // A zero-byte read on a tty means EOF, which for a USB CDC device means it went away.
        else if (bytesRead === 0) return this.fail('end of stream')
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (this.closed) return
        // EAGAIN is a port with nothing to say, not a broken one.
        if (code === 'EAGAIN') {
          await new Promise((r) => setTimeout(r, 5))
          continue
        }
        return this.fail(code ?? String(err))
      }
    }
  }

  private fail(why: string): void {
    if (this.closed) return
    this.closed = true
    void this.handle.close().catch(() => {})
    this.onClosed(why)
  }

  /**
   * Write every byte of ONE frame, looping over short writes. Rejects only when the port is gone.
   *
   * ⚠️ SERIALISED, AND NOT AS A PRECAUTION. A tty accepts a few hundred bytes at a time, so an 8 KB
   * firmware slice takes several passes through the loop below and parks on an await between each. Frames
   * come from several places at once — the 5-second ping, the per-tick agent sync, a slice pump — and
   * without this queue a JSON frame lands in the MIDDLE of a firmware slice. The dial's decoder resyncs
   * past the wreckage, which costs it both frames, and the transfer then fails at the far end with a
   * checksum error that says nothing about whose fault it was.
   *
   * The firmware holds exactly this invariant on its own side (`s_tx_lock` in cable_link.c, "two tasks
   * sending at once cannot interleave halves of two frames"). This is the mirror of it. A failed write
   * must not strand the writes queued behind it, so the tail deliberately swallows the rejection — the
   * caller still receives it.
   */
  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('port closed')
    const next = this.tail.then(() => this.writeFrame(bytes))
    this.tail = next.catch(() => {})
    return next
  }

  private tail: Promise<void> = Promise.resolve()

  private async writeFrame(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('port closed')
    let off = 0
    while (off < bytes.length) {
      const { bytesWritten } = await this.handle.write(bytes, off, bytes.length - off)
      if (bytesWritten <= 0) throw new Error('short write')
      off += bytesWritten
    }
  }

  get isOpen(): boolean {
    return !this.closed
  }

  async close(why = 'closed'): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.handle.close().catch(() => {})
    this.onClosed(why)
  }
}
