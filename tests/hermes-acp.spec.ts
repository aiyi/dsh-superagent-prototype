/** The ACP client against a scripted agent: framing, sessions, permissions, cancellation and resumption. */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpError, AcpProcess } from '../src/executor/acp.ts'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp.mjs')
let connections: AcpProcess[] = []
let directory: string
interface Entry { from?: string; method?: string; params?: Record<string, unknown>; result?: unknown }
const log = (): Entry[] => existsSync(join(directory, 'acp.log'))
  ? readFileSync(join(directory, 'acp.log'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Entry) : []

function open(env: Record<string, string> = {}, events: string[] = []): AcpProcess {
  directory ??= mkdtempSync(join(tmpdir(), 'acp-test-'))
  const acp = new AcpProcess({ command: process.execPath, args: [FIXTURE], env: { FAKE_ACP_LOG: join(directory, 'acp.log'), ...env },
    onUpdate: ({ update }) => { const content = update.content as { text?: string } | undefined
      if (update.sessionUpdate === 'agent_message_chunk' && content?.text) events.push(content.text) } })
  connections.push(acp)
  return acp
}

afterEach(async () => {
  await Promise.all(connections.map(acp => acp.close()))
  connections = []
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('AcpProcess', () => {
  it('opens a session in a directory with an HTTP MCP server, runs a prompt, and streams the agent text', async () => {
    const events: string[] = []
    const acp = open({}, events)
    const session = await acp.newSession({ cwd: '/ticket/dir', mcpServers: [{ type: 'http', name: 'superagent',
      url: 'http://127.0.0.1:1/mcp?ticket=t1', headers: [{ name: 'Authorization', value: 'Bearer t' }] }] })
    expect(session).toEqual({ sessionId: 'fake-session', resumed: false })
    await acp.setMode(session.sessionId, 'dont_ask')
    const turn = await acp.prompt(session.sessionId, 'say hi')
    expect(turn.stopReason).toBe('end_turn')
    expect(log().find(entry => entry.method === 'session/new')?.params).toMatchObject({ cwd: '/ticket/dir',
      mcpServers: [{ type: 'http', name: 'superagent' }] })
    expect(log().find(entry => entry.method === 'session/set_mode')?.params).toEqual({ sessionId: 'fake-session', modeId: 'dont_ask' })
    expect(log().find(entry => entry.method === 'session/prompt')?.params).toMatchObject({
      sessionId: 'fake-session', prompt: [{ type: 'text', text: 'say hi' }] })
    expect(events).toEqual(['hi'])
  })

  it('answers a permission request with the widest allow option, as an unattended full-access worker', async () => {
    const acp = open()
    await acp.initialize()
    const session = await acp.newSession({ cwd: '/ticket', mcpServers: [] })
    const turn = await acp.prompt(session.sessionId, 'permission to run')
    expect(turn.stopReason).toBe('end_turn')
    const answered = log().filter(entry => entry.from === 'client' && entry.result !== undefined)
    expect(answered.at(-1)?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_always' } })
  })

  it('cancels a running turn and returns its cancelled stop reason', async () => {
    const acp = open()
    await acp.initialize()
    const session = await acp.newSession({ cwd: '/ticket', mcpServers: [] })
    const turn = acp.prompt(session.sessionId, 'hang forever')
    await new Promise(resolve => setTimeout(resolve, 150))
    acp.cancel(session.sessionId)
    await expect(turn).resolves.toEqual({ stopReason: 'cancelled' })
    expect(log().some(entry => entry.method === 'session/cancel')).toBe(true)
  })

  it('resumes a known session and reports an unknown one', async () => {
    const acp = open()
    await acp.initialize()
    expect(await acp.resumeSession({ sessionId: 'known', cwd: '/ticket', mcpServers: [] }))
      .toEqual({ sessionId: 'known', resumed: true })
    const unknown = open({ FAKE_ACP_RESUME: 'fail' })
    await unknown.initialize()
    expect(await unknown.resumeSession({ sessionId: 'forgotten', cwd: '/ticket', mcpServers: [] })).toBeUndefined()
  })

  it('rejects control requests when the ACP process cannot start', async () => {
    const acp = new AcpProcess({ command: join(tmpdir(), 'no-such-hermes-binary-xyz'), args: ['acp'] })
    connections.push(acp)
    await expect(acp.initialize()).rejects.toBeInstanceOf(AcpError)
  })
})
