// 最小 ACP（Agent Client Protocol）用戶端：spawn 一個 ACP agent 子行程，stdio 一行一則 JSON-RPC 2.0。
// 原型用（docs/AGENT-ENGINES.md）。沒有 npm 依賴，風格同 codex-rpc.mjs。
// 只實作「送一句、拿回覆」需要的：initialize → session/new（或 session/load）→ session/prompt，
// 並收集 session/update 通知裡的 agent_message_chunk 文字。agent 要求權限（session/request_permission）一律拒絕。
import { spawn } from 'node:child_process'

// 子行程環境：白名單，不繼承任何金鑰（*_API_KEY、*_TOKEN、*SECRET* 一律不帶）。
// 登入狀態讀的是各 CLI 自己在 HOME 底下的憑證檔，不靠環境變數。
const KEEP = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'TEMP', 'TMP', 'USERNAME', 'COMPUTERNAME',
  'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'LANG', 'LC_ALL', 'TERM']
export function cleanEnv(env = process.env, extra = {}) {
  const out = {}
  for (const [k, v] of Object.entries(env)) if (KEEP.includes(k.toUpperCase())) out[k] = v
  return { ...out, ...extra }
}

export class AcpClient {
  // command/args：ACP agent 的啟動方式（例如 node + gemini bundle + '--acp'）
  constructor({ command, args = [], cwd, env, log = () => {}, requestTimeoutMs = 60_000 }) {
    Object.assign(this, { command, args, cwd, env: env ?? cleanEnv(), log, requestTimeoutMs })
    this.proc = null
    this.nextId = 1
    this.pending = new Map()
    this.buf = ''
    this.chunks = new Map()      // sessionId -> 目前這輪累積的 agent_message_chunk 文字
    this.updates = []            // 收到的 session/update 種類（診斷用）
    this.initResult = null
  }

  start() {
    const proc = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.env, cwd: this.cwd })
    this.proc = proc
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', d => {
      this.buf += d
      let i
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1)
        if (line) this.#onLine(line)
      }
    })
    let errN = 0
    proc.stderr.on('data', d => { if (errN++ < 8) this.log(`stderr: ${String(d).trim().slice(0, 300)}`) })
    const down = err => {
      if (this.proc !== proc) return
      this.proc = null
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err) }
      this.pending.clear()
    }
    proc.on('error', e => down(new Error(`ACP agent 起不來：${e.message}`)))
    proc.on('exit', code => down(new Error(`ACP agent 結束了（code=${code}）`)))
    proc.stdin.on('error', () => {})
    return this
  }

  #write(obj) { this.proc?.stdin.write(JSON.stringify(obj) + '\n') }

  #onLine(line) {
    let m
    try { m = JSON.parse(line) } catch { return }
    if (m.method) return this.#onIncoming(m)                       // agent 主動的通知／請求
    if (m.id == null || !this.pending.has(m.id)) return
    const p = this.pending.get(m.id); this.pending.delete(m.id)
    clearTimeout(p.timer)
    if (m.error) p.reject(new Error(`${p.method}: ${m.error.message ?? JSON.stringify(m.error)}`))
    else p.resolve(m.result)
  }

  #onIncoming(m) {
    if (m.method === 'session/update') {
      const u = m.params?.update ?? {}
      this.updates.push(u.sessionUpdate)
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
        const sid = m.params.sessionId
        this.chunks.set(sid, (this.chunks.get(sid) ?? '') + u.content.text)
      }
      return
    }
    if (m.id == null) return                                         // 其他通知：忽略
    if (m.method === 'session/request_permission') {                // 一律拒絕：收發室不替人核准任何工具
      const opts = m.params?.options ?? []
      const reject = opts.find(o => /reject/i.test(o.kind ?? '')) ?? null
      this.#write({ jsonrpc: '2.0', id: m.id, result: { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } } })
      return
    }
    // 沒宣告的用戶端能力（fs/*、terminal/*）：回 method not found
    this.#write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } })
  }

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (!this.proc) return Promise.reject(new Error('ACP agent 沒有在跑'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: 逾時`)) }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      try { this.#write({ jsonrpc: '2.0', id, method, params }) } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e) }
    })
  }

  async initialize() {
    this.initResult = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},                                        // 不提供 fs／terminal：agent 只能用自己的工具（且權限一律被拒）
      clientInfo: { name: 'irori-relay', title: 'Irori relay', version: '0.1.0' },
    })
    return this.initResult
  }

  // 有些 agent 在 session/new 之前要先 authenticate（methodId 取自 initialize 回的 authMethods）
  authenticate(methodId, timeoutMs = 30_000) { return this.request('authenticate', { methodId }, timeoutMs) }

  newSession(cwd) { return this.request('session/new', { cwd, mcpServers: [] }) }

  // 送一句，等這一輪結束，回 { text, stopReason }
  async prompt(sessionId, text, timeoutMs = 120_000) {
    this.chunks.set(sessionId, '')
    const r = await this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, timeoutMs)
    return { text: this.chunks.get(sessionId) ?? '', stopReason: r?.stopReason ?? null }
  }

  stop() {
    const p = this.proc
    if (!p) return
    this.proc = null
    try { p.stdin.end() } catch { /* ignore */ }
    setTimeout(() => { try { p.kill() } catch { /* ignore */ } }, 1500).unref()
  }
}
