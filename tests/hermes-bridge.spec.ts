/** The Hermes MCP bridge: private token, tool discovery, tool calls, auth, and ticket scoping. */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Ticket } from '../src/core/index.ts'
import type { Tool } from '../src/app/tools/tool.ts'
import { HERMES_MCP_PATH, hermesBridgeToken, mcpResult, registerHermesBridge } from '../src/executor/hermes-bridge.ts'

let directory: string | undefined
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined })

const ticket: Ticket = { id: 'ticket-1', title: 'Write the summary', decisionId: 'd1', channels: [], inputs: [], undelivered: [],
  mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed', sender: 'Jesse' }, actor: { source: 'github', id: 'jesse' }, scope: 'x' },
  assignments: [], createdAt: '2026-11-15T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z', origin: { triggerId: 't1', triggerIds: ['t1'] },
  execution: { name: 'ticket-1', directory: '/tickets/ticket-1', assignment: 'x', workspaceOnly: true, runtime: 'hermes' }, follows: [] }
const reportSchema = z.object({ state: z.enum(['progress', 'ready']), summary: z.string().min(1) }).strict()
const tools: Tool[] = [{ name: 'orchestrator_report', description: 'Report status.', schema: reportSchema,
  execute: async (args: unknown) => ({ reported: reportSchema.parse(args).state }) }]

interface Captured { status: number; body: unknown; headers: Record<string, string> }
function mount(value: Ticket | null = ticket): { request(method: string, url: string, body?: unknown, authorization?: string): Promise<Captured>;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> } {
  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
  const ctx = { webServer: { host: '127.0.0.1', register: (route: { handler: typeof handler }) => { handler = route.handler; return () => {} } } }
  registerHermesBridge(ctx as never, { store: { tickets: {
    get: (id: string): Ticket | undefined => value && id === value.id ? value : undefined,
    save: () => undefined, list: () => [], open: () => [], active: () => [] } }, tools: () => tools }, 'a'.repeat(43))
  return { handler: handler!, async request(method, url, body, authorization) {
    const captured: Captured = { status: 0, body: undefined, headers: {} }
    const req = { method, url, headers: authorization ? { authorization } : {},
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } } as unknown as IncomingMessage
    const res = { writeHead: (status: number, headers: Record<string, string> = {}) => { captured.status = status; captured.headers = headers },
      end: (value?: string) => { captured.body = value ? JSON.parse(value) : undefined }, on: () => undefined,
      get writableEnded() { return true } } as unknown as ServerResponse
    await handler!(req, res)
    return captured
  } }
}
const authorization = `Bearer ${'a'.repeat(43)}`

describe('Hermes MCP bridge', () => {
  it('creates an owner-private token and keeps it across reads', () => {
    directory = mkdtempSync(join(tmpdir(), 'hermes-bridge-'))
    const first = hermesBridgeToken(directory!)
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(hermesBridgeToken(directory!)).toBe(first)
    expect(statSync(join(directory!, 'hermes-bridge.token')).mode & 0o777).toBe(0o600)
  })

  it('authenticates, scopes the endpoint to an open Hermes ticket, and serves MCP discovery and calls', async () => {
    const bridge = mount()
    expect((await bridge.request('POST', HERMES_MCP_PATH, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401)
    const unauthorized = await bridge.request('POST', `${HERMES_MCP_PATH}?ticket=ticket-1`, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(unauthorized.status).toBe(401)
    const initialized = await bridge.request('POST', `${HERMES_MCP_PATH}?ticket=ticket-1`,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, authorization)
    expect(initialized.status).toBe(200)
    expect(initialized.body).toMatchObject({ jsonrpc: '2.0', id: 1, result: { capabilities: { tools: {} } } })
    const listed = await bridge.request('POST', `${HERMES_MCP_PATH}?ticket=ticket-1`,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' }, authorization)
    expect(listed.body).toMatchObject({ result: { tools: [{ name: 'orchestrator_report', inputSchema: { type: 'object' } }] } })
    const called = await bridge.request('POST', `${HERMES_MCP_PATH}?ticket=ticket-1`,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'orchestrator_report', arguments: { state: 'progress', summary: 'x' } } }, authorization)
    expect(called.body).toMatchObject({ result: { content: [{ type: 'text', text: '{"reported":"progress"}' }] } })
    const notified = await bridge.request('POST', `${HERMES_MCP_PATH}?ticket=ticket-1`,
      { jsonrpc: '2.0', method: 'notifications/initialized' }, authorization)
    expect(notified.status).toBe(202)
    expect((await bridge.request('GET', `${HERMES_MCP_PATH}?ticket=ticket-1`, undefined, authorization)).status).toBe(405)
    expect((await bridge.request('DELETE', `${HERMES_MCP_PATH}?ticket=ticket-1`, undefined, authorization)).status).toBe(204)
  })

  it('refuses another ticket, an ended ticket, and a ticket the Hermes backend does not run', async () => {
    const bridge = mount(null)
    expect((await bridge.request('POST', `${HERMES_MCP_PATH}?ticket=ticket-1`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, authorization)).status).toBe(404)
    const dsh = mount({ ...ticket, execution: { ...ticket.execution!, runtime: undefined } })
    expect((await dsh.request('POST', `${HERMES_MCP_PATH}?ticket=ticket-1`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, authorization)).status).toBe(404)
  })

  it('returns a failed tool call as an MCP error result, not a transport error', async () => {
    const result = await mcpResult({ id: 1, method: 'tools/call', params: { name: 'orchestrator_report', arguments: { state: 'nope' } } },
      tools, new AbortController().signal)
    expect(result).toMatchObject({ isError: true })
    const missing = await mcpResult({ id: 2, method: 'tools/call', params: { name: 'nobody' } }, tools, new AbortController().signal)
      .catch(error => error as Error & { code?: number })
    expect(missing).toMatchObject({ code: -32602 })
  })
})
