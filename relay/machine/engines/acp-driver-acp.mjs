// 標準 ACP 驅動：agent 當子行程、stdio JSON-RPC（initialize → session/new 或 session/load → session/prompt）。
// 可接任何 ACP agent：Google 官方 agy_acp_server、社群 google-antigravity-acp（包 agy，**不會**送權限請求，見 docs/AGENT-ENGINES.md）、
// Grok Build（grok agent stdio）、codex-acp、gemini --acp…
// 權限：agent 送 session/request_permission → guard.askPermission（政策 allow／deny／ask，ask 會寄信問人）→ 回 allow_once／reject_once。
import { AcpClient, cleanEnv } from './acp-client.mjs'
import { classifyFailure, WorkerError } from './acp-errors.mjs'
import { describeAcpRequest } from './acp-policy.mjs'

// guard.askPermission({category, paths, summary}) → Promise<'allow'|'deny'>
export function createAcpDriver({ cfg, env, log, sessionId = '', guard }) {
  let client = null
  let sid = sessionId
  let resumeLost = false
  let cur = null
  let exitCb = () => {}
  let stopped = false

  const finish = (fn, v) => { if (!cur) return; const c = cur; cur = null; clearTimeout(c.idleTimer); clearTimeout(c.maxTimer); fn === 'resolve' ? c.resolve(v) : c.reject(v) }
  const classify = (e, ctx = '') => {
    const tail = (client?.stderrTail ?? []).join(' | ')
    const text = `${e.message} ${e.rpcCode === -32000 ? 'authentication required' : ''} ${tail}`
    return new WorkerError(classifyFailure(text) ?? 'agent', `${ctx}${e.message}${tail ? ` | ${tail}` : ''}`.slice(0, 400))
  }

  return {
    protocol: 'acp',
    supportsRetryWithGrant: false,
    sessionId: () => sid,
    resumeLost: () => resumeLost,
    alive: () => !!client?.proc,
    touch: () => cur?.arm(),
    onExit(cb) { exitCb = cb },
    async start() {
      const childEnv = cleanEnv(env)
      for (const n of cfg.envPass) if (env[n] !== undefined) childEnv[n] = env[n]
      client = new AcpClient({
        command: cfg.command, args: cfg.args, cwd: cfg.cwd, env: childEnv, log,
        onActivity: () => cur?.arm(),
        onPermission: async params => {
          const info = describeAcpRequest(params)
          const verdict = await guard.askPermission(info)
          if (verdict !== 'allow' && cur) cur.denied.push({ category: info.category, summary: info.summary })
          return verdict
        },
        onExit: err => {
          const tail = (client?.stderrTail ?? []).join(' | ')
          if (cur) finish('reject', new WorkerError(classifyFailure(`${err.message} ${tail}`) ?? 'crash', `${err.message}${tail ? ` | ${tail}` : ''}`.slice(0, 400)))
          if (!stopped) exitCb({ stderr: tail })
        },
      }).start()
      try {
        const init = await client.initialize()
        if (cfg.authMethod) await client.authenticate(cfg.authMethod)
        const canLoad = !!init?.agentCapabilities?.loadSession
        if (sid && canLoad) {
          try { await client.loadSession(sid, cfg.cwd) } catch (e) { log(`session/load 失敗，改開新的：${e.message}`); resumeLost = true; sid = '' }
        } else if (sid) { resumeLost = true; sid = '' }
        if (!sid) sid = (await client.newSession(cfg.cwd)).sessionId
      } catch (e) {
        const err = classify(e, '啟動時：')
        try { client.stop() } catch { /* ignore */ }
        throw err
      }
    },
    turn(text, { timeoutMs, maxMs }) {
      return new Promise((resolve, reject) => {
        if (!client?.proc) return reject(new WorkerError('crash', 'ACP agent 沒有在跑'))
        if (cur) return reject(new WorkerError('agent', '上一輪還沒結束'))
        const c = { resolve, reject, denied: [], idleTimer: null, maxTimer: null }
        const expire = () => { try { client.cancel(sid) } catch { /* ignore */ } finish('reject', new WorkerError('timeout', '逾時')); try { client.stop() } catch { /* ignore */ } }
        c.arm = () => { clearTimeout(c.idleTimer); c.idleTimer = setTimeout(expire, timeoutMs) }
        c.maxTimer = setTimeout(expire, maxMs)
        cur = c
        c.arm()
        client.prompt(sid, text, maxMs + 5000).then(r => {
          if (r.stopReason === 'cancelled') return finish('reject', new WorkerError('agent', 'agent 取消了這一輪'))
          finish('resolve', { text: r.text, denied: c.denied, sessionId: sid, stopReason: r.stopReason })
        }, e => finish('reject', classify(e)))
      })
    },
    stop() { stopped = true; if (cur) finish('reject', new WorkerError('stopped', '工作者被停止')); try { client?.stop() } catch { /* ignore */ } },
  }
}
