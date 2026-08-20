import { describe, expect, it } from 'vitest'
import { decodeTmuxControlData } from './tmuxStream.js'

describe('tmux control-mode output decoding', () => {
  it('decodes octal bytes without corrupting adjacent UTF-8', () => {
    const decoded = decodeTmuxControlData('hello\\040世界\\015\\012\\033[31m')
    expect(Buffer.from(decoded)).toEqual(Buffer.from('hello 世界\r\n\u001b[31m'))
  })

  it('preserves ordinary backslashes that are not octal escapes', () => {
    expect(Buffer.from(decodeTmuxControlData('C:\\Users\\name')).toString()).toBe('C:\\Users\\name')
  })
})
