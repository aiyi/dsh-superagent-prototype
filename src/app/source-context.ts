/** Scoped runtime context exposed to each Source instance, isolating Sources from direct Store or Engine access. */
import type { EngineForSources, ReceiveResult, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import type { SetupProblem } from '../setup.ts'
import type { SourceContext } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { sameName } from '../infra/text.ts'
import type { Outbox } from './outbox.ts'
import type { Store } from './store.ts'

export interface SourceContextDeps {
  readonly store: Pick<Store, 'atomic' | 'get' | 'set' | 'delete' | 'keys' | 'threads' | 'tickets' | 'triggers' | 'read'>
  readonly outbox: Pick<Outbox, 'send'>
  readonly engine: Pick<EngineForSources, 'bindThread' | 'threadClosed'>
  readonly commands: Commands
  readonly sources: SourceRegistry
  /** Throws when accessed before initial setup completes. */
  readonly deployment: Deployment
  readonly ready: Promise<void>
  configured(): boolean
  /** The setup problem that pauses this Source instance, if any. */
  problemFor?(id: string): SetupProblem | undefined
  /** Legacy single-kind setup problems; `problemFor` supersedes them. */
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  /** Hands a Trigger to the Engine and schedules the pass that assesses it. */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
}

/**
 * Builds the context for one Source instance. Health reports are restricted to entries declared by the kind and
 * bound to the active registration, becoming no-ops once unregistered. The default instance (id === kind) keeps the
 * legacy instance-global KV keys; further instances store their keys under `@<id>` so they never share a cursor.
 */
export function sourceContextOf(deps: SourceContextDeps, kind: { kind: string; health: readonly string[] }, instanceId = kind.kind): SourceContext {
  const { store } = deps
  const health = deps.sources.healthEntriesFor(kind, instanceId)
  const legacy = instanceId === kind.kind
  const scoped = (key: string): string => legacy ? key : `${key}@${instanceId}`
  return {
    id: instanceId,
    get deployment() { return deps.deployment },
    get commands() {
      try {
        const repository = deps.deployment.repositories[instanceId]
        if (!repository && kind.kind === 'github') throw new Error(`The repository of ${instanceId} is unavailable; fix its setup problem first`)
        return repository && !sameName(repository, deps.commands.repository) ? deps.commands.withRepository(repository) : deps.commands
      } catch { return deps.commands }
    },
    ready: deps.ready,
    configured: () => deps.configured(),
    get problem() { return deps.problemFor?.(instanceId) ?? [deps.feishuProblem, deps.setupProblem].find(problem => problem?.place === instanceId) },
    config: <C extends Record<string, unknown>>(id = instanceId) => {
      const instance = deps.sources.instance<C>(id)
      return instance?.enabled ? instance.config : undefined
    },
    receive: trigger => deps.receive(trigger),
    atomic: work => store.atomic(work),
    state: {
      get: name => store.get(scoped(name)),
      set: (name, value) => { if (value === undefined) store.delete(scoped(name)); else store.set(scoped(name), value) },
      keys: prefix => {
        const names = store.keys(prefix)
        if (legacy) return names
        const suffix = `@${instanceId}`
        return names.filter(name => name.endsWith(suffix)).map(name => name.slice(0, -suffix.length))
      },
    },
    threads: {
      get: key => store.threads.get(key),
      subscribed: source => store.read.subscribedThreads(source),
      describe: (key, description) => store.threads.describe(key, description),
      patch: (key, meta) => { store.threads.patchMeta(key, meta) },
    },
    tickets: {
      get: id => store.tickets.get(id),
      open: () => store.tickets.open(),
      bindThread: (id, thread, own) => { deps.engine.bindThread(id, thread, own) },
      threadClosed: (thread, outcome, at) => { deps.engine.threadClosed(thread, outcome, at) },
    },
    triggers: { get: id => store.triggers.get(id), latest: thread => store.read.threadTriggers(thread, 1)[0] },
    notify: message => { deps.outbox.send(message) },
    report: (entry, value) => {
      if (!kind.health.includes(entry)) throw new Error(`The ${kind.kind} Source has no health entry ${entry}`)
      health.get(entry)?.set(value)
    },
  }
}
