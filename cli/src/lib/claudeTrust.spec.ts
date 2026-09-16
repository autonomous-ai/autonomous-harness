import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { preTrustClaudeProject } from './claudeTrust.js'

describe('preTrustClaudeProject', () => {
  it('records trust for a new folder the way Claude Code does, keeping everything else', () => {
    const home = mkdtempSync(join(tmpdir(), 'trust-'))
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 4, projects: { '/old': { allowedTools: ['Bash'], hasTrustDialogAccepted: true } } }))
    expect(preTrustClaudeProject('/Users/x/harnesses/harness-3', home)).toBe('trusted')
    const after = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    expect(after.numStartups).toBe(4)
    expect(after.projects['/old']).toEqual({ allowedTools: ['Bash'], hasTrustDialogAccepted: true })
    expect(after.projects['/Users/x/harnesses/harness-3']).toEqual({ allowedTools: [], hasTrustDialogAccepted: true })
    expect(preTrustClaudeProject('/Users/x/harnesses/harness-3', home)).toBe('already')
  })

  it('merges into an entry that exists without trust, and does nothing without Claude Code', () => {
    const home = mkdtempSync(join(tmpdir(), 'trust-'))
    expect(preTrustClaudeProject('/w', home)).toBe('skipped')
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { '/w': { allowedTools: ['Read'], hasClaudeMdExternalIncludesApproved: false } } }))
    expect(preTrustClaudeProject('/w', home)).toBe('trusted')
    const after = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    expect(after.projects['/w']).toEqual({ allowedTools: ['Read'], hasClaudeMdExternalIncludesApproved: false, hasTrustDialogAccepted: true })
    writeFileSync(join(home, '.claude.json'), '{not json')
    expect(preTrustClaudeProject('/w', home)).toBe('skipped')
  })
})
