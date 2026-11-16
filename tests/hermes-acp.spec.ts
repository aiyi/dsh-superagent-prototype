/** The ACP client against a scripted agent: framing, sessions, permissions, cancellation and resumption. */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpError, AcpProcess } from '../src/executor/acp.ts'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp.mjs')
let connections: AcpProcess[] = []
let directory: string
interface Entry { from?: string; method?: string; params?: Record<string, unknown>; result?: unknown }
const log = (): Entry[] => existsSync(join(directory, 'acp.log'))
  ? readFileSync(join(directory, 'acp.log'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Entry) : []

function open(env: Record<string, string> = {}, events: string[] = []): AcpProcess {
  if (!directory) directory = mkdtempSync(join(tmpdir(), 'acp-test-'))
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

  it.each(['', 'state'])('resumes the requested ID when the response has no session ID (%s)', async response => {
    const acp = open({ FAKE_ACP_RESUME: response })
    await expect(acp.resumeSession({ sessionId: 'known', cwd: '/ticket', mcpServers: [] }))
      .resolves.toEqual({ sessionId: 'known', resumed: true })
    await acp.prompt('known', 'continue')
    expect(log().filter(entry => entry.method === 'session/new')).toHaveLength(0)
    expect(log().find(entry => entry.method === 'session/prompt')?.params).toMatchObject({ sessionId: 'known' })
  })

  it('reuses an attached session for follow-ups without another resume or new request', async () => {
    const acp = open()
    const session = await acp.newSession({ cwd: '/ticket', mcpServers: [] })
    for (const text of ['first supplement', 'second supplement']) {
      await expect(acp.resumeSession({ sessionId: session.sessionId, cwd: '/ticket', mcpServers: [] }))
        .resolves.toEqual({ sessionId: session.sessionId, resumed: true })
      await acp.prompt(session.sessionId, text)
    }
    expect(log().filter(entry => entry.method === 'session/new')).toHaveLength(1)
    expect(log().filter(entry => entry.method === 'session/resume')).toHaveLength(0)
    expect(log().filter(entry => entry.method === 'session/prompt').map(entry => entry.params?.sessionId))
      .toEqual([session.sessionId, session.sessionId])
  })

  it('restores the same session on a new connection and reuses that attachment', async () => {
    const first = open()
    const session = await first.newSession({ cwd: '/ticket', mcpServers: [] })
    await first.close()
    const next = open()
    await next.resumeSession({ sessionId: session.sessionId, cwd: '/ticket', mcpServers: [] })
    await next.resumeSession({ sessionId: session.sessionId, cwd: '/ticket', mcpServers: [] })
    await next.prompt(session.sessionId, 'continue after reconnect')
    expect(log().filter(entry => entry.method === 'session/new')).toHaveLength(1)
    expect(log().filter(entry => entry.method === 'session/resume')).toHaveLength(1)
    expect(log().find(entry => entry.method === 'session/prompt')?.params).toMatchObject({ sessionId: session.sessionId })
  })

  it('forgets connection-local attachments after the ACP process exits', async () => {
    const acp = open()
    const session = await acp.newSession({ cwd: '/ticket', mcpServers: [] })
    await expect(acp.prompt(session.sessionId, 'disconnect')).rejects.toBeInstanceOf(AcpError)
    await acp.resumeSession({ sessionId: session.sessionId, cwd: '/ticket', mcpServers: [] })
    expect(log().filter(entry => entry.method === 'initialize')).toHaveLength(2)
    expect(log().filter(entry => entry.method === 'session/resume')).toHaveLength(1)
    expect(log().filter(entry => entry.method === 'session/new')).toHaveLength(1)
  })

  it('restores a closed attachment rather than treating it as still attached', async () => {
    const acp = open()
    await acp.resumeSession({ sessionId: 'known', cwd: '/ticket', mcpServers: [] })
    await acp.closeSession('known')
    await acp.resumeSession({ sessionId: 'known', cwd: '/ticket', mcpServers: [] })
    expect(log().filter(entry => entry.method === 'session/resume')).toHaveLength(2)
    expect(log().filter(entry => entry.method === 'session/close')).toHaveLength(1)
    expect(log().filter(entry => entry.method === 'session/new')).toHaveLength(0)
  })

  it('propagates a resume timeout without opening a replacement session', async () => {
    const acp = open({ FAKE_ACP_RESUME: 'hang' })
    await acp.initialize()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const failed = expect(acp.resumeSession({ sessionId: 'known', cwd: '/ticket', mcpServers: [] }))
        .rejects.toThrow('ACP request session/resume timed out')
      await vi.advanceTimersByTimeAsync(120_000)
      await failed
      expect(log().filter(entry => entry.method === 'session/new')).toHaveLength(0)
    } finally { vi.useRealTimers() }
  })

  it('rejects malformed resume responses without opening a replacement session', async () => {
    const acp = open({ FAKE_ACP_RESUME: 'invalid' })
    await expect(acp.resumeSession({ sessionId: 'known', cwd: '/ticket', mcpServers: [] }))
      .rejects.toThrow('invalid resume response')
    expect(log().filter(entry => entry.method === 'session/new')).toHaveLength(0)
  })

  it('propagates a failed resume instead of treating it as permission to create a session', async () => {
    const acp = open({ FAKE_ACP_RESUME: 'fail' })
    await expect(acp.resumeSession({ sessionId: 'forgotten', cwd: '/ticket', mcpServers: [] }))
      .rejects.toMatchObject({ name: 'Error', code: -32000, message: 'unknown session' })
    expect(log().filter(entry => entry.method === 'session/new')).toHaveLength(0)
  })

  it('rejects control requests when the ACP process cannot start', async () => {
    const acp = new AcpProcess({ command: join(tmpdir(), 'no-such-hermes-binary-xyz'), args: ['acp'] })
    connections.push(acp)
    await expect(acp.initialize()).rejects.toBeInstanceOf(AcpError)
  })
})
