/** DSH Voice Source: authenticated explicit handoffs, bounded original dialogue reads and durable Channel delivery. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import { dshHandoff, dshOriginKey, dshRequestKey, dshTrigger, DshDeliverySchema, DshHandoffSchema, DshHistorySchema,
  DshHistoryRequestSchema, DshReplySchema, DshReferenceSchema, DSH_VERSION, sameReference, type DshReceived } from './dsh-protocol.ts'
import { dshAuthorized, dshBaseUrl, DSH_MAX_BYTES, dshPost, dshToken } from './dsh-transport.ts'
import { sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

export const DshConfigSchema = z.object({
  bindingId: z.string().max(128).default(''), principalId: z.string().max(128).default(''),
  voiceUrl: z.string().default('').refine(value => { try { return !value || !!dshBaseUrl(value) } catch { return false } }, 'A loopback HTTP origin is required'),
  incomingTokenFile: z.string().default(''), voiceTokenFile: z.string().default(''),
  sharedSources: z.array(z.object({ source: z.string().regex(/^[a-z][a-z0-9-]*$/) }).strict()).max(50).default([]),
  timeoutMs: z.number().int().min(100).max(30000).default(5000), maxReaders: z.number().int().min(1).max(4).default(1),
}).strict()
export type DshConfig = z.infer<typeof DshConfigSchema>
const configured = (config: DshConfig) => !!(config.bindingId && config.principalId && config.voiceUrl
  && config.incomingTokenFile && config.voiceTokenFile)
const allowed = (trigger: Trigger, config: DshConfig) => configured(config)
  && trigger.actor.id === config.principalId && dshHandoff(trigger).bindingId === config.bindingId
const encode = (value: string) => Buffer.from(value).toString('base64url')
function decode(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,12000}$/.test(value)) throw new Error('Invalid DSH resource cursor')
  const decoded = Buffer.from(value, 'base64url').toString('utf8')
  if (encode(decoded) !== value) throw new Error('Invalid DSH resource cursor')
  return decoded
}
/** Reads the persisted initial window without involving the Voice process; only continuation or extra messages use HTTP. */
async function readOriginal(trigger: Trigger, path: string, config: DshConfig, signal?: AbortSignal): Promise<unknown> {
  if (!allowed(trigger, config)) throw new Error('DSH binding is unavailable')
  const request = dshHandoff(trigger), [part, token, ...extra] = path.split('/')
  if (extra.length || !['message', 'context'].includes(part ?? '')) throw new Error('Unknown DSH original resource')
  let page = request.snapshot.page
  if (part === 'message' && !token) return { message: request.anchor }
  if (token) {
    const selection = part === 'message' ? { message: DshReferenceSchema.parse(JSON.parse(decode(token))) } : { cursor: decode(token) }
    const local = selection.message && page.messages.find(message => sameReference(message.ref, selection.message!))
    if (local) return { message: local }
    const result = DshHistorySchema.parse(await dshPost(config, '/voice-bridge/v1/history', DshHistoryRequestSchema.parse({ version: DSH_VERSION,
      requestId: request.requestId, bindingId: request.bindingId, snapshotId: request.snapshot.id, part, ...selection }), signal))
    if (result.requestId !== request.requestId || result.snapshotId !== request.snapshot.id) throw new Error('Voice returned a different snapshot')
    page = result.page
    if (part === 'message' && page.messages.some(message => !sameReference(message.ref, selection.message!))) {
      throw new Error('Voice returned a different message')
    }
    if (part === 'message' && (page.messages.length > 1
      || !page.messages.length && !page.missing.some(ref => sameReference(ref, selection.message!)))) {
      throw new Error('Voice must return the requested message or explicitly mark it missing')
    }
  }
  return { snapshotId: request.snapshot.id, ...page,
    messages: page.messages.map(message => ({ ...message,
      read: `dsh/${trigger.id}/message/${encode(JSON.stringify(message.ref))}` })),
    ...(page.nextCursor ? { next_resource: `dsh/${trigger.id}/context/${encode(page.nextCursor)}` } : {}) }
}
export const dshKind: SourceKind<DshConfig> = {
  kind: 'dsh', title: { zh: '语音对话', en: 'Voice dialogue' },
  description: { zh: '接收独立 Voice Host 的显式请求，按原文路由并返回对话回复。', en: 'Explicit requests and original dialogue from an independent Voice Host.' },
  schema: DshConfigSchema,
  fields: [
    ...(['bindingId', 'principalId', 'voiceUrl', 'incomingTokenFile', 'voiceTokenFile'] as const).map(field => ({ key: field,
      type: 'text' as const, label: { zh: field, en: field } })),
    { key: 'sharedSources', type: 'rows', label: { zh: '明确允许继续的其他来源', en: 'Explicitly shared source instances' },
      columns: [{ key: 'source', type: 'text', label: { zh: '来源 ID', en: 'Source ID' } }] },
    { key: 'timeoutMs', type: 'number', advanced: true, min: 100, max: 30000, label: { zh: '读取超时 / 毫秒', en: 'Read timeout / ms' } },
    { key: 'maxReaders', type: 'number', advanced: true, min: 1, max: 4, label: { zh: '并发原文读取上限', en: 'Concurrent history reads' } },
  ], health: ['dsh'],
  scope({ meta }, config) { return configured(config) && meta.bindingId === config.bindingId && meta.principalId === config.principalId
    ? { listened: true, observed: false } : { listened: false, reason: 'dsh_binding_unavailable' } },
  policy: { schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().optional() }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '允许的 Voice 用户', en: 'Allowed Voice principals' },
      columns: [{ key: 'id', type: 'text', label: { zh: '用户 ID', en: 'Principal ID' } }] }],
    explicit: { zh: '可信 Voice Host 代绑定用户提交的原始工作请求；模型提示不扩大授权。',
      en: 'Original human requests delegated by the authenticated, bound Voice Host; model hints grant no extra authority.' } },
  original: { reference: (trigger, config) => { if (!allowed(trigger, config)) throw new Error('DSH binding is unavailable')
    const request = dshHandoff(trigger); return { action: request.action,
    ...(request.hint ? { hint: request.hint } : {}), read: `dsh/${trigger.id}/context`, tickets: `dsh/${trigger.id}/tickets` } }, read: readOriginal },
  targetAllowed(trigger, _ticket, origin, config) {
    if (!allowed(trigger, config) || !origin) return false
    return origin.source === trigger.source && origin.actor.id === config.principalId && origin.meta.bindingId === config.bindingId
      || config.sharedSources.some(item => item.source === origin.source)
  },
  routingSources: (trigger, config) => allowed(trigger, config) ? config.sharedSources.map(item => item.source) : [],
  channel: {
    allowed: (address, config) => configured(config) && address.bindingId === config.bindingId && address.principalId === config.principalId,
    link: () => ({ url: '', label: { zh: '语音对话', en: 'Voice dialogue' } }),
    async send(_host, message, config) {
      const result = DshDeliverySchema.parse(await dshPost(config, '/voice-bridge/v1/replies', DshReplySchema.parse({
        version: DSH_VERSION, replyId: message.id, bindingId: message.channel.address.bindingId,
        requestId: message.channel.address.requestId, text: message.text, kind: message.kind,
        ...(message.ticketId ? { ticketId: message.ticketId } : {}), ...(message.context ? { context: message.context } : {}),
      })))
      if (result.replyId !== message.id) throw new Error('Voice acknowledged a different reply')
      return result.status === 'gone' ? 'gone' : 'sent'
    },
  },
}

export interface DshReceipt extends DshReceived { fingerprint: string }
/** Safe, deterministic ingress refusals distinguished from temporary storage/transport failures. */
class DshInputError extends Error {
  constructor(readonly status: 403 | 409 | 413, message: string) { super(message) }
}
/** Atomically records the receipt and the immutable Trigger; a lost HTTP response is resolved by ID, not resubmission. */
export function acceptDsh(host: SourceContext, config: DshConfig, body: unknown): DshReceipt {
  const request = DshHandoffSchema.parse(body)
  if (Buffer.byteLength(JSON.stringify(request)) > DSH_MAX_BYTES) throw new DshInputError(413, 'DSH request exceeds the size limit')
  if (request.bindingId !== config.bindingId) throw new DshInputError(403, 'DSH binding mismatch')
  const fingerprint = key(JSON.stringify(request)), name = dshRequestKey(request.requestId)
  return host.atomic(() => {
    const existing = host.state.get<DshReceipt>(name)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new DshInputError(409, 'DSH request ID conflicts with its frozen payload')
      return existing
    }
    if (!configured(config) || !host.config() || !host.configured()) throw new Error('DSH Source is disabled or unconfigured')
    const trigger = dshTrigger(host.id, config.principalId, request)
    if (host.state.get(dshOriginKey(trigger.id))) throw new DshInputError(409, 'DSH origin was already submitted under another request ID')
    const result = host.receive(trigger)
    if (typeof result !== 'string') throw new Error('DSH ingress requires synchronous transactional intake')
    if (result !== 'stored') throw new Error('DSH trigger was not newly received')
    const receipt: DshReceipt = { version: DSH_VERSION, requestId: request.requestId, bindingId: request.bindingId,
      triggerId: trigger.id, status: 'received', fingerprint }
    host.state.set(name, receipt); host.state.set(dshOriginKey(trigger.id), request.requestId)
    return receipt
  })
}
const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value))
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > DSH_MAX_BYTES) throw new DshInputError(413, 'DSH request exceeds the size limit')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}
export const name = 'dsh-superagent-dsh'
export const inject = ['orchestrator', 'webServer']
/** Mounts only a loopback, bearer-authenticated bridge; no public human-prompt RPC is used. */
export function apply(ctx: Context): void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('DSH bridge requires a loopback Web server')
  const kind = dshKind
  ctx.effect(() => ctx.orchestrator.sources.register(kind), 'dsh: source kind')
  const reportHealth = () => {
    for (const instance of ctx.orchestrator.sources.instancesOfKind('dsh')) {
      const config = instance.config as DshConfig, host = sourceContext(ctx.orchestrator, kind, instance.id)
      if (!instance.enabled || !configured(config)
        || !ctx.orchestrator.sources.policyPart(instance.id)?.allowed.some(person => person.id === config.principalId)) {
        host.report('dsh', { state: 'paused', detail: 'Configure and enable the Voice binding, private credentials and allowed principal' }); continue
      }
      try {
        dshToken(config.incomingTokenFile); dshToken(config.voiceTokenFile)
        host.report('dsh', { state: 'ready', detail: 'Authenticated Voice intake is configured; outbound delivery has its own receipts' })
      } catch { host.report('dsh', { state: 'error', detail: 'Voice credential files are unavailable or not owner-private' }) }
    }
  }
  ctx.effect(() => { reportHealth(); const timer = setInterval(reportHealth, 5000); return () => { clearInterval(timer) } }, 'dsh: configuration health')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/voice-bridge/v1/sources/', handler: async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      const match = /^\/voice-bridge\/v1\/sources\/(dsh(?:-[a-z0-9-]+)?)\/handoffs(?:\/([A-Za-z0-9_-]{1,128}))?$/.exec(path)
      if (!match) { json(res, 404, { error: 'Unknown DSH bridge resource' }); return }
      const source = match[1]!, requestId = match[2], instance = ctx.orchestrator.sources.instance<DshConfig>(source)
      if (!instance || !configured(instance.config)) { json(res, 503, { error: 'DSH Source is unconfigured' }); return }
      if (!dshAuthorized(req.headers.authorization, instance.config.incomingTokenFile)) { json(res, 401, { error: 'Unauthorized' }); return }
      const host = sourceContext(ctx.orchestrator, kind, source)
      if (req.method === 'GET' && requestId) {
        const receipt = host.state.get<DshReceipt>(dshRequestKey(requestId))
        if (!receipt || receipt.bindingId !== instance.config.bindingId) { json(res, 404, { status: 'unknown' }); return }
        const { fingerprint: _fingerprint, ...publicReceipt } = receipt
        json(res, 200, publicReceipt); return
      }
      if (req.method !== 'POST' || requestId) { json(res, 405, { error: 'Method not allowed' }); return }
      if (!instance.enabled || !ctx.orchestrator.sources.policyPart(source)?.allowed.some(person => person.id === instance.config.principalId)) {
        json(res, 403, { error: 'DSH Source or principal is not admitted' }); return
      }
      const { fingerprint: _fingerprint, ...receipt } = acceptDsh(host, instance.config, await body(req))
      reportHealth()
      json(res, 200, receipt)
    } catch (error) {
      const invalid = error instanceof z.ZodError || error instanceof SyntaxError
      json(res, invalid ? 400 : error instanceof DshInputError ? error.status : 503,
        { error: invalid ? 'Invalid DSH handoff' : error instanceof DshInputError ? error.message : 'DSH bridge unavailable' })
    }
  } }), 'dsh: authenticated bridge')
}
