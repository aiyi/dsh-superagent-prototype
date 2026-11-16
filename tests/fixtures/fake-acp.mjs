// A scripted ACP v1 agent for tests: it records every client message and answers the small surface the AcpProcess uses.
import { appendFileSync } from 'node:fs'
import readline from 'node:readline'

const logPath = process.env.FAKE_ACP_LOG
const record = value => { if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`) }
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const pendingPrompts = new Map()
let permissionId = 0

readline.createInterface({ input: process.stdin }).on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.method === undefined) {
    // A client answer to our permission request.
    record({ from: 'client', result: message.result })
    const resolve = pendingPrompts.get(`permission:${message.id}`)
    if (resolve) { pendingPrompts.delete(`permission:${message.id}`); resolve(message.result) }
    return
  }
  record({ from: 'client', method: message.method, params: message.params })
  const respond = result => send({ jsonrpc: '2.0', id: message.id, result })
  const params = message.params ?? {}
  switch (message.method) {
    case 'initialize': respond({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
      agentInfo: { name: 'fake-hermes', version: '0' } }); break
    case 'session/new': respond({ sessionId: 'fake-session', modes: { currentModeId: 'default', availableModes: [] } }); break
    case 'session/resume':
      if (process.env.FAKE_ACP_RESUME === 'fail') send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'unknown session' } })
      else if (process.env.FAKE_ACP_RESUME === 'invalid') respond(null)
      else if (process.env.FAKE_ACP_RESUME === 'hang') break
      else if (process.env.FAKE_ACP_RESUME === 'state') respond({ modes: { currentModeId: 'dont_ask', availableModes: [] } })
      else respond({})
      break
    case 'session/set_mode': respond({}); break
    case 'session/close': respond({}); break
    case 'session/prompt': {
      const text = (params.prompt ?? []).map(part => part.text ?? '').join(' ')
      const sessionId = params.sessionId
      if (text.includes('permission')) {
        const id = ++permissionId
        send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId,
          toolCall: { toolCallId: 'perm', title: 'Run the command' },
          options: [{ optionId: 'allow_always', kind: 'allow_always', name: 'Allow always' },
            { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }] } })
        pendingPrompts.set(`permission:${id}`, () => {
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'allowed' } } } })
          respond({ stopReason: 'end_turn' })
        })
        break
      }
      if (text.includes('disconnect')) { process.exit(1) }
      if (text.includes('hang')) { pendingPrompts.set(`prompt:${sessionId}`, () => respond({ stopReason: 'cancelled' })); break }
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' } } } })
      respond({ stopReason: 'end_turn' })
      break
    }
    case 'session/cancel': {
      const resolve = pendingPrompts.get(`prompt:${params.sessionId}`)
      if (resolve) { pendingPrompts.delete(`prompt:${params.sessionId}`); resolve() }
      break
    }
    default: send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown ${message.method}` } })
  }
})
