// 自動發佈常駐程式的「活著嗎」機制（#2436）：心跳、收到結束訊號先寫告警、巡檢（--check-alive）。
// 背景：常駐程式被主控台關閉事件打死（結束碼 0xC000013A）後停了 3 小時沒人知道。
// 防線分三層：
//   1. 啟動時不掛主控台（auto_publish.mjs 的 startDaemon），收不到關閉事件；
//   2. 仍收到結束訊號時，先寫 daemon-stopped 告警再結束；
//   3. 被 /F 強砍時程式來不及寫任何東西，靠排程每 10 分鐘跑 --check-alive：pid 不在或心跳過期就寫告警、貼群組並重啟。
// 告警與群組文案一律是固定句，不放任何子程序或檔案裡的原文。
import path from 'node:path'
import { makeAlerts, alertPathOf, pidFileOf, parseLock, atomicWrite, makePost } from './auto_publish.mjs'
import { STALE_MS } from './auto_publish_core.mjs'

export const HEARTBEAT_FILE = 'auto-publish.heartbeat'
export const HEARTBEAT_STALE_MS = 10 * 60 * 1000
export const heartbeatPathOf = (opts) => path.join(path.dirname(opts.state), HEARTBEAT_FILE)

export const DEAD_MESSAGE = '自動發佈常駐程式沒有在執行，已嘗試重新啟動；請確認它有起來，並查 log 看為什麼停止'
export const STUCK_MESSAGE = '自動發佈常駐程式還在，但超過 10 分鐘沒有動靜（可能卡住），請查 log；確定卡死時只停它自己的 pid 再由巡檢拉起'
export const START_FAILED_MESSAGE = '自動發佈常駐程式沒有在執行，而且重新啟動失敗，請人工處理'
export const stoppedMessage = (sig, atIso) => `自動發佈常駐程式收到 ${sig} 訊號而結束（${atIso}）`

// 心跳：內容是毫秒時間戳。每輪開頭寫一次（子程序執行期間事件迴圈是卡住的，所以發佈中的長時間無心跳由巡檢另外判斷）
export function writeHeartbeat(opts, deps) {
  try { atomicWrite(deps, heartbeatPathOf(opts), String(deps.now())) } catch (e) { deps.log(`寫心跳檔失敗（不影響發版）：${e.message}`) }
}

// 收到結束訊號：先寫 daemon-stopped 告警（時間、訊號）再結束。proc 只要有 on、exit 兩個方法（測試用假的）
export function handleStopSignal(sig, opts, deps, proc = process) {
  try {
    makeAlerts(opts, deps).raise('daemon-stopped', sig, stoppedMessage(sig, new Date(deps.now()).toISOString()))
    deps.log(`收到 ${sig} 訊號，已寫 daemon-stopped 告警，常駐程式結束`)
  } catch { /* 寫不成也要結束，不能卡在這裡 */ }
  proc.exit(0)
}

export const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']
export function installStopHandlers(opts, deps, proc = process) {
  for (const sig of STOP_SIGNALS) proc.on(sig, () => handleStopSignal(sig, opts, deps, proc))
}

const readJson = (deps, p) => { try { return JSON.parse(deps.readFile(p)) } catch { return null } }

// 同一個類別已經是 active 就不再重貼群組（不看原因：stuck 與 not-running 交替也只貼一次；告警檔自己會累計次數）。
// 恢復正常（標成 resolved）之後再出事才會重新貼
const alreadyAlerted = (opts, deps, cause) => readJson(deps, alertPathOf(opts))?.alerts?.[cause]?.status === 'active'

// 常駐程式是不是活著：pid 檔裡的 pid 還在、而且命令列確實是 auto_publish（查不到命令列時保守當作活著）
function daemonPid(opts, deps) {
  let pid = NaN
  try { pid = parseLock(deps.readFile(pidFileOf(opts))).pid } catch { /* 沒有 pid 檔＝沒在跑 */ }
  if (!Number.isFinite(pid) || !deps.pidAlive(pid)) return null
  const who = typeof deps.isAutoPublish === 'function' ? deps.isAutoPublish(pid) : true
  return who === false ? null : pid
}

// 發佈子程序執行中（state 的 inflight 還沒超過 STALE_MS）：事件迴圈被 spawnSync 卡住，心跳不會更新，不算卡住
// inflight 記的 pid 也要還活著，否則是程式當掉留下的標記，不能拿來免告警
function publishInFlight(opts, deps) {
  const inf = readJson(deps, opts.state)?.inflight
  const started = Date.parse(inf?.startedAt)
  return Number.isFinite(started) && deps.now() - started <= STALE_MS && Number.isFinite(inf?.pid) && deps.pidAlive(inf.pid)
}

// 巡檢；回 { code, outcome, msg }
// outcome：alive（正常）、busy（發佈中、心跳沒更新但正常）、stuck（pid 在但心跳過期，只告警不動它）、
//          restarted（沒在跑，已告警並重新啟動）、start-failed（沒在跑，重啟失敗）
export function checkAlive(opts, deps) {
  const alerts = makeAlerts(opts, deps)
  const post = makePost(opts, deps, alerts)
  const notify = (cause, reason, message) => {
    const first = !alreadyAlerted(opts, deps, cause)
    alerts.raise(cause, reason, message)
    if (first) {
      // 巡檢不在 Claude 視窗底下，asn-cli 可能寄不出；寄不出就把原文寫進 log（告警檔也已記）。不另寫 post-failed：它的固定句是叫人跑 --post-pending，而這種訊息不在待貼佇列裡
      if (!post(message, { noAlert: true })) deps.log(`巡檢的群組通知沒貼成，原文：${message}`)
    }
  }

  const pid = daemonPid(opts, deps)
  if (pid !== null) {
    let hb = NaN
    try { hb = Number(deps.readFile(heartbeatPathOf(opts))) } catch { /* 沒有心跳檔＝沒有心跳 */ }
    const now = deps.now()
    // 心跳時間在未來（時鐘被調、檔案被改）不可信，當成無效
    const future = Number.isFinite(hb) && hb > now
    const fresh = Number.isFinite(hb) && !future && now - hb <= HEARTBEAT_STALE_MS
    if (fresh) {
      alerts.resolve('daemon-dead')
      alerts.resolve('daemon-start-failed')
      return { code: 0, outcome: 'alive', msg: `常駐程式在跑（pid ${pid}）` }
    }
    if (!future && publishInFlight(opts, deps)) return { code: 0, outcome: 'busy', msg: `常駐程式在跑（pid ${pid}），正在發佈，心跳沒更新屬正常` }
    notify('daemon-dead', future ? 'heartbeat-invalid' : 'heartbeat-stale', STUCK_MESSAGE)
    deps.log(`巡檢：pid ${pid} 還在但心跳${future ? '時間在未來（無效）' : '超過 10 分鐘沒更新'}`)
    // 只告警：回 0，免得排程把它當失敗而重跑
    return { code: 0, outcome: 'stuck', msg: STUCK_MESSAGE }
  }

  notify('daemon-dead', 'not-running', DEAD_MESSAGE)
  deps.log('巡檢：找不到執行中的自動發佈常駐程式，重新啟動')
  try {
    const started = deps.startDaemon(opts)
    deps.log(`巡檢：已啟動常駐程式（pid ${started ?? '未知'}）`)
    alerts.resolve('daemon-start-failed')
    return { code: 0, outcome: 'restarted', msg: `${DEAD_MESSAGE}（新 pid ${started ?? '未知'}）` }
  } catch (e) {
    deps.log(`巡檢：啟動常駐程式失敗：${e.message}`)
    notify('daemon-start-failed', 'start-failed', START_FAILED_MESSAGE)
    return { code: 1, outcome: 'start-failed', msg: START_FAILED_MESSAGE }
  }
}
