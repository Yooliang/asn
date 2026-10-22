// 假的 ACP agent（工作者測試用）：比 fake-acp-agent.mjs 多了「依暗號送各種權限請求」「可 session/load」「登入失敗」。
//   @@EDIT <路徑>  → session/request_permission（kind=edit，locations=[路徑]）
//   @@EXEC <指令>  → session/request_permission（kind=execute，rawInput.command）
//   @@FETCH <網址> → session/request_permission（kind=fetch）
//   @@READ <路徑>  → session/request_permission（kind=read）
//   @@MULTI        → 連續三個 execute 請求（測「這次全部允許」）
//   @@SLEEP        → 沒有任何動靜（看門狗）
// 回覆文字列出每個請求的結果：edit:allowed / execute:denied …
// 環境變數：FAKE_ACP_LOAD=1 宣告 loadSession；FAKE_ACP_AUTH=1 → session/new 回 Authentication required；FAKE_ACP_STATE=資料夾（存 session 與輪數）
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const out = o => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n')
const stateDir = process.env.FAKE_ACP_STATE || ''
const sFile = id => path.join(stateDir, `${id}.json`)
const turnsOf = id => { try { return JSON.parse(fs.readFileSync(sFile(id), 'utf8')).turns } catch { return 0 } }
const waiters = new Map()
let nextReq = 500

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  const m = JSON.parse(line)
  if (m.method == null && waiters.has(m.id)) { waiters.get(m.id)(m.result); waiters.delete(m.id); return }
  if (m.method === 'initialize') {
    return out({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'fake-acp-worker', version: '0' }, agentCapabilities: { loadSession: process.env.FAKE_ACP_LOAD === '1' }, authMethods: [{ id: 'oauth', name: 'Google' }] } })
  }
  if (m.method === 'authenticate') return out({ id: m.id, result: {} })
  if (m.method === 'session/new') {
    if (process.env.FAKE_ACP_AUTH === '1') return out({ id: m.id, error: { code: -32000, message: 'Authentication required' } })
    const id = `sess-${Math.random().toString(16).slice(2, 8)}`
    if (stateDir) fs.writeFileSync(sFile(id), JSON.stringify({ turns: 0 }))
    return out({ id: m.id, result: { sessionId: id } })
  }
  if (m.method === 'session/load') {
    if (!stateDir || !fs.existsSync(sFile(m.params.sessionId))) return out({ id: m.id, error: { code: -32602, message: 'session not found' } })
    return out({ id: m.id, result: {} })
  }
  if (m.method === 'session/prompt') { void prompt(m); return }
  if (m.id != null) out({ id: m.id, error: { code: -32601, message: 'unknown' } })
})

const ask = (sessionId, toolCall) => new Promise(resolve => {
  const id = nextReq++
  waiters.set(id, resolve)
  out({ id, method: 'session/request_permission', params: { sessionId, toolCall, options: [
    { optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } })
})

async function prompt(m) {
  const sid = m.params.sessionId
  const text = m.params.prompt.map(p => p.text).join('')
  const body = text.includes('\n---\n') ? text.slice(text.indexOf('\n---\n') + 5) : text
  const results = []
  const req = async (kind, extra) => {
    const r = await ask(sid, { toolCallId: `t${nextReq}`, kind, title: `${kind} request`, ...extra })
    results.push(`${kind}:${r?.outcome?.optionId === 'yes' ? 'allowed' : 'denied'}`)
  }
  let t
  if (/@@SLEEP/.test(body)) return
  if ((t = /@@EDIT\s+(\S+)/.exec(body))) await req('edit', { locations: [{ path: t[1] }] })
  if ((t = /@@READ\s+(\S+)/.exec(body))) await req('read', { locations: [{ path: t[1] }] })
  if ((t = /@@EXEC\s+(.+)/.exec(body))) await req('execute', { rawInput: { command: t[1].trim() } })
  if ((t = /@@FETCH\s+(\S+)/.exec(body))) await req('fetch', { rawInput: { url: t[1] } })
  if (/@@MULTI/.test(body)) for (const c of ['a', 'b', 'c']) await req('execute', { rawInput: { command: `cmd-${c}` } })
  const n = turnsOf(sid) + 1
  if (stateDir) fs.writeFileSync(sFile(sid), JSON.stringify({ turns: n }))
  const reply = `收到：${body.replace(/^\[RELAY 來信\][^\n]*\n?/, '').replace(/^寄件人：[^\n]*\n?/, '').replace(/^【要回信】[^\n]*\n?/, '').trim().slice(0, 60)} [${[`第${n}輪`, results.join(','), text.includes('背景工作者') ? '含說明' : ''].filter(Boolean).join(' ')}]`
  out({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } } })
  out({ id: m.id, result: { stopReason: 'end_turn' } })
}
