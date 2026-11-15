/** Routes each Ticket to the backend that runs it: repository work and DSH Tickets to the DSH Executor, Hermes Tickets to ACP. */
import type { AssessmentOutcome, Assignment, Execution, Ticket } from '../core/index.ts'
import type { Settings } from '../policy.ts'
import type { DshExecutor } from './dsh.ts'
import type { HermesAcpExecutor } from './hermes.ts'

/**
 * The Runtime's Executor: it prepares every Ticket through the DSH Executor and sends a workspace-only Ticket to the configured
 * general-task backend. A Ticket's backend is fixed when it is accepted, so changing the setting never moves running work.
 */
export class TicketExecutor {
  constructor(private readonly dsh: DshExecutor, private readonly hermes: HermesAcpExecutor, private readonly settings: () => Settings) {}

  /** Prepares a new Ticket, marking it for the Hermes backend when the setting and its workspace-only scope choose it. */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    const prepared = this.dsh.prepare(ticket, outcome)
    if (outcome.workspaceOnly !== true || !prepared.execution || this.settings().executor.backend !== 'hermes') return prepared
    const execution: Execution = { ...prepared.execution, runtime: 'hermes' }
    return { ...prepared, execution }
  }

  /** Whether `ticket` runs in a Hermes ACP session. */
  static hermes(ticket: Ticket): boolean { return ticket.execution?.runtime === 'hermes' }

  start(ticket: Ticket, assignment: Assignment): void {
    if (TicketExecutor.hermes(ticket)) this.hermes.start(ticket, assignment)
    else this.dsh.start(ticket, assignment)
  }
  deliver(ticket: Ticket, assignment: Assignment): void {
    if (TicketExecutor.hermes(ticket)) this.hermes.deliver(ticket, assignment)
    else this.dsh.deliver(ticket, assignment)
  }
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    if (TicketExecutor.hermes(ticket)) this.hermes.stop(ticket, assignment, reason)
    else this.dsh.stop(ticket, assignment, reason)
  }

  /** Installs both backends' host event handlers. */
  install(): void { this.dsh.install(); this.hermes.install() }
  /** Reconciles both backends' Assignments after a restart. */
  resume(): void { this.dsh.resume(); this.hermes.resume() }
  /** Stops both backends' work; a failure in one still stops the other. */
  async shutdown(): Promise<void> { await Promise.allSettled([this.dsh.shutdown(), this.hermes.shutdown()]) }
  /** Releases both backends' in-process state. */
  dispose(): void { this.dsh.dispose(); this.hermes.dispose() }
  /** The number of open Tickets running in either backend. */
  activeCount(): number { return this.dsh.activeCount() + this.hermes.activeCount() }
}
