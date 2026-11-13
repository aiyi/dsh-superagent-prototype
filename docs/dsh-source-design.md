# DSH Voice Source

The Superagent side is implemented as an optional `dsh-superagent/dsh-source`
plugin. The independent Voice Host peer still needs implementation and joint
verification. No production installation or real-audio verification is implied.

The shared architecture and rationale remain in
[Voice channel 与 superagent 的跨进程集成](https://github.com/aiyi/dsh-voice/blob/main/.agents/notes/proposed/architecture/2026-11-10-superagent-voice-delegation.md).
This file documents the implemented Superagent boundary; it does not maintain a
second architecture proposal. The original in-process, frontend-maintained
virtual-Thread design is superseded by the shared proposal.

## Composition and configuration

The bundle includes a disabled-by-default `dsh-superagent-dsh` entry. Enable it
only on the Superagent Host. It uses that Host's loopback Web server and its own
Source instance settings, not a shared Voice database or remote human-prompt RPC.
A default/unconfigured Source receives nothing.

Each Source instance is one explicit Voice binding. Configure its `source:<id>`
settings block (`dsh`, or another instance named `dsh-<name>`):

| Field | Meaning |
| --- | --- |
| bindingId | Stable Voice user/workspace binding, independent of daily Session IDs |
| principalId | Trusted local principal represented by this authenticated ingress |
| voiceUrl | Fixed Voice origin, exactly `http://127.0.0.1:<port>`; no remote host, credentials, path or redirects |
| incomingTokenFile | Absolute file containing the credential Voice uses to call Superagent |
| voiceTokenFile | Absolute file containing the credential Superagent uses to call Voice |
| sharedSources | Explicit `{source: <instance-id>}` grants to continue work originating on other Sources; default empty |
| timeoutMs | Peer request deadline; default 5000 ms |
| maxReaders | Concurrent remote history requests per Voice origin; default 1, maximum 4; excess requests fail instead of queuing |

Also add principalId to the instance's Policy `allowed` list. A valid transport
credential alone is not permission to admit work. The Source rechecks binding
and principal at routing, original reading and reply dispatch boundaries.
`sharedSources` grants the whole named Source's work, so use dedicated Source
instances where isolation is required; same-name accounts imply no grant.

Use separate, randomly generated bearer credentials in owner-private files
(mode 0600, containing directory 0700). On the Mac mini these belong under
`/Users/aiyi/Library/Application Support/DSH Voice/host/secrets/`, outside either
checkout and user workspace. Settings store file paths, not token values. Do not
put tokens in tools, prompts, URLs, examples or model-readable resources.

## Contract ownership

The executable version-1 contract is exported as `dsh-superagent/dsh-protocol`:
[schemas and types](../src/sources/dsh-protocol.ts). The two peers must pin a
compatible package/revision. The exported Zod schemas, rather than copied
interfaces in each repository, define accepted handoffs, dialogue pages,
history requests/responses, outbound replies and durable delivery receipts.
All envelopes reject unknown fields and unsupported versions.

## Voice to Superagent

`POST /voice-bridge/v1/sources/<source-id>/handoffs`
uses `Authorization: Bearer <incoming credential>` and a `DshHandoffSchema` body.
The body includes version, requestId, bindingId, action, optional hint, the exact
human anchor and a frozen snapshot with its bounded initial dialogue page.
The initial page must contain the unchanged human anchor. Original physical
Session/message/event references survive daily rotation.

Received requests have one independent Source Thread each. Only the anchor
becomes a Trigger; earlier dialogue is read-only context, not additional work.
Actor and Channel are derived from the authenticated configured binding.
Action/hint remain model suggestions and never replace Trigger.text.

A 200 response is `{version, requestId, bindingId, triggerId, status: "received"}`.
It means the request and Trigger committed atomically, not accepted or running.
The same ID and frozen payload returns the same receipt. Changed payloads or
another request ID for the same original message produce 409. Malformed data
returns 400, unauthorized credentials 401, a disallowed binding/principal or
Source 403, oversize input 413, and temporary service/storage problems 503.
Bodies and peer responses are limited to 256 KiB.

`GET /voice-bridge/v1/sources/<source-id>/handoffs/<request-id>`
uses the same authentication and returns the persisted receipt, including while
an otherwise unchanged Source is disabled. Unknown IDs return 404 with
`status: "unknown"`. Unknown is not permission to blindly replay old work.
The Voice sender must reconcile uncertain requests and quarantine never-confirmed
outage backlog, especially when later stops/corrections exist. This Source has
no automatic historical-replay worker.

## Original dialogue resources

Both the main Session and authorized workers use existing `orchestrator_read`:

| Resource | Result |
| --- | --- |
| dsh/<trigger-id>/message | Original human anchor |
| dsh/<trigger-id>/context | Persisted initial dialogue window; no Voice HTTP request |
| returned message read reference | Exact message in that authorized snapshot, local when already retained |
| returned next_resource | Older dialogue page fetched from the fixed Voice origin |
| dsh/<trigger-id>/tickets | Main Session only: indexed binding/explicitly shared-source candidates, including ended work |

Follow next_offset for text/list pagination and next_resource for history
continuation. Ticket candidate lookups use indexed source/principal metadata
and bounded SQL pages, not full Ticket JSON loading. Router selection still
uses original dialogue; the only running Ticket is never an implicit target.
Workers cannot read other Tickets' dialogue or the main Session's candidate list.

Only `human/user`, `assistant/voice-agent`, and
`notification/dsh-superagent` final dialogue records are accepted. Tool calls,
results, arguments, reasoning, system/developer instructions, runtime notices
and streaming blocks do not satisfy the strict dialogue schema. Voice must
classify these from native provenance before exporting them; role=user alone
is insufficient. Human quotations of tool text remain human dialogue. The
same validation applies to initial pages, remote pages and message reads.

For additional context, Superagent sends `DshHistoryRequestSchema` to the fixed
Voice endpoint `POST /voice-bridge/v1/history`, using the outgoing credential.
The response is `DshHistorySchema` with the identical requestId and snapshotId,
a bounded page, explicit missing references and an opaque continuation when
incomplete. A message read must return that exact reference or mark it missing.
No Source code asks the Voice agent to execute a tool or model turn. The Voice
peer must use nonactivating, bounded history queries and short persistence
access; it must not scan lifetime history or hold up foreground turns. CPU/I/O
contention and real Voice latency remain joint measurements, not guarantees
established by HTTP tests.

## Routing and recovery

Explicit requests use the existing main Session `orchestrator_route`, not a
second Router or proactive Eval. Source context points to the dialogue reader
and candidate list. The fixed `dsh-superagent-dsh` Skill explains provenance,
continuation, target ambiguity and result presentation. Changing task state
never rewrites system-prompt sections.

The existing Engine can attach to an ended Ticket under a valid Mandate and
cannot resume a human-stopped one. The DSH command adapter additionally records
routing receipts in the same transaction as Engine changes. Retrying an attach
after its work completed returns the old operation result, rather than creating
a new Assignment. A worker handback or explicit re-evaluation permits selecting another target;
a transient new Eval ID alone does not permit replaying the same applied operation. A new user message has a new Trigger.

A clarification or refusal before admission uses purpose=answer and the original
human trigger_id, without creating a Ticket. purpose=status is restricted to a
recorded human stop or failed/blocked report. Existing answer, verified-result
and stored-attention rules remain enforced. Ordinary progress stays internal.

## Superagent to Voice

Existing Outbox persists and retries the Source's Channel writes. The Channel
POSTs a `DshReplySchema` envelope to the fixed Voice endpoint
`/voice-bridge/v1/replies`, using the outgoing credential. It includes stable
replyId, bindingId, requestId, text, kind and frozen context (purpose, original
Trigger, attention ID and Ticket title where applicable).

Context is frozen when queued, never guessed from a later mutable Ticket.
Acknowledgements are presentation metadata: Voice must not automatically speak
a second handoff/worker receipt. Present useful conclusions, scope, failures and
concrete questions naturally; no worker identity preamble is required.
When continuing explicitly shared-source work, workers identify the human
follow-up they answer with reply_to_trigger_id; the main Session answers that
message's Voice Channel. Ordinary origin-result routing remains unchanged.

The Voice peer must authenticate and validate the envelope, resolve the binding
to today's root on first receipt, freeze that destination/message ID and payload,
and durably deduplicate before returning
`{version: 1, replyId, status: "received"}`. A retry must acknowledge the same
accepted reply without injecting it again, including across midnight or after
its presentation was canceled. Only authoritative permanent removal returns
`status: "gone"`; timeout, missing service and persistence failure are retryable.
Sink acceptance is not evidence of audio playback or that a human heard it.

## Verification boundary

[DSH Source tests](../tests/dsh-source.spec.ts) run a configured Runtime with
separate loopback HTTP test endpoints, fake native agents and durable SQLite.
They exercise authentication, dialogue filtering, local/remote reads, limits,
routing/ended continuation, target isolation, receipt rollback/reopen and
lost-reply-ack retries. They do not run real ASR/TTS, the Voice Host peer,
production LaunchAgents or model-based routing accuracy. Full joint acceptance
remains in the shared architecture proposal.
