/**
 * The private loopback MCP bridge of the Hermes ACP backend. Hermes discovers it as an HTTP MCP server of its ACP session and
 * calls the same `orchestrator_*` tools a DSH Executor Session has, so a Hermes Ticket reports through one contract. The token
 * lives in an owner-private file in the state directory, never in settings or a workspace.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { liveTicket, type Ticket } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import type { Tool } from '../app/tools/tool.ts'
import { dshToken } from '../sources/dsh-transport.ts'

/** The loopback prefix of the bridge, under which the MCP endpoint and its ticket live. */
export const HERMES_BRIDGE_PREFIX = '/hermes-bridge/v1'
/** The one MCP endpoint Hermes connects to as a Streamable HTTP MCP server. */
export const HERMES_MCP_PATH = `${HERMES_BRIDGE_PREFIX}/mcp`
/** Body limit of one MCP message; tool arguments and results stay well under it. */
const MAX_MCP_BYTES = 256 * 1024
/** The MCP protocol version this bridge answers in, which Hermes negotiates down to on initialize. */
const MCP_VERSION = '2025-06-18'
/** A JSON-RPC message as the MCP bridge reads and writes it. */
interface McpMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

/** What the bridge reads of the Store: the Ticket a Hermes session belongs to. */
export interface HermesBridgeHost {
  readonly store: Pick<Store, 'tickets'>
  /** The Executor Session tools of `ticket`, the same set a DSH worker Session has. */
  tools(ticket: Ticket): Tool[]
}

/**
 * Returns the bridge's bearer token, creating it in `stateDir` on first use. The file stays owner-private and unchanged across
 * restarts, so a resumed Hermes ACP session may reattach with the same MCP server specification.
 */
export function hermesBridgeToken(stateDir: string): string {
  const path = join(stateDir, 'hermes-bridge.token')
  try { return dshToken(path) } catch { /* Absent or not private yet: write a fresh one below. */ }
  const token = randomBytes(32).toString('base64url')
  writeFileSync(path, `${token}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return dshToken(path)
}

/** The URL of one Ticket's MCP endpoint on `base`, an `http://127.0.0.1:<port>` origin. */
export const hermesMcpUrl = (base: string, ticketId: string): string => `${base}${HERMES_MCP_PATH}?ticket=${encodeURIComponent(ticketId)}`

/** Whether `header` carries `token`; both are compared by digest, not byte by byte. */
export function hermesAuthorized(header: string | undefined, token: string): boolean {
  const digest = (text: string) => createHash('sha256').update(text).digest()
  return timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`))
}

const json = (res: ServerResponse, status: number, value?: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(value === undefined ? '' : JSON.stringify(value))
}
const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code })
/** Reads one JSON body, rejecting an oversized one as it streams. */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_MCP_BYTES) throw rpcError(-32600, 'The MCP message exceeds the size limit')
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw rpcError(-32700, 'The MCP message is not JSON') }
}

/** The JSON schema of one tool, as MCP advertises it to the model. */
const toolDescriptor = (tool: Tool) => ({ name: tool.name, description: tool.description,
  inputSchema: z.toJSONSchema(tool.schema, { io: 'input' }) as Record<string, unknown> })

/** Runs one `tools/call` and returns its MCP result, or an error result the model reads as a failed tool call. */
async function callTool(tools: Tool[], name: unknown, raw: unknown, signal: AbortSignal): Promise<unknown> {
  if (typeof name !== 'string') throw rpcError(-32602, 'tools/call needs a tool name')
  const found = tools.find(tool => tool.name === name)
  if (!found) throw rpcError(-32602, `Unknown tool ${name}`)
  try {
    const args = found.schema.parse(raw ?? {})
    const value = await found.execute(args, signal)
    return { content: [{ type: 'text', text: JSON.stringify(value ?? null) }] }
  } catch (error) {
    const detail = error instanceof z.ZodError ? `Invalid arguments: ${error.message}` : String(error)
    return { content: [{ type: 'text', text: detail }], isError: true }
  }
}

/**
 * Answers one MCP request for `tools`. `initialize`, `ping`, `tools/list` and `tools/call` are the whole surface a reporting
 * worker needs; an unknown method is a JSON-RPC error, and `tools/call` failures come back as `isError` results.
 */
export async function mcpResult(message: McpMessage, tools: Tool[], signal: AbortSignal): Promise<unknown> {
  if (message.method === 'initialize') {
    return { protocolVersion: MCP_VERSION, capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'dsh-superagent', version: '1' } }
  }
  if (message.method === 'ping') return {}
  if (message.method === 'tools/list') return { tools: tools.map(toolDescriptor) }
  if (message.method === 'tools/call') {
    const params = message.params ?? {}
    return callTool(tools, params.name, params.arguments, signal)
  }
  throw rpcError(-32601, `Unknown MCP method ${String(message.method)}`)
}

/**
 * Registers the MCP endpoint under the loopback management server. A Ticket's endpoint exists only while the Ticket is open and
 * the Hermes backend runs it; every call is authenticated with the bridge token and acted on as that Ticket's worker.
 */
export function registerHermesBridge(ctx: Pick<Context, 'webServer'>, host: HermesBridgeHost, token: string): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('The Hermes bridge requires a loopback Web server')
  return ctx.webServer.register({ kind: 'prefix', path: HERMES_BRIDGE_PREFIX, handler: async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== HERMES_MCP_PATH) { json(res, 404, { error: 'Unknown Hermes bridge resource' }); return }
    if (!hermesAuthorized(req.headers.authorization, token)) { json(res, 401, { error: 'Unauthorized' }); return }
    if (req.method === 'HEAD') { res.writeHead(200); res.end(); return }
    if (req.method === 'GET') { res.writeHead(405, { allow: 'POST, DELETE' }); res.end(); return }
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST, DELETE' }); res.end(); return }
    const ticket = host.store.tickets.get(url.searchParams.get('ticket') ?? '')
    if (!ticket || !liveTicket(ticket) || ticket.execution?.runtime !== 'hermes') { json(res, 404, { error: 'No Hermes ticket for this endpoint' }); return }
    try {
      const body = await readBody(req)
      const messages = (Array.isArray(body) ? body : [body]) as McpMessage[]
      const replies: unknown[] = []
      for (const message of messages) {
        if (!message || typeof message !== 'object' || message.id === undefined || message.id === null) continue
        try { replies.push({ jsonrpc: '2.0', id: message.id, result: await mcpResult(message, host.tools(ticket), ctxSignal(res)) }) }
        catch (error) {
          replies.push({ jsonrpc: '2.0', id: message.id, error: { code: (error as { code?: number }).code ?? -32603,
            message: String(error instanceof Error ? error.message : error) } })
        }
      }
      // Only notifications carry no id: MCP acknowledges them with an empty 202, as it does a batch of them.
      if (!replies.length) { res.writeHead(202); res.end(); return }
      json(res, 200, Array.isArray(body) ? replies : replies[0])
    } catch (error) {
      json(res, 400, { jsonrpc: '2.0', id: null, error: { code: (error as { code?: number }).code ?? -32700,
        message: String(error instanceof Error ? error.message : error) } })
    }
  } })
}

/** The abort signal of one HTTP call, aborted when the MCP client disconnects. */
function ctxSignal(res: ServerResponse): AbortSignal {
  const controller = new AbortController()
  res.on('close', () => { if (!res.writableEnded) controller.abort() })
  return controller.signal
}

/** Reads the bridge token file for a deployment; exported for startup checks and tests. */
export const readBridgeToken = (path: string): string => readFileSync(path, 'utf8').trim()
