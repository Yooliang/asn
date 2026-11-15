// 對話釘選的帳號層同步（電腦版與手機版共用，#1479 第二部分，0.2.27）。純邏輯，不碰 DOM。
// 後台（asn_account_chat_pins）的規則：rev 是遞增版本號，寫入的 rev 必須是後台現有 rev＋1，否則不寫入、回現有那份並標 stale；
// 後台不合併，合併在這裡：mergePins（同一個 id 看 pins／unpinned 誰的 at 新，at 相同釘選勝）。
// 一次同步的流程：讀後台那份 → mergePins(本機, 後台) → 合併後內容跟後台一樣就不送 → 否則以「後台 rev＋1」送出
//   → 回 stale 就用回來的那份再合併重送（最多 MAX_SEND 次）→ 回 rate_limited 就等一會兒再送（不立刻連打）
//   → 成功後本機存成後台回來的那份。後台還沒有任何一份時用本機的 rev（至少 1）送；兩邊都空就什麼都不做。
// 沒登入或後台還沒部署新動作就靜默略過，本機照舊存檔，行為跟只存本機的 0.2.26 一樣。
import { mergePins, normalizePins } from './chat-pins.mjs'

export const MAX_SEND = 3            // 一次同步最多送幾次（遇到 stale 就合併後重送）
export const COOLDOWN_RETRY_MS = 2500 // 後台說太頻繁（2 秒冷卻）時，等這麼久再送
export const PUSH_DEBOUNCE_MS = 1500  // 本機釘選或取消之後，等這麼久沒再動才同步
export const PULL_EVERY_MS = 120_000  // 定時看一次別台有沒有更新

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
/** 內容的比對鍵：只看釘選與取消紀錄（不看 rev），順序不影響 */
export const canonPins = s => {
  const n = normalizePins(s)
  return JSON.stringify([[...n.pins].sort(byId).map(p => [p.id, p.at]), [...n.unpinned].sort(byId).map(p => [p.id, p.at])])
}
const isEmpty = s => { const n = normalizePins(s); return n.pins.length === 0 && n.unpinned.length === 0 }
const toBody = (s, rev) => { const n = normalizePins(s); return { pins: n.pins, unpinned: n.unpinned, rev } }

/**
 * 同步一次。回 { status, state?, sent }：
 *   status：'noop'（不用送）｜'synced'（送成功）｜'gaveup'（stale 重送次數用完或冷卻一直沒過，下次再說）
 *   state：要存回本機的那份（noop 與 synced 才有）；sent＝實際送了幾次
 * api＝{ get(): { pins } , set(body): { pins, stale, rate_limited } }；wait(ms)＝等一會兒（測試可注入）；
 * getLocal()＝取本機現在的那份（每次送之前重新取，等待期間使用者又釘了也不會漏）
 */
export async function syncPinsOnce({ getLocal, api, wait, maxSend = MAX_SEND, cooldownMs = COOLDOWN_RETRY_MS }) {
  let remote = (await api.get())?.pins ?? null
  remote = remote ? normalizePins(remote) : null
  let sent = 0
  let cooldowns = 0
  while (sent < maxSend) {
    const local = normalizePins(getLocal())
    if (!remote && isEmpty(local)) return { status: 'noop', sent }
    const merged = remote ? mergePins(local, remote) : local
    // 合併後跟後台一樣：不送（本機改成後台那份，連 rev 也跟上）
    if (remote && canonPins(merged) === canonPins(remote)) return { status: 'noop', state: remote, sent }
    const rev = remote ? remote.rev + 1 : Math.max(1, local.rev)
    sent++
    const r = await api.set(toBody(merged, rev))
    if (r?.rate_limited) {
      sent--   // 沒寫進去，不算一次重送；但冷卻等太多次也放棄
      if (++cooldowns > maxSend) return { status: 'gaveup', sent }
      await wait(cooldownMs)
      continue
    }
    if (r?.stale && r.pins) { remote = normalizePins(r.pins); continue }   // 別台先寫了：用回來的那份再合併重送
    if (!r?.pins) return { status: 'gaveup', sent }   // 後台沒回東西（還沒部署等）：當作這次沒成功，不改本機
    return { status: 'synced', state: normalizePins(r.pins), sent }
  }
  return { status: 'gaveup', sent }
}

/**
 * 同步控制器。getPins()／setPins(state)＝讀寫本機那份（電腦版是 chatPins ref，手機版是 prefs.chatPins）；
 * api＝{ get, set }；canSync()＝有登入才同步。schedule／clear／wait 可注入（測試用）。
 */
export function createPinsSync({ getPins, setPins, api, canSync = async () => true, schedule = setTimeout, clear = clearTimeout, wait = ms => new Promise(r => schedule(r, ms)), debounceMs = PUSH_DEBOUNCE_MS, everyMs = PULL_EVERY_MS, onError = () => {} }) {
  let lastCanon = canonPins(getPins()), timer = null, poll = null, busy = false, again = false, stopped = false
  async function run() {
    if (stopped) return
    if (busy) { again = true; return }
    busy = true
    try {
      if (!(await canSync())) return
      const startCanon = canonPins(getPins())
      const r = await syncPinsOnce({ getLocal: getPins, api, wait })
      if (r.state) {
        // 同步期間使用者又改了本機：把新的改動併進後台回來的那份，下面再排一次推送
        const cur = getPins()
        const changed = canonPins(cur) !== startCanon
        const next = changed ? mergePins(cur, r.state) : r.state
        setPins(next)
        if (changed) again = true
      }
      lastCanon = canonPins(getPins())
    } catch (e) { onError(e) } finally {
      busy = false
      if (again && !stopped) { again = false; requestPush() }
    }
  }
  function requestPush() {
    if (stopped || timer) return
    timer = schedule(() => { timer = null; void run() }, debounceMs)
  }
  /** 本機釘選可能變了（監看到 chatPins 變動就呼叫）：內容真的變了才排同步（內容沒變只是 rev 動，不送） */
  function noteLocal() {
    const c = canonPins(getPins())
    if (c === lastCanon) return
    lastCanon = c
    requestPush()
  }
  function start() {
    stopped = false
    void run()
    poll = schedule(function tick() { void run(); poll = schedule(tick, everyMs) }, everyMs)
  }
  function stop() { stopped = true; if (timer) clear(timer); if (poll) clear(poll); timer = poll = null }
  return { start, stop, run, noteLocal, requestPush }
}
