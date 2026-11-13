/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, resolveGithubInstance, sourceKind, workerProbe, type Deployment, type Machine }
  from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { sameName } from '../infra/text.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

const setupFields = (settings: Settings) =>
  JSON.stringify(Object.entries(settings.sources).filter(([id]) => SETUP_FIELDS[sourceKind(id) ?? ''] !== undefined)
    .map(([id, value]) => [id, SETUP_FIELDS[sourceKind(id)!]!.map(key => value.config[key] ?? '')]
  ).sort(([a], [b]) => String(a).localeCompare(String(b))))
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)

/**
 * Resolves the target repositories, the shared GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  /** A failure of the shared GitHub account or of the execution environment, which stops every Source. */
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  /** Setup problems that pause only one Source instance, such as a repository it cannot push to. */
  problems: Record<string, SetupProblem> = {}
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** The setup problem that pauses `id`, or the global one when it names that place. */
  problemFor(id: string): SetupProblem | undefined {
    return this.problems[id] ?? (this.feishuProblem?.place === id ? this.feishuProblem
      : this.problem?.place === id ? this.problem : undefined)
  }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    this.problems = {}
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and Feishu are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify one Source instance's account settings before saving, ignoring setup errors belonging to other Sources. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    const id = block.startsWith('source:') ? block.slice('source:'.length) : 'github'
    if (sourceKind(id) === 'feishu') {
      await resolveFeishuBot(machine, settings.sources[id]?.config, this.probe()).catch((error: unknown) => {
        if (!(error instanceof SetupError) || error.place === 'feishu') throw error
      })
      return
    }
    // Other Sources (including Voice) have no GitHub account to probe.
    if (sourceKind(id) !== 'github') return
    const config = settings.sources[id]?.config ?? {}
    // A further instance inherits the shared CLI when it names none; it may not introduce another account or CLI.
    const declared = typeof config.cli === 'string' && config.cli ? config.cli : undefined
    const cli = declared ?? this.resolved?.github.cli
    const checked = await resolveGithubInstance(machine, id, { ...config, ...cli ? { cli } : {} }, this.probe())
    if (this.resolved && id !== 'github' && (checked.github.cli !== this.resolved.github.cli || !sameName(checked.github.login, this.resolved.github.login))) {
      throw new SetupError('agentCliMismatch', {}, id)
    }
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before a repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    const deployment = await resolveDeployment(machine, settings.sources, probe)
    this.problems = deployment.problems ?? {}
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    await verifyEnvironment(resolved, context.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
