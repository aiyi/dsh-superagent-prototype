/** Transactional receipts distinguish a retried Voice routing command from a genuine new human continuation. */
import { key } from '../core/index.ts'
import { isDshSource } from '../sources/dsh-protocol.ts'
import type { Store } from './store.ts'

interface RoutingItem { kind: string; trigger_id: string; ticket_id?: string | null }
type RoutingStore = Pick<Store, 'get' | 'set' | 'atomic' | 'triggers'>
/** Records operations by immutable origin/action/target, independent of transient Eval IDs or process lifetime. */
export function dshRoute<T extends object>(store: RoutingStore, item: RoutingItem, run: () => T): T {
  const trigger = store.triggers.get(item.trigger_id)
  if (!trigger || !isDshSource(trigger.source)) return run()
  return store.atomic(() => {
    const name = `dsh-route:${key(trigger.id, item.kind, item.ticket_id ?? '')}`
    const prior = store.get<T>(name)
    if (prior) return { ...prior, reused: true }
    const targetKey = `dsh-route-target:${key(trigger.id)}`
    const target = store.get<{ kind: string; ticketId?: string | null }>(targetKey)
    const disposition = store.triggers.disposition(trigger.id)
    const released = disposition?.requeued || target?.ticketId && disposition?.handbacks?.some(item => item.ticketId === target.ticketId)
    if (['accept', 'attach'].includes(item.kind) && target
      && (target.kind !== item.kind || target.ticketId !== item.ticket_id) && !released) {
      return { refused: 'This request was already routed; a correction needs a new human message or explicit re-evaluation' } as T
    }
    const result = run()
    if (!('refused' in result)) {
      store.set(name, result)
      if (['accept', 'attach'].includes(item.kind)) store.set(targetKey, { kind: item.kind,
        ticketId: item.ticket_id ?? ('ticketId' in result && typeof result.ticketId === 'string' ? result.ticketId : undefined) })
    }
    return result
  })
}
