# Voice delivery contract for delegated work

Status: proposal for review (plan only; no code in this PR)

## Problem

The DSH Source returns a delegated Voice task's result as free-form `DshReply.text`. The reply schema carries `kind`, optional `ticketId`, and `context.purpose` (`answer`, `result`, `attention`, `status`, ...), but no structured deliverable. A task that opens a pull request has a URL in the text; a research or report task has only prose. There is no required artifact path, no verification list, and no explicit limitation. The Voice agent therefore cannot tell whether a file is expected, cannot verify it, and sometimes presents a result it cannot support. The handoff is unstable across tasks and workers.

This document defines the superagent side of the fix. The Voice-side trigger, file tiering, standard receipt, and gateway consumption are in the counterpart dsh-voice proposal.

## Proposal

### Result envelope

Add an optional `result` object to `DshReplySchema` (`src/sources/dsh-protocol.ts`) and to the reply model (`src/core/replies.ts`, `src/core/ports.ts`):

```json
{
  "kind": "answer | artifact | changes | attention | blocked",
  "summary": "1-3 sentences the user can understand",
  "artifacts": [{"path": "documents/example.md", "label": "report"}],
  "changes": [{"prUrl": "https://github.com/.../pull/123", "state": "open | merged"}],
  "verification": ["checks actually run"],
  "limitations": ["what was not done or verified"],
  "nextAction": "one decision the user must make"
}
```

`kind` and `summary` are required. `kind=artifact` requires at least one artifact; `kind=changes` requires at least one change with a PR URL and state; `kind=answer` requires no artifacts and the summary is the deliverable; `kind=attention` requires `nextAction`; `kind=blocked` requires `limitations`. Artifact paths are relative to the Voice workspace; absolute paths and `..` are rejected.

### Artifact policy

- Research, analysis, and reports default to `documents/<title>-<date>.md` in the Voice workspace, or `notebook/notes/` for internal notes.
- File processing writes to `documents/` or a user-specified directory.
- Code and configuration changes use `kind=changes` with the pull-request URL and state; the agent never merges on the user's behalf.
- No artifact is `kind=answer` with `artifacts: []` and an explicit "no file artifact"; it is never omitted.
- The worker verifies existence, non-empty content, and key content before sending; the checks go in `verification`. A missing expected artifact is `blocked`/`limitations`, never "done".

### Reply path

- `src/core/replies.ts` and `src/core/ports.ts`: carry the envelope with `purpose=result`.
- `send_reply` (`src/app/tools/main.ts`): accept optional `artifacts`, `verification`, `limitations`, and `next_action` for `purpose=result` (or a single `result` object); reject an artifact envelope without a path and a changes envelope without a PR URL/state.
- `src/sources/dsh.ts`: include the envelope in the outgoing `DshReply`.
- `src/sources/dsh-protocol.ts`: validate it. The field stays optional for backward compatibility.
- The worker report and reply builder must supply the fields; the builder must not invent artifacts.

### Voice-side consumption (counterpart)

The dsh-voice gateway inserts a hidden context notice with the envelope before the result, validates artifact paths against the managed Voice workspace, marks missing paths, and the Voice agent uses the summary, artifacts, changes, limitations, and next action. No worker, ticket, queue, or background terms are spoken.

### Backward compatibility

`result` is optional. Old replies without it render as `kind=answer`; there is no protocol version bump. The text field remains the human-readable rendering; the envelope is authoritative for the Voice side.

### Tests

- `DshReplySchema` fixtures: artifact, answer, changes, attention, blocked, missing artifact path, and an old reply without `result`.
- Reply model and `send_reply` tests: required fields, artifact path validation, and no invented artifacts.
- The dsh-voice counterpart: gateway notice, path validation, Voice prompt, and missing-artifact handling.
- A cross-repository fixture pair: the same envelope validated by both sides.

## Alternatives considered

**Keep free-form text.** Rejected: it is the source of the unstable handoff; the Voice agent cannot verify the deliverable.

**A Markdown-only template.** Considered; simpler, but not machine-checkable. Keep it only as the backward-compatible rendering of the envelope.

**Require a pull request for every task.** Rejected: research, reports, and answers do not have pull requests; the contract must cover non-PR artifacts and answers.

**A separate status endpoint instead.** That solves status, not artifact delivery; status remains a separate concern.

## Acceptance criteria

- The five envelope kinds plus the missing-artifact and legacy fixtures pass.
- `send_reply` rejects an artifact envelope without a path and a changes envelope without a PR URL/state.
- The dsh-voice counterpart consumes the envelope and verifies artifact paths.
- No added model call; the result payload stays within the existing size limits.

## Risks

- Cross-repository: schema and reply builder must change together; the optional field keeps old replies working.
- Artifact paths are only as reliable as the worker's verification; the Voice side re-checks and reports missing paths.
- The envelope adds tokens to the result; negligible.
- The contract is public: `result` carries workspace-relative artifact paths only, never private user content.

## Cross-repository plan

- dsh-voice: trigger, file tiering, standard receipt, gateway/schema, Voice prompt, tests.
- superagent: this contract, reply builder, `send_reply`, worker report fields, tests.
- Both sides use the same envelope version; the dsh-voice proposal is the counterpart.
