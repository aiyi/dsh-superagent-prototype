/** Cross-process Voice Source contract, permissions, idempotent routing and bounded dialogue transport. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { chmodSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer, { type WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { apply, acceptDsh, DshConfigSchema, dshKind, type DshConfig } from '../src/sources/dsh.ts'
import { DshHandoffSchema, dshHandoff, dshTrigger, type DshHandoff, type DshPage } from '../src/sources/dsh-protocol.ts'
import { dshPost, dshToken, DSH_MAX_BYTES } from '../src/sources/dsh-transport.ts'
import { sourceContext } from '../src/sources/host.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { Store } from '../src/app/store.ts'
import { dshRoute } from '../src/app/dsh-routing.ts'
import { Setup } from '../src/app/setup.ts'

const INCOMING = 'a'.repeat(48), OUTGOING = 'b'.repeat(48)
const send = (res: ServerResponse, code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
async function body(req: IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> }
function handoff(id: string, text = '请研究这个，只调研不改代码', action: DshHandoff['action'] = 'new'): DshHandoff {
  const anchor = { ref: { sessionId: 'voice-user-2026-11-13', messageId: `message-${id}`, eventSeq: 5 },
    kind: 'human' as const, producer: 'user' as const, at: '2026-11-13T01:00:00.000Z', text }
  return DshHandoffSchema.parse({ version: 1, requestId: `request-${id}`, bindingId: 'user', action, anchor,
    snapshot: { id: `snapshot-${id}`, page: { messages: [anchor], complete: true } } })
}
let h: Host, config: DshConfig, voice: Server, bridge: Server, bridgeUrl: string
let histories: Record<string, unknown>[], replies: Record<string, unknown>[], page: DshPage, historyGate: Promise<void> | undefined
let replyFailure = false, replyGone = false, badHistory = false, hugeHistory = false, loseReplyAck = false
let cleanup: (() => void)[]
let bridgeRoute: WebRoute
beforeEach(async () => {
  h = await startRuntime()
  histories = []; replies = []; cleanup = []; historyGate = undefined
  replyFailure = false; replyGone = false; badHistory = false; hugeHistory = false; loseReplyAck = false
  page = handoff('older').snapshot.page
  voice = createServer((req, res) => { void (async () => {
    if (req.headers.authorization !== `Bearer ${OUTGOING}`) { send(res, 401, {}); return }
    const data = await body(req)
    if (req.url === '/voice-bridge/v1/history') {
      histories.push(data); await historyGate
      if (hugeHistory) { res.end('x'.repeat(DSH_MAX_BYTES + 1)); return }
      send(res, 200, { version: 1, requestId: badHistory ? 'wrong' : data.requestId, snapshotId: data.snapshotId, page }); return
    }
    if (req.url === '/voice-bridge/v1/replies') {
      if (replyFailure) { send(res, 503, {}); return }
      if (!replies.some(reply => reply.replyId === data.replyId)) replies.push(data)
      if (loseReplyAck) { res.destroy(); return }
      send(res, 200, { version: 1, replyId: data.replyId, status: replyGone ? 'gone' : 'received' }); return
    }
    send(res, 404, {})
  })().catch(() => { send(res, 500, {}) }) })
  const voiceUrl = await listen(voice)
  const incomingTokenFile = join(h.directory, 'incoming.token'), voiceTokenFile = join(h.directory, 'voice.token')
  writeFileSync(incomingTokenFile, INCOMING, { mode: 0o600 }); writeFileSync(voiceTokenFile, OUTGOING, { mode: 0o600 })
  config = DshConfigSchema.parse({ bindingId: 'user', principalId: 'voice-user', voiceUrl, incomingTokenFile, voiceTokenFile })
  let handler!: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  const context = { orchestrator: h.runtime, webServer: { host: '127.0.0.1',
    register: (route: WebRoute) => { bridgeRoute = route; handler = route.handler as typeof handler; return () => {} } },
  effect: (effect: () => () => void) => { cleanup.push(effect()) } }
  apply(context as unknown as Context)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, dsh: { enabled: true, config } },
    policy: { ...settings.policy, sources: { ...settings.policy.sources, dsh: { allowed: [{ id: config.principalId }] } } } })
  bridge = createServer((req, res) => { void handler(req, res) })
  bridgeUrl = await listen(bridge)
})
afterEach(async () => {
  for (const server of [bridge, voice]) if (server) { server.closeAllConnections(); await new Promise<void>(resolve => { server.close(() => resolve()) }) }
  for (const dispose of cleanup.reverse()) dispose()
  await h.stop()
})
async function submit(request: unknown, token = INCOMING) {
  const response = await fetch(`${bridgeUrl}/voice-bridge/v1/sources/dsh/handoffs`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(request) })
  return { code: response.status, value: await response.json() as { triggerId: string; status: string } }
}
async function admitted(id: string, title = id) {
  const request = handoff(id), receipt = await submit(request)
  expect(receipt.code).toBe(200); await h.runtime.idle()
  const result = await h.route({ kind: 'accept', trigger_id: receipt.value.triggerId, title, worktree_name: `fix-${id}`, acknowledgement: '这次只做调研。' })
  await h.runtime.idle()
  return { request, triggerId: receipt.value.triggerId, ticketId: (result.ticket as { ticket_id: string }).ticket_id }
}
const read = (resource: string, session = h.runtime.masterId, offset = 0, limit?: number) =>
  h.runTool(session, 'orchestrator_read', { resource, offset, ...(limit ? { limit } : {}) })
async function original(resource: string, session?: string) {
  const result = await read(resource, session)
  return JSON.parse(String(result.text)) as Record<string, unknown>
}

it('serves authenticated handoffs through the real native Web Server prefix matcher', async () => {
  const native = new Context()
  try {
    await native.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    native.webServer.register(bridgeRoute)
    await vi.waitFor(() => expect(native.webServer.port).toBeGreaterThan(0))
    const base = `http://127.0.0.1:${native.webServer.port}/voice-bridge/v1/sources/dsh/handoffs`
    const request = handoff('real-webserver')
    const response = await fetch(base, { method: 'POST', headers: { authorization: `Bearer ${INCOMING}`,
      'content-type': 'application/json' }, body: JSON.stringify(request) })
    expect(response.status).toBe(200)
    const receipt = await response.json()
    expect(receipt).toMatchObject({ status: 'received', requestId: request.requestId })
    const query = await fetch(`${base}/${request.requestId}`, { headers: { authorization: `Bearer ${INCOMING}` } })
    expect(query.status).toBe(200)
    expect(await query.json()).toEqual(receipt)
  } finally { await native.fiber.dispose() }
})

it('saves a new Voice Source through settings without GitHub account probing or a setup restart', async () => {
  const accounts = vi.spyOn(Setup.prototype, 'checkAccounts')
  try {
    const result = await h.runtime.settings.save('source:dsh-new', { enabled: true, config }, 0, 'panel')
    expect(result).toMatchObject({ saved: true, restarting: false })
    expect(accounts).not.toHaveBeenCalled()
    expect(h.runtime.store.settings().sources['dsh-new']?.config).toMatchObject({ bindingId: 'user', principalId: 'voice-user' })
  } finally { accounts.mockRestore() }
})

it('accepts only authenticated bound human origins, freezes IDs and persists queryable receipts without starting work', async () => {
  const request = handoff('first')
  expect((await submit(request, 'wrong')).code).toBe(401)
  expect((await submit({ ...request, bindingId: 'other' })).code).toBe(403)
  const first = await submit(request)
  expect(first).toMatchObject({ code: 200, value: { status: 'received' } })
  expect(await submit(request)).toEqual(first)
  expect((await submit({ ...request, hint: 'changed' })).code).toBe(409)
  expect((await submit({ ...request, requestId: 'another' })).code).toBe(409)
  await h.runtime.idle()
  expect(h.runtime.store.tickets.list()).toHaveLength(0)
  expect(h.candidates()).toEqual([first.value.triggerId])
  expect(h.runtime.health.dsh?.state).toBe('ready')
  const response = await fetch(`${bridgeUrl}/voice-bridge/v1/sources/dsh/handoffs/${request.requestId}`, { headers: { authorization: `Bearer ${INCOMING}` } })
  expect(await response.json()).toMatchObject({ status: 'received', triggerId: first.value.triggerId })
  const reopened = new Store(join(h.directory, 'orchestrator.sqlite'))
  try { expect(reopened.get('dsh-request:request-first')).toMatchObject({ triggerId: first.value.triggerId }) } finally { reopened.close() }
})

it.each(['tool_call', 'tool_result', 'reasoning', 'system', 'runtime'])('rejects %s records rather than exporting execution history', async kind => {
  const request = handoff('invalid') as unknown as Record<string, unknown>
  const snapshot = request.snapshot as { page: { messages: unknown[] } }
  snapshot.page.messages.push({ ...handoff('bad').anchor, kind })
  expect((await submit(request)).code).toBe(400)
  expect(h.runtime.store.read.recentTriggers()).toHaveLength(0)
})

it('rejects mixed private content blocks and false producer attribution, but preserves human-quoted tool text', async () => {
  const request = handoff('quote', '这个 tool result: {"ok": true} 是什么意思？')
  expect((await submit({ ...request, anchor: { ...request.anchor, tool_calls: [] } })).code).toBe(400)
  expect((await submit({ ...request, anchor: { ...request.anchor, producer: 'voice-agent' } })).code).toBe(400)
  const accepted = await submit(request)
  expect(h.runtime.store.triggers.get(accepted.value.triggerId)?.text).toBe(request.anchor.text)
})

it('does not listen by default or admit a disabled source or an unlisted principal', async () => {
  expect(dshKind.scope!({ meta: { bindingId: 'user' } }, DshConfigSchema.parse({}))).toMatchObject({ listened: false })
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, dsh: { enabled: false, config } } })
  expect((await submit(handoff('disabled'))).code).toBe(403)
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources, dsh: { allowed: [] } } } })
  expect((await submit(handoff('unlisted'))).code).toBe(403)
})

it('rolls receipt and Trigger back together when receipt persistence fails', () => {
  const scoped = sourceContext(h.runtime, dshKind), write = scoped.state.set
  scoped.state.set = () => { throw new Error('disk failure') }
  expect(() => acceptDsh(scoped, config, handoff('rollback'))).toThrow('disk failure')
  scoped.state.set = write
  expect(h.runtime.store.read.recentTriggers()).toHaveLength(0)
  expect(scoped.state.get('dsh-request:request-rollback')).toBeUndefined()
  expect(acceptDsh(scoped, config, handoff('rollback')).status).toBe('received')
})

it('gives explicit Router and its worker the local snapshot, with no Voice HTTP request or agent activation', async () => {
  const { triggerId, ticketId } = await admitted('local')
  const candidate = h.relays(h.runtime.masterId).find(item => item.trigger_id === triggerId)!
  expect(candidate.source_context).toMatchObject({ action: 'new', read: `dsh/${triggerId}/context` })
  expect(await original(`dsh/${triggerId}/context`)).toMatchObject({ messages: [{ text: '请研究这个，只调研不改代码' }] })
  expect(await original(`dsh/${triggerId}/message`, `worker-${ticketId}`)).toMatchObject({ message: { kind: 'human' } })
  expect(histories).toEqual([])
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_eval', { trigger_id: triggerId })).rejects.toThrow()
  expect(h.controller.prompt).not.toHaveBeenCalled()
})

it('reads bounded older pages through the fixed snapshot and refuses mismatched responses and unapproved messages', async () => {
  const request = handoff('pages'); request.snapshot.page.complete = false; request.snapshot.page.nextCursor = 'before-this'
  const { value } = await submit(request); await h.runtime.idle()
  const first = await original(`dsh/${value.triggerId}/context`)
  expect(first.next_resource).toBeTruthy()
  const second = await original(String(first.next_resource))
  expect(second).toMatchObject({ messages: [{ text: page.messages[0]!.text }] })
  expect(histories[0]).toMatchObject({ requestId: request.requestId, snapshotId: request.snapshot.id, cursor: 'before-this' })
  badHistory = true
  await expect(original(String(first.next_resource))).rejects.toThrow('different snapshot')
  badHistory = false; hugeHistory = true
  await expect(original(String(first.next_resource))).rejects.toThrow('size limit')
})

it('caps simultaneous remote history reads without making the initial local dialogue wait', async () => {
  const gate = Promise.withResolvers<void>(); historyGate = gate.promise
  const request = handoff('concurrent'); request.snapshot.page.complete = false; request.snapshot.page.nextCursor = 'older'
  const { value } = await submit(request); await h.runtime.idle()
  const first = await original(`dsh/${value.triggerId}/context`), remote = original(String(first.next_resource))
  try {
    await vi.waitFor(() => { expect(histories).toHaveLength(1) })
    await expect(original(String(first.next_resource))).rejects.toThrow('busy')
    expect(await original(`dsh/${value.triggerId}/context`)).toHaveProperty('messages')
  } finally { gate.resolve(); await remote }
})

it('enforces the history timeout and owner-private credential files', async () => {
  const gate = Promise.withResolvers<void>(); historyGate = gate.promise
  try { await expect(dshPost({ ...config, timeoutMs: 100 }, '/voice-bridge/v1/history', {})).rejects.toThrow() }
  finally { gate.resolve() }
  chmodSync(config.incomingTokenFile, 0o644)
  expect(() => dshToken(config.incomingTokenFile)).toThrow('private')
  expect(() => DshConfigSchema.parse({ voiceUrl: 'https://example.com' })).toThrow()
})

it('routes a new human append back to done A while B runs, and a retry after completion creates no extra Assignment', async () => {
  const a = await admitted('alpha'), b = await admitted('beta')
  await h.runTool(`worker-${a.ticketId}`, 'orchestrator_report', { state: 'ready', summary: 'A done' }); await h.runtime.idle()
  const request = handoff('continue', '继续 A 的调研', 'append'), { value } = await submit(request); await h.runtime.idle()
  const all = await read(`dsh/${value.triggerId}/tickets`)
  expect((all.items as { ticket_id: string }[]).map(item => item.ticket_id)).toEqual(expect.arrayContaining([a.ticketId, b.ticketId]))
  const list = vi.spyOn(h.runtime.store.tickets, 'list').mockImplementation(() => { throw new Error('No full-history scan') })
  try {
    await read(`dsh/${value.triggerId}/tickets`)
    await h.route({ kind: 'attach', trigger_id: value.triggerId, ticket_id: a.ticketId }); await h.runtime.idle()
    await h.runTool(`worker-${a.ticketId}`, 'orchestrator_report', { state: 'ready', summary: 'A continued' }); await h.runtime.idle()
    const before = h.runtime.store.tickets.get(a.ticketId)!.assignments.length
    await h.route({ kind: 'attach', trigger_id: value.triggerId, ticket_id: a.ticketId }); await h.runtime.idle()
    expect(h.runtime.store.tickets.get(a.ticketId)!.assignments).toHaveLength(before)
    expect(h.runtime.store.tickets.get(a.ticketId)!.ended).toBeDefined()
    expect(h.runtime.store.tickets.get(b.ticketId)!.ended).toBeUndefined()
    const reopened = new Store(join(h.directory, 'orchestrator.sqlite'))
    try {
      expect(dshRoute<Record<string, unknown>>(reopened, { kind: 'attach', trigger_id: value.triggerId, ticket_id: a.ticketId },
        () => { throw new Error('A restarted process must reuse the route receipt') })).toMatchObject({ ticketId: a.ticketId })
    } finally { reopened.close() }
  } finally { list.mockRestore() }
})

it('isolates worker dialogue and rejects routing to another binding or reading its ticket list', async () => {
  const a = await admitted('owner'), b = await admitted('other')
  const origin = h.runtime.store.triggers.get(b.triggerId)!
  h.runtime.store.triggers.save({ ...origin, actor: { ...origin.actor, id: 'someone-else' } })
  const { value } = await submit(handoff('steer', '补充一下', 'append')); await h.runtime.idle()
  await expect(h.route({ kind: 'attach', trigger_id: value.triggerId, ticket_id: b.ticketId })).rejects.toThrow('outside')
  await expect(original(`dsh/${b.triggerId}/context`, `worker-${a.ticketId}`)).rejects.toThrow()
  await expect(read(`dsh/${a.triggerId}/tickets`, `worker-${a.ticketId}`)).rejects.toThrow('main Session')
})

it('delivers pre-ticket clarification and refusal without creating work, and preserves frozen question metadata', async () => {
  const { value } = await submit(handoff('question', '改一下那个')); await h.runtime.idle()
  const list = vi.spyOn(h.runtime.store.tickets, 'list').mockImplementation(() => { throw new Error('No full-history scan') })
  try { await h.runTool(h.runtime.masterId, 'orchestrator_reply', { purpose: 'answer', trigger_id: value.triggerId, text: '你指的是音乐还是地图？' }) }
  finally { list.mockRestore() }
  expect(replies[0]).toMatchObject({ requestId: 'request-question', context: { purpose: 'answer', triggerId: value.triggerId } })
  expect(h.runtime.store.tickets.list()).toHaveLength(0)
  const a = await admitted('attention')
  await h.runTool(`worker-${a.ticketId}`, 'orchestrator_report', { state: 'progress', summary: 'need choice', human_action: '选 A 还是 B？', question_for_trigger_id: a.triggerId })
  const attention = h.runtime.store.tickets.get(a.ticketId)!.attention!
  replyFailure = true
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', { purpose: 'attention', ticket_id: a.ticketId, human_action: attention.question, text: attention.question })
  const queued = h.runtime.store.receipts.waiting().find(reply => reply.context?.purpose === 'attention')!
  expect(queued.context).toMatchObject({ attentionId: attention.id, triggerId: a.triggerId })
  await h.runTool(`worker-${a.ticketId}`, 'orchestrator_report', { state: 'progress', summary: 'another choice', human_action: '选 C 还是 D？' })
  expect(queued.context?.attentionId).toBe(attention.id)
})

it('stops the Router-selected ticket and reports actual stop/failed states through durable replies', async () => {
  const a = await admitted('stop'), b = await admitted('keep')
  const { value } = await submit(handoff('stop-now', '停止第一个，第二个继续', 'stop')); await h.runtime.idle()
  await h.route({ kind: 'stop', trigger_id: value.triggerId, ticket_id: a.ticketId }); await h.runtime.idle()
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', { purpose: 'status', ticket_id: a.ticketId, trigger_id: value.triggerId, text: '第一个已停止。' })
  expect(h.runtime.store.tickets.get(a.ticketId)!.ended?.by).toBe('human')
  expect(h.runtime.store.tickets.get(b.ticketId)!.ended).toBeUndefined()
  expect(replies.at(-1)).toMatchObject({ requestId: 'request-stop-now', context: { purpose: 'status' } })
  await h.runTool(`worker-${b.ticketId}`, 'orchestrator_report', { state: 'failed', summary: 'missing access' })
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', { purpose: 'status', ticket_id: b.ticketId, text: '访问权限不足，暂时无法继续。' })
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_reply', { purpose: 'result', ticket_id: b.ticketId, text: 'done' })).rejects.toThrow()
  const newMessage = await submit(handoff('resume-stop', '继续', 'append')); await h.runtime.idle()
  await expect(h.route({ kind: 'attach', trigger_id: newMessage.value.triggerId, ticket_id: a.ticketId })).rejects.toThrow('stopped')
})

it('keeps failed delivery pending and treats only an authoritative gone receipt as permanent', async () => {
  const a = await admitted('delivery'); await h.runtime.sendReplies()
  replyFailure = true
  const message = { id: 'retry-outbound', channel: h.runtime.store.triggers.get(a.triggerId)!.channel!, kind: 'notice' as const, text: '结果已准备好。' }
  h.runtime.outbox.send(message); await h.runtime.sendReplies()
  expect(h.runtime.outbox.status(message.id)).toBe('pending')
  replyFailure = false
  await dshKind.channel!.send({ commands: h.runtime.commands }, message, config)
  await dshKind.channel!.send({ commands: h.runtime.commands }, message, config)
  expect(replies.filter(reply => reply.replyId === message.id)).toHaveLength(1)
  replyGone = true
  expect(await dshKind.channel!.send({ commands: h.runtime.commands }, { ...message, id: 'gone' }, config)).toBe('gone')
})

it('retries a lost reply acknowledgement through Outbox without duplicating the accepted Voice reply', async () => {
  const a = await admitted('lost'); await h.runtime.sendReplies()
  loseReplyAck = true
  const message = { id: 'lost-ack', channel: h.runtime.store.triggers.get(a.triggerId)!.channel!, text: '结果。', kind: 'notice' as const }
  h.runtime.outbox.send(message); await h.runtime.sendReplies()
  expect(h.runtime.outbox.status(message.id)).toBe('pending')
  expect(replies.filter(reply => reply.replyId === message.id)).toHaveLength(1)
  loseReplyAck = false
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6000 })
  try { await h.runtime.pump(); await h.runtime.sendReplies() } finally { vi.useRealTimers() }
  expect(h.runtime.outbox.status(message.id)).toBe('sent')
  expect(replies.filter(reply => reply.replyId === message.id)).toHaveLength(1)
})

it('revalidates the source at routing time, while keeping previously received receipts queryable', async () => {
  const request = handoff('revoke'), { value } = await submit(request); await h.runtime.idle()
  const cached = await read(`dsh/${value.triggerId}/context`, undefined, 0, 20)
  expect(cached.next_offset).toBeGreaterThan(0)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, dsh: { enabled: false, config } } })
  await expect(h.route({ kind: 'accept', trigger_id: value.triggerId, title: 'revoked', worktree_name: 'revoked', acknowledgement: 'ok' }))
    .rejects.toThrow('no longer admitted')
  await expect(read(`dsh/${value.triggerId}/context`, undefined, 20)).rejects.toThrow('no longer available')
  const response = await fetch(`${bridgeUrl}/voice-bridge/v1/sources/dsh/handoffs/${request.requestId}`, { headers: { authorization: `Bearer ${INCOMING}` } })
  expect(response.status).toBe(200)
  expect(h.runtime.store.tickets.list()).toHaveLength(0)
})

it('retains visible assistant and attributed result context, rejects future/duplicate events, and keeps message reads local', async () => {
  const request = handoff('dialogue'), anchor = request.anchor
  request.snapshot.page.messages = [
    { ...anchor, ref: { ...anchor.ref, messageId: 'earlier', eventSeq: 1 }, text: '只调研。' },
    { ...anchor, ref: { ...anchor.ref, messageId: 'assistant', eventSeq: 2 }, kind: 'assistant', producer: 'voice-agent', text: '好，我看看。' },
    { ...anchor, ref: { ...anchor.ref, messageId: 'notice', eventSeq: 3 }, kind: 'notification', producer: 'dsh-superagent', text: '之前的结果已经准备好。' },
    anchor,
  ]
  const { value } = await submit(request); await h.runtime.idle()
  const result = await original(`dsh/${value.triggerId}/context`)
  const messages = result.messages as { kind: string; read: string }[]
  expect(messages.map(message => message.kind)).toEqual(['human', 'assistant', 'notification', 'human'])
  expect(await original(messages[1]!.read)).toMatchObject({ message: { kind: 'assistant', text: '好，我看看。' } })
  expect(histories).toHaveLength(0)
  const future = handoff('future')
  future.snapshot.page.messages.push({ ...future.anchor, ref: { ...future.anchor.ref, messageId: 'future-message', eventSeq: 6 } })
  expect((await submit(future)).code).toBe(400)
  const duplicate = handoff('duplicate'); duplicate.snapshot.page.messages.push(duplicate.anchor)
  expect((await submit(duplicate)).code).toBe(400)
})

it('shares other source work only by explicit source grant and returns follow-up answers to Voice', async () => {
  const other = await h.acceptedTicket((await import('./fixtures/host.ts')).feishu('external', '调研地图'))
  const request = handoff('cross', '继续地图调研', 'append'), { value } = await submit(request); await h.runtime.idle()
  await expect(h.route({ kind: 'attach', trigger_id: value.triggerId, ticket_id: other.ticket.id })).rejects.toThrow('outside')
  const settings = h.runtime.store.settings(), shared = { ...config, sharedSources: [{ source: 'feishu' }] }
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, dsh: { enabled: true, config: shared } } })
  expect((await read(`dsh/${value.triggerId}/tickets`)).items).toEqual(expect.arrayContaining([expect.objectContaining({ ticket_id: other.ticket.id })]))
  await h.route({ kind: 'attach', trigger_id: value.triggerId, ticket_id: other.ticket.id }); await h.runtime.idle()
  await h.runTool(other.sessionId, 'orchestrator_report', { state: 'ready', summary: '地图调研结果', reply_to_trigger_id: value.triggerId })
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', { purpose: 'answer', ticket_id: other.ticket.id,
    trigger_id: value.triggerId, text: '地图调研结果' })
  expect(replies.at(-1)).toMatchObject({ requestId: request.requestId, context: { purpose: 'answer', triggerId: value.triggerId } })
})

it('rolls a failed route receipt back with the Engine change, then permits a safe retry', async () => {
  const a = await admitted('atomic')
  await h.runTool(`worker-${a.ticketId}`, 'orchestrator_report', { state: 'ready', summary: 'done' }); await h.runtime.idle()
  const { value } = await submit(handoff('atomic-next', '继续', 'append')); await h.runtime.idle()
  const set = h.runtime.store.set.bind(h.runtime.store)
  const fault = vi.spyOn(h.runtime.store, 'set').mockImplementation((name, value) => {
    if (String(name).startsWith('dsh-route:')) throw new Error('route receipt disk failure')
    return set(name, value)
  })
  const before = h.runtime.store.tickets.get(a.ticketId)!.assignments.length
  try {
    await expect(h.route({ kind: 'attach', trigger_id: value.triggerId, ticket_id: a.ticketId })).rejects.toThrow('disk failure')
    expect(h.runtime.store.tickets.get(a.ticketId)!.assignments).toHaveLength(before)
    expect(h.runtime.store.tickets.get(a.ticketId)!.ended).toBeDefined()
  } finally { fault.mockRestore() }
  await h.route({ kind: 'attach', trigger_id: value.triggerId, ticket_id: a.ticketId }); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(a.ticketId)!.assignments).toHaveLength(before + 1)
})

it('allows a worker handback to select another ticket without replaying its old attachment', async () => {
  const a = await admitted('handback-a'), b = await admitted('handback-b')
  const { value } = await submit(handoff('routed', '补充刚才的', 'append')); await h.runtime.idle()
  await h.route({ kind: 'attach', trigger_id: value.triggerId, ticket_id: a.ticketId }); await h.runtime.idle()
  await h.runTool(`worker-${a.ticketId}`, 'orchestrator_trigger_handback', { trigger_id: value.triggerId, reason: 'This belongs to the other request.' })
  await h.runtime.idle()
  await h.route({ kind: 'attach', trigger_id: value.triggerId, ticket_id: b.ticketId }); await h.runtime.idle()
  expect(h.runtime.store.triggers.disposition(value.triggerId)?.fanout).toContain(b.ticketId)
  const assignments = h.runtime.store.tickets.get(a.ticketId)!.assignments.length
  expect(await h.route({ kind: 'attach', trigger_id: value.triggerId, ticket_id: a.ticketId })).toMatchObject({ reused: true })
  expect(h.runtime.store.tickets.get(a.ticketId)!.assignments).toHaveLength(assignments)
})
