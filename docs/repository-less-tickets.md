# Repository-less Tickets

**Status: research and proposal. This document describes no implemented behavior and
changes no runtime code.** It answers two questions: whether a Ticket must name a
GitHub repository before it can be accepted, and how to remove that requirement for
work that has nothing to do with a repository.

## 1 Summary

dsh-superagent is built around GitHub repositories: a deployment configures at
least one repository, a GitHub Trigger derives its own repository from the Source
instance, and a pull request binds to a Ticket by repository and branch. That is the
right model for a Ticket that changes code, opens a pull request and is delivered
through review.

Today, however, **every** accepted Ticket also gets a repository. For a GitHub
origin the repository is derived; for any other origin the main Session must name
one when the deployment configures several repositories, and a deployment with one
repository silently supplies the default. The Executor then writes the repository
into `Execution` and the worker's environment says the Ticket works on it.

For a summary, a research question, a piece of writing or an answer, that repository
is only a marker. It is never used for a pull request, and a multi-repository
deployment forces the main Session to make an arbitrary choice. The requirement is
reasonable for repository work but not as a condition of every Ticket.

The recommendation is to make **no repository** an explicit, first-class Ticket
mode — a *workspace-only Ticket* — while keeping the repository requirement for
repository work. Do not make an omitted repository silently mean "none": that would
turn a forgotten choice into a hidden dead end. An explicit `workspace_only` accept
field, stored on the Ticket, gives the main Session a safe way to accept work that
needs no repository.

This is a Ticket-level change. It does not enable a deployment with no GitHub
repository at all; that is a separate product change (section 5.6).

## 2 Current behavior

### 2.1 A deployment always has a repository

`resolveDeployment` refuses a deployment with no GitHub Source instance
(`repositoryUnset`) and requires at least one usable repository; the default is the
`github` instance's repository, or the first usable instance's
([deployment.ts](../src/deployment.ts), [006 Deployment](006-deployment.md)). A
deployment therefore always has a default repository, even when the request that
started a Ticket came from Feishu.

### 2.2 Every accepted Ticket gets one

`Execution.repository` is optional in the model
([model.ts](../src/core/model.ts)), but `DshExecutor.prepare` fills it:

```ts
const repository = outcome.repository ?? this.host.repositoryOf(source?.source)
```

`repositoryOf` falls back to the default repository
([dsh.ts](../src/executor/dsh.ts), [runtime.ts](../src/app/runtime.ts)). The value is
stored by `ticketExecution`, and GitHub's execution environment publishes it as
`DSH_SUPERAGENT_GITHUB_REPOSITORY`
([execution-environment.ts](../src/app/execution-environment.ts),
[github.ts](../src/sources/github.ts)). A Ticket accepted with no repository in a
single-repository deployment therefore still ends up with the default one.

### 2.3 The multi-repository guard

Two accept paths enforce the requirement explicitly:

- `orchestrator_route` with `kind: 'accept'` derives the repository from the origin
  Source; when it has none and the deployment configures more than one repository,
  it refuses with `accept needs repository: …`
  ([main.ts](../src/app/tools/main.ts)).
- `orchestrator_eval_decide` has the same guard, then picks
  `result.repository ?? derived ?? repositories[0]`
  ([assessment.ts](../src/app/assessment.ts)).

So the hard "must name a repository" applies to a multi-repository deployment when
the origin is not a GitHub repository. With one repository the default is used
silently, which is convenient but hides the same choice.

### 2.4 What the repository selects

The repository is not just a label. It selects:

| Use | Where | Effect |
| --- | --- | --- |
| Workspace checkout | `DshExecutor.prepare`, `DSH_SUPERAGENT_GITHUB_REPOSITORY` | the prepare command clones the repository |
| Worker instructions | GitHub environment values | the worker is told the Ticket works on that repository |
| Pull-request binding | `claimPull`, `host.github(ticket)` ([github-pull.ts](../src/sources/github-pull.ts), [runtime.ts](../src/app/runtime.ts)) | a reported PR is validated in that repository |
| GitHub reads | `readResource` `github/…` and the GitHub skill | reads use that repository's Source instance |
| Delivery and merge | [delivery.md](../prompts/team/delivery.md) | merge commands name that repository |

That is why the constraint cannot simply be deleted for repository work: an
unvalidated or wrong repository is a real error, and the multi-repository guard
exists to prevent it. The defect is different: the model has no representation for
"this Ticket needs no repository", so the system has to invent one.

## 3 Why the constraint exists

The multi-repository design records the decision in its risk table, under "Which
repository a Feishu-origin or proactive Ticket uses":

> name it in the accept; default when only one is configured; otherwise the main
> Session asks instead of guessing.
>
> — [multi-repository-design.md](multi-repository-design.md), section 8

At acceptance time the main Session is the only place that knows both the request
and the deployment's repositories. Deriving from a GitHub Trigger is exact, so the
main Session does not choose at all. For a non-GitHub Trigger, naming a repository
is a deliberate product decision: the alternative was a silent default that could
clone and modify the wrong repository. The guard is therefore reasonable for
repository work. It becomes wrong only when it is applied to work that will never
use a repository.

## 4 Is the restriction reasonable?

**For a Ticket that changes code: yes.** The repository determines the checkout,
the pull-request scope, the review and merge commands, and the Source instance used
for GitHub reads. Making it explicit at acceptance prevents working in the wrong
repository, and the multi-repository guard is the right safety property.

**As a blanket rule for every Ticket: no.** Research, summarization, writing,
question answering and many administrative tasks are legitimate Tickets. They may
read a repository for context, but they do not own one, do not open a pull request
and are not delivered through review. For them the repository is an arbitrary
marker with concrete costs:

1. **The main Session must guess.** In a deployment with several repositories it
   has no basis for choosing one for a summary task. The result looks like a
   decision (“this task belongs to `acme/widgets`”) that nobody made.
2. **The worker is told something false.** `DSH_SUPERAGENT_GITHUB_REPOSITORY` says
   the Ticket works on that repository. A careful worker may inspect or modify it
   because the environment says it is in scope.
3. **Preparation clones a repository that is not needed.** The prepare command is
   written for a checkout and receives a repository it did not need.
4. **Pull-request and delivery rules name a repository** the Ticket will never use;
   the merge instructions in [delivery.md](../prompts/team/delivery.md) are
   inapplicable.

The right rule is therefore: **a Ticket that may change code must name a
repository; a Ticket that needs no repository may name none.** The current
implementation has no way to express the second case, and that is the actual
defect. The next section compares ways to express it.

## 5 Options

| Option | Description | Verdict |
| --- | --- | --- |
| A. Keep the rule | Require a repository for every accepted Ticket | Rejects legitimate work; keeps the arbitrary marker |
| B. Silent default | Accept without a repository and use the default | Hides a wrong guess; the worker still believes it owns that repository |
| C. Explicit workspace-only | Add an explicit "no repository" accept option, stored on the Ticket | Recommended |
| D. Defer binding | Start without a repository and bind when the worker first needs code | Not needed for the reported problem; large lifecycle change |
| E. Per-Source default | Configure a default repository (or none) for non-GitHub Sources | Useful complement, not a substitute for C |
| F. No-GitHub deployment | Run the whole deployment without any GitHub repository | Separate product change; not required for the reported problem |

### 5.1 A: keep the current rule

No code change. Every non-GitHub Ticket in a multi-repository deployment must name
a repository. The marker remains, the worker remains misinformed, and summary
Tickets remain impossible to accept without a choice. This is the status quo the
request asks to improve.

### 5.2 B: silently use the default

Remove the guard and let `prepare` use the default repository when none is named.
This removes the forced choice but keeps the marker and makes the failure mode
worse: a code Ticket accepted without a repository would land in the default one
with no explicit decision. It is also not a real improvement in a
single-repository deployment, where today's fallback already supplies the default.
Not recommended.

### 5.3 C: explicit workspace-only Ticket (recommended)

Add an explicit accept option for a Ticket that needs no repository. The main
Session decides it from the request, the same way it decides the title and
worktree name. The Ticket then has no repository, an empty workspace, an empty
`DSH_SUPERAGENT_GITHUB_REPOSITORY`, and no pull-request binding. Repository Tickets
keep the current behavior and guard unchanged. This is the smallest change that
solves the reported problem without weakening the safety property for code work.

### 5.4 D: defer the repository choice

Start the Ticket without a repository and choose one later, when the worker first
needs code. Technically this means the workspace, the execution environment, the
Source instance and the PR binding could change mid-Ticket, or a second workspace
could be prepared. It is a larger lifecycle change and it moves the decision to a
worker that has less context about other repositories. Not recommended for this
problem. A follow-up that needs code can be a new repository Ticket (section 7).

### 5.5 E: a default repository per non-GitHub Source

A Feishu Source could carry `defaultRepository: owner/name` or "none". Tickets
from that Source would not need the main Session to choose, and a deployment that
uses Feishu only for summaries would configure "none". This is a good complement
for routine routing, but it does not handle a single chat mixing summary and code
requests; the per-Ticket explicit option still covers that. It also adds a settings
field and a policy question about which Source owns the default. Consider it after
C, not instead of it.

### 5.6 F: a deployment with no GitHub repository

The request is about a Ticket, not necessarily about the deployment. Today a
deployment cannot run without at least one GitHub Source: `resolveDeployment`
fails with `repositoryUnset`, and setup, the panel, the prompt environment and the
delivery rules all assume a GitHub repository. Supporting a Feishu-only deployment
would be a separate change (deployment identity, setup, default environment, and
the GitHub skill). It is not needed for a summary Ticket inside a deployment that
also serves repositories. If the goal is “no GitHub at all”, treat it as a new
product decision, not as part of this fix.

## 6 Design sketch for C

The names below are illustrative; the important part is the behavior.

### 6.1 Acceptance

Add `workspace_only?: boolean` to both accept paths:

- `orchestrator_route` accept
  ([main.ts](../src/app/tools/main.ts)).
- `orchestrator_eval_decide` accept
  ([assessment.ts](../src/app/assessment.ts)).

Rules:

- `workspace_only: true` and `repository` are mutually exclusive; an item that sets
  both is refused.
- `workspace_only: true` means the Ticket needs no repository, even when the
  deployment has several and even when the origin is a GitHub repository (for
  example an Issue that asks for research).
- When `workspace_only` is absent, current behavior is unchanged: derive the
  repository for a GitHub origin; otherwise use the chosen repository, refuse when
  several are configured and none is named, or use the single default.
- The main Session decides conservatively: use `workspace_only` only when the
  request clearly needs no repository; if the request may change code, name a
  repository. This is a judgement call, like the title and worktree name, and the
  prompt must say so.

The field could instead be a sentinel such as `repository: "none"`, but a boolean
keeps `repository` an `owner/name` field and avoids a magic value that could clash
with a real name.

### 6.2 Ticket model and execution

- `AssessmentOutcome` accept gains `workspaceOnly?: true`
  ([ports.ts](../src/core/ports.ts)).
- `Execution` gains `workspaceOnly?: true`
  ([model.ts](../src/core/model.ts)); `repository` stays absent for such a Ticket.
- `DshExecutor.prepare`:

  ```ts
  const repository = outcome.workspaceOnly ? undefined : (outcome.repository ?? this.host.repositoryOf(source?.source))
  ```

  and `ticketExecution` stores `workspaceOnly: true`.
- The existing fallback for old Tickets is kept. `Execution.workspaceOnly` is the
  explicit marker that distinguishes "no repository by design" from "legacy
  Ticket that predates `Execution.repository`".

### 6.3 Execution environment

- `environmentOf` / `ticketEnvironment` must know the mode and pass it to the
  Source environment values
  ([execution-environment.ts](../src/app/execution-environment.ts)).
- For a workspace-only Ticket, `DSH_SUPERAGENT_GITHUB_REPOSITORY` is empty.
  `DSH_SUPERAGENT_GITHUB_REPOSITORIES` still lists every configured repository
  (useful context), and the account, commit email, number and PR head remain when
  the origin is GitHub.
- The execution-environment heading already says “an empty value means that part is
  not configured here”; the GitHub variable description should say that an empty
  repository means a workspace-only Ticket.

### 6.4 Workspace preparation

Skip the repository prepare command for a workspace-only Ticket and create the
empty directory. The command is documented as a checkout of the Ticket's
repository ([003 Execution](003-execution.md)); running it with an empty
`DSH_SUPERAGENT_GITHUB_REPOSITORY` would fail for the existing commands, so
skipping is the compatible behavior. The worker still gets a directory and can
create files, download an attachment or run commands there.

If a deployment needs custom setup for workspace-only work, a later option is a
separate `executor.prepareWorkspace` command, or a documented conditional:

```sh
[ -n "$DSH_SUPERAGENT_GITHUB_REPOSITORY" ] || exit 0
```

A separate command is cleaner but is additional configuration and UI; it is not
required for the first version.

### 6.5 Pull requests and delivery

- `orchestrator_report` with `pr_number` must be refused for a workspace-only
  Ticket: it cannot own a pull request. The `orchestrator_report` tool in
  [executor.ts](../src/app/tools/executor.ts) calls `claimPull`, which validates
  against the Ticket's repository; without a repository it currently falls back to
  the default Source. Add an explicit guard rather than relying on that fallback.
- `claimPull` / `observePull` must not bind a PR to a workspace-only Ticket
  ([github-pull.ts](../src/sources/github-pull.ts)).
- A `ready` report without a pull request already ends a Ticket as completed
  ([003 Execution](003-execution.md)), so delivery needs no new state.
- Following a GitHub Thread for context remains possible; the Ticket still has the
  GitHub account, it just does not own a PR.
- `readResource` for `github/…` currently falls back to the default repository when
  a Ticket has none ([resources.ts](../src/app/resources.ts)). For a workspace-only
  Ticket that is context, not ownership; decide whether to keep it (documented as
  the default repository) or refuse it. Keeping it is less disruptive, but the
  prompt must not present it as the Ticket's repository.

### 6.6 Prompts and panel

- `prompts/orchestrator.md` currently says “A Ticket works on one repository”.
  Change it to distinguish a repository Ticket from a workspace-only Ticket, and
  state when to use which.
- `prompts/admission.md` tells the main Session to name a repository or ask when
  several are configured. Allow a workspace-only accept for requests that need no
  repository, while keeping “never guess” for code work.
- `prompts/cli.md` says a Ticket's work belongs to its own repository; qualify it.
- `prompts/team/delivery.md` should say: if the Ticket has no repository, do not
  open a pull request; report the result in the source conversation.
- The panel does not currently show a per-Ticket repository, so no UI is required.
  If a ticket view later shows it, label the workspace-only state explicitly (such
  as “workspace only” / “无仓库”) rather than an empty string.

## 7 Compatibility and limits

- **No migration.** `workspaceOnly` is additive. Old Tickets have no flag and keep
  their current behavior: a Ticket with a stored repository keeps it, and a Ticket
  that predates per-Ticket repositories keeps the default fallback. Repository
  Tickets keep their `repository` and behavior.
- **A workspace-only Ticket cannot be re-bound to a repository.** If a follow-up
  asks for code, the worker should report blocked and the main Session should open
  a new Ticket with a repository (or a future “attach repository” action can be
  designed separately). This is a real limitation and belongs in the worker
  prompt, not in a silent fallback.
- **Classification risk.** The main Session must not mark code work as
  workspace-only. The failure is a blocked Ticket, not a wrong commit; the worker's
  empty repository makes the situation visible.
- **Prepare command semantics.** Skipping the command changes what a
  workspace-only Ticket's directory contains. Document it; do not make the command
  run with an empty repository for existing installations.
- **Repository reads.** A workspace-only Ticket can still read a repository through
  the default Source. Treat that as context; do not claim it is the Ticket's
  repository.

## 8 Verification plan

For the implementation (not this document):

| Scenario | Expected |
| --- | --- |
| `orchestrator_route` accept with `workspace_only: true`, several repositories | Ticket is created without `execution.repository`, with `execution.workspaceOnly: true` |
| `workspace_only: true` together with `repository` | Accept is refused |
| `orchestrator_eval_decide` accept with `workspace_only: true` | Same outcome |
| A GitHub-origin Ticket accepted as workspace-only | No PR binding; the origin Thread still receives replies |
| `ticketEnvironment` for a workspace-only Ticket | `DSH_SUPERAGENT_GITHUB_REPOSITORY` is empty; `DSH_SUPERAGENT_GITHUB_REPOSITORIES` is unchanged |
| Prepare for a workspace-only Ticket | The repository prepare command is skipped; the directory exists |
| `orchestrator_report` with `pr_number` on a workspace-only Ticket | Refused |
| A legacy Ticket with no `execution.repository` | Keeps the default repository in its environment |
| Existing repository Tickets | No change |

Doc-only changes can be checked with `pnpm exec vitest run tests/docs.spec.ts` and
`git diff --check`.

## 9 Open questions

1. **Who decides?** The main Session is the natural place, but the prompt needs a
   conservative rule. Should a rule or setting be able to force repository-less
   tickets for a Source? (See option E.)
2. **Should a workspace-only Ticket be allowed from a GitHub origin?** The
   recommendation is yes: it is useful for research on an Issue, and the origin
   Thread still receives the reply even though the Ticket has no PR. Confirm that a
   GitHub Thread may legitimately produce a no-PR Ticket; if not, the guard must
   distinguish the origin.
3. **Should the workspace-only flag be immutable?** A follow-up that needs code
   cannot be served by the same Ticket today. Leaving it immutable and opening a
   new Ticket is simpler and honest.
4. **Is a second prepare command worth it?** Only if deployments need custom
   workspace setup beyond an empty directory.
5. **Should the deployment itself support no GitHub repository?** Separate
   question (section 5.6); the Ticket-level fix does not require it.

## 10 Recommendation

Adopt option C. It removes the arbitrary marker for summary, research and writing
Tickets without weakening the repository requirement for code work, needs no data
migration, and is a focused change in the accept schemas, the Executor's
preparation, the environment, the PR guard and the prompts. Keep the
multi-repository guard for repository Tickets. Do not make an omitted repository
mean “none” silently.

If the product wants a larger improvement later, option E (a per-Source default or
“none”) can reduce how often the main Session has to choose, and option F (a
deployment with no GitHub) is a separate product decision. Neither is necessary to
stop requiring a repository on a summary Ticket.
