import { describe, expect, it } from 'vitest'
import {
  countOpencodePickers,
  opencodeFooterModelId,
  parseOpencodeFooter,
  opencodeRowMatches,
  parseOpencodeModelsOutput,
  parseOpencodePickerRows,
} from './runtimeProfile.js'

// Real `opencode models` lines from this computer (opencode 1.18.7), including the nested-model form.
const OUTPUT = [
  'opencode/ling-3.0-flash-free',
  'opencode-go/kimi-k3',
  'opencode-go/minimax-m3',
  'opencode-go/mimo-v2.5',
  'opencode-go/mimo-v2.5-pro',
  'vibe/minimax/minimax-m3',
  'not a model line',
].join('\n')

const catalog = parseOpencodeModelsOutput(OUTPUT)

describe('opencode model catalog', () => {
  it('reads provider/model and builds a picker filter from the model leaf plus provider', () => {
    expect(catalog.map((t) => t.id)).toEqual([
      'opencode/ling-3.0-flash-free',
      'opencode-go/kimi-k3',
      'opencode-go/minimax-m3',
      'opencode-go/mimo-v2.5',
      'opencode-go/mimo-v2.5-pro',
      'vibe/minimax/minimax-m3',
    ])
    // The picker renders the model's LAST segment, so that is what the filter is built from.
    expect(catalog.find((t) => t.id === 'vibe/minimax/minimax-m3')?.filter).toBe('minimax m3 vibe')
    expect(catalog.find((t) => t.id === 'opencode-go/kimi-k3')?.filter).toBe('kimi k3 opencode go')
  })

  it('parses the picker rows between its header and the hint line', () => {
    // Verbatim from the live picker, filtered to "minimax m3": two rows that differ only by provider.
    const capture = [
      '        Select model                                     esc',
      '        minimax m3',
      '        MiniMax-M3                               OpenCode Go',
      '      ● MiniMax M3 (vibe)             Vibe Gateway (Minimax)',
      '        Connect provider ctrl+a  Favorite ctrl+f',
      '   ┃  Ask anything...',
    ].join('\n')

    const rows = parseOpencodePickerRows(capture)
    // The filter box ("minimax m3") sits between the header and the rows and must not be counted as one.
    expect(rows).toEqual([
      { display: 'MiniMax-M3', provider: 'OpenCode Go', current: false },
      { display: 'MiniMax M3 (vibe)', provider: 'Vibe Gateway (Minimax)', current: true },
    ])
    expect(parseOpencodePickerRows('no picker here')).toBeNull()
  })

  it('reads the CURRENT picker, not an earlier one left in the scrollback', () => {
    // A tmux capture carries history; the pane really does hold several openings of the same picker.
    const stale = [
      '        Select model                                     esc',
      '        kimi',
      '        Kimi K3 (2x usage)                       OpenCode Go',
      '        Kimi K2.6                                OpenCode Go',
      '        Connect provider ctrl+a  Favorite ctrl+f',
      '        Select model                                     esc',
      '        kimi k3 opencode go',
      '        Kimi K3 (2x usage)                       OpenCode Go',
      '        Connect provider ctrl+a  Favorite ctrl+f',
    ].join('\n')

    expect(parseOpencodePickerRows(stale)).toEqual([
      { display: 'Kimi K3 (2x usage)', provider: 'OpenCode Go', current: false },
    ])
  })

  it('counts picker openings so a stale one cannot pass for a fresh one', () => {
    const two = ['   Select model   esc', '   kimi', '   Select model   esc', '   kimi k3'].join('\n')
    expect(countOpencodePickers(two)).toBe(2)
    expect(countOpencodePickers('nothing')).toBe(0)
  })

  it('tells two same-named models apart by provider', () => {
    const rows = parseOpencodePickerRows([
      '        Select model    esc',
      '        minimax m3',
      '        MiniMax-M3                               OpenCode Go',
      '      ● MiniMax M3 (vibe)             Vibe Gateway (Minimax)',
      '        Connect provider ctrl+a',
    ].join('\n'))!
    const go = catalog.find((t) => t.id === 'opencode-go/minimax-m3')!
    const vibe = catalog.find((t) => t.id === 'vibe/minimax/minimax-m3')!

    expect(rows.filter((r) => opencodeRowMatches(go, r))).toEqual([rows[0]])
    expect(rows.filter((r) => opencodeRowMatches(vibe, r))).toEqual([rows[1]])
  })

  it('resolves the footer back to a catalog id, longest model name first', () => {
    // Both footers are real: before and after the probe switched the model.
    expect(opencodeFooterModelId('┃  Build · MiniMax M3 (vibe) Vibe Gateway (Minimax)', catalog))
      .toBe('vibe/minimax/minimax-m3')
    expect(opencodeFooterModelId('┃  Build · Ling-3.0-flash Free OpenCode Zen', catalog))
      .toBe('opencode/ling-3.0-flash-free')
    // `MiMo V2.5 Pro` must not collapse onto `mimo-v2.5`.
    expect(opencodeFooterModelId('┃  Build · MiMo V2.5 Pro OpenCode Go', catalog))
      .toBe('opencode-go/mimo-v2.5-pro')
    expect(opencodeFooterModelId('┃  Ask anything...', catalog)).toBeNull()
  })

  it('keeps the reasoning level out of the model it searches for', () => {
    // Builds that have a reasoning axis print it after a second separator. Taking everything after
    // the FIRST one swallowed the level into the model text, so the catalog was searched for
    // "…OpenCode Zen high" and the level was thrown away.
    expect(opencodeFooterModelId('┃  Build · Ling-3.0-flash Free OpenCode Zen · high', catalog))
      .toBe('opencode/ling-3.0-flash-free')
  })

  it('reads model and level apart, from a real footer', () => {
    expect(parseOpencodeFooter('┃  Build · Ox Alpha Free (Unlimited) OpenCode Zen · high'))
      .toEqual({ target: 'Ox Alpha Free (Unlimited) OpenCode Zen', effort: 'high' })

    // A build with no reasoning axis says nothing about one, and nothing is what it gets.
    expect(parseOpencodeFooter('┃  Build · MiniMax M3 (vibe) Vibe Gateway (Minimax)'))
      .toEqual({ target: 'MiniMax M3 (vibe) Vibe Gateway (Minimax)', effort: null })

    // A trailing segment that is not a single bare word is part of a name, not a level: guessing one
    // would put a wrong value on the chip rather than no value.
    expect(parseOpencodeFooter('┃  Build · Some Model Provider · 2 files')?.effort).toBeNull()

    expect(parseOpencodeFooter('┃  Ask anything...')).toBeNull()
  })

  it('still names the model when the catalog does not list it', () => {
    // Not hypothetical: with no provider connected OpenCode runs a built-in free model that
    // `opencode models` never prints, and insisting on a catalog match left the chips blank while
    // the terminal named the model two lines below.
    const footer = '┃  Build · Ox Alpha Free (Unlimited) OpenCode Zen · high'
    expect(opencodeFooterModelId(footer, catalog)).toBeNull()
    expect(parseOpencodeFooter(footer)?.target).toBe('Ox Alpha Free (Unlimited) OpenCode Zen')
  })
})
