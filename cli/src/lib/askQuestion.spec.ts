import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  AskQuestionController,
  matchRow,
  parseEngineQuestionPane,
  parseQuestionPane,
  QuestionWatcher,
  shapeQuestions,
  type QuestionView,
  type ReviewView,
} from './askQuestion.js'
import type { RegisteredSession } from './registry.js'

// Real `tmux capture-pane` output from Claude Code 2.1.220 dialogs (the single-select one still carries
// its SGR codes, exactly as captureTmuxPane returns it).
const fixture = (name: string): string =>
  readFileSync(join(__dirname, '__fixtures__', `question-${name}.txt`), 'utf8')

const asQuestion = (view: ReturnType<typeof parseQuestionPane>): QuestionView => {
  expect(view?.kind).toBe('question')
  return view as QuestionView
}

describe('shapeQuestions', () => {
  it('keys each question the way the CLI matches answers, and flattens option labels', () => {
    const shaped = shapeQuestions([
      { question: 'Which color?', header: 'Color', multiSelect: true, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }] },
    ])
    expect(shaped).toEqual([{ key: 'Which color?', q: 'Which color?', options: ['Red', 'Blue'], multi: true }])
  })

  it('falls back to id/header for the key and defaults multi to false', () => {
    expect(shapeQuestions([{ id: 'q1', options: [] }])).toEqual([{ key: 'q1', q: '', options: [], multi: false }])
    expect(shapeQuestions(undefined)).toEqual([])
  })
})

describe('the Hermes clarify dialog', () => {
  // Real capture from hermes on a live pane: the SAME dialog Claude paints (`❯ 1. Xanh` rows, a footer
  // reading "Enter to confirm") wrapped in a box-drawing frame. Peeling the frame is the whole adaptation
  // — a second parser would have drifted from the one it duplicates.
  it('reads through the box frame that wraps it', () => {
    const view = asQuestion(parseEngineQuestionPane('hermes', fixture('hermes')))
    expect(view.question).toBe('Bạn muốn chọn size nào?')
    expect(view.rows.map((r) => [r.number, r.label])).toEqual([['1', 'S'], ['2', 'M']])
    expect(view.multi).toBe(false)
  })

  it('offers the free-text row as free text, not as an option', () => {
    // Hermes writes "Other (type your answer)" where Claude writes "Type something." — it must not be
    // announced to the device as a choosable label.
    const view = asQuestion(parseEngineQuestionPane('hermes', fixture('hermes')))
    expect(view.rows.map((r) => r.label)).not.toContain('Other (type your answer)')
  })

  it('is invisible to the unframed parser — which is why the engine branch exists', () => {
    expect(parseQuestionPane(fixture('hermes'))).toBeNull()
  })
})

describe('the OpenCode question dialog', () => {
  // Real capture from opencode on a live pane. Same bones as Claude's — `1. Size S` rows, a free-text row
  // last — but framed in `┃` and with its own footer wording ("enter submit"), which is why the shared
  // footer anchor had to learn a second phrasing rather than each CLI getting a parser.
  it('reads through the frame and the different footer wording', () => {
    const view = asQuestion(parseEngineQuestionPane('opencode', fixture('opencode')))
    expect(view.question).toBe('Bạn muốn chọn size nào?')
    expect(view.rows.map((r) => r.label)).toEqual(['Size S', 'Size M'])
  })

  it('treats "Type your own answer" as the free-text row, not an option', () => {
    // Each CLI words this row differently; offering it as a label would send the device an answer that
    // selects nothing.
    const view = asQuestion(parseEngineQuestionPane('opencode', fixture('opencode')))
    expect(view.typeRow?.label).toBe('Type your own answer')
    expect(view.rows.map((r) => r.label)).not.toContain('Type your own answer')
  })

  it('ignores the description line under each option', () => {
    const view = asQuestion(parseEngineQuestionPane('opencode', fixture('opencode')))
    expect(view.rows).toHaveLength(2)
  })
})

describe('the OpenCode review screen', () => {
  // Real capture of the last step of a multi-question dialog: a "Review" heading over `label: answer`
  // lines, NO numbered rows, submitted with Enter. Before this was recognised the driver read it as "no
  // dialog", stopped, and left a fully-answered form sitting there unsubmitted.
  it('is a review, not a question, and submits with Enter', () => {
    const view = parseEngineQuestionPane('opencode', fixture('opencode-review')) as ReviewView
    expect(view?.kind).toBe('review')
    expect(view.submitRow).toBe('Enter')
  })

  it('does not mistake a live question for the review', () => {
    expect(parseEngineQuestionPane('opencode', fixture('opencode'))?.kind).toBe('question')
  })
})

describe('parseQuestionPane', () => {
  it('reads a single-select dialog through its ANSI styling', () => {
    const view = asQuestion(parseQuestionPane(fixture('single')))
    expect(view.question).toBe('Which drink would you like?')
    expect(view.rows.map((r) => r.label)).toEqual(['Tea', 'Coffee'])
    expect(view.multi).toBe(false)
    expect(view.typeRow?.number).toBe('3')
  })

  it('reads a multi-select dialog: checkbox rows, and excludes the type/chat rows', () => {
    const view = asQuestion(parseQuestionPane(fixture('multi')))
    expect(view.question).toBe('Which toppings do you want?')
    expect(view.rows.map((r) => r.label)).toEqual(['Cheese', 'Ham', 'Basil'])
    expect(view.multi).toBe(true)
    expect(view.typeRow?.number).toBe('4')
  })

  it('skips the question tab bar when several questions share one dialog', () => {
    const view = asQuestion(parseQuestionPane(fixture('tabs')))
    expect(view.question).toBe('Which colors do you like?')
    expect(view.rows.map((r) => r.label)).toEqual(['Red', 'Blue', 'Green'])
  })

  it('recognises the review screen (no footer, rows below the prompt)', () => {
    const view = parseQuestionPane(fixture('review'))
    expect(view?.kind).toBe('review')
    expect((view as ReviewView).submitRow).toBe('1')
  })

  it('returns null when no dialog is open', () => {
    expect(parseQuestionPane('❯ \n  ⏸ plan mode on (shift+tab to cycle)')).toBeNull()
  })
})

describe('matchRow', () => {
  const rows = [
    { number: '1', label: 'Tách socket riêng cho voice', checked: false },
    { number: '2', label: 'Giữ nguyên', checked: false },
  ]

  it('matches exactly and case/space-insensitively', () => {
    expect(matchRow(rows, 'giữ  NGUYÊN')?.number).toBe('2')
  })

  it('matches a label the device truncated to its 80-byte buffer', () => {
    expect(matchRow(rows, 'Tách socket riêng')?.number).toBe('1')
  })

  it('returns null for a free-text answer', () => {
    expect(matchRow(rows, 'cho tao cai khac di')).toBeNull()
  })
})

// --- driving the pane -------------------------------------------------------------------------

interface Machine {
  keys: string[]
  texts: string[]
  controller: AskQuestionController
}

function machine(captures: string[], engine?: string): Machine {
  const keys: string[] = []
  const texts: string[] = []
  let i = 0
  const controller = new AskQuestionController({
    getSession: () => ({ sessionId: 's1', tmuxPane: '%1', ...(engine ? { engine } : {}) } as RegisteredSession),
    capture: async () => captures[Math.min(i++, captures.length - 1)],
    sendText: async (_pane, text) => { texts.push(text); return true },
    sendKey: async (_pane, key) => { keys.push(key); return true },
    wait: async () => {},
  })
  return { keys, texts, controller }
}

const CLOSED = '❯ \n  ⏸ plan mode on (shift+tab to cycle)'

describe('AskQuestionController.answer', () => {
  it('presses the option digit for a single-select answer', async () => {
    const h = machine([fixture('single'), CLOSED])
    const ok = await h.controller.answer({ requestId: 'r1', sessionId: 's1', answers: { 'Which drink would you like?': 'Coffee' } })
    expect(ok).toBe(true)
    expect(h.keys).toEqual(['2'])
  })

  it('types a voice/free-text answer into the "Type something." row and submits it', async () => {
    const h = machine([fixture('single'), CLOSED])
    const ok = await h.controller.answer({ requestId: 'r1', sessionId: 's1', answers: { 'Which drink would you like?': 'nuoc mia' } })
    expect(ok).toBe(true)
    expect(h.keys).toEqual(['3', 'Enter'])
    expect(h.texts).toEqual(['nuoc mia'])
  })

  it('toggles each selected checkbox then Tabs on, and submits from the review screen', async () => {
    const h = machine([fixture('multi'), fixture('review')])
    const ok = await h.controller.answer({ requestId: 'r1', sessionId: 's1', answers: { 'Which toppings do you want?': 'Cheese, Basil' } })
    expect(ok).toBe(true)
    expect(h.keys).toEqual(['1', '3', 'Tab', '1'])
  })

  it('answers each question of a multi-question dialog positionally when the text does not match', async () => {
    const h = machine([fixture('tabs'), fixture('single'), CLOSED])
    const ok = await h.controller.answer({
      requestId: 'r1',
      sessionId: 's1',
      answers: { 'Which colors do you like?': 'Blue', 'Which size do you want?': 'Tea' },
    })
    expect(ok).toBe(true)
    expect(h.keys).toEqual(['2', 'Tab', '1'])
  })

  it('leaves a multi-question dialog open on the question the device has not been shown yet', async () => {
    // The device answers ONE question at a time (the watcher pushes them as the pane advances), so the
    // drive loop must stop at the next question instead of guessing an answer for it.
    const h = machine([fixture('tabs'), fixture('single'), CLOSED])
    const ok = await h.controller.answer({ requestId: 'r1', sessionId: 's1', answers: { 'Which colors do you like?': 'Blue' } })
    expect(ok).toBe(true)
    expect(h.keys).toEqual(['2', 'Tab'])
  })

  it('does nothing when the dialog is already gone', async () => {
    const h = machine([CLOSED])
    expect(await h.controller.answer({ requestId: 'r1', sessionId: 's1', answers: { q: 'a' } })).toBe(false)
    expect(h.keys).toEqual([])
  })

  it('gives up instead of hammering keys when the dialog never advances', async () => {
    const h = machine([fixture('single')])
    const ok = await h.controller.answer({ requestId: 'r1', sessionId: 's1', answers: { 'Which drink would you like?': 'Tea' } })
    expect(ok).toBe(false)
    expect(h.keys.length).toBeLessThanOrEqual(3)
  })

  it('falls back to the remembered session when the device sends no sessionId', async () => {
    const h = machine([fixture('single'), CLOSED])
    h.controller.remember('r9', 's1')
    expect(await h.controller.answer({ requestId: 'r9', answers: { 'Which drink would you like?': 'Tea' } })).toBe(true)
    expect(h.keys).toEqual(['1'])
  })

  it('drops an answer with no answers map', async () => {
    const h = machine([fixture('single')])
    expect(await h.controller.answer({ requestId: 'r1', sessionId: 's1', answers: {} })).toBe(false)
  })
})

describe('QuestionWatcher', () => {
  const session = { sessionId: 's1', tmuxPane: '%1', engine: 'claude' } as RegisteredSession

  function watcher(captures: string[], opts: { hasDevice?: boolean } = {}): {
    seen: Array<{ requestId: string; questions: ReturnType<typeof shapeQuestions> }>
    tick: () => Promise<void>
    instance: QuestionWatcher
  } {
    let i = 0
    const seen: Array<{ requestId: string; questions: ReturnType<typeof shapeQuestions> }> = []
    const instance = new QuestionWatcher({
      getSession: () => session,
      capture: async () => captures[Math.min(i++, captures.length - 1)],
      hasDevice: () => opts.hasDevice !== false,
      onQuestion: (_s, requestId, questions) => { seen.push({ requestId, questions }) },
    })
    // tick() is private — exercised the way the interval does.
    const tick = (): Promise<void> => (instance as unknown as { tick: (s: string) => Promise<void> }).tick('s1')
    return { seen, tick, instance }
  }

  it('announces an open dialog in the device question shape', async () => {
    const w = watcher([fixture('single')])
    await w.tick()
    expect(w.seen).toHaveLength(1)
    expect(w.seen[0].questions).toEqual([
      { key: 'Which drink would you like?', q: 'Which drink would you like?', options: ['Tea', 'Coffee'], multi: false },
    ])
  })

  it('announces a question ONCE while it stays on screen', async () => {
    const w = watcher([fixture('single')])
    await w.tick(); await w.tick(); await w.tick()
    expect(w.seen).toHaveLength(1)
  })

  it('announces the next question of the same dialog once the pane advances', async () => {
    const w = watcher([fixture('tabs'), fixture('single')])
    await w.tick(); await w.tick()
    expect(w.seen.map((s) => s.questions[0].q)).toEqual(['Which colors do you like?', 'Which drink would you like?'])
    expect(w.seen[0].requestId).not.toBe(w.seen[1].requestId)
  })

  it('re-announces an open question after a device (re)join', async () => {
    const w = watcher([fixture('single')])
    await w.tick()
    w.instance.reset()
    await w.tick()
    expect(w.seen).toHaveLength(2)
    expect(w.seen[0].requestId).toBe(w.seen[1].requestId) // stable id → the device dedups if it still has it
  })

  it('says nothing when the pane has no dialog, or when no device is listening', async () => {
    expect((await (async () => { const w = watcher([CLOSED]); await w.tick(); return w.seen })()).length).toBe(0)
    expect((await (async () => { const w = watcher([fixture('single')], { hasDevice: false }); await w.tick(); return w.seen })()).length).toBe(0)
  })

  it('carries the multi-select flag so the device renders checkboxes', async () => {
    const w = watcher([fixture('multi')])
    await w.tick()
    expect(w.seen[0].questions[0]).toMatchObject({ options: ['Cheese', 'Ham', 'Basil'], multi: true })
  })
})

describe('parseQuestionPane — frame boundary', () => {
  // A capture taken mid-repaint: the live frame's question line is not painted yet, and the PREVIOUS
  // question is still in scrollback above. Pairing that stale title with the live options is what made
  // the device re-show "Chọn màu?" over question 2's options.
  const midRepaint = [
    'Chọn màu?',
    '',
    '  1. Đỏ',
    '  2. Vàng',
    '────────────────────────────',
    '←  ☒ Màu  ☐ Size  ✔ Submit  →',
    '',
    '',
    '❯ 1. S',
    '     Nhỏ.',
    '  2. M',
    '  3. Type something.',
    '',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ].join('\n')

  it('never takes a question from an older frame in scrollback', () => {
    const view = parseQuestionPane(midRepaint) as QuestionView
    expect(view.kind).toBe('question')
    expect(view.rows.map((r) => r.label)).toEqual(['S', 'M'])
    expect(view.question).toBe('')   // → the watcher skips this tick instead of announcing a stale title
  })

  it('so the watcher announces nothing until the question paints', async () => {
    let capture = midRepaint
    const seen: string[] = []
    const w = new QuestionWatcher({
      getSession: () => ({ sessionId: 's1', tmuxPane: '%1', engine: 'claude' } as RegisteredSession),
      capture: async () => capture,
      hasDevice: () => true,
      onQuestion: (_s, _r, qs) => { seen.push(qs[0].q) },
    })
    const tick = (): Promise<void> => (w as unknown as { tick: (s: string) => Promise<void> }).tick('s1')
    await tick()
    expect(seen).toEqual([])
    capture = midRepaint.replace('←  ☒ Màu  ☐ Size  ✔ Submit  →\n\n', '←  ☒ Màu  ☐ Size  ✔ Submit  →\n\nChọn size?\n')
    await tick()
    expect(seen).toEqual(['Chọn size?'])
  })
})

/**
 * Command Code paints the same dialog as Claude but with NO footer — the pane just ends at the last
 * option — so the footer anchor found nothing and the device showed no question at all while the terminal
 * sat waiting for an answer. Fixture captured from a live pane.
 */
describe('the Command Code question dialog', () => {
  const capture = fixture('commandcode')

  it('reads it through the tab bar instead of a footer', () => {
    const view = parseQuestionPane(capture)
    expect(view?.kind).toBe('question')
    if (view?.kind !== 'question') return
    expect(view.question).toBe('"Cầu vụ" bạn muốn game gì?')
    expect(view.rows.map((row) => row.label)).toEqual([
      'Cờ vua (Chess) (Recommended)',
      'Cầu vồng',
      'Cầu vượt',
    ])
  })

  it('keeps the free-text row out of the options', () => {
    // Claude writes "Type something.", Command Code "Type something..." — treated as an option it would
    // both pollute the device's list and leave a voice answer nowhere to go.
    const view = parseQuestionPane(capture)
    if (view?.kind !== 'question') throw new Error('not a question')
    expect(view.typeRow?.number).toBe('4')
    expect(view.rows.some((row) => /type something/i.test(row.label))).toBe(false)
  })
})

/**
 * Command Code's review screen has neither Claude's "Ready to submit your answers" line nor a footer —
 * just a Submit/Cancel pair under a numbered summary. Unrecognised, the drive loop hit its "nothing on
 * screen" exit and reported success while the terminal sat on the review screen, unanswered. Fixture
 * captured from a live pane in exactly that state.
 */
describe('the Command Code review screen', () => {
  const capture = fixture('commandcode-review')

  it('is recognised by its Submit/Cancel pair', () => {
    expect(parseQuestionPane(capture)).toEqual({ kind: 'review', submitRow: '1' })
  })

  it('does not read the numbered SUMMARY as options', () => {
    // "1. Quân cờ mày muốn hình dạng kiểu nào?" and friends are recap lines, not choices — reading them
    // as a question is how a review screen turns into a phantom question on the device.
    const view = parseQuestionPane(capture)
    expect(view?.kind).not.toBe('question')
  })
})

/**
 * Permission prompts — the reason this whole bridge matters on a remote machine.
 *
 * The CLI attaches to an agent the USER started, under the user's own config and with no permission flag
 * of ours, so a blocking approval is the pane's normal state rather than an edge case. Every fixture below
 * is a real `tmux capture-pane -e` of a live prompt, triggered by asking the engine to run a curl (or, for
 * opencode, to read outside its workspace) — never hand-written, per `engines/README.md`'s one rule.
 *
 * Four engines needed nothing: codex and hermes already fall out of the shared parser (their footers are
 * its anchor), opencode's is kilo's horizontal prompt, and amp/kilo shipped theirs earlier. Muse and pi
 * are absent because they have no such prompt at all — both sandbox the shell and refuse outright rather
 * than ask (measured: muse answers "the shell is sandboxed to the workspace", pi reports the denial and
 * offers alternatives). Cursor is absent because its free-request limit blocked a capture, and a parser
 * written without one would be exactly the silent failure the one rule exists to prevent.
 */
const permission = (name: string): string =>
  readFileSync(join(__dirname, '__fixtures__', `permission-${name}.txt`), 'utf8')

describe('permission prompts, per engine', () => {
  const cases: Array<{ engine: string; fixture: string; question: string; rows: string[] }> = [
    {
      engine: 'claude', fixture: 'claude',
      question: 'Approve Bash command: curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin',
      // Note the TYPOGRAPHIC apostrophe: Claude writes "don’t", not "don't".
      rows: ['Yes', 'Yes, and don’t ask again for: curl *', 'No'],
    },
    {
      engine: 'claude', fixture: 'claude-edit',
      question: 'Approve Edit file: README.md',
      rows: ['Yes', 'Yes, allow all edits during this session (shift+tab)', 'No'],
    },
    {
      engine: 'commandcode', fixture: 'commandcode',
      question: 'Approve Execute Shell Command: Command Code needs to execute curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin.',
      rows: ['Yes', "Yes, don't ask again for this exact command in this project", 'No, tell Command Code what to do differently'],
    },
    {
      engine: 'codex', fixture: 'codex',
      question: "$ printf 'hi\\n' > /private/etc/harness-probe.txt",
      rows: [
        'Yes, proceed (y)',
        "Yes, and don't ask again for commands that start with `printf 'hi\\n' > /private/etc/harness-probe.txt` (p)",
        'No, and tell Codex what to do differently (esc)',
      ],
    },
    {
      engine: 'devin', fixture: 'devin',
      question: 'Approve curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin',
      rows: ['Yes (Approve once)', 'Yes, allow `curl` commands', 'Yes, always allow `curl` commands in `work-devin`', 'Yes, always allow `curl` commands in all projects', 'No'],
    },
    {
      engine: 'grok', fixture: 'grok',
      question: 'curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin',
      rows: ["Yes, and don't ask again for anything (always-approve mode)", 'Yes, proceed', 'No, reject (type to add feedback)'],
    },
    {
      // Muse gates the NETWORK, not the command: its prompt names the host, and it only appears at all
      // because `--approval-mode` defaults to `on-request`. A first sweep that only tried a sandboxed
      // file write concluded muse never asks — it does.
      engine: 'muse', fixture: 'muse',
      question: '$ curl -s https://example.com',
      rows: ['Yes, proceed (y)', "Yes, don't ask again this session (p)  example.com:443 (https)", 'No, and tell Muse Code what to do differently (esc)'],
    },
    {
      engine: 'hermes', fixture: 'hermes',
      question: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin',
      rows: ['Allow once', 'Allow for this session', 'Deny'],
    },
    {
      // Cursor is the third selection mechanism: it numbers nothing and walks nothing — each row states
      // its own key, so `number` carries `y` / `Tab` / `BTab` / `n` instead of a digit or an index.
      engine: 'cursor', fixture: 'cursor',
      question: 'Approve curl -s https://example.com',
      rows: ['Run (once)', 'Add Shell(curl) to allowlist?', 'Run Everything', 'Skip & tell the agent what to do instead'],
    },
    {
      engine: 'opencode', fixture: 'opencode',
      question: 'Access external directory /private/etc',
      rows: ['Allow once', 'Allow always', 'Reject'],
    },
  ]

  for (const c of cases) {
    describe(`${c.engine} (${c.fixture})`, () => {
      const view = (): QuestionView => asQuestion(parseEngineQuestionPane(c.engine as never, permission(c.fixture)))

      it('reads the prompt and every option off the pane', () => {
        expect(view().question).toBe(c.question)
        expect(view().rows.map((row) => row.label)).toEqual(c.rows)
      })

      it('keeps a way to say no', () => {
        // Amp's rule, and the reason its "Reject with feedback" row survives: a device user offered three
        // ways to approve and none to decline cannot answer the prompt at all. The word varies more than
        // it looks — cursor says "Skip", hermes says "Deny" — which is why the shared REJECT_RE lists all
        // of them rather than assuming "no".
        expect(view().rows.some((row) => /^(no|reject|deny|skip|cancel)\b/i.test(row.label))).toBe(true)
      })

      it('is single-select with nothing to type into', () => {
        // The device answers a question by TAPPING (ui_screens.c) and an approval has no free-text row,
        // so a typeRow here would offer a choice the device can never make.
        expect(view().multi).toBe(false)
        expect(view().typeRow).toBeNull()
      })

      it('fits the device screen', () => {
        // Firmware caps: Q_MAX 4 questions, OPT_MAX 6 options. Overflow is dropped SILENTLY, and the row
        // that would fall off the end is the last one — which on devin is "No".
        expect(view().rows.length).toBeLessThanOrEqual(6)
      })
    })
  }
})

describe('permission prompts vs the ask dialog', () => {
  // Both anchors can be on one capture, because a pane keeps its scrollback. Whichever sits LOWER is the
  // live dialog; getting this backwards shows the user a prompt they already answered, or answers the
  // wrong dialog with the digit meant for the other.
  it('takes the permission prompt when it is below an answered question', () => {
    const view = asQuestion(parseQuestionPane(fixture('single') + permission('claude')))
    expect(view.rows.map((r) => r.label)).toEqual(['Yes', 'Yes, and don’t ask again for: curl *', 'No'])
  })

  it('takes the question when IT is the lower of the two', () => {
    const view = asQuestion(parseQuestionPane(permission('claude') + fixture('single')))
    expect(view.question).toBe('Which drink would you like?')
    expect(view.rows.map((r) => r.label)).toEqual(['Tea', 'Coffee'])
  })

  it('does not read an ordinary numbered list as an approval', () => {
    // The rows are what identify a permission prompt — a list that offers no way to decline is prose.
    const prose = [
      'Here is the plan:',
      '  1. Yes we should refactor the parser',
      '  2. Then update the fixtures',
      '',
      'Esc to cancel',
    ].join('\n')
    expect(parseQuestionPane(prose)).toBeNull()
  })

  it('does not read a numbered block with no key hints under it as an approval', () => {
    const orphan = ['  1. Yes', '  2. No', '', '', '', '', '', ''].join('\n')
    expect(parseQuestionPane(orphan)).toBeNull()
  })
})

describe('answering a permission prompt from the device', () => {
  it('presses the digit that declines, on an engine whose rows are numbered', () => {
    // Verified on a live claude pane: one digit selects AND submits, so no Enter follows it.
    const h = machine([permission('claude'), CLOSED])
    const answers = { 'Approve Bash command: curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin': 'No' }
    return h.controller.answer({ requestId: 'r1', sessionId: 's1', answers }).then((ok) => {
      expect(ok).toBe(true)
      expect(h.keys).toEqual(['3'])
    })
  })

  it('presses devin\'s real row number, not its position in the shortened list', () => {
    // Devin's "No" is row 7 of 7; two unanswerable editor rows are dropped from what the device shows, so
    // the label→digit mapping must survive that filter.
    const h = machine([permission('devin'), CLOSED], 'devin')
    return h.controller.answer({ requestId: 'r1', sessionId: 's1', answers: { 'Approve curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin': 'No' } }).then((ok) => {
      expect(ok).toBe(true)
      expect(h.keys).toEqual(['7'])
    })
  })

  it('walks to the row on opencode, whose permission prompt numbers nothing', () => {
    // opencode draws BOTH a numbered ask dialog and kilo's horizontal prompt, so the direction travels on
    // the ROW. Keying "2" here would select nothing at all.
    const h = machine([permission('opencode'), CLOSED], 'opencode')
    return h.controller.answer({ requestId: 'r1', sessionId: 's1', answers: { 'Access external directory /private/etc': 'Reject' } }).then((ok) => {
      expect(ok).toBe(true)
      expect(h.keys).toEqual(['Right', 'Right', 'Enter'])
    })
  })

  it('matches an option the device truncated to its 80-byte buffer', () => {
    const h = machine([permission('codex'), CLOSED], 'codex')
    const truncated = "Yes, and don't ask again for commands that start with `printf 'hi\\n' > /priva"
    return h.controller.answer({ requestId: 'r1', sessionId: 's1', answers: { "$ printf 'hi\\n' > /private/etc/harness-probe.txt": truncated } }).then((ok) => {
      expect(ok).toBe(true)
      expect(h.keys).toEqual(['2'])
    })
  })
})

describe('QuestionWatcher on a permission prompt', () => {
  it('announces it exactly like a question, so the firmware renders it unchanged', async () => {
    const seen: Array<{ requestId: string; questions: Array<{ key: string; q: string; options: string[]; multi: boolean }> }> = []
    const w = new QuestionWatcher({
      getSession: () => ({ sessionId: 's1', tmuxPane: '%1', engine: 'claude' } as RegisteredSession),
      capture: async () => permission('claude'),
      hasDevice: () => true,
      onQuestion: (_s, requestId, questions) => { seen.push({ requestId, questions }) },
    })
    const tick = (): Promise<void> => (w as unknown as { tick: (s: string) => Promise<void> }).tick('s1')
    await tick()
    expect(seen).toHaveLength(1)
    expect(seen[0].questions[0]).toMatchObject({
      q: 'Approve Bash command: curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin',
      options: ['Yes', 'Yes, and don’t ask again for: curl *', 'No'],
      multi: false,
    })
    // Same prompt still on screen ⇒ announced once, not every 1.5s tick.
    await tick()
    expect(seen).toHaveLength(1)
  })
})
