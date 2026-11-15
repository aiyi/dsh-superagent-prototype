/** ACP v1 client over the newline-delimited JSON-RPC stdio of a Hermes profile's `acp` command. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/** One `session/update` notification of a session. */
export interface AcpUpdate { sessionId: string; update: Record<string, unknown> }
/** One `session/request_permission` request: the agent asks before an edit or a command. */
export interface AcpPermissionRequest { sessionId: string; toolCall?: Record<string, unknown>
  options?: readonly { optionId?: string; kind?: string; name?: string }[] }
/** An MCP server an ACP session attaches; the Superagent bridge is an HTTP MCP server on loopback. */
export interface AcpMcpServer { type: 'http'; name: string; url: string; headers: { name: string; value: string }[] }
/** What starts one ACP connection. */
export interface AcpOptions {
  command: string
  args: readonly string[]
  /** Working directory of the ACP process itself; the profile's own directory is fine. */
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Receives every `session/update` notification, in arrival order. */
  onUpdate?(update: AcpUpdate): void
  /** Receives each permission request and the option this client chose for it, for the log. */
  onPermission?(request: AcpPermissionRequest, optionId: string | undefined): void
}
/** A new or resumed ACP session, with whether it continued an earlier one. */
export interface AcpSession { sessionId: string; resumed: boolean }
/** What a prompt turn ended with, from ACP's stop reasons; `timedOut` when this client cancelled it. */
export interface AcpPromptResult { stopReason: string; timedOut?: boolean }
/** The slice of an ACP connection the Executor uses. */
export interface AcpConnection {
  readonly alive: boolean
  initialize(): Promise<void>
  newSession(input: { cwd: string; mcpServers: readonly AcpMcpServer[] }): Promise<AcpSession>
  /** Resumes `sessionId`; returns undefined when the agent no longer knows it, so the caller opens a new session. */
  resumeSession(input: { sessionId: string; cwd: string; mcpServers: readonly AcpMcpServer[] }): Promise<AcpSession | undefined>
  setMode(sessionId: string, modeId: string): Promise<void>
  /** Runs one prompt turn. With `timeoutMs`, a turn running past it is cancelled. */
  prompt(sessionId: string, text: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<AcpPromptResult>
  cancel(sessionId: string): void
  closeSession(sessionId: string): Promise<void>
  close(): Promise<void>
}
/** Opens one ACP connection; the Executor's tests replace it with a scripted connection. */
export type AcpFactory = (options: AcpOptions) => AcpConnection

/** An ACP request failed, or the ACP process went away; the message carries the ACP error. */
export class AcpError extends Error {
  constructor(message: string, readonly code?: number) { super(message) }
}

/** How long one control request, such as `initialize` or `session/new`, may take. */
const CONTROL_TIMEOUT_MS = 120_000
/** How long the process may take to exit after its stdin closes. */
const EXIT_GRACE_MS = 3000
/** How much of the ACP server's stderr an error message may carry. */
const STDERR_CHARS = 4000

/**
 * One ACP v1 connection to a Hermes profile, over the process's stdin and stdout. It answers the agent's permission
 * requests in favour of allowing the action, because a Ticket runs unattended and has the same full access as a DSH worker;
 * it never advertises client-side file or terminal capabilities, so files and commands run inside Hermes.
 */
export class AcpProcess implements AcpConnection {
  private child?: ChildProcessWithoutNullStreams
  private starting?: Promise<void>
  private initialized = false
  private nextId = 1
  private buffer = ''
  private stderr = ''
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout> }>()
  private readonly sessions = new Set<string>()
  private closing = false

  constructor(private readonly options: AcpOptions) {}

  get alive(): boolean { return !!this.child && this.child.exitCode === null && !this.closing }

  /** Starts the ACP process and completes the protocol handshake once; later calls reuse it. */
  async initialize(): Promise<void> {
    this.starting ??= this.start().then(async () => {
      await this.request('initialize', { protocolVersion: 1, clientCapabilities: { terminal: false },
        clientInfo: { name: 'dsh-superagent', version: '1' } }, CONTROL_TIMEOUT_MS)
      this.initialized = true
    }).catch(error => { this.starting = undefined; throw error })
    await this.starting
  }

  private start(): Promise<void> {
    if (this.child && this.child.exitCode === null) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.command, [...this.options.args], { cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env }, stdio: ['pipe', 'pipe', 'pipe'] })
      this.child = child
      this.buffer = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => { this.receive(String(chunk)) })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => { this.stderr = (this.stderr + String(chunk)).slice(-STDERR_CHARS) })
      child.on('error', error => {
        this.child = undefined
        this.fail(new AcpError(`Could not start the Hermes ACP server (${this.options.command}): ${error.message}`))
        reject(new AcpError(`Could not start the Hermes ACP server (${this.options.command}): ${error.message}`))
      })
      child.on('spawn', () => { resolve() })
      child.on('exit', (code, signal) => {
        this.child = undefined
        if (!this.closing) this.fail(new AcpError(`The Hermes ACP server exited (${signal ?? code}): ${this.stderr.trim().slice(-1000)}`))
      })
    })
  }

  private fail(error: AcpError): void {
    for (const [id, waiter] of this.pending) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.reject(error)
      this.pending.delete(id)
    }
  }

  /** Answers one line of the ACP server's stdout: a response, a notification or a client request. */
  private receive(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const at = this.buffer.indexOf('\n')
      if (at < 0) return
      const line = this.buffer.slice(0, at).trim()
      this.buffer = this.buffer.slice(at + 1)
      if (!line) continue
      let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string } }
      try { message = JSON.parse(line) } catch { continue }
      if (message.id !== undefined && message.method === undefined) {
        const waiter = this.pending.get(message.id)
        if (!waiter) continue
        if (waiter.timer) clearTimeout(waiter.timer)
        this.pending.delete(message.id)
        if (message.error) waiter.reject(new AcpError(message.error.message ?? 'ACP request failed', message.error.code))
        else waiter.resolve(message.result)
        continue
      }
      if (message.method === 'session/update') {
        const params = message.params ?? {}
        const sessionId = String(params.sessionId ?? '')
        const update = (params.update ?? {}) as Record<string, unknown>
        if (sessionId) this.options.onUpdate?.({ sessionId, update })
        continue
      }
      if (message.method === 'session/request_permission') {
        this.answerPermission(message.id, message.params ?? {})
        continue
      }
      if (message.id !== undefined) {
        // No client-side fs, terminal or elicitation capability was advertised, so these are refused, not answered by hand.
        this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unsupported client method ${String(message.method)}` } })
      }
    }
  }

  /** Chooses an explicit allow option for one permission request, preferring the widest scope the agent offers. */
  private answerPermission(id: number | undefined, params: Record<string, unknown>): void {
    const options = (Array.isArray(params.options) ? params.options : []) as { optionId?: string; kind?: string; name?: string }[]
    const allow = (optionId: string) => options.find(option => option.optionId === optionId)
      ?? options.find(option => option.kind === optionId)
    const chosen = allow('allow_always') ?? allow('allow_session') ?? allow('allow_once')
      ?? options.find(option => (option.kind ?? '').startsWith('allow'))
    this.options.onPermission?.({ sessionId: String(params.sessionId ?? ''), toolCall: params.toolCall as Record<string, unknown> | undefined,
      options }, chosen?.optionId)
    if (id === undefined) return
    this.send({ jsonrpc: '2.0', id, result: chosen?.optionId === undefined ? { outcome: { outcome: 'cancelled' } }
      : { outcome: { outcome: 'selected', optionId: chosen.optionId } } })
  }

  private send(message: unknown): void {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = CONTROL_TIMEOUT_MS): Promise<unknown> {
    if (!this.child) throw new AcpError('The Hermes ACP server is not running')
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id)
        reject(new AcpError(`ACP request ${method} timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs) : undefined
      timer?.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params: Record<string, unknown>): void { this.send({ jsonrpc: '2.0', method, params }) }

  async newSession(input: { cwd: string; mcpServers: readonly AcpMcpServer[] }): Promise<AcpSession> {
    if (!this.initialized) await this.initialize()
    const result = await this.request('session/new', { cwd: input.cwd, mcpServers: input.mcpServers }, CONTROL_TIMEOUT_MS) as { sessionId?: unknown }
    if (typeof result?.sessionId !== 'string' || !result.sessionId) throw new AcpError('The Hermes ACP server returned no session ID')
    this.sessions.add(result.sessionId)
    return { sessionId: result.sessionId, resumed: false }
  }

  async resumeSession(input: { sessionId: string; cwd: string; mcpServers: readonly AcpMcpServer[] }): Promise<AcpSession | undefined> {
    if (!this.initialized) await this.initialize()
    try {
      const result = await this.request('session/resume', { sessionId: input.sessionId, cwd: input.cwd, mcpServers: input.mcpServers },
        CONTROL_TIMEOUT_MS) as { sessionId?: unknown }
      if (typeof result?.sessionId !== 'string' || !result.sessionId) return undefined
      this.sessions.add(result.sessionId)
      return { sessionId: result.sessionId, resumed: true }
    } catch { return undefined }
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.request('session/set_mode', { sessionId, modeId }, CONTROL_TIMEOUT_MS)
  }

  async prompt(sessionId: string, text: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<AcpPromptResult> {
    let timedOut = false
    const timer = options.timeoutMs && options.timeoutMs > 0 ? setTimeout(() => {
      timedOut = true
      this.cancel(sessionId)
    }, options.timeoutMs) : undefined
    timer?.unref?.()
    const cancelled = () => { this.cancel(sessionId) }
    options.signal?.addEventListener('abort', cancelled, { once: true })
    if (options.signal?.aborted) cancelled()
    try {
      const result = await this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 0) as { stopReason?: unknown }
      return { stopReason: timedOut ? 'cancelled' : String(result?.stopReason ?? 'end_turn'), ...(timedOut ? { timedOut: true } : {}) }
    } finally {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancelled)
    }
  }

  cancel(sessionId: string): void { this.notify('session/cancel', { sessionId }) }

  async closeSession(sessionId: string): Promise<void> {
    if (!this.sessions.delete(sessionId) || !this.child) return
    await this.request('session/close', { sessionId }, CONTROL_TIMEOUT_MS).catch(() => undefined)
  }

  async close(): Promise<void> {
    this.closing = true
    this.fail(new AcpError('The Hermes ACP connection closed'))
    const child = this.child
    if (!child) return
    child.stdin.end()
    await new Promise<void>(resolve => {
      if (child.exitCode !== null) { resolve(); return }
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, EXIT_GRACE_MS)
      timer.unref?.()
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.kill('SIGTERM')
    })
    this.child = undefined
  }
}

/** Opens a real ACP connection to a Hermes profile's `acp` command. */
export const acpFactory: AcpFactory = options => new AcpProcess(options)
