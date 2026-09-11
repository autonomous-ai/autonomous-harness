import { ValidationError } from '../errors/index.js'

const AGENT_ID_RE = /^[a-f0-9]{32}$/

export function isMachineId(value: string): boolean {
  return AGENT_ID_RE.test(value)
}

/** Guard before an machineId is interpolated into a manager URL path. */
export function assertMachineId(value: string): void {
  if (!isMachineId(value)) {
    throw new ValidationError(`Invalid machineId: ${value}`)
  }
}
