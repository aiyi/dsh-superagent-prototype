# Voice delivery contract for delegated work

Status: implemented. Version 1 covers the result envelope and the delivery directory layout below.

## Problem

The DSH Source returns a delegated Voice task's result as free-form `DshReply.text`. The reply schema carries `kind`, optional `ticketId`, and `context.purpose` (`answer`, `result`, `attention`, `status`, ...), but no structured deliverable. A task that opens a pull request has a URL in the text; a research or report task has only prose. There is no required artifact path, no verification list, and no explicit limitation. The Voice agent therefore cannot tell whether a file is expected, cannot verify it, and sometimes presents a result it cannot support. The handoff is unstable across tasks and workers.

The artifact side had the same fault. The agent wrote files straight into the Voice user workspace, in whatever directory it chose, often `documents/` or `notebook/notes/`. Delivered files therefore mixed with the Voice assistant's own notes; the user could not tell which files belonged to one task, and a revision had no stable place to go back to. The contract below fixes both: a structured envelope, and one delivery directory per Ticket, separate from the working area and from the Voice assistant's notes.

This document defines the Superagent side of the contract. The dsh-voice counterpart carries the trigger, result consumption, and artifact verification in the Voice Host.

## Delivery directory layout

### Location and naming

A Voice Ticket's finished deliverables live in exactly one directory:

```
<voice-workspace>/superagent/<ticket-name>/
```

- `<voice-workspace>` is the DSH Source instance's `deliveryWorkspace`, an absolute path. It must
  be the Voice user workspace that the binding owns, because the Voice Host resolves result artifact
  paths under that workspace.
- `superagent/` is the one Superagent delivery area in that workspace. It holds nothing else.
- `<ticket-name>` is `DSH_SUPERAGENT_NAME`: a short English slug plus the Ticket's 12-character ID,
  such as `fix-plan-color-0123456789ab`. It is fixed when the Ticket is accepted, stable for its
  whole life, and unique across Tickets.
- A Ticket writes only its own subdirectory. It never writes into another Ticket's directory.
- `notebook/` (including `notebook/notes/`) and `documents/` are the Voice assistant's own areas; the
  Voice assistant may read and write them. `books/`, `stock/` and the workspace top level are the
  user's. Superagent must not write anywhere in the workspace outside its own delivery
  subdirectory, and `notebook/` is never a Superagent destination.
- The Voice assistant does not need to open files under `superagent/`. Its job is to report the
  artifact paths and list to the user; formats such as PPTX, DOCX and PDF cannot be read directly and
  are for the user to open. Reading a text artifact is optional when that helps answer a question,
  but no deliverable has to be read to be delivered. The `superagent/` directory belongs to
  Superagent.
- The worker creates the directory when it first writes a deliverable. A Ticket that produces no
  file leaves no directory. Empty files and placeholder files are not deliverables.

### Deliverables and working files

- **Deliverables** are the finished files the person is meant to receive: a report, document,
  presentation, spreadsheet, PDF, image, data file, or a finished script. They go directly in the
  Ticket's delivery directory, in their own format and under a meaningful filename. There are no
  per-type subdirectories: one Ticket, one directory, so a later revision finds everything together.
- **Working files** are drafts, intermediate renders, logs, caches, downloaded source material and
  the scripts used to produce a deliverable. They stay in the Ticket's CWD (`DSH_SUPERAGENT_DIR`).
  They are never copied into the delivery directory, and never into the Voice workspace.
- A filename that already exists is not overwritten; use a distinct filename instead. A Ticket's
  directory is the record of what that Ticket delivered.

### Report and result paths

- The execution environment names the Ticket's directory as `DSH_SUPERAGENT_DELIVERY_DIR`. Report
  `delivery.artifacts[].path` values are relative to it, for example `summary.md`.
- The result envelope keeps paths relative to the Voice workspace. The Superagent prefixes each
  reported path with `superagent/<ticket-name>/` before sending, for example
  `superagent/fix-plan-color-0123456789ab/summary.md`, so the Voice Host can resolve and verify it
  inside the bound workspace.
- When `deliveryWorkspace` is empty there is no Voice workspace anchor: the delivery directory is
  the Ticket directory, and the result envelope cannot point at workspace files. A binding that is
  meant to return files must configure it.

### Revisions and lifetime

- A revision made within the same Ticket edits or replaces files in that Ticket's delivery
  directory.
- A follow-up Ticket is a new Ticket with a new directory. It copies the deliverable it revises into
  its own directory before changing it, and never edits an earlier Ticket's directory; the earlier
  deliverable stays the record of that Ticket. Its directory is therefore a complete record of its
  own delivery.
- The delivery directory outlives the Ticket. The Ticket's CWD may be discarded without losing a
  deliverable.
- Files written before this contract stay where they are; moving them is a separate, explicit
  migration, never part of a delivery.

## Result envelope

The optional `result` object on `DshReplySchema` (`src/sources/dsh-protocol.ts`) and on the reply
model (`src/core/replies.ts`, `src/core/ports.ts`):

```json
{
  "kind": "answer | artifact | changes | attention | blocked",
  "summary": "1-3 sentences the user can understand",
  "artifacts": [{"path": "superagent/fix-plan-color-0123456789ab/summary.md", "label": "report"}],
  "changes": [{"prUrl": "https://github.com/.../pull/123", "state": "open | merged"}],
  "verification": ["checks actually run"],
  "limitations": ["what was not done or verified"],
  "nextAction": "one decision the user must make"
}
```

`kind` and `summary` are required. `kind=artifact` requires at least one artifact; `kind=changes`
requires at least one change with a PR URL and state; `kind=answer` requires no artifacts and the
summary is the deliverable; `kind=attention` requires `nextAction`; `kind=blocked` requires
`limitations`. Artifact paths are relative to the Voice workspace; absolute paths and `..` are
rejected.

## Artifact policy

- Only deliverables enter the delivery directory; working files stay in the Ticket directory.
- Research, analysis and reports are deliverables in the Ticket's delivery directory, whatever
  their format. Notes the Voice assistant keeps for the user are not Superagent deliverables and are
  never written by Superagent.
- File processing writes its finished output to the Ticket's delivery directory; its intermediates
  stay in the Ticket directory.
- Code and configuration changes use `kind=changes` with the pull-request URL and state; the agent
  never merges on the user's behalf.
- A result with no file artifact reports `kind=answer` with no artifacts (or, for a ready Report,
  an empty artifact list); the fact is stated, never omitted.
- The worker verifies existence, non-empty content and key content before reporting; the checks go
  in `verification`. A missing expected artifact is `blocked`/`limitations`, never "done".

## Reply path

- `src/core/replies.ts` and `src/core/ports.ts`: carry the envelope with `purpose=result`.
- `orchestrator_reply` (`src/app/tools/main.ts`): builds the envelope from the worker's latest report
  and the bound pull requests; it must not invent artifacts. A Voice Ticket's report paths are
  prefixed with `superagent/<ticket-name>/` here, because the report paths are relative to
  `DSH_SUPERAGENT_DELIVERY_DIR` while the envelope is relative to the Voice workspace.
- `src/sources/dsh.ts`: includes the envelope in the outgoing `DshReply`.
- `src/sources/dsh-protocol.ts`: validates it. The field stays optional for backward compatibility.

## Voice-side consumption (counterpart)

The dsh-voice gateway inserts a hidden context notice with the envelope before the result, validates
artifact paths against the managed Voice workspace, marks missing paths, and the Voice agent uses the
summary, artifacts, changes, limitations, and next action. No worker, ticket, queue, or background
terms are spoken.

The `superagent/` directory belongs to Superagent. The Voice assistant reports the artifact paths and
list; it does not need to read the contents, and binary formats such as PPTX, DOCX and PDF cannot be
read directly. Reading a text artifact is optional when that helps answer a question; the user is
the one who opens the files. `notebook/` and `documents/` are the Voice assistant's own areas.

## Backward compatibility

`result` is optional. Old replies without it render as `kind=answer`; there is no protocol version
bump. The text field remains the human-readable rendering; the envelope is authoritative for the
Voice side.

## Tests

- `DshReplySchema` fixtures: artifact, answer, changes, attention, blocked, missing artifact path,
  and an old reply without `result`.
- Reply model and reply-tool tests: required fields, artifact path validation, and no invented
  artifacts.
- Delivery directory tests: `DSH_SUPERAGENT_DELIVERY_DIR` is
  `<deliveryWorkspace>/superagent/<ticket name>` for a Voice Ticket and empty for one from another
  Source; the result envelope prefixes reported paths with `superagent/<ticket name>/`.
- The dsh-voice counterpart: gateway notice, path validation, Voice prompt, missing-artifact
  handling, and reporting the artifact paths and list for deliverables it cannot read.
- A cross-repository fixture pair: the same envelope validated by both sides.

## Alternatives considered

**Keep free-form text.** Rejected: it is the source of the unstable handoff; the Voice agent cannot
verify the deliverable.

**Reuse `documents/` or `notebook/` as the delivery area.** Rejected: those are the user's and the
Voice assistant's areas; mixing delivered files there hides which files belong to one task and makes
`notebook/` ambiguous as the Voice assistant's own notes.

**Sort deliverables by type under `documents/`.** Rejected: one task's PPT, spreadsheet and document
would land in different places, and a revision could not find them together. One Ticket, one
directory.

**A separate status endpoint instead.** That solves status, not artifact delivery; status remains a
separate concern.

## Acceptance criteria

- The five envelope kinds plus the missing-artifact and legacy fixtures pass.
- A Voice Ticket's environment names `<deliveryWorkspace>/superagent/<ticket name>`, and its result
  envelope carries `superagent/<ticket name>/` artifact paths.
- `orchestrator_reply` rejects an artifact envelope without a path and a changes envelope without a
  PR URL/state.
- The dsh-voice counterpart consumes the envelope and verifies artifact paths.

## Risks

- Cross-repository: schema and reply builder must change together; the optional field keeps old
  replies working.
- Artifact paths are only as reliable as the worker's verification; the Voice side re-checks and
  reports missing paths.
- The delivery layout depends on `deliveryWorkspace` actually being the Voice user workspace. A
  misconfigured path writes outside the workspace and the Voice side marks every artifact missing.
- The envelope adds tokens to the result; negligible.
- The contract is public: `result` carries workspace-relative artifact paths only, never private
  user content.

## Cross-repository plan

- dsh-voice: trigger, file tiering, standard receipt, gateway/schema, Voice prompt, tests.
- superagent: this contract, the delivery directory in the execution environment, the envelope
  prefix, the worker report fields, tests.
- Both sides use the same envelope version; the dsh-voice side is the counterpart.
