// 自動發佈常駐程式「活著嗎」機制的回歸測試（#2436）：結束訊號先寫告警、巡檢（--check-alive）、心跳、不掛主控台啟動。
// 全用假環境（記憶體裡的檔案），不碰真的 %LOCALAPPDATA%。
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { parseArgs, ALERT_CAUSES, realDeps, runDaemon } from '../../../tools/release/auto_publish.mjs'
import { startViaWmi, buildCommandLine, WMI_ENV_CMDLINE, WMI_ENV_CWD } from '../../../tools/release/auto_publish_start.mjs'
import { checkAlive, handleStopSignal, installStopHandlers, writeHeartbeat, heartbeatPathOf, HEARTBEAT_STALE_MS, DEAD_MESSAGE, STUCK_MESSAGE, STOP_SIGNALS } from '../../../tools/release/auto_publish_alive.mjs'
import { env, STATE, ALERT, alertOf, lk, T0, opts, seededState } from './helpers/auto-publish-env.mjs'

const PID_FILE = path.join(path.dirname(STATE), 'auto-publish.pid')
const HB = heartbeatPathOf({ state: STATE })

// 巡檢用的假環境：多一個 startDaemon，記錄被呼叫幾次；pid 檔與心跳由各測試自己放
function aliveEnv({ pid = 7000, alive = [], hb = null, files = {}, started = 7001, startThrows = false } = {}) {
  const f = { ...files }
  if (pid !== null) f[PID_FILE] = lk(pid)
  const e = env({ files: f, alive })
  if (hb !== null) e.fsMap.set(HB, String(hb))
  e.starts = []
  e.deps.isAutoPublish = () => true
  e.deps.startDaemon = (o) => { if (startThrows) throw new Error('spawn 失敗'); e.starts.push(o); return started }
  return e
}

// ---- 結束訊號：先寫告警再結束

test('收到 SIGINT：先寫 daemon-stopped 告警（含訊號與時間），再結束', () => {
  const e = env()
  const exits = []
  const order = []
  const proc = { on() {}, exit: (c) => { order.push(e.fsMap.has(ALERT) ? 'alert-first' : 'no-alert'); exits.push(c) } }
  handleStopSignal('SIGINT', opts, e.deps, proc)
  assert.deepEqual(exits, [0])
  assert.deepEqual(order, ['alert-first'], '告警要在結束之前就寫好')
  const a = alertOf(e).alerts['daemon-stopped']
  assert.equal(a.status, 'active')
  assert.equal(a.reason, 'SIGINT')
  assert.match(a.message, /SIGINT/)
  assert.match(a.message, new RegExp(new Date(T0).toISOString()))
})

test('installStopHandlers：每種結束訊號（含主控台關閉的 SIGHUP、SIGBREAK）都掛上處理，觸發後寫告警並結束', () => {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) assert.ok(STOP_SIGNALS.includes(sig), `少了 ${sig}`)
  for (const sig of STOP_SIGNALS) {
    const e = env()
    const proc = new EventEmitter()
    const exits = []
    proc.exit = (c) => exits.push(c)
    installStopHandlers(opts, e.deps, proc)
    proc.emit(sig)
    assert.deepEqual(exits, [0], sig)
    assert.equal(alertOf(e).alerts['daemon-stopped'].reason, sig)
  }
})

test('告警寫不成也要結束，不卡在結束訊號裡', () => {
  const e = env()
  e.deps.writeFile = () => { throw new Error('磁碟滿了') }
  const exits = []
  handleStopSignal('SIGTERM', opts, e.deps, { exit: (c) => exits.push(c) })
  assert.deepEqual(exits, [0])
})

// ---- 心跳

test('writeHeartbeat：寫進與 state 同資料夾的心跳檔，內容是毫秒時間戳', () => {
  const e = env()
  writeHeartbeat(opts, e.deps)
  assert.equal(path.dirname(HB), path.dirname(path.join(STATE)))
  assert.equal(e.fsMap.get(HB), String(T0))
})

// ---- 巡檢

test('巡檢：pid 在、心跳新鮮 → 什麼都不做（不寫告警、不貼群組、不啟動）', () => {
  const e = aliveEnv({ alive: [7000], hb: T0 - 60_000 })
  const r = checkAlive(opts, e.deps)
  assert.equal(r.outcome, 'alive')
  assert.equal(r.code, 0)
  assert.equal(e.starts.length, 0)
  assert.equal(e.calls.posts.length, 0)
  assert.equal(e.fsMap.has(ALERT), false)
})

test('巡檢：pid 檔指到的程序不在 → 寫 daemon-dead 告警、貼群組、重新啟動', () => {
  const e = aliveEnv({ alive: [], hb: T0 - 60_000 })
  const r = checkAlive(opts, e.deps)
  assert.equal(r.outcome, 'restarted')
  const a = alertOf(e).alerts['daemon-dead']
  assert.equal(a.status, 'active')
  assert.equal(a.reason, 'not-running')
  assert.equal(a.message, DEAD_MESSAGE)
  assert.deepEqual(e.calls.posts, [DEAD_MESSAGE])
  assert.equal(e.starts.length, 1)
  assert.equal(e.starts[0].state, STATE)
})

test('巡檢：完全沒有 pid 檔（從沒跑過、或被清掉）也算沒在跑', () => {
  const e = aliveEnv({ pid: null })
  assert.equal(checkAlive(opts, e.deps).outcome, 'restarted')
  assert.equal(alertOf(e).alerts['daemon-dead'].status, 'active')
})

test('巡檢：pid 被別的程式重用（命令列不是 auto_publish）→ 當成沒在跑', () => {
  const e = aliveEnv({ alive: [7000], hb: T0 })
  e.deps.isAutoPublish = () => false
  assert.equal(checkAlive(opts, e.deps).outcome, 'restarted')
})

test('巡檢：pid 在但心跳超過 10 分鐘 → 寫告警、貼群組，但不重啟（它還活著）', () => {
  const e = aliveEnv({ alive: [7000], hb: T0 - HEARTBEAT_STALE_MS - 1000 })
  const r = checkAlive(opts, e.deps)
  assert.equal(r.outcome, 'stuck')
  assert.equal(r.code, 0, '只告警：回非 0 會讓排程以為失敗而重跑')
  const a = alertOf(e).alerts['daemon-dead']
  assert.equal(a.reason, 'heartbeat-stale')
  assert.equal(a.message, STUCK_MESSAGE)
  assert.deepEqual(e.calls.posts, [STUCK_MESSAGE])
  assert.equal(e.starts.length, 0)
})

test('巡檢：pid 在、心跳在 10 分鐘內邊界 → 不動作', () => {
  const e = aliveEnv({ alive: [7000], hb: T0 - HEARTBEAT_STALE_MS })
  assert.equal(checkAlive(opts, e.deps).outcome, 'alive')
})

test('巡檢：pid 在、沒有心跳檔 → 當成心跳過期（舊版程式或剛升級）', () => {
  const e = aliveEnv({ alive: [7000] })
  assert.equal(checkAlive(opts, e.deps).outcome, 'stuck')
})

test('巡檢：發佈子程序執行中（state 有 inflight 且未逾時）心跳沒更新是正常的，不告警', () => {
  const inflight = { key: 'desktop@0.2.99', step: 'publish', startedAt: new Date(T0 - 30 * 60_000).toISOString(), pid: 7000, platform: 'desktop', tag: 'v0.2.99', runId: '1' }
  const e = aliveEnv({ alive: [7000], hb: T0 - 30 * 60_000, files: { [STATE]: JSON.stringify(seededState({ inflight })) } })
  const r = checkAlive(opts, e.deps)
  assert.equal(r.outcome, 'busy')
  assert.equal(e.fsMap.has(ALERT), false)
})

test('巡檢：inflight 已經超過 2 小時不再算發佈中 → 照樣告警', () => {
  const inflight = { key: 'desktop@0.2.99', step: 'publish', startedAt: new Date(T0 - 3 * 3600_000).toISOString(), pid: 7000, platform: 'desktop', tag: 'v0.2.99', runId: '1' }
  const e = aliveEnv({ alive: [7000], hb: T0 - 3 * 3600_000, files: { [STATE]: JSON.stringify(seededState({ inflight })) } })
  assert.equal(checkAlive(opts, e.deps).outcome, 'stuck')
})

test('巡檢：同一原因連續巡檢不重複貼群組，告警次數累加；恢復後標成已恢復', () => {
  const e = aliveEnv({ alive: [] })
  checkAlive(opts, e.deps)
  checkAlive(opts, e.deps)
  assert.equal(e.calls.posts.length, 1)
  assert.equal(alertOf(e).alerts['daemon-dead'].count, 2)
  // 程式被拉起來、心跳也新鮮了
  e.deps.pidAlive = (p) => p === 7000
  e.fsMap.set(HB, String(T0))
  assert.equal(checkAlive(opts, e.deps).outcome, 'alive')
  assert.equal(alertOf(e).alerts['daemon-dead'].status, 'resolved')
})

test('巡檢：群組寄不出去 → 原文寫 log、告警照寫、仍然重啟，不丟例外', () => {
  const e = aliveEnv({ alive: [] })
  e.deps.asnCli = () => ({ status: 2, stdout: '', stderr: '拒絕：找不到呼叫者所屬的 Claude 視窗' })
  const r = checkAlive(opts, e.deps)
  assert.equal(r.outcome, 'restarted')
  assert.ok(e.calls.logs.some((l) => l.includes(DEAD_MESSAGE) && l.includes('原文')), '寄不出時要把原文寫進 log')
  assert.equal(alertOf(e).alerts['daemon-dead'].status, 'active')
  assert.equal(alertOf(e).alerts['post-failed'], undefined, '不借用 post-failed（它叫人跑 --post-pending，但這則不在佇列裡）')
})

test('巡檢：沒有 --room 只寫 log 與告警，不貼群組', () => {
  const e = aliveEnv({ alive: [] })
  checkAlive({ ...opts, room: null }, e.deps)
  assert.equal(e.calls.posts.length, 0)
  assert.equal(alertOf(e).alerts['daemon-dead'].status, 'active')
})

test('巡檢：重啟失敗 → 另記 daemon-start-failed 告警（也貼群組）並回非 0', () => {
  const e = aliveEnv({ alive: [], startThrows: true })
  const r = checkAlive(opts, e.deps)
  assert.equal(r.outcome, 'start-failed')
  assert.equal(r.code, 1)
  assert.equal(alertOf(e).alerts['daemon-start-failed'].reason, 'start-failed')
  assert.equal(alertOf(e).alerts['daemon-dead'].reason, 'not-running', '起不來不能把原本的告警原因蓋掉')
  assert.equal(e.calls.posts.length, 2, '沒在跑一則、起不來一則')
})

test('巡檢：起不來而且連續巡檢 4 次 → 群組各只貼一次（共 2 則），告警次數累加', () => {
  const e = aliveEnv({ alive: [], startThrows: true })
  for (let i = 0; i < 4; i++) { checkAlive(opts, e.deps); e.clock.t += 10 * 60_000 }
  assert.equal(e.calls.posts.length, 2)
  assert.equal(alertOf(e).alerts['daemon-start-failed'].count, 4)
})

test('巡檢：卡住與沒在跑交替出現 → 同一類別只貼一次群組', () => {
  const e = aliveEnv({ alive: [7000], hb: T0 - HEARTBEAT_STALE_MS - 1000 })
  checkAlive(opts, e.deps) // stuck
  e.deps.pidAlive = () => false
  checkAlive(opts, e.deps) // not-running
  e.deps.pidAlive = (p) => p === 7000
  checkAlive(opts, e.deps) // stuck
  assert.equal(e.calls.posts.length, 1)
})

test('巡檢：恢復正常後再出事才會重新貼群組', () => {
  const e = aliveEnv({ alive: [], startThrows: true })
  checkAlive(opts, e.deps)
  assert.equal(e.calls.posts.length, 2)
  e.deps.pidAlive = (p) => p === 7000
  e.fsMap.set(HB, String(T0))
  assert.equal(checkAlive(opts, e.deps).outcome, 'alive')
  assert.equal(alertOf(e).alerts['daemon-start-failed'].status, 'resolved')
  e.deps.pidAlive = () => false
  checkAlive(opts, e.deps)
  assert.equal(e.calls.posts.length, 4)
})

test('巡檢：心跳時間在未來 → 無效，當成不正常（不算新鮮）', () => {
  const e = aliveEnv({ alive: [7000], hb: T0 + 3600_000 })
  const r = checkAlive(opts, e.deps)
  assert.equal(r.outcome, 'stuck')
  assert.equal(alertOf(e).alerts['daemon-dead'].reason, 'heartbeat-invalid')
})

test('巡檢：inflight 的 pid 已經不在 → 不能拿來免告警', () => {
  const inflight = { key: 'desktop@0.2.99', step: 'publish', startedAt: new Date(T0 - 30 * 60_000).toISOString(), pid: 9999, platform: 'desktop', tag: 'v0.2.99', runId: '1' }
  const e = aliveEnv({ alive: [7000], hb: T0 - 30 * 60_000, files: { [STATE]: JSON.stringify(seededState({ inflight })) } })
  assert.equal(checkAlive(opts, e.deps).outcome, 'stuck')
})

// ---- 接線：主迴圈真的有裝停止處理、寫心跳

test('runDaemon：常駐模式會裝結束訊號處理、每輪寫心跳；收到訊號寫 daemon-stopped', async () => {
  const e = env()
  const proc = new EventEmitter()
  const exits = []
  proc.exit = (c) => exits.push(c)
  const r = await runDaemon({ ...opts, interval: 120, once: false }, e.deps, { proc, rounds: 2, sleep: async () => { e.clock.t += 120_000 } })
  assert.equal(r.code, 0)
  for (const sig of STOP_SIGNALS) assert.equal(proc.listenerCount(sig), 1, `沒裝 ${sig} 處理`)
  assert.equal(e.fsMap.get(HB), String(T0 + 120_000), '第二輪開頭的心跳')
  proc.emit('SIGTERM')
  assert.deepEqual(exits, [0])
  assert.equal(alertOf(e).alerts['daemon-stopped'].reason, 'SIGTERM')
})

test('runDaemon：--once 不裝處理、不寫心跳；拿不到單例鎖回 3', async () => {
  const e = env()
  const proc = new EventEmitter()
  await runDaemon({ ...opts, interval: 120, once: true }, e.deps, { proc, rounds: 1 })
  assert.equal(proc.listenerCount('SIGINT'), 0)
  assert.equal(e.fsMap.has(HB), false)
  const e2 = env({ files: { [PID_FILE]: lk(7000) }, alive: [7000] })
  e2.deps.isAutoPublish = () => true
  assert.equal((await runDaemon({ ...opts, interval: 120, once: false }, e2.deps, { proc: new EventEmitter(), rounds: 1 })).code, 3)
})

// ---- 啟動方式：WMI，不是 Node 的 detached

test('startDaemon：Windows 用 WMI Win32_Process.Create 啟動，命令列、工作目錄用環境變數傳；回新 pid', () => {
  const calls = []
  const run = (bin, args, o) => { calls.push({ bin, args, o }); return { status: 0, stdout: '31337\r\n', stderr: '' } }
  const d = realDeps({ state: path.resolve('/w/state.json') }, path.resolve('/repo'), { start: { run, platform: 'win32', spawnChild: () => { throw new Error('不該用 Node spawn') } } })
  const pid = d.startDaemon({ state: path.resolve('/w/state.json'), interval: 120, room: 'r1', dryRunOnly: true })
  assert.equal(pid, 31337)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].bin, 'powershell.exe')
  assert.ok(calls[0].args.join(' ').includes('Win32_Process'))
  assert.ok(calls[0].args.join(' ').includes('Create'))
  const cmdline = calls[0].o.env[WMI_ENV_CMDLINE]
  assert.ok(cmdline.includes('auto_publish.mjs'))
  for (const frag of ['--state', '--interval', '"120"', '--room', '"r1"', '--dry-run-only']) assert.ok(cmdline.includes(frag), frag)
  assert.ok(!cmdline.includes('--check-alive'), '常駐程式本體不能帶 --check-alive')
  assert.equal(calls[0].o.env[WMI_ENV_CWD], path.resolve('/repo'))
  assert.equal(calls[0].o.windowsHide, true)
})

test('startViaWmi：WMI 回非 0 或沒有 pid → 丟例外；buildCommandLine 每個參數加引號', () => {
  assert.throws(() => startViaWmi({ execPath: 'node', args: [], cwd: '/x' }, { run: () => ({ status: 1, stdout: '', stderr: '拒絕' }), platform: 'win32' }), /WMI 啟動失敗/)
  assert.throws(() => startViaWmi({ execPath: 'node', args: [], cwd: '/x' }, { run: () => ({ status: 0, stdout: '', stderr: '' }), platform: 'win32' }), /WMI 啟動失敗/)
  assert.equal(buildCommandLine('C:\\Program Files\\nodejs\\node.exe', ['a b.mjs', '--x']), '"C:\\Program Files\\nodejs\\node.exe" "a b.mjs" "--x"')
})

test('startViaWmi：非 Windows 退回 Node detached（只在 CI、開發機用）', () => {
  const seen = []
  const child = { pid: 5, on() {}, unref() { seen.push('unref') } }
  const pid = startViaWmi({ execPath: 'node', args: ['x'], cwd: '/c' }, { platform: 'linux', spawnChild: (bin, args, o) => { seen.push(o.detached); return child } })
  assert.equal(pid, 5)
  assert.deepEqual(seen, [true, 'unref'])
})

// ---- 參數與設定

test('parseArgs：--check-alive 可搭配 --room、--state、--interval；不能和其他子命令混用；告警類別可被 --ack-alert 清', () => {
  const ok = parseArgs(['--check-alive', '--room', 'r1', '--state', '/w/s.json', '--interval', '60'])
  assert.equal(ok.error, null)
  assert.equal(ok.checkAlive, true)
  for (const bad of [['--check-alive', '--once'], ['--check-alive', '--post-pending'], ['--check-alive', '--ack', 'desktop@0.2.1'], ['--check-alive', '--seed', '0.2.1']]) {
    assert.ok(parseArgs(bad).error, bad.join(' '))
  }
  assert.ok(ALERT_CAUSES.includes('daemon-stopped'))
  assert.ok(ALERT_CAUSES.includes('daemon-dead'))
  assert.equal(parseArgs(['--ack-alert', 'daemon-dead']).error, null)
})

test('ALERT_CAUSES 含 daemon-start-failed', () => {
  assert.ok(ALERT_CAUSES.includes('daemon-start-failed'))
})
