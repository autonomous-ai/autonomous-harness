import { describe, expect, it } from 'vitest'
import * as C from './e2ee/core.js'
import {
  DEVICE_RECENT_SAFE_FRAME_BYTES,
  fitRecentReplyPayloadForDevice,
  truncateUtf8,
} from './deviceRecentTrim.js'

const key = new Uint8Array(32).fill(7)

function encryptedRecentFrameBytes(payload: Record<string, unknown>): number {
  const full = { requestId: 1, ...payload }
  const wrapped = C.wrapPayload(key, 'p', 0, 'agent_recent_result', undefined, full)
  return Buffer.byteLength(JSON.stringify({ type: 'agent_recent_result', payload: wrapped }), 'utf8')
}

describe('device recent trim', () => {
  it('keeps small encrypted recent payloads unchanged', () => {
    const payload = {
      agentId: 'agent-1',
      events: [{ kind: 'summary', text: 'Short body', recap: 'Short recap' }],
    }
    const result = fitRecentReplyPayloadForDevice(payload, encryptedRecentFrameBytes)
    expect(result.trimmed).toBe(false)
    expect(result.payload).toBe(payload)
    expect(result.finalBytes).toBeLessThan(DEVICE_RECENT_SAFE_FRAME_BYTES)
  })

  it('trims huge ascii body to fit the encrypted 90%-of-16KB frame budget', () => {
    const payload = {
      agentId: 'agent-1',
      events: [{ kind: 'summary', text: 'a'.repeat(100_000), recap: 'Important recap stays' }],
    }
    const result = fitRecentReplyPayloadForDevice(payload, encryptedRecentFrameBytes)
    const event = (result.payload.events as Array<{ text: string; recap: string }>)[0]
    expect(result.trimmed).toBe(true)
    expect(result.finalBytes).toBeLessThan(DEVICE_RECENT_SAFE_FRAME_BYTES)
    expect(event.recap).toBe('Important recap stays')
    expect(event.text.length).toBeGreaterThan(0)
    expect(event.text.length).toBeLessThan(100_000)
  })

  it('trims huge unicode body without splitting utf8 characters', () => {
    const payload = {
      agentId: 'agent-1',
      events: [{ kind: 'summary', text: 'Đây là nội dung tiếng Việt rất dài. '.repeat(10_000), recap: 'Tóm tắt tiếng Việt' }],
    }
    const result = fitRecentReplyPayloadForDevice(payload, encryptedRecentFrameBytes)
    const event = (result.payload.events as Array<{ text: string; recap: string }>)[0]
    expect(result.finalBytes).toBeLessThan(DEVICE_RECENT_SAFE_FRAME_BYTES)
    expect(Buffer.from(event.text, 'utf8').toString('utf8')).toBe(event.text)
    expect(event.recap).toBe('Tóm tắt tiếng Việt')
  })

  it('trims recap only after body is exhausted', () => {
    const payload = {
      agentId: 'agent-1',
      events: [{ kind: 'summary', text: 'body', recap: 'r'.repeat(100_000) }],
    }
    const result = fitRecentReplyPayloadForDevice(payload, encryptedRecentFrameBytes)
    const event = (result.payload.events as Array<{ text: string; recap: string }>)[0]
    expect(result.finalBytes).toBeLessThan(DEVICE_RECENT_SAFE_FRAME_BYTES)
    expect(event.text).toBe('body')
    expect(event.recap.length).toBeLessThan(100_000)
  })

  it('truncateUtf8 respects byte limits', () => {
    expect(Buffer.byteLength(truncateUtf8('ááá', 4), 'utf8')).toBeLessThanOrEqual(4)
    expect(truncateUtf8('abc', 2)).toBe('ab')
  })
})
