/**
 * The Hermes ACP backend: runs a Ticket's Assignments in a session of a local Hermes profile instead of a DSH Session, with the
 * same tools, the same full permissions and the same report contract as a DSH worker.
 */
import { mkdir } from 'node:fs/promises'
import { latestAssignment, latestReport, liveTicket, runningAssignment, waitsForPerson } from '../core/index.ts'
import type { Assignment, EngineForExecutor, Ticket, TicketInput, Trigger } from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../app/store.ts'
import { Later, type Effects } from '../app/effects.ts'
import { KV } from '../kv.ts'
import type { Variable } from '../app/execution-environment.ts'
import type { HealthEntry } from '../infra/health.ts'
import { acpFactory, type AcpConnection, type AcpFactory, type AcpMcpServer, type AcpSession, type AcpUpdate } from './acp.ts'
import { batchLine, batchOf, inputMessage, sourceTrigger, transient, triggerMessage } from './dsh.ts'
import { hermesMcpUrl } from './hermes-bridge.ts'

/** How much of the assignment text the first prompt carries inline; a longer one is read through the ticket resource. */
const ASSIGNMENT_CHARS = 1500
/** How long a launch waits for its session before the effect retries with backoff. */
const LAUNCH_TRIES = 3
/** The ACP edit mode that auto-allows edits in this session; commands are still auto-approved one request at a time. */
const EDIT_MODE = 'dont_ask'
/** What a Hermes worker is told about its backend, beyond the worker prompt every Executor Session gets. */
const BACKEND_RULES = `## Execution backend: Hermes ACP
This Ticket runs in a Hermes ACP session, not in a DSH Session.
- Your working directory is the Ticket's own directory. Keep drafts, logs and scripts that produce a deliverable there.
- The \`superagent\` MCP server exposes the Executor Session tools: \`orchestrator_read\`, \`orchestrator_ack\`, \`orchestrator_thread_follow\`, \`orchestrator_thread_unrelated\`, \`orchestrator_trigger_handback\` and \`orchestrator_report\`. Use \`orchestrator_report\` exactly as the worker rules above require: a ready result that opens no pull request carries \`delivery\`, and a turn never ends the work without a report.
- Every permission request is approved automatically: you run unattended, with the same full access as a DSH worker. Never ask a person for approval or wait for one.
- Only finished deliverables go to the delivery directory below, and report artifact paths are relative to it. Working files stay in the Ticket directory.
- If you cannot continue, report blocked or failed with the concrete missing prerequisite instead of stopping silently.`

/** What the Executor needs of the Runtime. */
export interface HermesHost {
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed'
    | 'report' | 'assignmentInterrupted'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'settings' | 'get' | 'set' | 'delete' | 'afterCommit'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  /** The `hermes` health entry, which reports the ACP connection and the Hermes effect kinds. */
  readonly health: HealthEntry
  readonly lifetime: AbortSignal
  readonly machine: Pick<Machine, 'stateDir'>
  /** Execution environment variables of `ticket`, which its prompt states. */
  environment(ticket: Ticket): Variable[]
  /** The worker prompt a DSH Executor Session would get, which the Hermes session receives as its first instruction. */
  workerPrompt(ticket: Ticket): string
  /** The loopback origin of the management server, such as `http://127.0.0.1:3082`. */
  readonly bridgeUrl: string
  /** The private bearer token of the MCP bridge. */
  readonly token: string
  closing(): boolean
  paused(): boolean
  sourceLink?(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  repliedTo?(trigger: Trigger): Trigger | undefined
  /** Opens the ACP connection; tests replace it with a scripted one. */
  acp?: AcpFactory
}

/** What one Ticket's ACP work needs: its session, the prompts still running, and the report baseline of this turn sequence. */
interface Run { assignmentId: string; before?: string; pending: number; text: string; error?: unknown; timedOut?: boolean }

/**
 * Executes workspace-only Tickets in Hermes ACP sessions, one session per Ticket. It queues launches and Input deliveries
 * through Effects, attaches the Superagent MCP bridge to each session, answers every permission request in favour of the action,
 * and turns ACP turn ends into the same turn and report facts a DSH Executor reports.
 */
export class HermesAcpExecutor {
  private connection?: AcpConnection
  private connecting?: Promise<AcpConnection>
  /** The ACP session of each Ticket that ran in this process, also kept in KV across restarts. */
  private readonly sessions = new Map<string, string>()
  /** The Ticket of each ACP session, for stream updates. */
  private readonly tickets = new Map<string, string>()
  /** Tickets whose ACP turn currently holds a worker slot, with the Assignment it runs. */
  private readonly busy = new Map<string, string>()
  /** The turn sequence of each Ticket, from its first prompt until the last queued turn ends. */
  private readonly runs = new Map<string, Run>()
  /** Transient launch failure counts, by Assignment ID. */
  private readonly transient = new Map<string, number>()

  constructor(private readonly host: HermesHost) {
    host.effects.handle('hermes-launch', payload => this.launchQueued(payload), { limit: () => this.freeSlots(), retry: [15_000, 300_000] })
    host.effects.handle('hermes-delivery', payload => this.deliverQueued(payload.ticketId), { limit: () => host.paused() || host.closing() ? 0 : 2, quiet: true })
    this.reportHealth('ready', 'No Hermes ACP session is open')
  }

  private get hermes() { return this.host.store.settings().executor.hermes }
  private maxWorkers(): number { return this.host.store.settings().executor.maxWorkers }
  private freeSlots(): number {
    if (this.host.paused() || this.host.closing()) return 0
    return Math.max(0, this.maxWorkers() - this.busy.size)
  }
  private reportHealth(state: 'ready' | 'error', detail: string): void { this.host.health.set({ state, detail, at: new Date().toISOString() }) }

  /** Queues a launch of a Hermes Ticket's pending Assignment. */
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('hermes-launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  /** Queues delivery of a Hermes Ticket's waiting Inputs to its running Assignment. */
  deliver(ticket: Ticket, _assignment: Assignment): void {
    this.host.effects.enqueue('hermes-delivery', ticket.id, { ticketId: ticket.id })
  }

  /** Number of Hermes Tickets whose ACP turn holds a worker slot. */
  activeCount(): number { return this.busy.size }

  /** Registers nothing with the host: the Hermes backend has no DSH Session events; ACP streams arrive on its own connection. */
  install(): void { /* Nothing to subscribe to on the DSH context. */ }

  /** Marks Hermes Assignments a restart interrupted, and re-queues the pending launches of open Hermes Tickets. */
  resume(): void {
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (ticket.execution?.runtime !== 'hermes') continue
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      if (running) this.host.engine.assignmentInterrupted(ticket.id, running.id)
      else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, latest)
    }
  }

  /** Closes the ACP connection after marking every open ACP session's turn cancelled. */
  async shutdown(): Promise<void> {
    const connection = this.connection
    if (!connection) return
    for (const session of this.sessions.values()) connection.cancel(session)
    await connection.close().catch(() => undefined)
    this.connection = undefined
    this.connecting = undefined
  }

  /** Clears the in-process state; the ACP connection is closed by `shutdown`. */
  dispose(): void {
    this.sessions.clear(); this.tickets.clear(); this.busy.clear(); this.runs.clear(); this.transient.clear()
  }

  /** Ends a Ticket's ACP turn: cancels the running prompt and, when the Ticket ended, closes its session and forgets it. */
  stop(ticket: Ticket, assignment: Assignment, _reason: string): void {
    this.transient.delete(assignment.id)
    const ticketId = ticket.id
    this.host.store.afterCommit(() => {
      const run = this.runs.get(ticketId)
      if (run?.assignmentId === assignment.id) { this.runs.delete(ticketId); this.busy.delete(ticketId) }
      const session = this.sessions.get(ticketId) ?? this.host.store.get(KV.hermes.session(ticketId))
      if (!session) return
      const connection = this.connection
      if (connection?.alive) connection.cancel(session)
      if (!liveTicket(ticket)) void this.closeSession(ticketId, session)
    })
  }

  private async launchQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || ticket.execution?.runtime !== 'hermes' || assignment?.id !== assignmentId || assignment.state !== 'pending') return
    if (this.host.paused() || this.host.closing()) throw new Later('Processing is paused')
    if (this.freeSlots() <= 0) throw new Later('No worker slot is free')
    this.busy.set(ticketId, assignmentId)
    let started = false
    try {
      await this.launch(ticket, assignment)
      started = true
      this.transient.delete(`launch:${assignmentId}`)
    } catch (error) {
      if (this.host.closing() || error instanceof Later) { this.busy.delete(ticketId); throw error }
      const tries = this.transient.get(`launch:${assignmentId}`) ?? 0
      if (transient(error) && tries < LAUNCH_TRIES) {
        this.transient.set(`launch:${assignmentId}`, tries + 1)
        this.busy.delete(ticketId)
        this.reportHealth('error', `Launch failed, retrying: ${String(error).slice(0, 300)}`)
        throw error
      }
      this.transient.delete(`launch:${assignmentId}`)
      this.busy.delete(ticketId)
      this.reportHealth('error', String(error).slice(0, 500))
      this.fail(ticketId, assignmentId, String(error))
    } finally {
      // A launch that never sent its prompt holds no slot; one that did is released when its turn sequence ends.
      if (!started && !this.runs.get(ticketId)) this.busy.delete(ticketId)
    }
  }

  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    const directory = ticket.execution?.directory ?? ''
    await mkdir(directory, { recursive: true })
    const connection = await this.connect()
    const session = await this.sessionFor(ticket, connection)
    const text = await this.assignmentPrompt(ticket)
    const run: Run = { assignmentId: assignment.id, before: this.before(ticket), pending: 0, text: '' }
    this.runs.set(ticket.id, run)
    this.host.engine.assignmentStarted(ticket.id, assignment.id)
    this.prompt(ticket.id, assignment.id, connection, session.sessionId, text)
  }

  /** Opens, or reuses, the one ACP connection of this Executor, and reports the connection health. */
  private async connect(): Promise<AcpConnection> {
    if (this.connection?.alive) return this.connection
    this.connecting ??= (async () => {
      const settings = this.hermes
      const factory = this.host.acp ?? acpFactory
      const connection = factory({ command: settings.command, args: ['-p', settings.profile, 'acp'], cwd: this.host.machine.stateDir,
        onUpdate: update => this.onUpdate(update), onPermission: (request, optionId) => {
          this.reportHealth('ready', `Approved ${optionId ?? 'no option'}: ${String(request.toolCall?.title ?? 'a permission request').slice(0, 160)}`)
        } })
      try {
        await connection.initialize()
      } catch (error) {
        await connection.close().catch(() => undefined)
        this.reportHealth('error', `Hermes ACP is unavailable: ${String(error).slice(0, 500)}`)
        throw error
      }
      this.connection = connection
      this.reportHealth('ready', `Hermes profile ${settings.profile} is connected`)
      return connection
    })().catch(error => { this.connecting = undefined; throw error })
    const connection = await this.connecting
    this.connecting = undefined
    return connection
  }

  /** The ACP session of a Ticket: the stored one resumed when the profile still knows it, else a new session in its directory. */
  private async sessionFor(ticket: Ticket, connection: AcpConnection): Promise<AcpSession> {
    const known = this.sessions.get(ticket.id) ?? this.host.store.get(KV.hermes.session(ticket.id))
    const directory = ticket.execution?.directory ?? ''
    const mcpServers: AcpMcpServer[] = [{ type: 'http', name: 'superagent',
      url: hermesMcpUrl(this.host.bridgeUrl, ticket.id), headers: [{ name: 'Authorization', value: `Bearer ${this.host.token}` }] }]
    if (known) {
      const resumed = await connection.resumeSession({ sessionId: known, cwd: directory, mcpServers })
      if (resumed) {
        await this.adopt(ticket, connection, resumed.sessionId)
        return resumed
      }
      this.host.store.delete(KV.hermes.session(ticket.id))
    }
    const opened = await connection.newSession({ cwd: directory, mcpServers })
    await this.adopt(ticket, connection, opened.sessionId)
    return opened
  }

  /** Records a session, sets its unattended edit mode, and maps it back to its Ticket for stream updates. */
  private async adopt(ticket: Ticket, connection: AcpConnection, sessionId: string): Promise<void> {
    this.sessions.set(ticket.id, sessionId)
    this.tickets.set(sessionId, ticket.id)
    this.host.store.set(KV.hermes.session(ticket.id), sessionId)
    await connection.setMode(sessionId, EDIT_MODE).catch(() => { /* Older Hermes versions have no edit modes; permissions still auto-allow. */ })
  }

  /** Forgets and closes a Ticket's ACP session. */
  private async closeSession(ticketId: string, sessionId: string): Promise<void> {
    this.sessions.delete(ticketId)
    this.tickets.delete(sessionId)
    this.host.store.delete(KV.hermes.session(ticketId))
    await this.connection?.closeSession(sessionId).catch(() => undefined)
  }

  private before(ticket: Ticket): string | undefined { return latestReport(ticket)?.at }

  /** Sends one prompt and starts tracking its turn; the caller has recorded the Assignment or the Input it carries. */
  private prompt(ticketId: string, assignmentId: string, connection: AcpConnection, sessionId: string, text: string): void {
    const run = this.runs.get(ticketId)
    if (!run) return
    run.pending++
    run.text = ''
    this.busy.set(ticketId, assignmentId)
    const timeoutMs = this.hermes.turnTimeoutSeconds * 1000
    const turn = connection.prompt(sessionId, text, { timeoutMs, signal: this.host.lifetime })
    this.track(ticketId, assignmentId, run, turn)
  }

  private track(ticketId: string, assignmentId: string, run: Run, turn: Promise<{ stopReason: string; timedOut?: boolean }>): void {
    const finish = (result?: { stopReason: string; timedOut?: boolean }, error?: unknown) => {
      if (error !== undefined) run.error = error
      if (result?.timedOut) run.timedOut = true
      run.pending--
      if (run.pending > 0) return
      void this.settle(ticketId, assignmentId, run)
    }
    turn.then(result => finish(result), (error: unknown) => finish(undefined, error))
  }

  /** Turns the end of a Ticket's last queued ACP turn into the turn and report facts the Engine records. */
  private async settle(ticketId: string, assignmentId: string, run: Run): Promise<void> {
    if (this.runs.get(ticketId) === run) this.runs.delete(ticketId)
    this.busy.delete(ticketId)
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) return
    if (run.error !== undefined) {
      this.reportHealth('error', String(run.error).slice(0, 500))
      this.fail(ticketId, assignmentId, String(run.error))
      return
    }
    if (run.timedOut) {
      this.fail(ticketId, assignmentId, `The Hermes turn ran past its ${this.hermes.turnTimeoutSeconds}-second limit and was cancelled.`)
      return
    }
    const handedOff = !!ticket.attention || waitsForPerson(ticket) || !!latestReport(ticket) && latestReport(ticket)!.at !== run.before
      && !['progress', 'waiting'].includes(latestReport(ticket)!.state)
    this.host.engine.turnEnded(ticketId, assignmentId)
    const current = this.host.store.tickets.get(ticketId)
    if (handedOff || !current || !liveTicket(current) || runningAssignment(current)?.id !== assignmentId) return
    const summary = run.text.trim() || latestReport(current)?.summary || 'The Hermes worker ended its turn without a report.'
    this.host.engine.report(ticketId, { state: 'waiting', summary })
  }

  /** Records a failed launch or turn on the Ticket, as DshExecutor does. */
  private fail(ticketId: string, assignmentId: string, detail: string): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) return
    this.host.engine.report(ticketId, { state: 'failed', summary: `The Hermes ACP backend failed: ${detail.slice(0, 2000)}` })
  }

  /** Streams the agent's text into the summary a turn without a report leaves; tool activity is not mirrored. */
  private onUpdate({ sessionId, update }: AcpUpdate): void {
    if (update.sessionUpdate !== 'agent_message_chunk') return
    const ticketId = this.tickets.get(sessionId)
    const run = ticketId ? this.runs.get(ticketId) : undefined
    const content = update.content as { type?: string; text?: string } | undefined
    if (run && content?.type === 'text' && content.text) run.text += content.text
  }

  private async deliverQueued(ticketId: string): Promise<void> {
    const first = this.host.store.tickets.get(ticketId)
    const assignment = first && liveTicket(first) ? runningAssignment(first) : undefined
    if (!first || !assignment || first.execution?.runtime !== 'hermes' || !first.undelivered.length) return
    if (this.host.paused() || this.host.closing()) throw new Later('Processing is paused')
    const connection = await this.connect()
    const session = await this.sessionFor(first, connection)
    for (;;) {
      const ticket = this.host.store.tickets.get(ticketId)
      const running = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
      const inputId = ticket?.undelivered[0]
      if (!ticket || !running || inputId === undefined) return
      const input = ticket.inputs.find(item => item.id === inputId)
      if (!input) return
      const message = inputMessage(input)
      if (message === undefined) return
      const text = `${message}\n\nContinue this Ticket. Report with orchestrator_report when this turn's work is done.`
      const run = this.runs.get(ticketId) ?? { assignmentId: running.id, before: this.before(ticket), pending: 0, text: '' }
      if (!this.runs.has(ticketId)) this.runs.set(ticketId, run)
      try {
        this.prompt(ticketId, running.id, connection, session.sessionId, text)
        this.host.engine.inputsDelivered(ticketId, running.id, [inputId])
        this.host.engine.inputsRead(ticketId, [inputId])
      } catch (error) {
        this.host.engine.deliveryFailed(ticketId, running.id, String(error))
        throw error
      }
    }
  }

  /** One Ticket's first prompt: the worker prompt, the backend rules, its execution environment, and its assignment card. */
  private async assignmentPrompt(ticket: Ticket): Promise<string> {
    const assignment = ticket.execution?.assignment ?? ''
    const brief = assignment.length <= ASSIGNMENT_CHARS ? { assignment } : { assignment: `${assignment.slice(0, ASSIGNMENT_CHARS)}…`,
      assignment_chars: assignment.length, assignment_read: `ticket/${ticket.id}/assignment` }
    const source = sourceTrigger(this.host, ticket)
    const card = source ? triggerMessage(source, await this.host.sourceLink?.(source) ?? {}) : undefined
    const batch = batchOf(this.host, ticket).map(batchLine)
    const environment = this.host.environment(ticket).filter(variable => variable.value)
      .map(variable => `${variable.key}=${JSON.stringify(variable.value)}`).join('\n')
    const payload = { ticket_id: ticket.id, title: ticket.title, ...brief, ...(card ? { trigger: card } : {}),
      ...(batch.length ? { batch } : {}) }
    const intro = this.host.workerPrompt(ticket).trimEnd()
    return `${intro}\n\n${BACKEND_RULES}\n\n### Execution environment\n${environment || '(none)'}\n\n---\n${JSON.stringify(payload)}`
  }
}

/** Reads a Ticket Input for a prompt; exported for tests of the backend's delivery text. */
export const hermesInputMessage = (input: TicketInput): string | undefined => inputMessage(input)
