import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, mkdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { type Artifact, requireThat } from './model.js'

function inside(root: string, file: string): boolean {
  const path = relative(root, file)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Snapshot only named regular files contained in the worker's own workspace. */
export async function snapshotArtifacts(cwd: string, destination: string, paths: string[]): Promise<Artifact[]> {
  requireThat(paths.length <= 64, 'ARTIFACT_LIMIT', 'At most 64 artifacts per task.')
  const root = await realpath(cwd)
  const prepared: Array<{ source: string; path: string; size: number }> = []
  let bytes = 0
  for (const path of new Set(paths)) {
    requireThat(path.length > 0 && path.length <= 4096 && !isAbsolute(path) && !path.split(/[\\/]/).includes('..'), 'INVALID_ARTIFACT', 'Artifact paths must stay inside the task workspace.')
    const source = await realpath(join(root, path))
    requireThat(inside(root, source), 'INVALID_ARTIFACT', `Artifact ${path} escapes the task workspace.`)
    const info = await stat(source)
    requireThat(info.isFile() && info.size <= 256 * 1024 * 1024, 'INVALID_ARTIFACT', `${path} must be a regular file of at most 256 MiB.`)
    bytes += info.size
    requireThat(bytes <= 1024 * 1024 * 1024, 'ARTIFACT_LIMIT', 'Artifacts exceed 1 GiB.')
    prepared.push({ source, path, size: info.size })
  }
  // Destination is a new attempt-owned directory, never a caller-supplied path.
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const result: Artifact[] = []
  for (const file of prepared) {
    const target = join(destination, file.path)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await copyFile(file.source, target)
    const info = await stat(target)
    const sha256 = await hashFile(target)
    requireThat(info.size === file.size && sha256 === await hashFile(file.source), 'ARTIFACT_CHANGED', `${file.path} changed during handoff. Finish writing it and try again.`)
    await chmod(target, 0o400)
    result.push({ path: file.path, size: info.size, sha256 })
  }
  return result
}

export async function materializeInputs(source: string, destination: string, artifacts: Artifact[]): Promise<void> {
  for (const artifact of artifacts) {
    const path = join(source, artifact.path)
    requireThat(await hashFile(path) === artifact.sha256, 'ARTIFACT_CHANGED', `The saved artifact ${artifact.path} no longer matches its completed result.`)
    const target = join(destination, artifact.path)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await copyFile(path, target)
    requireThat(await hashFile(target) === artifact.sha256, 'ARTIFACT_CHANGED', `The input copy of ${artifact.path} changed.`)
    await chmod(target, 0o400)
  }
}
