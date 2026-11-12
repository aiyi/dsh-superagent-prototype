/** Pull request binding, lifecycle observation, and terminal IM notification helpers. */
import { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { githubPage, UserSchema } from './github-trigger.ts'

const PullSchema = z.looseObject({
  title: z.string().optional(), state: z.string(), html_url: z.string(), user: UserSchema,
  body: z.string().nullish(), created_at: z.string().optional(),
  merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), auto_merge: z.unknown().optional(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
})
export type Pull = z.infer<typeof PullSchema> & { number: number }
export const readPull = async (ctx: SourceContext, number: number, signal?: AbortSignal): Promise<Pull> =>
  ({ ...await ctx.commands.withSignal(signal).api(PullSchema, `pulls/${number}`), number })
/** A GitHub Issue or PR Thread key: `<source>:<number>`, where the number is numeric. */
export const pullThread = (thread: string): { source: string; number: number } | undefined => {
  const at = thread.indexOf(':')
  if (at <= 0) return undefined
  const number = Number(thread.slice(at + 1))
  return Number.isInteger(number) && number > 0 ? { source: thread.slice(0, at), number } : undefined
}
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => pullThread(item.thread)?.number ?? [])
/** The PR numbers of `source`'s Threads a Ticket follows, which is how a Source instance addresses its own pull requests. */
export const pullsOfSource = (ticket: Pick<Ticket, 'follows'>, source: string, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => {
    const parsed = pullThread(item.thread)
    return parsed?.source === source ? [parsed.number] : []
  })
export const pullOf = (ticket: Pick<Ticket, 'follows'>): number | undefined => pullsOf(ticket, true).at(-1) ?? pullsOf(ticket).at(-1)
/** True when the PR was opened by the agent account from a branch in `repository` (not a fork). */
export const agentPull = (pr: { user: { login: string }; head?: { repo?: { full_name: string } | null } | null },
  deployment: Pick<Deployment, 'github'>, repository: string): boolean =>
  sameName(pr.user.login, deployment.github.login) && sameName(pr.head?.repo?.full_name ?? '', repository)
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }

/**
 * Validates and binds an open PR to a ticket when the PR is either the ticket's origin PR or an agent-authored PR on the ticket's branch, enforcing that one PR binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the PR is bound or when the PR is not open (which is not an error).
 */
export function claimPull(ctx: SourceContext, ticketId: string, pr: Pull): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const source = ctx.id, repository = ctx.commands.repository
  const trigger = ctx.triggers.get(ticket.origin.triggerId)
  const started = trigger?.source === source && trigger.meta.isPr === true && trigger.meta.number === pr.number
  const opened = agentPull(pr, ctx.deployment, repository) && ticketBranch(ticket, pr.head.ref)
  if (!started && !opened) {
    const { login } = ctx.deployment.github
    return `PR does not belong to this ticket: use the source PR or a PR by ${login} in ${repository} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
  }
  const owner = ctx.tickets.open().find(item => pullsOfSource(item, source, true).includes(pr.number))
  if (owner && owner.id !== ticketId) return 'PR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === `${source}:${pr.number}`)
  if (pr.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, pr, opened)
  return undefined
}
/**
 * Reconciles a polled PR's open/merged/closed state and auto-merge fact with any bound or branch-matching ticket.
 * An open agent PR auto-binds to the single open ticket on its branch unless that ticket already follows another open PR
 * (which only the Executor's report changes).
 * @returns whether the PR has ended.
 */
export async function observePull(ctx: SourceContext, pr: Pull): Promise<boolean> {
  const ended = pr.state === 'closed' || !!pr.merged
  if (ended) closePull(ctx, pr)
  else {
    const candidates = agentPull(pr, ctx.deployment, ctx.commands.repository) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, pr.head.ref)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // A PR the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === `${ctx.id}:${pr.number}` && item.closed)
    if (ticket && (reopened || pullsOfSource(ticket, ctx.id, true).every(number => number === pr.number))) claimPull(ctx, ticket.id, pr)
  }
  ctx.threads.describe(`${ctx.id}:${pr.number}`, { facts: { autoMerge: !ended && pr.auto_merge != null ? AUTO_MERGE_ON : null } })
  return ended
}
function bind(ctx: SourceContext, ticketId: string, pr: Pull, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: ctx.id, id: String(pr.number) }, own)
    ctx.threads.patch(`${ctx.id}:${pr.number}`, { number: pr.number, isPr: true, url: pr.html_url, prAuthor: pr.user.login })
  })
}
/**
 * Reports a merged or closed PR once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the PR stays so a later human comment there resumes the ticket.
 */
function closePull(ctx: SourceContext, pr: Pull): void {
  if (!ctx.tickets.open().some(ticket => pullsOfSource(ticket, ctx.id, true).includes(pr.number))) return
  const at = pr.merged_at ?? pr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: ctx.id, id: String(pr.number) }, pr.merged ? 'merged' : 'closed', at)
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its PR (selecting the last-closed PR it
 * opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when it contains
 * Han characters and no kana, otherwise English.
 */
export function pullEndNotices(ticket: Ticket, request: string, repositoryOf: (source: string) => string | undefined): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && pullThread(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const parsed = pullThread(follow.thread)!
  const repository = repositoryOf(parsed.source) ?? repositoryOf('')
  if (!repository) return []
  const url = githubPage(repository, parsed.number, true)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[PR #${parsed.number}](${url}) 已合并。` : `[PR #${parsed.number}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[PR #${parsed.number}](${url}) has merged.` : `[PR #${parsed.number}](${url}) was closed without merging.`
  // GitHub timelines and linked issues already show the merge or closure, so GitHub channels are skipped.
  return ticket.channels.filter(channel => channel.source !== parsed.source).map(channel => ({
    id: key('pr-terminal', String(parsed.number), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
