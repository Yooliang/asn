// 假的 ACP agent（stdio、一行一則 JSON-RPC）：給 acp-client.test.mjs 用，不碰任何真的 AI。
// 行為：initialize → session/new → session/prompt（先要一次權限，再串流兩段文字，回 end_turn）。
// 環境變數 FAKE_ACP_ECHO_ENV=NAME：把該環境變數有沒有被帶進來放進回覆（測子行程環境白名單）。
import readline from 'node:readline'

const out = o => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n')
const rl = readline.createInterface({ input: process.stdin })
let permWaiter = null

rl.on('line', line => {
  const m = JSON.parse(line)
  if (m.method == null && permWaiter && m.id === permWaiter.id) {          // 用戶端對權限請求的回應
    const w = permWaiter; permWaiter = null; w.done(m.result)
    return
  }
  if (m.method === 'initialize') {
    return out({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'fake-acp', version: '0' }, agentCapabilities: { loadSession: false }, authMethods: [] } })
  }
  if (m.method === 'session/new') return out({ id: m.id, result: { sessionId: 'sess-1' } })
  if (m.method === 'session/prompt') {
    const text = m.params.prompt.map(p => p.text).join('')
    const send = t => out({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } } })
    permWaiter = {
      id: 900,
      done: res => {
        const denied = res?.outcome?.optionId === 'no'
        send(`收到：${text}`)
        send(denied ? '（權限被拒）' : '（權限被放行？）')
        const name = process.env.FAKE_ACP_ECHO_ENV
        if (name) send(`[env ${name}=${process.env[name] ? 'present' : 'absent'}]`)
        out({ id: m.id, result: { stopReason: 'end_turn' } })
      },
    }
    return out({ id: 900, method: 'session/request_permission', params: { sessionId: m.params.sessionId, toolCall: { toolCallId: 't1' }, options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } })
  }
  if (m.id != null) out({ id: m.id, error: { code: -32601, message: 'unknown' } })
})
