/** Multiple GitHub Source instances: identity, deployment isolation, environment and pull binding. */
import { describe, expect, it } from 'vitest'
import { key, type Ticket, type Trigger } from '../src/core/index.ts'
import { SettingsSchema } from '../src/policy.ts'
import { repositoryOf, resolveDeployment, sourceOfRepository, type Probe } from '../src/deployment.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { githubKind } from '../src/sources/github.ts'
import { commentTrigger, githubChannel, issueTrigger } from '../src/sources/github-trigger.ts'
import { agentPull, pullThread, pullsOfSource } from '../src/sources/github-pull.ts'
import { environmentOf } from '../src/app/execution-environment.ts'
import { setupChanged } from '../src/app/setup.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'

const settingsOf = (sources: Record<string, unknown>) => SettingsSchema.parse({ sources })
const twoRepositories = () => settingsOf({
  github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh-agent' } },
  'github-acme-api': { enabled: true, config: { repository: 'acme/api', cli: '' } },
})
const issue = (repository: string, number = 12) => ({ number, title: 'Login fails', body: '@agent-bot please fix', user: { login: 'alice', type: 'User' },
  created_at: '2026-09-09T00:00:00Z', html_url: `https://github.com/${repository}/issues/${number}` })

describe('multiple GitHub Source instances', () => {
  it('resolves each instance and keeps its kind, repository, scope and links apart', () => {
    const settings = twoRepositories()
    const sources = new SourceRegistry(() => settings)
    sources.register(githubKind)
    expect(sources.instances().map(instance => ({ id: instance.id, kind: instance.kind, repository: instance.config.repository })))
      .toEqual([{ id: 'github', kind: 'github', repository: 'acme/widgets' },
        { id: 'github-acme-api', kind: 'github', repository: 'acme/api' }])
    expect(sources.kind('github-acme-api')).toBe(githubKind)
    expect(sources.instance('github-acme-api')?.config).toMatchObject({ repository: 'acme/api' })
    expect(sources.scope({ source: 'github-acme-api', meta: { kind: 'issue' } }))
      .toEqual({ listened: true, observed: false, row: 'issues' })
    expect(sources.find('#12')).toEqual({ threads: ['github:12', 'github-acme-api:12'], terms: [] })
    expect(sources.link(githubChannel(8, undefined, 'github-acme-api'), { repositories: { github: 'acme/widgets', 'github-acme-api': 'acme/api' } }).url)
      .toBe('https://github.com/acme/api/issues/8')
  })
  it("gives one repository's Issue a different Trigger, Thread and Channel from another repository's", () => {
    const first = issueTrigger(issue('acme/widgets'), 'agent-bot')
    const second = issueTrigger(issue('acme/api'), 'agent-bot', 'github-acme-api')
    expect(first.id).toBe(key('github-issue', '12'))
    expect(first.threads).toEqual([{ source: 'github', id: '12' }])
    expect(second.id).not.toBe(first.id)
    expect(second.threads).toEqual([{ source: 'github-acme-api', id: '12' }])
    expect(second.channel).toMatchObject({ source: 'github-acme-api', thread: 'github-acme-api:12' })
    const comment = { id: 5, body: 'fix', user: { login: 'alice', type: 'User' }, html_url: 'https://github.com/acme/api/pull/12#discussion_r5' }
    expect(commentTrigger(comment, { source: 'github-acme-api', number: 12, isPr: true }, 'inline', 'agent-bot').threads)
      .toEqual([{ source: 'github-acme-api', id: '12' }])
    expect(githubChannel(12, undefined, 'github-acme-api')).toEqual({ source: 'github-acme-api', thread: 'github-acme-api:12', address: { number: '12' } })
  })
  it('verifies every repository while one failing repository leaves the others usable', async () => {
    const probe: Probe = async argv => {
      if (argv[1] === 'api' && argv[2] === 'user') return JSON.stringify({ login: 'agent-bot', id: 7 })
      const path = argv.find(argument => argument.startsWith('repos/'))!
      const repository = path.slice('repos/'.length)
      if (repository.includes('missing')) throw new Error('gh: Not Found (HTTP 404)')
      return JSON.stringify({ name: repository, push: true })
    }
    const machine = testMachine({ stateDir: '/tmp/dsh-superagent-multi-repo' })
    const sources = {
      github: { enabled: true, config: { repository: 'acme/widgets', cli: process.execPath } },
      'github-acme-api': { enabled: true, config: { repository: 'acme/api', cli: '' } },
    }
    const deployment = await resolveDeployment(machine, sources, probe, '/bin')
    expect(deployment.repository).toBe('acme/widgets')
    expect(deployment.repositories).toEqual({ github: 'acme/widgets', 'github-acme-api': 'acme/api' })
    expect(repositoryOf(deployment, 'github-acme-api')).toBe('acme/api')
    expect(sourceOfRepository(deployment, 'acme/api')).toBe('github-acme-api')
    const isolated = await resolveDeployment(machine, { ...sources, 'github-acme-api': { enabled: true, config: { repository: 'acme/missing', cli: '' } } }, probe, '/bin')
    expect(isolated.repositories).toEqual({ github: 'acme/widgets' })
    expect(isolated.problems?.['github-acme-api']).toMatchObject({ place: 'github-acme-api', code: 'repositoryUnreadable' })
    await expect(resolveDeployment(machine, { ...sources, 'github-acme-api': { enabled: true, config: { repository: 'acme/api', cli: '/bin/sh' } } }, probe, '/bin'))
      .rejects.toMatchObject({ code: 'agentCliMismatch' })
  })
  it('gives a Ticket its own repository and the main Session every configured repository', () => {
    const settings = twoRepositories()
    const sources = new SourceRegistry(() => settings)
    sources.register(githubKind)
    const deployment = testDeployment({ repositories: { github: 'acme/widgets', 'github-acme-api': 'acme/api' } })
    const trigger = issueTrigger(issue('acme/api'), 'agent-bot', 'github-acme-api')
    const values = (ticket: { id: string; name: string; directory: string } | undefined, trigger: Trigger | undefined, repository?: string) =>
      Object.fromEntries(environmentOf({ deployment, sources, settings, ...ticket ? { ticket } : {}, ...trigger ? { trigger } : {}, ...repository ? { repository } : {} })
        .map(variable => [variable.key, variable.value]))
    expect(values({ id: 't1', name: 'fix-login', directory: '/w/fix-login' }, trigger, 'acme/api')).toMatchObject({
      DSH_SUPERAGENT_GITHUB_REPOSITORY: 'acme/api', DSH_SUPERAGENT_GITHUB_REPOSITORIES: 'acme/widgets\nacme/api',
      DSH_SUPERAGENT_GITHUB_NUMBER: '12' })
    // The main Session, which has no Ticket, reads the first configured repository and the full list.
    expect(values(undefined, undefined)).toMatchObject({ DSH_SUPERAGENT_GITHUB_REPOSITORY: 'acme/widgets', DSH_SUPERAGENT_GITHUB_REPOSITORIES: 'acme/widgets\nacme/api' })
  })
  it('restarts setup when the instances or a repository change, but not for a receiving switch', () => {
    const before = settingsOf({ github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh-agent' } } })
    const added = settingsOf({ ...before.sources, 'github-acme-api': { enabled: true, config: { repository: 'acme/api', cli: '' } } })
    const observed = settingsOf({ ...before.sources, github: { enabled: true, config: { ...before.sources.github!.config, observeIssues: true } } })
    const renamed = settingsOf({ ...before.sources, github: { enabled: true, config: { ...before.sources.github!.config, repository: 'acme/gadgets' } } })
    expect(setupChanged(before, added)).toBe(true)
    expect(setupChanged(before, observed)).toBe(false)
    expect(setupChanged(before, renamed)).toBe(true)
  })
  it('binds a PR and its Thread to the repository that opened it', () => {
    const deployment = testDeployment()
    const pr = { user: { login: 'agent-bot' }, head: { repo: { full_name: 'acme/api' } } }
    expect(agentPull(pr, deployment, 'acme/api')).toBe(true)
    expect(agentPull(pr, deployment, 'acme/widgets')).toBe(false)
    expect(pullThread('github-acme-api:5')).toEqual({ source: 'github-acme-api', number: 5 })
    expect(pullThread('feishu:oc_1:om_1')).toBeUndefined()
    const ticket = { follows: [{ thread: 'github:5', own: true }, { thread: 'github-acme-api:5', own: true }] } as unknown as Ticket
    expect(pullsOfSource(ticket, 'github-acme-api')).toEqual([5])
    expect(pullsOfSource(ticket, 'github')).toEqual([5])
  })
})
