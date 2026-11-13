/** Versioned cross-process Voice dialogue contract; tool records and private model content are never accepted. */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'

export const DSH_VERSION = 1 as const
const opaque = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
export const DshReferenceSchema = z.object({ sessionId: z.string().min(1).max(256), messageId: z.string().min(1).max(256),
  eventSeq: z.number().int().nonnegative() }).strict()
export const DshMessageSchema = z.object({ ref: DshReferenceSchema, at: z.iso.datetime({ offset: true }),
  kind: z.enum(['human', 'assistant', 'notification']), producer: z.enum(['user', 'voice-agent', 'dsh-superagent']),
  text: z.string().min(1).max(20000) }).strict().refine(message =>
  ({ human: 'user', assistant: 'voice-agent', notification: 'dsh-superagent' })[message.kind] === message.producer,
{ message: 'Dialogue kind and trusted producer must agree' })
export const DshPageSchema = z.object({ messages: z.array(DshMessageSchema).max(40), complete: z.boolean(),
  nextCursor: z.string().min(1).max(2000).optional(), missing: z.array(DshReferenceSchema).max(40).default([]) }).strict()
  .refine(page => page.complete ? page.nextCursor === undefined : page.nextCursor !== undefined,
    { message: 'Incomplete pages need a continuation; complete pages must not have one' })
  .superRefine((page, ctx) => {
    const seen = new Set<string>(), positions = new Map<string, number>()
    for (const message of page.messages) {
      const id = JSON.stringify([message.ref.sessionId, message.ref.messageId]), previous = positions.get(message.ref.sessionId)
      if (seen.has(id) || previous !== undefined && message.ref.eventSeq <= previous) {
        ctx.addIssue({ code: 'custom', message: 'Dialogue references must be unique and ordered within each Session' })
      }
      seen.add(id); positions.set(message.ref.sessionId, message.ref.eventSeq)
    }
  })
export const DshHandoffSchema = z.object({ version: z.literal(DSH_VERSION), requestId: opaque, bindingId: opaque,
  action: z.enum(['new', 'append', 'stop']), hint: z.string().trim().min(1).max(120).optional(),
  anchor: DshMessageSchema.refine(message => message.kind === 'human', 'An anchor must be genuine human input'),
  snapshot: z.object({ id: opaque, page: DshPageSchema }).strict() }).strict().superRefine((request, ctx) => {
  const anchor = request.snapshot.page.messages.find(message => sameReference(message.ref, request.anchor.ref))
  if (!anchor || JSON.stringify(anchor) !== JSON.stringify(request.anchor)) ctx.addIssue({ code: 'custom',
    message: 'The snapshot must include the unchanged human anchor', path: ['snapshot', 'page'] })
  if (request.snapshot.page.messages.some(message => message.ref.sessionId === request.anchor.ref.sessionId
    && message.ref.eventSeq > request.anchor.ref.eventSeq)) ctx.addIssue({ code: 'custom',
    message: 'The snapshot cannot contain messages after the anchor', path: ['snapshot', 'page'] })
})
export type DshHandoff = z.infer<typeof DshHandoffSchema>
export const DshReceivedSchema = z.object({ version: z.literal(DSH_VERSION), requestId: opaque, bindingId: opaque,
  triggerId: z.string().min(1).max(256), status: z.literal('received') }).strict()
export type DshReceived = z.infer<typeof DshReceivedSchema>
export type DshPage = z.infer<typeof DshPageSchema>
export type DshReference = z.infer<typeof DshReferenceSchema>
export const DshHistorySchema = z.object({ version: z.literal(DSH_VERSION), requestId: opaque,
  snapshotId: opaque, page: DshPageSchema }).strict()
export const DshHistoryRequestSchema = z.object({ version: z.literal(DSH_VERSION), requestId: opaque, bindingId: opaque,
  snapshotId: opaque, part: z.enum(['context', 'message']), cursor: z.string().min(1).max(2000).optional(),
  message: DshReferenceSchema.optional() }).strict().refine(value => value.part === 'message'
    ? !!value.message && !value.cursor : !value.message, { message: 'History selection must match its part' })
export const DshReplySchema = z.object({ version: z.literal(DSH_VERSION), replyId: z.string().min(1).max(256),
  bindingId: opaque, requestId: opaque, text: z.string().min(1).max(20000), kind: z.enum(['acknowledgement', 'reply', 'notice']),
  ticketId: z.string().min(1).max(256).optional(), context: z.object({
    purpose: z.enum(['acknowledgement', 'answer', 'result', 'attention', 'status', 'notice']),
    triggerId: z.string().min(1).max(256).optional(), attentionId: z.string().min(1).max(256).optional(),
    ticketTitle: z.string().max(200).optional(),
  }).strict().optional() }).strict()
export type DshReply = z.infer<typeof DshReplySchema>
export const DshDeliverySchema = z.object({ version: z.literal(DSH_VERSION), replyId: z.string().min(1).max(256),
  status: z.enum(['received', 'gone']) }).strict()
export const isDshSource = (source: string) => source === 'dsh' || source.startsWith('dsh-')
export const sameReference = (a: DshReference, b: DshReference) => a.sessionId === b.sessionId
  && a.messageId === b.messageId && a.eventSeq === b.eventSeq
export const dshTriggerId = (source: string, request: DshHandoff) =>
  key('dsh-origin', source, request.bindingId, request.anchor.ref.sessionId, request.anchor.ref.messageId)
export const dshRequestKey = (requestId: string) => `dsh-request:${requestId}`
export const dshOriginKey = (triggerId: string) => `dsh-origin:${triggerId}`
export function dshHandoff(trigger: Trigger): DshHandoff {
  if (!isDshSource(trigger.source)) throw new Error('A DSH source trigger is required')
  return DshHandoffSchema.parse(trigger.meta.handoff)
}
/** Creates one immutable incoming event on its own Thread, never a conversation-wide fan-out thread. */
export function dshTrigger(source: string, principal: string, request: DshHandoff): Trigger {
  const id = dshTriggerId(source, request)
  return { id, source, threads: [{ source, id }], actor: { source, id: principal }, human: true, addressed: 'direct',
    at: request.anchor.at, text: request.anchor.text,
    channel: { source, thread: id, address: { bindingId: request.bindingId, principalId: principal, requestId: request.requestId } },
    meta: { bindingId: request.bindingId, principalId: principal, handoff: request } }
}
