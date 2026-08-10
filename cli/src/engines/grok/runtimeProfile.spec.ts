import { describe, expect, it } from 'vitest'
import { parseGrokFooterProfile, parseGrokModelsOutput } from './runtimeProfile.js'

describe('Grok runtime profile', () => {
  it('reads the measured idle footer', () => {
    expect(parseGrokFooterProfile('--- Grok 4.5 (medium) · always-approve ---')).toEqual({
      model: 'grok-4.5',
      effort: 'medium',
    })
  })

  it('reads the measured model catalog and skips prose', () => {
    expect(parseGrokModelsOutput([
      'You are logged in with grok.com.',
      '',
      'Default model: grok-4.5',
      '',
      'Available models:',
      '  * grok-4.5 (default)',
    ].join('\n'))).toEqual(['grok-4.5'])
  })
})
