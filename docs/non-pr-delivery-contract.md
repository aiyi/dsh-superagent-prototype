# Non-PR delivery contract

**Status: proposal for review. This document describes no implemented behavior and changes no runtime code.** It is the superagent half of a two-repository proposal; the Voice Host half is [aiyi/dsh-voice#3](https://github.com/aiyi/dsh-voice/pull/3).

A result that opens no pull request should carry the same facts a pull request already carries: what was delivered, how it was verified, and what is still open.

## 1 The problem

A `DshReply` has a free-text `text`, a `kind` (`acknowledgement`, `reply`, `notice`) and an optional `context.purpose`, `context.ticketId` and `context.ticketTitle` ([dsh-protocol.ts](../src/sources/dsh-protocol.ts)). A pull-request Ticket also reports `pr_number`, which binds the PR and is visible to the main Session through the relay. A Ticket that opens no pull request — a workspace-only Ticket, research, a report, a written answer — has only prose. The worker report has the same shape: `state`, `summary`, `question`, `askedBy` and `answers` ([assignments.ts](../src/core/assignments.ts)), and `Assignment.report` stores only `state`, `summary` and `at` ([model.ts](../src/core/model.ts)).

The Voice Host therefore cannot tell whether a file should exist, and the Superagent cannot be held to a shape. The 0738 case is the concrete failure: the result said a report was in `documents/`, the directory was empty, and the user had to point it out before the worker appended it. The same free text can be a conclusion, a claim that a file was written, or only an analysis in the conversation. A prompt-only convention does not fix it: the worker can omit the path, or write a path that does not exist, and nothing checks either.

## 2 The contract

### 2.1 The envelope

A `purpose=result` reply carries an optional `result`:

```ts
interface DshResult {
  kind: 'answer' | 'artifact' | 'changes' | 'attention' | 'blocked'
  summary: string
  artifacts?: { path: string; label?: string }[]
  changes?: { prUrl: string; state: 'open' | 'merged' }[]
  verification?: string[]
  limitations?: string[]
  nextAction?: string
}
```

`text` stays: it is the human-readable message the main Session writes today. The Voice Host reads the envelope as the contract and uses `text` to cross-check. A reply without `result` is treated as an answer, so old replies and old workers keep working; no protocol version changes.

### 2.2 Constraints

- `kind` and `summary` are required.
- `kind=artifact` needs at least one `artifacts` entry; `path` is relative to the delivery directory (the bound Voice workspace for a DSH Ticket, otherwise the Ticket workspace), with no absolute path and no `..`. The worker creates the file before reporting it.
- `kind=changes` needs at least one `changes` entry; `prUrl` and `state` are reported as they are, and the agent never merges for the user.
- `kind=answer` has an empty `artifacts` list and a `summary` that is itself the deliverable; "the report is placed" without a path is not an answer.
- `kind=attention` puts the question in `nextAction`; `kind=blocked` states the obstacle and the needed condition in `limitations`.
- When there is no file, `artifacts` is an empty list rather than an omitted field. When nothing is outstanding, `limitations` is an empty list.

### 2.3 Who fills it

The superagent reply builder fills the envelope from the worker report, not the main Session from prose. The report supplies `artifacts`, `verification` and `limitations`; the ticket supplies the bound PR for `changes`; `kind` is derived from the report state, the PR and the artifacts. The main Session's `text` remains the human version. This keeps the structured facts in the worker's evidence instead of inviting the router to restate or invent them.

## 3 Superagent side

### 3.1 Worker report

`WorkerReport` gains `delivery`; `Assignment.report` stores it:

```ts
interface DeliveryArtifact { path: string; label?: string }
interface Delivery { artifacts: DeliveryArtifact[]; verification: string[]; limitations: string[] }
interface WorkerReport { /* state, summary, question, askedBy, answers */ delivery?: Delivery }
```

`orchestrator_report` ([executor.ts](../src/app/tools/executor.ts)) accepts `delivery` with three required arrays: `artifacts` (relative path and optional label), `verification` (checks actually run) and `limitations` (what was not done or verified). A `ready` report that opens no pull request must carry it; the tool refuses the report otherwise. A Ticket that follows a PR is exempt from that refusal, because its ready follow-up report describes the PR rather than a non-PR delivery. A path with an absolute prefix, a drive letter or a `..` segment is refused.

`reportRelay` and `resultRelay` ([notices.ts](../src/app/notices.ts)) carry the delivery facts to the main Session, and `orchestrator_read ticket/<id>/result` and `ticket/<id>/report/<id>` ([resources.ts](../src/app/resources.ts)) render them as artifact, verification and limitation lines. The built-in `work` and `dispatch` prompt sections ([work.md](../prompts/work.md), [dispatch.md](../prompts/dispatch.md)) state the rule. The rule is deliberately not in `prompts/team/delivery.md`: a deployment may have a saved delivery override, and the contract must reach its sessions either way.

A named artifact that is absent or empty is not a ready result. The prompt says to report blocked and name what is missing; a host-side existence check is a possible follow-up, not part of this proposal.

### 3.2 Reply builder

The DSH channel ([dsh.ts](../src/sources/dsh.ts)) attaches `result` to the queued result reply:

- `summary` is the latest worker report's summary, bounded as the relay bounds it.
- `artifacts`, `verification` and `limitations` come from `report.delivery`.
- `changes` comes from the PR the Ticket follows, with its URL and open/merged state.
- `kind` is `changes` when a PR is bound, `artifact` when the delivery has an artifact, `answer` when it has none, and `blocked` when the report is blocked or failed.
- `attention` is reserved for a reply that asks the person to decide something. A ready report cannot carry an open question today, so the current attention reply keeps its own purpose; the kind is kept in the schema so the Voice side can rely on one shape if that changes.

The envelope is frozen on the outbound message when it is queued, like the rest of the outbox message, so a retry sends the same result. The builder never reads a later report to reconstruct it.

### 3.3 Protocol schema and vendoring

`DshReplySchema` in [dsh-protocol.ts](../src/sources/dsh-protocol.ts) gains an optional `result` with a strict schema. The Voice Host does not edit its copy by hand: in that repository, `plugins/dsh-session-gateway/vendor/dsh-protocol.mjs` is generated from this file by `plugins/dsh-session-gateway/scripts/update-superagent-protocol.mjs`, which checks the pinned revision and the source hash and regenerates the module and its declarations. The Voice Host bumps the pin in [provenance.json](https://github.com/aiyi/dsh-voice/blob/main/plugins/dsh-session-gateway/vendor/provenance.json) only after the superagent schema commit exists.

## 4 Where artifacts live (decision requested)

The Voice Host's contract expects `artifacts.path` to be relative to the user's Voice workspace, and its gateway checks that the file exists there. The superagent Ticket workspace is separate: it lives under the deployment state directory (`~/.dsh-superagent/state/superagent/work/<ticket>` by default), and a worker neither knows nor writes to the Voice workspace. This is the one open decision that must settle before the contract is implemented:

- **A (recommended).** Add an optional `deliveryWorkspace` to the DSH Source configuration, one per binding, pointing at the Voice user's workspace. The ticket execution environment publishes it as `DSH_SUPERAGENT_DELIVERY_DIR`; the worker writes artifacts there and reports relative paths; the Voice gateway validates the same root. This adds configuration and an environment variable, not a handoff change. The cost is that the path is configured on both sides and setup should check they agree.
- **B.** Put the workspace in `DshHandoff`; the Voice Host already knows it. This removes the duplicate configuration but changes the handoff protocol, so both sides must update together.
- **C.** Keep artifacts in the superagent Ticket workspace and return absolute paths. The gateway cannot verify them and the user may not be able to open them; not recommended.
- **D.** Put file content in the envelope. This works only for small files and makes replies large.

Until A, B or a shared directory is chosen, a worker can report a path but the Voice Host cannot verify it; the contract's "verified artifact" claim would be incomplete. The report and envelope paths are therefore defined relative to the delivery directory — `DSH_SUPERAGENT_DELIVERY_DIR` when set, otherwise the Ticket workspace. For Feishu-origin Tickets there is no Voice workspace; the Ticket workspace is the delivery directory and the result names the path, while uploading a file to Feishu is a separate capability.

## 5 Compatibility and rollout

`DshReplySchema` is strict. A Voice Host that does not know `result` rejects the whole reply, so the deployment order matters:

1. Land the superagent schema, the builder, the worker report and prompt changes, and the regenerated Voice vendor, with the gateway accepting an optional `result`.
2. Deploy the Voice Host, so it accepts `result` before any superagent sends one.
3. Deploy the superagent, which starts emitting `result`.

Old replies without `result` fall back to an answer, and no protocol version changes. Rolling the superagent out first would lose non-PR results until the Voice Host catches up.

## 6 Tests and acceptance

- `tests/tools.spec.ts`: a ready report without a PR is refused without `delivery`; a ready report that follows a PR is accepted without it; absolute, drive-letter and `..` artifact paths are refused; the relay and `ticket/<id>/result` include the three delivery sections.
- `tests/dsh-source.spec.ts`: the five envelope kinds; `changes` carries the bound PR URL and state; a reply without `result` still sends; the envelope is frozen on the queued message.
- `tests/prompts.spec.ts` or `tests/cards.spec.ts`: the built-in `work` and `dispatch` text carries the rule even when the team's delivery section is overridden.
- The Voice repository's gateway tests: a valid envelope before a result, a missing artifact marked `missing`, an old reply without `result` treated as an answer, and the persona rule present.
- Behavior eval: a non-PR research task produces `kind=artifact` and a path that the Voice agent verifies; a quick answer produces `kind=answer` with no files; a code change produces `kind=changes` with a PR; an impossible task produces `kind=blocked` with limitations.

Acceptance means a non-PR result names its artifact or says there is none, states what was actually checked, and states what remains; the Voice agent can verify the path before speaking and never claims completion for a missing artifact.

## 7 Alternatives considered

- **A convention in `text`.** The current state. It is not checkable, and a worker can omit or fabricate the path.
- **A separate status call.** It answers "is it done" but not "what was delivered and verified", and needs another protocol extension.
- **A protocol version bump.** `result` is optional and old replies can fall back to an answer, so a new version would strand old Hosts for no gain.
- **Extracting the facts from free text in the orchestrator.** The worker report is the evidence; letting the router extract and rephrase loses the guarantee and invites invented detail.

## 8 Risks

- **Artifact location.** The workspace decision above is unresolved; without it the "verified path" half of the contract is not real.
- **Deploy order.** Strict schemas make a superagent-first deployment lose results; the rollout order is part of the design, not an operational detail.
- **Prompt compliance.** A model can still forget the fields; the `orchestrator_report` refusal and the gateway's `missing` mark are the guards.
- **Small answers become heavier.** Every non-PR result needs three arrays; empty arrays are allowed so an honest answer stays light, and the prompt should not invite invented checks.
- **Duplicate text and envelope.** They can disagree; the envelope is authoritative and `text` is only cross-checked, which the tests must cover.
- **Security boundary.** Writing into the Voice workspace widens what the worker can touch; the delivery directory and relative-path validation keep it to the intended root, but the operator should treat it as a real permission change.
- **Latency.** The change adds a notice and parsing, not a model call; it should stay within the current Voice latency envelope.

## 9 Related

- The Voice Host half: [aiyi/dsh-voice#3](https://github.com/aiyi/dsh-voice/pull/3).
- [003 Execution](003-execution.md) describes how a ready report ends a Ticket with no pull request.
- [Repository-less Tickets](repository-less-tickets.md) describes the workspace-only Ticket this contract must serve first.
- [004 Prompts](004-prompts.md) describes the built-in and team sections the prompt changes touch.
- [007 Architecture](007-architecture.md) lists the modules and tests named above.
