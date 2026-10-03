// agy（Antigravity CLI）原生 stream-json 驅動：長駐一個 `agy --input-format stream-json --output-format stream-json`，
// 一行一則 NDJSON；每輪送 {"event":"user","message":{"content":"…"}}，讀到 {"event":"result"} 結束。同一個行程＝同一個 conversation。
// 格式來自實測（agy 1.2.16，Windows）：
//   {"event":"init","conversation_id":"…","init":{cwd,tools}}      ← 第一則使用者訊息之後才會出現
//   {"event":"step_update","step_update":{step_type:"tool"|"agent_response"|"user_input", state:"ACTIVE"|"DONE"|"ERROR", tool_name, tool_info:{parameters}, text_delta}}
//   {"event":"result","result":{status:"SUCCESS"|"ERROR", response, error?, denied_actions?:[{action,display_name}], conversation_id}}
// 權限的現實（實測，也是為什麼要有 guard）：agy 無頭模式不能問人。指令（run_command）會被它自己自動拒絕；
// 但寫檔（write_to_file…）在無頭模式下不問就直接寫，連工作資料夾之外也寫得進去。所以這裡看每個工具步驟的事件，
// 違反政策就立刻殺掉行程（絆線：能擋住後續動作並明確回報，但那一次寫入可能已經發生）。
import { spawn } from 'node:child_process'
import { cleanEnv } from './acp-client.mjs'
import { classifyFailure, WorkerError } from './acp-errors.mjs'
import { describeAgyTool } from './acp-policy.mjs'

// cfg.args 放最前面（可放額外旗標；測試時放假 agy 的腳本路徑），後面才是這個驅動需要的旗標
export function agyArgs({ cfg, sessionId, fullAccess }) {
  return [
    ...cfg.args,
    '--input-format', 'stream-json', '--output-format', 'stream-json',
    ...(cfg.model ? ['--model', cfg.model] : []),
    ...(sessionId ? ['--conversation', sessionId] : []),
    ...(fullAccess ? ['--dangerously-skip-permissions'] : []),
  ]
}

// guard.checkTool({category, paths, summary, state}) → { ok: true } | { ok: false, reason }
export function createAgyDriver({ cfg, env, log, sessionId = '', fullAccess = false, guard }) {
  let proc = null
  let sid = sessionId
  let resumeLost = false
  let cur = null
  let buf = ''
  let stderrTail = []
  let exitCb = () => {}
  let killedBy = null

  const finish = (fn, v) => { if (!cur) return; const c = cur; cur = null; clearTimeout(c.idleTimer); clearTimeout(c.maxTimer); fn === 'resolve' ? c.resolve(v) : c.reject(v) }
  const kill = why => { killedBy = why; try { proc?.kill() } catch { /* ignore */ } }

  function onEvent(ev) {
    if (cur) cur.arm()
    if (ev.event === 'init') {
      if (sessionId && ev.conversation_id && ev.conversation_id !== sessionId) { resumeLost = true; log(`agy 找不到先前的 conversation ${sessionId}，已開新的 ${ev.conversation_id}`) }
      if (ev.conversation_id) sid = ev.conversation_id
      return
    }
    if (ev.event === 'step_update' && cur) return onStep(ev.step_update ?? {})
    if (ev.event === 'result' && cur) return onResult(ev.result ?? {})
  }

  function onStep(s) {
    if (s.conversation_id && !sid) sid = s.conversation_id
    if (s.step_type !== 'tool') return
    const info = describeAgyTool(s.tool_name, s.tool_info?.parameters)
    const key = `${s.step_index}`
    if (s.state === 'ERROR') {
      const msg = String(s.tool_info?.error?.message ?? '')
      if (/permission check failed|user denied permission/i.test(msg)) cur.denied.push({ category: info.category, summary: info.summary })
      return
    }
    const first = !cur.seen.has(key)
    cur.seen.add(key)
    const verdict = guard.checkTool({ ...info, state: s.state, firstSight: first })
    if (verdict && verdict.ok === false) {
      cur.violation = { reason: verdict.reason, summary: info.summary }
      log(`policy violation: ${info.summary} (${verdict.reason}) → kill agy`)
      kill('violation')
    }
  }

  function onResult(r) {
    if (r.conversation_id) sid = r.conversation_id
    if (cur.violation) return finish('reject', new WorkerError('violation', cur.violation.reason, { summary: cur.violation.summary }))
    const denied = [...cur.denied]
    for (const d of r.denied_actions ?? []) if (!denied.length) denied.push({ category: d.action === 'command' ? 'execute' : 'other', summary: String(d.display_name ?? d.action ?? '') })
    if (String(r.status ?? '').toUpperCase() === 'SUCCESS') return finish('resolve', { text: String(r.response ?? ''), denied, sessionId: sid, usage: r.usage ?? null })
    const err = String(r.error ?? r.status ?? '原因不明')
    finish('reject', new WorkerError(classifyFailure(err) ?? 'agent', err.slice(0, 400)))
  }

  return {
    protocol: 'agy-stream',
    supportsRetryWithGrant: true,
    fullAccess,
    sessionId: () => sid,
    resumeLost: () => resumeLost,
    alive: () => !!proc,
    touch: () => cur?.arm(),
    onExit(cb) { exitCb = cb },
    async start() {
      const childEnv = cleanEnv(env)
      for (const n of cfg.envPass) if (env[n] !== undefined) childEnv[n] = env[n]
      await new Promise((resolve, reject) => {
        const p = spawn(cfg.command, agyArgs({ cfg, sessionId, fullAccess }), { cwd: cfg.cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
        proc = p
        p.stdout.setEncoding('utf8')
        p.stdout.on('data', d => {
          buf += d
          let i
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
            if (!line) continue
            try { onEvent(JSON.parse(line)) } catch (e) { if (!(e instanceof SyntaxError)) log(`agy event handler failed: ${e.message}`) }
          }
        })
        p.stderr.on('data', d => { stderrTail = [...stderrTail, String(d).trim().slice(0, 300)].slice(-5) })
        p.stdin.on('error', () => {})
        p.once('spawn', resolve)
        p.once('error', e => { proc = null; reject(new WorkerError('crash', `起不來：${e.message}`, { spawnFailed: true })); finish('reject', new WorkerError('crash', e.message)) })
        p.once('exit', (code, signal) => {
          if (proc === p) proc = null
          const tail = stderrTail.join(' | ')
          if (cur) {
            if (killedBy === 'violation' && cur.violation) finish('reject', new WorkerError('violation', cur.violation.reason, { summary: cur.violation.summary }))
            else if (killedBy === 'timeout') finish('reject', new WorkerError('timeout', '逾時'))
            else if (killedBy === 'stop') finish('reject', new WorkerError('stopped', '工作者被停止'))
            else finish('reject', new WorkerError(classifyFailure(tail) ?? 'crash', `行程結束了（code=${code ?? signal}）${tail ? '：' + tail : ''}`))
          }
          exitCb({ code, signal, stderr: tail })
        })
      })
    },
    // 送一輪。timeoutMs：這麼久完全沒有事件就中止；maxMs：一輪的總上限
    turn(text, { timeoutMs, maxMs }) {
      return new Promise((resolve, reject) => {
        if (!proc) return reject(new WorkerError('crash', 'agy 行程沒有在跑'))
        if (cur) return reject(new WorkerError('agent', '上一輪還沒結束'))
        const c = { resolve, reject, denied: [], seen: new Set(), idleTimer: null, maxTimer: null, violation: null }
        c.arm = () => { clearTimeout(c.idleTimer); c.idleTimer = setTimeout(() => kill('timeout'), timeoutMs) }
        c.maxTimer = setTimeout(() => kill('timeout'), maxMs)
        cur = c
        c.arm()
        try { proc.stdin.write(JSON.stringify({ event: 'user', message: { content: text } }) + '\n') } catch (e) { finish('reject', new WorkerError('crash', e.message)) }
      })
    },
    stop() { if (proc) { kill('stop'); } },
  }
}
