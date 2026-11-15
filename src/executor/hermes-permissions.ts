/**
 * Permission policy for the Hermes ACP execution backend.
 *
 * Hermes defaults to asking a person before dangerous terminal commands and, over ACP, before file edits. A
 * superagent worker runs unattended, so the Hermes backend must be launched with the same effective permission as a
 * DSH worker: no approval prompt, no tool approval round trip, and a stable working directory. This module holds the
 * launch and permission decisions in one place so the backend cannot drift from the DSH Executor's policy; it does
 * not launch Hermes or speak ACP itself.
 */

/** Environment that turns off Hermes' dangerous-command and unseen-hook approvals for the backend process. */
export const HERMES_FULL_PERMISSION_ENV = Object.freeze({
  HERMES_YOLO_MODE: '1',
  HERMES_ACCEPT_HOOKS: '1',
})

/** ACP edit mode that auto-allows file edits for the session, the closest ACP mode to a DSH worker's file access. */
export const HERMES_FULL_EDIT_MODE = 'dont_ask'

/** How to start the Hermes ACP process of the backend. */
export interface HermesAcpLaunch {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

/** What `hermesAcpLaunch` needs: the Hermes profile, the process working directory, and optional command/env overrides. */
export interface HermesAcpLaunchOptions {
  profile: string
  /** The ACP process's working directory; each session gets its Ticket directory as `cwd` on `session/new`. */
  cwd: string
  command?: string
  env?: NodeJS.ProcessEnv
}

/**
 * Build the Hermes ACP process launch.
 *
 * `--yolo` is deliberately not an argument: `hermes acp` rejects it, so full permission is carried by the process
 * environment, which Hermes freezes into each session it creates.
 */
export function hermesAcpLaunch(options: HermesAcpLaunchOptions): HermesAcpLaunch {
  return {
    command: options.command ?? 'hermes',
    args: ['-p', options.profile, 'acp'],
    cwd: options.cwd,
    env: { ...options.env, ...HERMES_FULL_PERMISSION_ENV },
  }
}

/** One ACP `PermissionOption`, named as the wire protocol and the Python SDK carry it. */
export interface HermesPermissionOption {
  optionId: string
  kind: string
}

/** The ids Hermes maps to its own approvals, most durable first. */
const ALLOW_OPTION_IDS = ['allow_always', 'allow_session', 'allow_once'] as const

/**
 * Choose the most durable allow option from an ACP `session/request_permission` request, or `undefined` to deny.
 *
 * The backend answers its own permission requests because no person is watching. An option is accepted only when its
 * kind is an allow kind, so a request that offers no allow option is denied rather than guessed at.
 */
export function chooseHermesPermissionOption(options: readonly HermesPermissionOption[]): string | undefined {
  const allows = options.filter(option => option.kind.startsWith('allow'))
  for (const id of ALLOW_OPTION_IDS) {
    const match = allows.find(option => option.optionId === id)
    if (match) return match.optionId
  }
  return allows[0]?.optionId
}
