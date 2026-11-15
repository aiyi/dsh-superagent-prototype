/** The Hermes backend's full-permission launch and ACP permission choice. */
import { expect, it } from 'vitest'
import { HERMES_FULL_EDIT_MODE, HERMES_FULL_PERMISSION_ENV, chooseHermesPermissionOption, hermesAcpLaunch }
  from '../src/executor/hermes-permissions.ts'

it('launches Hermes ACP for the ticket directory with the DSH worker permission policy', () => {
  const launch = hermesAcpLaunch({ profile: 'work', cwd: '/work/ticket', env: { PATH: '/bin', HOME: '/home/agent' } })
  expect(launch.command).toBe('hermes')
  expect(launch.args).toEqual(['-p', 'work', 'acp'])
  expect(launch.cwd).toBe('/work/ticket')
  expect(launch.env).toEqual({ PATH: '/bin', HOME: '/home/agent', ...HERMES_FULL_PERMISSION_ENV })
  // `hermes acp` rejects `--yolo`; the policy must travel in the environment.
  expect(launch.args).not.toContain('--yolo')
})

it('uses a command override without dropping the full-permission environment', () => {
  const launch = hermesAcpLaunch({ profile: 'work', cwd: '/work/ticket', command: '/opt/hermes/bin/hermes', env: { HERMES_YOLO_MODE: '0' } })
  expect(launch.command).toBe('/opt/hermes/bin/hermes')
  expect(launch.env.HERMES_YOLO_MODE).toBe('1')
})

it('sets the ACP edit mode that auto-allows ticket edits', () => {
  expect(HERMES_FULL_EDIT_MODE).toBe('dont_ask')
})

it('answers a permission request with the most durable allow option', () => {
  expect(chooseHermesPermissionOption([
    { optionId: 'allow_once', kind: 'allow_once' },
    { optionId: 'allow_session', kind: 'allow_always' },
    { optionId: 'allow_always', kind: 'allow_always' },
    { optionId: 'deny', kind: 'reject_once' },
  ])).toBe('allow_always')
  expect(chooseHermesPermissionOption([
    { optionId: 'allow_once', kind: 'allow_once' },
    { optionId: 'allow_session', kind: 'allow_always' },
  ])).toBe('allow_session')
  expect(chooseHermesPermissionOption([{ optionId: 'allow_once', kind: 'allow_once' }])).toBe('allow_once')
})

it('denies a permission request that offers no allow option, and ignores mislabelled deny ids', () => {
  expect(chooseHermesPermissionOption([{ optionId: 'deny', kind: 'reject_once' }])).toBeUndefined()
  expect(chooseHermesPermissionOption([])).toBeUndefined()
  expect(chooseHermesPermissionOption([{ optionId: 'allow_always', kind: 'reject_once' }])).toBeUndefined()
})
