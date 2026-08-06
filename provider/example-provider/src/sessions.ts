/**
 * The identity bridge, persisted to `sessions.json`.
 *
 * One agent is one continuous transcript, so one agent maps to **one Claude session**, resumed on
 * every turn with `--resume`. That is the whole bridge: agentId → claudeSessionId, surviving restarts
 * of this process.
 *
 * Turn records exist because a recap is per-TURN while Claude's transcript is a whole session. The
 * timestamp window on each record is what lets a turn be sliced back out of the JSONL.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface TurnRecord {
  turnId: string
  agentId: string
  startedAt: number
  endedAt?: number
  failed?: boolean
  /** First user text of the turn. */
  title: string
  /**
   * Headline of what this turn ACCOMPLISHED. Absent until the turn has been summarised, and
   * absent forever on a turn that failed — deliberately NOT the same thing as `title`, which is what
   * the user asked.
   */
  recap?: string
  /** The fuller summary behind the headline; `text` on the wire. */
  body?: string
}

export interface AgentRecord {
  agentId: string
  /** Absent until Claude reports one on the first turn. */
  claudeSessionId?: string
}

interface StateFile {
  agents: Record<string, AgentRecord>
  turns: Record<string, TurnRecord>
}

export class SessionStore {
  private state: StateFile = { agents: {}, turns: {} }

  constructor(private readonly file: string) {
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StateFile>
      this.state = { agents: parsed.agents ?? {}, turns: parsed.turns ?? {} }
    } catch {
      // A corrupt state file must not stop the provider from serving new turns; history for the
      // affected agents is lost, which is visible, whereas refusing to boot is not.
      this.state = { agents: {}, turns: {} }
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    // Write-then-rename: a crash mid-write must not leave a truncated state file behind.
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2))
    renameSync(tmp, this.file)
  }

  agent(agentId: string): AgentRecord | undefined {
    return this.state.agents[agentId]
  }

  ensureAgent(agentId: string): AgentRecord {
    const existing = this.state.agents[agentId]
    if (existing) return existing
    const created: AgentRecord = { agentId }
    this.state.agents[agentId] = created
    this.save()
    return created
  }

  setClaudeSession(agentId: string, claudeSessionId: string): void {
    const record = this.state.agents[agentId]
    if (!record || record.claudeSessionId === claudeSessionId) return
    record.claudeSessionId = claudeSessionId
    this.save()
  }

  createTurn(turn: TurnRecord): void {
    this.state.turns[turn.turnId] = turn
    this.save()
  }

  finishTurn(turnId: string, failed: boolean): void {
    const turn = this.state.turns[turnId]
    if (!turn) return
    turn.failed = failed
    turn.endedAt = Date.now()
    this.save()
  }

  turn(turnId: string): TurnRecord | undefined {
    return this.state.turns[turnId]
  }

  /** Newest first, for one agent. */
  turns(agentId: string): TurnRecord[] {
    return Object.values(this.state.turns)
      .filter((t) => t.agentId === agentId)
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Attach a summary to a finished turn. Persisted, so a device restoring tiles has no stream to need. */
  setRecap(turnId: string, recap: string, body: string): void {
    const turn = this.state.turns[turnId]
    if (!turn || !recap) return
    turn.recap = recap
    turn.body = body
    this.save()
  }

  /**
   * The most recent SUMMARISED turns for one agent, newest first.
   *
   * Turns still running, and turns that failed, carry no recap and are simply not here — an empty
   * array before anything has been summarised is the correct answer, and the device then shows
   * nothing rather than stale text.
   */
  /** The agent's LAST summarised turn. The device shows one tile per agent; there is nothing to page. */
  lastRecap(agentId: string): TurnRecord | undefined {
    return Object.values(this.state.turns)
      .filter((t) => t.agentId === agentId && !!t.recap)
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))[0]
  }
}
