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
import { isUtf8 } from 'node:buffer'
import { cleanEnv } from './acp-client.mjs'
import { classifyFailure, WorkerError } from './acp-errors.mjs'
import { describeAgyTool, isRegisteredAgyTool, redact } from './acp-policy.mjs'

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
export function createAgyDriver({ cfg, env, log, sessionId = '', fullAccess = false, guard, spawnFn = spawn }) {
  let proc = null
  let sid = sessionId
  let resumeLost = false
  let cur = null
  let buf = Buffer.alloc(0)   // 還沒收到換行的位元組：行在位元組層切，換行之後才解碼，多位元組字元被切在兩個 data 事件之間也不會壞
  let lineNo = 0
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

  // 解讀工具步驟與檢查過程中出任何錯（例如參數巢狀太深）：當成沒通過、整輪中止（偏向擋，跟標準 ACP 那條路一樣）。
  // log 只記工具名與例外類別，不記參數內容
  function onStep(s) {
    try { handleStep(s) } catch (e) {
      if (!cur) return
      const name = redact(String(s?.tool_name ?? '')).slice(0, 60)
      const kind = String(e?.name ?? 'Error')
      cur.violation = { reason: '讀取檢查沒能完成，為了安全已中止', summary: `工具步驟檢查失敗：${name}` }
      log(`agy 工具步驟解讀或檢查出錯，當成沒通過 → kill agy：${name}（${kind}）`)
      kill('violation')
    }
  }

  // 解析不了的行：事後才看工具步驟，這一行的步驟沒經過讀取檢查，當成沒通過、整輪中止。只記行號、長度、類別，不記內容
  function onUnparsed(len, kind) {
    log(`agy 輸出第 ${lineNo} 行無法解讀（長度 ${len}，${kind}）${cur ? ' → kill agy' : '，目前沒有進行中的一輪，略過'}`)
    if (!cur) return
    if (!cur.violation) cur.violation = { reason: '工具步驟無法解讀，這一輪已中止', summary: '工具步驟無法解讀' }
    kill('violation')
  }

  function handleStep(s) {
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
    // 沒登記的工具名：類別是用關鍵字猜的、猜不出來就照執行處理，記一行 log（只記工具名，不記參數）
    if (first && !isRegisteredAgyTool(info.tool)) {
      const how = { execute: '執行', write: '寫入', network: '網路', read: '讀取' }[info.category] ?? '內部控制'
      log(`agy 工具名沒登記，類別以${how}處理：${redact(info.tool)}`)
    }
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
    for (const d of r.denied_actions ?? []) if (!denied.length) denied.push({ category: d.action === 'command' ? 'execute' : 'other', summary: redact(String(d.display_name ?? d.action ?? '')) })
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
        const p = spawnFn(cfg.command, agyArgs({ cfg, sessionId, fullAccess }), { cwd: cfg.cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
        proc = p
        p.stdout.on('data', d => {
          buf = buf.length ? Buffer.concat([buf, d]) : d
          let i
          while ((i = buf.indexOf(0x0a)) >= 0) {
            const bytes = buf.subarray(0, i); buf = buf.subarray(i + 1)
            // 這一行的位元組不是有效的 UTF-8 才算無效編碼，跟解析失敗同樣處理；
            // 合法 UTF-8 裡的替換字元（agy 讀到別的編碼的檔時寫進去的）是正常內容，照常解析
            const valid = isUtf8(bytes)
            const line = valid ? bytes.toString('utf8').trim() : ''
            if (valid && !line) continue
            lineNo++
            let ev
            if (!valid) { onUnparsed(bytes.length, 'InvalidEncoding'); continue }
            try { ev = JSON.parse(line) } catch (e) { onUnparsed(line.length, String(e?.name ?? 'Error')); continue }
            try { onEvent(ev) } catch (e) { log(`agy event handler failed: ${e.message}`) }
          }
        })
        // 讀取串流本身出錯：記 log、結束這一輪與行程，不能讀取停了行程還活著
        p.stdout.on('error', e => { log(`agy 輸出讀取出錯 → kill agy（${String(e?.name ?? 'Error')}）`); kill('stream') })
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
