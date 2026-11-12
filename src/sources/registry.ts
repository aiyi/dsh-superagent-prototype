/** Registry of installed Source kinds, their configured instances, and the Engine's SourceScope implementation. */
import type { ChannelRef, OutboundMessage, ScopeResult, SourceScope, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { sameName } from '../infra/text.ts'
import { AdmissionTableSchema, type Settings } from '../policy.ts'
import type { ChannelLink, ChannelLinks, SourceInstance, SourceKind, TriggerContext, VariableSpec } from './kind.ts'

/**
 * Manages registered SourceKind plugins, validates their instance and policy configurations, and implements SourceScope for the Engine.
 * A kind may have several instances named `<kind>` or `<kind>-<name>`; each instance has its own configuration, health and Policy part,
 * and an instance id is the `source` of its Triggers, Threads and Channels.
 */
export class SourceRegistry implements SourceScope {
  private readonly kinds = new Map<string, SourceKind>()
  private readonly health = new Map<string, HealthEntry>()
  constructor(private readonly settings: () => Settings, private readonly board: Pick<HealthBoard, 'claim'> = new HealthBoard(),
    private readonly registered: (kind: SourceKind) => () => void = () => () => {}) {}

  /** Registers a SourceKind, claims its default instance's health entries on HealthBoard (rejecting `sync:` prefixes owned by Settings), and returns an unregister disposer. */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void {
    if (this.kinds.has(kind.kind)) throw new Error(`Source kind already registered: ${kind.kind}`)
    const refused = (name: string) => new Error(`Source kind ${kind.kind} declares the health entry ${name}, which another part reports`)
    const synced = kind.health.find(name => name.startsWith('sync:'))
    if (synced) throw refused(synced)
    const entries = new Map<string, HealthEntry>()
    const release = () => { for (const [name, entry] of entries) { entry.release(); this.health.delete(name) } }
    for (const name of kind.health) {
      // Declared entries are claimed strictly: a name another kind already reports is refused, unlike a lazy instance entry.
      try { const entry = this.board.claim(name, { state: 'starting', detail: '' }); entries.set(name, entry); this.health.set(name, entry) }
      catch { release(); throw refused(name) }
    }
    this.kinds.set(kind.kind, kind as unknown as SourceKind)
    const unregistered = this.registered(kind as unknown as SourceKind)
    return () => {
      this.kinds.delete(kind.kind)
      for (const [name, entry] of entries) { entry.release(); this.health.delete(name) }
      // Release the per-instance entries this kind claimed lazily, such as `github:acme-api`.
      for (const [name, entry] of this.health) {
        if (!name.startsWith(`${kind.kind}:`)) continue
        entry.release(); this.health.delete(name)
      }
      unregistered()
    }
  }
  /** Claim one health entry name, or return the entry already claimed for it. */
  private claim(name: string): HealthEntry {
    const existing = this.health.get(name)
    if (existing) return existing
    const entry = this.board.claim(name, { state: 'starting', detail: '' })
    this.health.set(name, entry)
    return entry
  }
  /**
   * Returns the active health entries for `names`, keyed by their declared names. The default instance (`instanceId === kind`) uses the
   * declared names; another instance uses `<name>:<instanceId>` so each repository reports its own health.
   */
  healthEntries(names: readonly string[], instanceId?: string): Map<string, HealthEntry> {
    return new Map(names.flatMap(name => {
      const entry = this.health.get(instanceId === undefined || instanceId === name ? name : `${name}:${instanceId}`)
      return entry ? [[name, entry] as const] : []
    }))
  }
  /**
   * Returns the health entries of one instance, keyed by their declared names. The default instance uses the entries the kind
   * claimed at registration; a further instance claims its own `<name>:<instanceId>` entries on first use.
   */
  healthEntriesFor(kind: { kind: string; health: readonly string[] }, instanceId: string): Map<string, HealthEntry> {
    return new Map(kind.health.flatMap(name => {
      if (instanceId === kind.kind) {
        const entry = this.health.get(name)
        return entry ? [[name, entry] as const] : []
      }
      return [[name, this.claim(`${name}:${instanceId}`)] as const]
    }))
  }
  /** The kind id of a Source instance id, by the `kind` or `kind-<name>` naming rule. */
  kindId(instanceId: string): string | undefined {
    let found: string | undefined
    for (const kind of this.kinds.keys()) {
      if (instanceId === kind || instanceId.startsWith(`${kind}-`)) {
        if (!found || kind.length > found.length) found = kind
      }
    }
    return found
  }
  kind(id: string): SourceKind | undefined { return this.kinds.get(this.kindId(id) ?? '') }
  /** Every instance of `kindId`, installed or not, for a plugin that polls each configured instance. */
  instancesOfKind(kindId: string, settings = this.settings()): (SourceInstance & { installed: boolean })[] {
    return this.instances(settings).filter(instance => instance.kind === kindId)
  }
  /** Every configured instance, ordered by kind and id, followed by stored instances whose kind is not installed (with their config kept as stored). */
  instances(settings = this.settings()): (SourceInstance & { installed: boolean })[] {
    const installed = [...this.kinds.values()].flatMap(kind => {
      const ids = Object.keys(settings.sources).filter(id => id === kind.kind || id.startsWith(`${kind.kind}-`))
      return (ids.length ? ids : [kind.kind]).map(id => ({ ...this.resolve(kind, settings.sources[id], id), installed: true }))
    }).sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
    const orphaned = Object.entries(settings.sources).filter(([id]) => !this.kindId(id)).map(([id, stored]) => ({ id, kind: id, enabled: stored.enabled, config: stored.config, installed: false }))
    return [...installed, ...orphaned]
  }
  instance<C extends Record<string, unknown>>(id: string, settings = this.settings()): SourceInstance<C> | undefined {
    const kindId = this.kindId(id)
    const kind = kindId === undefined ? undefined : this.kinds.get(kindId)
    return kind ? this.resolve(kind, settings.sources[id], id) as SourceInstance<C> : undefined
  }
  validate(id: string, value: { enabled: boolean; config: unknown }): { enabled: boolean; config: Record<string, unknown> } {
    const kind = this.kind(id)
    if (!kind) throw new Error(`Source kind not installed: ${id}`)
    return { enabled: value.enabled, config: kind.schema.parse(value.config) }
  }
  /** Validates each Source's part of a submitted Policy against its kind; policy parts for uninstalled Source kinds are kept as stored. */
  validatePolicy(parts: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown> & { allowed: { id: string; name?: string }[] }> {
    return Object.fromEntries(Object.entries(parts).map(([id, part]) => {
      const policy = this.kind(id)?.policy
      // `admission` is validated by the Policy's own schema (shared across all kinds), while the kind validates the rest of its part.
      const { admission, ...rest } = part
      return [id, policy ? { ...policy.schema.parse(rest), admission: AdmissionTableSchema.parse(admission ?? {}) } : part as Record<string, unknown> & { allowed: { id: string; name?: string }[] }]
    }))
  }
  policyPart(id: string, settings = this.settings()) {
    const policy = this.kind(id)?.policy
    if (!policy) return undefined
    const { admission, ...rest } = settings.policy.sources[id] ?? {}
    const parsed = policy.schema.safeParse(rest)
    return { ...parsed.success ? parsed.data : policy.schema.parse({}), admission: AdmissionTableSchema.safeParse(admission ?? {}).data ?? {} }
  }
  channelAllowed(channel: { source: string; address: Record<string, string> }, settings = this.settings()): boolean {
    const kind = this.kind(channel.source)
    if (!kind) return false
    const instance = this.instance(channel.source, settings)
    return !!instance?.enabled && (kind.channel?.allowed?.(channel.address, instance.config) ?? true)
  }
  /** Environment variable declarations for every installed kind, whether enabled or disabled. */
  declarations(): { kind: string; variables: readonly VariableSpec[] }[] {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => kind.environment ? [{ kind: kind.kind, variables: kind.environment.variables }] : [])
  }
  /** One entry per enabled Source instance whose kind declares environment variables. */
  environments(settings = this.settings()) {
    return this.instances(settings).flatMap(instance => {
      if (!instance.installed || !instance.enabled) return []
      const kind = this.kinds.get(instance.kind)
      return kind?.environment ? [{ kind, environment: kind.environment, config: instance.config, source: instance.id }] : []
    })
  }
  /**
   * Sends a message idempotently through its Channel's kind; returns `'waiting'` while the kind is not installed, or
   * `'gone'` when the target (or a kind without channels) can never receive it.
   */
  async send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'> {
    const kind = this.kind(message.channel.source)
    if (!kind) return 'waiting'
    const bound = this.bind(commands, message.channel.source)
    return kind.channel ? kind.channel.send({ commands: bound }, message) : 'gone'
  }
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink {
    const repository = links.repositories?.[channel.source]
    const link = this.kind(channel.source)?.channel?.link(channel.address, repository ? { ...links, repository } : links)
    return link ?? { url: '', label: { zh: channel.source, en: channel.source } }
  }
  find(query: string): { threads: string[]; terms: string[] } {
    const found = this.instances().filter(instance => instance.installed).flatMap(instance => {
      const kind = this.kinds.get(instance.kind)
      return kind?.find ? [kind.find(query, instance.id)] : []
    })
    return { threads: [...new Set(found.flatMap(item => item.threads))], terms: [...new Set(found.flatMap(item => item.terms))] }
  }
  repliesTo(trigger: Trigger): string | undefined { return this.kind(trigger.source)?.repliesTo?.(trigger) }
  threadContext(trigger: Trigger, settings = this.settings()): TriggerContext | undefined {
    const kind = this.kind(trigger.source)
    const context = kind?.threadContext
    if (!kind || !context) return undefined
    const instance = this.instance(trigger.source, settings)
    if (!instance) return undefined
    const { config } = instance
    return {
      messageId: context.messageId(trigger),
      read: (commands, part, cursor) => context.read(this.bind(commands, trigger.source), trigger, part, cursor, config),
      images: text => context.images?.(text) ?? [],
      image: async (agent, commands, message, key, stateDir, signal) => {
        if (!context.image) throw new Error(`The ${kind.kind} Source has no images`)
        return context.image(agent, this.bind(commands, trigger.source), trigger, message, key, stateDir, signal)
      },
    }
  }
  scope(input: { source: string; meta: Record<string, unknown> }, settings = this.settings()): ScopeResult {
    const kind = this.kind(input.source)
    const stored = settings.sources[input.source]
    // Without its kind plugin the stored scope cannot be evaluated, so a configured Source whose plugin is missing listens to nothing.
    if (!kind) return stored ? { listened: false, reason: 'source_not_installed' } : { listened: true, observed: false }
    const instance = this.instance(input.source, settings)
    if (!instance?.enabled) return { listened: false, reason: 'source_disabled' }
    return kind.scope ? kind.scope({ meta: input.meta }, instance.config) : { listened: true, observed: false }
  }
  /** Bind GitHub calls to the instance's repository; other kinds, and instances without one, use the transport as it is. */
  private bind(commands: Commands, source: string): Commands {
    let deployment
    try { deployment = commands.deployment } catch { return commands }
    if (!deployment?.repositories) return commands
    const repository = deployment.repositories[source]
    if (!repository) {
      // A GitHub instance whose repository setup failed must not read or write the default repository instead.
      if (this.kind(source)?.kind === 'github') throw new Error(`The repository of ${source} is unavailable; fix its setup problem first`)
      return commands
    }
    return sameName(repository, commands.repository) ? commands : commands.withRepository(repository)
  }
  /** Falls back to schema defaults and disables the instance when stored configuration fails validation. */
  private resolve(kind: SourceKind, stored: { enabled: boolean; config: Record<string, unknown> } | undefined, id: string): SourceInstance {
    const parsed = kind.schema.safeParse(stored?.config ?? {})
    return { id, kind: kind.kind, enabled: parsed.success && (stored?.enabled ?? true), config: parsed.success ? parsed.data : kind.schema.parse({}) }
  }
}
