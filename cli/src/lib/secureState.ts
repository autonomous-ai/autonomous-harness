import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs'

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

function ownerUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export function secureStateDirectory(directory: string, create = true): void {
  if (create) mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const fd = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    const stat = fstatSync(fd)
    const uid = ownerUid()
    if (!stat.isDirectory() || (uid !== null && stat.uid !== uid)) {
      throw new Error('state directory has unsafe owner or type')
    }
    const mode = stat.mode & 0o777
    // Refuse — deliberately do NOT chmod and carry on. If another account could write here, it could
    // already have planted the registry, the token or the hook credential, and tightening afterwards
    // would leave us trusting whatever it left behind. Three tests pin this (registry.spec.ts,
    // hookAuth.spec.ts, terminalConfigSnapshot.spec.ts); the fix belongs at creation time, and every
    // site that makes a directory under ADAPTER_DATA_DIR now passes mode 0o700 so Ubuntu's default
    // umask 0002 can no longer produce a 0775 one. This branch is what a PRE-EXISTING 0775 directory
    // (made by an older build on Ubuntu) lands in, so the message has to say what to do about it.
    if ((mode & 0o022) !== 0) {
      throw new Error(`state directory ${directory} is group/world writable, so its contents cannot be`
        + ` trusted. If you did not set that mode yourself, delete it; otherwise: chmod 700 ${directory}`)
    }
    if (mode !== PRIVATE_DIRECTORY_MODE) {
      fchmodSync(fd, PRIVATE_DIRECTORY_MODE)
      if ((fstatSync(fd).mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
        throw new Error('state directory permissions could not be tightened')
      }
    }
  } finally {
    closeSync(fd)
  }
}

function inspectPrivateStateFile(fd: number, maxBytes: number): void {
  const stat = fstatSync(fd)
  const uid = ownerUid()
  if (!stat.isFile() || (uid !== null && stat.uid !== uid)) {
    throw new Error('state file has unsafe owner or type')
  }
  if (stat.size > maxBytes) throw new Error('state file exceeds its size limit')
  const mode = stat.mode & 0o777
  // Same reasoning as secureStateDirectory: a file another account could have rewritten is not made
  // trustworthy by tightening it now. Every writer under ADAPTER_DATA_DIR already passes mode 0o600.
  if ((mode & 0o022) !== 0) throw new Error('state file is group/world writable')
  if (mode !== PRIVATE_FILE_MODE) {
    fchmodSync(fd, PRIVATE_FILE_MODE)
    if ((fstatSync(fd).mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw new Error('state file permissions could not be tightened')
    }
  }
}

export function readPrivateStateFile(file: string, maxBytes = Number.MAX_SAFE_INTEGER): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    inspectPrivateStateFile(fd, maxBytes)
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

export function hardenPrivateStateFileIfPresent(
  file: string,
  maxBytes = Number.MAX_SAFE_INTEGER,
): boolean {
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
  try {
    inspectPrivateStateFile(fd, maxBytes)
    return true
  } finally {
    closeSync(fd)
  }
}
