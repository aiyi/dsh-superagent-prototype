# 009 Hermes ACP backend

**Status: implemented.** Work unrelated to any repository can run in a session of a
local Hermes profile over the Agent Client Protocol (ACP) instead of a DSH Session.
Repository work is unaffected: it always runs in the DSH Executor. The backend is a
setting, chosen when a Ticket is accepted, so changing it never moves running work.

## 1 Why

A DSH Executor Session is stateless between Tickets: every Ticket starts a session
with its own history, and DSH has no cross-Ticket memory. Hermes keeps a profile-wide
learning loop — `MEMORY.md`/`USER.md`, `memory`, `skill_manage`, and a background
review — that suits general tasks ("summarize this", "write that document") better
than a code repository, where `AGENTS.md`, the code and git history already carry the
context.

The requirement was therefore not to replace the Executor but to add a second
execution runtime for workspace-only Tickets, switchable at runtime:

> 通用任务走 Hermes，仓库任务继续走 DSH；做成可配置切换，默认还是 DSH。

DSH remains the default. A deployment switches the general-task backend only after
the Hermes profile has been set up and tried.

## 2 Shape

```
Ticket (workspace-only, accepted with executor.backend = hermes)
  Execution.runtime = 'hermes'
        │
        ▼
TicketExecutor ── repository/DSH Ticket ──▶ DshExecutor (unchanged)
        └──────── Hermes Ticket ──────────▶ HermesAcpExecutor
                                                 │
                                                 ├─ AcpProcess: `hermes -p <profile> acp` (stdio JSON-RPC)
                                                 │      session/new  cwd = Ticket directory
                                                 │      session/resume  the stored session, after a restart
                                                 │      session/prompt  the worker prompt + assignment
                                                 │      session/cancel  a stop
                                                 │      permission requests  answered allow
                                                 │
                                                 └─ MCP bridge: http://127.0.0.1:<port>/hermes-bridge/v1/mcp?ticket=<id>
                                                        the same `orchestrator_*` tools a DSH worker has
                                                        orchestrator_report writes the same report contract
```

- **One ACP session per Ticket.** `session/new` receives the Ticket's directory as
  its `cwd`, so Hermes' file, shell and search tools start there. The session ID is
  stored in KV (`hermes-session:<ticket id>`) and resumed after a restart, so a
  follow-up on the same Ticket continues the same Hermes conversation.
- **The profile keeps identity.** Hermes reads its `SOUL.md`, memory, skills and
  session history from the profile home; those are profile-wide, not per Ticket. The
  Ticket directory is only the session's working directory, not a sandbox.
- **The delivery directory is a third place.** `DSH_SUPERAGENT_DELIVERY_DIR` is
  rendered into the worker prompt as before; finished deliverables go only there,
  working files stay in the Ticket directory, and `orchestrator_report` artifact
  paths are relative to it.
- **The same report contract.** The bridge builds the Executor Session tools from
  the Ticket (`executorTools`), so `orchestrator_ack`, `orchestrator_read`,
  `orchestrator_thread_*`, `orchestrator_trigger_handback` and `orchestrator_report`
  validate arguments and write reports exactly as they do for a DSH worker. A ready
  result with no pull request still needs `delivery`; a report relays to the Voice
  conversation through the same outbox path.
- **Turn facts.** The ACP client streams `session/update`; the executor turns the
  end of the last queued prompt into `Executors.turnEnded`, and, when no report came,
  a `waiting` report with the last streamed text, mirroring `DshExecutor`.

## 3 Permissions

The requirement was explicit: **the Hermes backend gets the same full permissions as
the DSH worker.**

- DSH workers run with `danger-full-access` (`Sessions.ensure`), so no human
  approves their commands or edits.
- The ACP client advertises no client-side file-system, terminal or elicitation
  capabilities: Hermes runs files and commands itself, on the operator's OS user, as
  it does for any ACP editor.
- On `session/new`/`session/resume` the executor sets the `dont_ask` edit mode, so
  workspace edits do not prompt. Any remaining `session/request_permission`
  (dangerous commands, sensitive paths) is answered with the widest allow option the
  agent offers (`allow_always`, else `allow_session`, else `allow_once`), and the
  decision is shown in the `hermes` health detail.
- Hermes' gateway profile must be enabled and have a model credential; that is
  deployment work (section 6), not a per-Ticket approval.

This is real full access, not a sandbox: a Hermes Ticket can do anything the
operator's user can. That matches DSH workers and must be treated the same way.

## 4 Settings

`executor` settings block:

| Field | Meaning |
| --- | --- |
| `backend` | `dsh` (default) or `hermes`; applies to workspace-only Tickets accepted from then on |
| `hermes.profile` | Local Hermes profile id, default `jesse`; its memory, skills and session history serve the Tickets |
| `hermes.command` | Command or absolute path that runs the Hermes CLI. Default `hermes`; use an absolute path when it is not on the Superagent process `PATH` |
| `hermes.turnTimeoutSeconds` | Longest single turn; `0` (default) means no timeout. A timed-out turn is cancelled and the Ticket reports failed |

The Executor runs `<command> -p <profile> acp` from the state directory. Changing
these fields needs no restart; the next launch uses them. A Ticket keeps the
`Execution.runtime` it was accepted with, even after the setting changes.

## 5 Data and lifecycle

- **KV:** `hermes-session:<ticket id>` names the ACP session. It is removed and the
  session closed through `session/close` when the Ticket ends.
- **Effects:** `hermes-launch` and `hermes-delivery` mirror `launch` and `delivery`
  for Hermes Tickets, so a crash between commit and launch retries the launch. The
  effect health entries appear in the overview.
- **Concurrency:** a Hermes turn holds a worker slot; new Hermes launches wait while
  `executor.maxWorkers` Hermes turns run. DSH and Hermes each count their own turns,
  so the aggregate can briefly exceed the limit by the number of running Hermes
  turns; lower `maxWorkers` if both backends are busy in one deployment.
- **Restart:** an interrupted Hermes Assignment is recovered like a DSH one
  (`assignmentInterrupted`, then a new Assignment), and the ACP session is resumed by
  ID. If Hermes no longer knows the session, a new one starts in the Ticket
  directory.
- **Health:** the `hermes` entry reports the connection, the last approval, or the
  error; `hermes-launch` and `hermes-delivery` report their queues.

## 6 Deployment

The profile has to exist and be runnable before the switch. On the Hermes host:

```sh
hermes profile list                 # the profile exists and its gateway is running
hermes -p <profile> acp --check     # the ACP adapter and its dependencies are installed
```

The profile needs a model credential (`hermes -p <profile> setup`, or its `.env`);
the ACP process is only a view of the profile gateway, so the gateway must serve the
profile (not `parked`). The Superagent host and the Hermes host are the same machine
in the current deployment; the MCP bridge is loopback-only.

Then in the Superagent **Execution** settings set *General-task backend* to
**Hermes ACP**, confirm the profile and command, and save. A new workspace-only
Ticket (no repository, no pull request) is then accepted with
`Execution.runtime = 'hermes'`.

Do not point `executor.backend` at Hermes before the ACP check passes: launches fail
and the Ticket reports failed.

## 7 Verification

- `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Unit: `tests/hermes-acp.spec.ts` (framing, sessions, permission answers, cancel,
  resume), `tests/hermes-executor.spec.ts` (launch, prompt content, delivery,
  turn-end report, stop, resume), `tests/hermes-bridge.spec.ts` (token, auth, tool
  discovery and calls, ticket scoping).
- Manual: set the backend, accept a workspace-only Ticket, and confirm the Ticket
  shows a `hermes` health detail, the MCP tools are listed in the Hermes session, a
  `ready` report with `delivery` reaches the Voice conversation, and the delivery
  directory contains the reported files.

## 8 Limits

- ACP is versioned but still evolving; the client speaks protocol v1 and the Hermes
  SDK's unstable extensions are not used beyond `session/resume` and `session/close`.
- Profile memory and skills are shared by every Hermes Ticket, by design; sensitive
  content can reach another Ticket's prompt. Use a separate profile if that matters.
- Background shell jobs and subagents are Hermes' own; the DSH worker's 30-minute
  background limit and job notices do not apply. An ACP turn ends when Hermes ends
  it, or at `turnTimeoutSeconds`.
- The DSH `ticket/<id>/transcript` resource has no Hermes equivalent; a Hermes worker
  reads its Ticket's assignment, inputs and reports instead.
