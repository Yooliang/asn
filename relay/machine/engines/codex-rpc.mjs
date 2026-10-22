// codex app-server 的最小 JSON-RPC 客戶端（stdio、一行一則 JSON）。
// 協定是實驗性的（codex app-server generate-json-schema 可產生當版 schema），所以這裡只用到最少的方法，
// 而且收發室只用「讀」類的方法（thread/list／read／turns/list、account/*）；絕不 thread/resume——
// 一旦在這個行程載入某個 thread，它就變成這個行程在持有（會搶走使用者視窗的佇列、也會佔 thread-writer-lock）。
import { spawn } from 'node:child_process'

export class AppServerClient {
  // codex：resolveCodex() 的結果；env：給子行程的環境
  constructor({ codex, env, cwd, log = () => {}, requestTimeoutMs = 20_000, clientName = 'asn' }) {
    Object.assign(this, { codex, env, cwd, log, requestTimeoutMs, clientName })
    this.proc = null
    this.ready = null
    this.nextId = 1
    this.pending = new Map()
    this.buf = ''
  }

  get alive() { return !!this.proc }

  #spawn() {
    const proc = spawn(this.codex.command, [...this.codex.pre, 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.env, cwd: this.cwd })
    this.proc = proc
    this.buf = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', d => {
      this.buf += d
      let i
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1)
        if (line) this.#onLine(line)
      }
    })
    let errLogged = 0
    proc.stderr.on('data', d => { if (errLogged++ < 5) this.log(`codex app-server stderr: ${String(d).trim().slice(0, 300)}`) })
    const down = err => {
      if (this.proc !== proc) return
      this.proc = null; this.ready = null
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
    }
    proc.on('error', e => down(new Error(`codex app-server 起不來：${e.message}`)))
    proc.on('exit', code => down(new Error(`codex app-server 結束了（code=${code}）`)))
    proc.stdin.on('error', () => {})
    return proc
  }

  #onLine(line) {
    let m
    try { m = JSON.parse(line) } catch { return }
    if (m.id == null || !this.pending.has(m.id)) return   // 通知（notification）與伺服器主動請求：reader 一律忽略
    const p = this.pending.get(m.id); this.pending.delete(m.id)
    clearTimeout(p.timer)
    if (m.error) p.reject(new Error(`${p.method}: ${m.error.message ?? JSON.stringify(m.error)}`))
    else p.resolve(m.result)
  }

  #send(method, params) {
    const proc = this.proc
    if (!proc) return Promise.reject(new Error('codex app-server 沒有在跑'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: 逾時`)) }, this.requestTimeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      try { proc.stdin.write(JSON.stringify({ id, method, params }) + '\n') } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e) }
    })
  }

  async #start() {
    this.#spawn()
    await this.#send('initialize', { clientInfo: { name: this.clientName, title: this.clientName, version: '0.1.0' } })
    this.proc?.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
  }

  // 第一次呼叫（或行程掛掉之後）自動啟動並完成 initialize
  async request(method, params) {
    if (!this.proc) { this.ready = this.#start().catch(e => { this.close(); throw e }) }
    await this.ready
    return this.#send(method, params)
  }

  close() {
    const proc = this.proc
    this.proc = null; this.ready = null
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('codex app-server 已關閉')) }
    this.pending.clear()
    if (!proc) return Promise.resolve()
    return new Promise(resolve => {
      const done = () => { clearTimeout(t); resolve() }
      const t = setTimeout(() => { try { proc.kill() } catch {} ; resolve() }, 3000)
      proc.once('exit', done)
      try { proc.stdin.end() } catch {}
    })
  }
}
