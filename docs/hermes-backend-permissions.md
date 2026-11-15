# Hermes backend permissions

- Status: implemented. The permission policy and the Hermes ACP backend that consumes it are both in this repository;
  [009 Hermes ACP backend](009-hermes-backend.md) describes the backend.
- Decision: the Hermes backend gets the same effective permission as a DSH worker. A different backend must not
  produce a different permission outcome for the same Ticket.
- Code: [`src/executor/hermes-permissions.ts`](../src/executor/hermes-permissions.ts), tested by
  [`tests/hermes-permissions.spec.ts`](../tests/hermes-permissions.spec.ts); the ACP client and Executor consume it in
  [`src/executor/acp.ts`](../src/executor/acp.ts) and [`src/executor/hermes.ts`](../src/executor/hermes.ts).

## Why

A superagent Ticket runs unattended. A DSH worker executes commands without approval as the operator's OS user, and
there is no person in front of the machine to answer a prompt. Hermes defaults to a different policy: dangerous
terminal commands are approved (Smart approvals), and over ACP file edits are asked for by default. Without an
explicit decision, a Hermes-backed Ticket would block on a prompt that no one can answer, or silently fall back to
writing files and running them, and the same Ticket would behave differently depending on its backend.

The decision is therefore: **one work policy for every backend.** A backend may differ in language, model, memory or
transport; it may not differ in whether a person must approve the work.

## What parity means

| Surface | DSH worker | Hermes backend |
| --- | --- | --- |
| Dangerous terminal commands | No approval; executes as the operator | `HERMES_YOLO_MODE=1` on the ACP process |
| File edits | Read/write in the Ticket directory | ACP edit mode `dont_ask`; no edit prompt |
| Residual ACP permission requests | Not applicable | Answered `allow_always` / `allow_session` / `allow_once`, never left waiting |
| Unseen shell hooks | No hooks service | `HERMES_ACCEPT_HOOKS=1` |
| Working directory | Ticket directory | ACP `session/new` cwd is the Ticket directory |
| OS identity | Operator | Operator |
| Tool surface | The worker preset's tools | The Hermes ACP toolset plus the orchestrator report tools; a difference in available tools is allowed, a difference in approval is not |

Sensitive Hermes paths (`.env`, `id_rsa`, ...) still need a permission request under `dont_ask`. That request is
answered by the backend itself, not by a person, so it stays unattended.

## How it is applied

1. Launch `hermes -p <profile> acp` with `HERMES_YOLO_MODE=1` and `HERMES_ACCEPT_HOOKS=1` in its environment.
   `hermes acp` rejects a `--yolo` argument, so the environment is the supported carrier; Hermes freezes it into
   each session. `hermesAcpLaunch` builds this command, argument list, cwd and environment.
2. Create the ACP session with the Ticket directory as `cwd`, then set the session mode to `dont_ask`
   (`HERMES_FULL_EDIT_MODE`) so file edits do not prompt.
3. Answer every `session/request_permission` request with the most durable allow option.
   `chooseHermesPermissionOption` prefers `allow_always`, then `allow_session`, then `allow_once`, and denies when the
   request offers no allow option. Option ids are checked against their allow kind, so a mislabelled deny is not
   accepted.
4. Give the session the same report tools a DSH worker has (the orchestrator MCP tools) and no toolset that would
   reintroduce an approval gate for ordinary work.

## Evidence

On the machine that runs the backend profile (2026-11-15):

- `hermes -p <profile> approvals test --env-type local -- python3 -c 'print(42)'` returned `ask-approval` before the
  change and `allow` after it. The rule was `script execution via -e/-c flag`; under the full policy the detail was
  `approval bypass active (--yolo or approvals.mode: off)`.
- A real unattended CLI run with the profile's `approvals.mode: off` executed the command and printed `42`; no prompt
  appeared.
- A real ACP session on a temporary directory: launched with `HERMES_YOLO_MODE=1`, set to `dont_ask`, asked to run
  `python3 -c 'print(6*7)'` and to write `note.txt`. The prompt finished `end_turn`, stdout was `42`, `note.txt`
  contained `OK`, and **zero** `session/request_permission` requests were sent to the client. The tool calls were
  visible through `session/update` (111 updates).

The backend profile also has `approvals.mode: off` as a profile-level backstop for its unattended CLI use. The
backend process sets the environment explicitly anyway, so the policy does not depend on that profile setting.

## How the Executor consumes it

- [`HermesAcpExecutor`](../src/executor/hermes.ts) starts the ACP process through `hermesAcpLaunch`, so the
  environment and command cannot drift from this policy.
- [`AcpProcess`](../src/executor/acp.ts) answers every `session/request_permission` with
  `chooseHermesPermissionOption`, and the executor sets `HERMES_FULL_EDIT_MODE` on each session.
- Each session receives the `orchestrator_*` tools through the loopback MCP bridge
  ([`src/executor/hermes-bridge.ts`](../src/executor/hermes-bridge.ts)), so the report and delivery contract is the
  same contract a DSH worker writes, not a text convention.
- The backend is selected per Ticket by `executor.backend`; a Ticket's `Execution.runtime` fixes the choice when it is
  accepted, and repository Tickets always use the DSH Executor.

## Security

Full permission is a deliberate choice for unattended Tickets, not a default for every Hermes session. Launch the
ACP process with the environment above only for the backend, and keep the Hermes profile dedicated to that use.
Commands that match Hermes' hardline blocklist or `approvals.deny` still fail; this policy removes the human prompt,
not the operator's hard limits.
