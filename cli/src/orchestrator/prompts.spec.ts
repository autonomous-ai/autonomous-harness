import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { directorPrompt, shellQuote, workerPrompt } from './prompts.js'
import type { Run, Task } from './model.js'

describe('self-contained orchestration briefs', () => {
  it('quotes executable paths without expanding shell metacharacters', () => {
    const value = `/project/a'b $(printf unexpected) \"workspace\"`
    expect(execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' })).toBe(value)
  })
  it.each([true, false])('keeps the explicit unattended setting at %s', bypassPermission => {
    const run = { id: 'a'.repeat(32), root: '/project', prompt: 'Make it', parallelism: 2, engine: 'codex', bypassPermission, tasks: [] } as unknown as Run
    const brief = directorPrompt(run, [], 'harness orchestrator')
    expect(brief).toContain(bypassPermission ? 'explicitly enabled by the user' : 'NOT enabled; normal engine permission prompts')
    expect(brief).toContain('An idle worker or a viewer is NOT evidence of completion')
    expect(brief).toContain('Successful work is immutable')
    const task = { id: 'one', attempt: 2, cwd: '/project/one', prompt: 'Verify dimensions', dependsOn: [] } as unknown as Task
    expect(workerPrompt(run, task, 'harness orchestrator')).toContain(`finish ${run.id} one 2`)
    expect(workerPrompt(run, task, 'harness orchestrator')).toContain(`fail ${run.id} one 2`)
  })
})
