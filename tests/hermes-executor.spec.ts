/** The Hermes backend: launch, session resume, delivery, turn-to-report facts, permissions and stop. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Assignment, Ticket, TicketInput } from '../src/core/index.ts'
import type { AcpConnection, AcpFactory, AcpMcpServer, AcpOptions, AcpSession } from '../src/executor/acp.ts'
import { HermesAcpExecutor } from '../src/executor/hermes.ts'
import { SettingsSchema } from '../src/policy.ts'
import { KV } from '../src/kv.ts'

let stateDir: string | undefined
afterEach(() => { if (stateDir) rmSync(stateDir, { recursive: true, force: true }); stateDir = undefined })

class FakeConnection implements AcpConnection {
  alive = true
  options: AcpOptions
  readonly prompts: { sessionId: string; text: string }[] = []
  readonly modes: [string, string][] = []
  readonly cancelled: string[] = []
  readonly closed: string[] = []
  private finishes: (() => void)[] = []

  constructor(options: AcpOptions) { this.options = options }
  attach(options: AcpOptions): void { this.options = options }
  emit(text: string): void { this.options.onUpdate?.({ sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text } } }) }
  async initialize(): Promise<void> { /* Ready. */ }
  async newSession(input: { cwd: string; mcpServers: readonly AcpMcpServer[] }): Promise<AcpSession> {
    this.newSessions.push(input)
    return { sessionId: 's1', resumed: false }
  }
  async resumeSession(input: { sessionId: string; cwd: string; mcpServers: readonly AcpMcpServer[] }): Promise<AcpSession | undefined> {
    this.resumed.push(input)
    return this.resumeWorks ? { sessionId: input.sessionId, resumed: true } : undefined
  }
  async setMode(sessionId: string, modeId: string): Promise<void> { this.modes.push([sessionId, modeId]) }
  prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    this.prompts.push({ sessionId, text })
    return new Promise(resolve => { this.finishes.push(() => resolve({ stopReason: 'end_turn' })) })
  }
  cancel(sessionId: string): void { this.cancelled.push(sessionId) }
  async closeSession(sessionId: string): Promise<void> { this.closed.push(sessionId) }
  async close(): Promise<void> { this.alive = false }
  finish(): void { for (const finish of this.finishes.splice(0)) finish() }
  readonly newSessions: { cwd: string; mcpServers: readonly AcpMcpServer[] }[] = []
  readonly resumed: { sessionId: string; cwd: string; mcpServers: readonly AcpMcpServer[] }[] = []
  resumeWorks = false
}

interface Harness {
  executor: HermesAcpExecutor
  ticket: Ticket
  assignment: Assignment
  connection: FakeConnection
  handlers: Map<string, (payload: never, key: string) => Promise<void>>
  enqueued: { kind: string; key: string; payload: unknown }[]
  engine: Record<string, ReturnType<typeof vi.fn>>
  settings: ReturnType<typeof SettingsSchema.parse>
  kv: Map<string, unknown>
}

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

function harness(options: { runtimes?: 'hermes'; ended?: boolean; inputs?: TicketInput[]; state?: 'pending' | 'running' } = {}): Harness {
  stateDir ??= mkdtempSync(join(tmpdir(), 'hermes-executor-'))
  const settings = SettingsSchema.parse({ executor: { backend: 'hermes', hermes: { profile: 'jesse', command: '/bin/hermes' } } })
  const kv = new Map<string, unknown>()
  const ticket: Ticket = { id: 'ticket-1', title: 'Write the summary', decisionId: 'd1', channels: [], inputs: options.inputs ?? [],
    undelivered: [], mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed', sender: 'Jesse' },
      actor: { source: 'github', id: 'jesse' }, scope: 'Write the summary.' },
    assignments: [{ id: 'a1', state: options.state ?? 'pending', createdAt: '2026-11-15T00:00:00Z' }],
    createdAt: '2026-11-15T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z', origin: { triggerId: 't1', triggerIds: ['t1'] },
    execution: { name: 'ticket-1', directory: join(stateDir, 'ticket-1'), assignment: 'Write the summary.', workspaceOnly: true,
      runtime: options.runtimes ?? 'hermes' }, follows: [] }
  if (options.ended) ticket.ended = { outcome: 'completed', by: 'executor', at: '2026-11-15T01:00:00Z' }
  ticket.undelivered = ticket.inputs.filter(input => !(input as { readAt?: string }).readAt).map(input => input.id)
  const store = {
    tickets: { get: (id: string) => id === ticket.id ? ticket : undefined, open: () => ticket.ended ? [] : [ticket],
      list: () => [ticket], save: (_value: Ticket) => undefined },
    triggers: { get: () => undefined },
    settings: () => settings,
    get: (key: string) => kv.get(key) as never,
    set: (key: string, value: unknown) => { kv.set(key, value) },
    delete: (key: string) => { kv.delete(key) },
    afterCommit: (work: () => void) => work(),
  }
  const handlers = new Map<string, (payload: never, key: string) => Promise<void>>()
  const enqueued: { kind: string; key: string; payload: unknown }[] = []
  const effects = { enqueue: (kind: string, key: string, payload: unknown) => { enqueued.push({ kind, key, payload }) },
    handle: (kind: string, run: (payload: never, key: string) => Promise<void>) => { handlers.set(kind, run) } }
  const engineFns = {
    assignmentStarted: vi.fn((_ticketId: string, assignmentId: string) => {
      ticket.assignments = ticket.assignments.map(item => item.id === assignmentId ? { ...item, state: 'running' as const } : item)
    }),
    inputsDelivered: vi.fn((_ticketId: string, _assignmentId: string, ids: string[]) => {
      ticket.undelivered = ticket.undelivered.filter(id => !ids.includes(id))
      ticket.inputs = ticket.inputs.map(input => ids.includes(input.id)
        ? Object.assign({}, input, { readAt: '2026-11-15T00:00:00Z' }) as TicketInput : input)
    }),
    inputsRead: vi.fn(),
    turnEnded: vi.fn(),
    deliveryFailed: vi.fn(),
    report: vi.fn(),
    assignmentInterrupted: vi.fn(),
  }
  const connection = new FakeConnection({ command: '/bin/hermes', args: ['-p', 'jesse', 'acp'] })
  const factory: AcpFactory = opts => { connection.attach(opts); return connection }
  const executor = new HermesAcpExecutor({ engine: engineFns as never, store: store as never, effects: effects as never,
    health: { get: () => undefined, set: vi.fn(), release: vi.fn() }, lifetime: new AbortController().signal,
    machine: { stateDir: '/state' }, environment: () => [{ key: 'DSH_SUPERAGENT_DELIVERY_DIR', value: '/delivery', owner: 'dsh',
      description: { zh: '', en: '' } }], workerPrompt: () => 'WORKER PROMPT', bridgeUrl: 'http://127.0.0.1:3082', token: 'secret',
    closing: () => false, paused: () => false, acp: factory })
  return { executor, ticket, assignment: ticket.assignments[0]!, connection, handlers, enqueued, engine: engineFns as never, settings, kv }
}

describe('HermesAcpExecutor', () => {
  it('launches an ACP session in the ticket directory with the report bridge and sends the worker prompt', async () => {
    const h = harness()
    h.executor.start(h.ticket, h.assignment)
    expect(h.enqueued).toEqual([{ kind: 'hermes-launch', key: 'a1', payload: { ticketId: 'ticket-1', assignmentId: 'a1' } }])
    await h.handlers.get('hermes-launch')!({ ticketId: 'ticket-1', assignmentId: 'a1' } as never, 'a1')
    expect(h.connection.newSessions).toHaveLength(1)
    expect(h.connection.newSessions[0]!.cwd).toBe(join(stateDir!, 'ticket-1'))
    expect(h.connection.newSessions[0]!.mcpServers[0]).toMatchObject({ type: 'http', name: 'superagent',
      url: 'http://127.0.0.1:3082/hermes-bridge/v1/mcp?ticket=ticket-1', headers: [{ name: 'Authorization', value: 'Bearer secret' }] })
    expect(h.connection.modes).toEqual([['s1', 'dont_ask']])
    expect(h.kv.get(KV.hermes.session('ticket-1'))).toBe('s1')
    expect(h.engine.assignmentStarted).toHaveBeenCalledWith('ticket-1', 'a1')
    expect(h.executor.activeCount()).toBe(1)
    const text = h.connection.prompts[0]!.text
    expect(text).toContain('WORKER PROMPT')
    expect(text).toContain('## Execution backend: Hermes ACP')
    expect(text).toContain('DSH_SUPERAGENT_DELIVERY_DIR="/delivery"')
    expect(text).toContain('"ticket_id":"ticket-1"')
  })

  it('turns the end of a turn without a report into a waiting report with the streamed text', async () => {
    const h = harness()
    await h.handlers.get('hermes-launch')!({ ticketId: 'ticket-1', assignmentId: 'a1' } as never, 'a1')
    h.connection.emit('half done')
    h.connection.finish()
    await flush()
    expect(h.engine.turnEnded).toHaveBeenCalledWith('ticket-1', 'a1')
    expect(h.engine.report).toHaveBeenCalledWith('ticket-1', { state: 'waiting', summary: 'half done' })
    expect(h.executor.activeCount()).toBe(0)
  })

  it('resumes the stored ACP session and sends a follow-up input as a prompt', async () => {
    const input: TicketInput = { id: 'i1', kind: 'text', text: 'Add a conclusion.', at: '2026-11-15T00:30:00Z' }
    const h = harness({ inputs: [input], state: 'running' })
    h.kv.set(KV.hermes.session('ticket-1'), 'known-session')
    h.connection.resumeWorks = true
    h.executor.deliver(h.ticket, h.assignment)
    await h.handlers.get('hermes-delivery')!({ ticketId: 'ticket-1' } as never, 'ticket-1')
    expect(h.connection.resumed[0]).toMatchObject({ sessionId: 'known-session', cwd: join(stateDir!, 'ticket-1') })
    expect(h.connection.prompts[0]!.text).toContain('Add a conclusion.')
    expect(h.engine.inputsDelivered).toHaveBeenCalledWith('ticket-1', 'a1', ['i1'])
    expect(h.engine.inputsRead).toHaveBeenCalledWith('ticket-1', ['i1'])
  })

  it('cancels a turn and closes the session when the ticket ended', async () => {
    const h = harness()
    await h.handlers.get('hermes-launch')!({ ticketId: 'ticket-1', assignmentId: 'a1' } as never, 'a1')
    expect(h.connection.newSessions).toHaveLength(1)
    h.ticket.ended = { outcome: 'completed', by: 'executor', at: '2026-11-15T01:00:00Z' }
    h.executor.stop(h.ticket, h.assignment, 'completed')
    await flush()
    expect(h.connection.cancelled).toEqual(['s1'])
    expect(h.connection.closed).toEqual(['s1'])
    expect(h.kv.has(KV.hermes.session('ticket-1'))).toBe(false)
  })

  it('marks interrupted Hermes assignments and re-queues pending ones on resume', () => {
    const running = harness({ state: 'running' })
    running.executor.resume()
    expect(running.engine.assignmentInterrupted).toHaveBeenCalledWith('ticket-1', 'a1')
    const pending = harness({ state: 'pending' })
    pending.executor.resume()
    expect(pending.enqueued).toEqual([{ kind: 'hermes-launch', key: 'a1', payload: { ticketId: 'ticket-1', assignmentId: 'a1' } }])
  })
})
