// 設備順序同步（電腦版與手機版共用）：deviceOrder／deviceShown／deviceRemoved 放到帳號層（後台 account_device_prefs 動作）。
// 規則（小良哥拍板）：整份以 rev（毫秒時間戳）較新的為準（last-writer-wins）；removed 也同步；
// 只有「後台還是空的、這台從沒同步過、本機有舊值」的第一次升級才用聯集當起點。
// 各機器自己 prune，只有內容真的變了才更新 rev 並推送，內容沒變不推（避免兩台一直互相覆蓋）。
// 推送節流至少 5 秒、同內容不重送；本機仍照舊存 asn-me.json 當離線快取；沒登入或後台還沒部署新動作就靜默略過。
import { normalizeKeys } from './device-order.mjs'

export const PUSH_GAP_MS = 5000
export const PULL_EVERY_MS = 120_000

const lists = p => [normalizeKeys(p?.deviceOrder ?? p?.order), normalizeKeys(p?.deviceShown ?? p?.shown), normalizeKeys(p?.deviceRemoved ?? p?.removed)]
export const canon = p => JSON.stringify(lists(p))
export const isEmptyPrefs = p => lists(p).every(a => a.length === 0)
const uniq = (...arrs) => normalizeKeys(arrs.flat())

/** 本機設定 → 後台格式 */
export const toRemote = p => { const [order, shown, removed] = lists(p); return { order, shown, removed, rev: Number.isSafeInteger(p?.deviceRev) && p.deviceRev > 0 ? p.deviceRev : 0 } }

/** 第一次升級的起點：順序以後台的為底、本機多出來的接在後面；shown／removed 取聯集；rev 一定比兩邊都新 */
export function unionSeed(remote, local, now) {
  const r = lists(remote), l = lists(local)
  const rrev = Number.isSafeInteger(remote?.rev) ? remote.rev : 0
  const lrev = Number.isSafeInteger(local?.deviceRev) ? local.deviceRev : 0
  return { order: uniq(r[0], l[0]), shown: uniq(r[1], l[1]), removed: uniq(r[2], l[2]), rev: Math.max(now, rrev + 1, lrev + 1) }
}

/**
 * 拿到後台那份之後該做什麼：
 *   { action: 'none' }｜{ action: 'adopt', next }（改採用後台的）｜{ action: 'push', next? }（本機要推上去；有 next 就先把本機改成 next 再推）
 * local 是本機的 { deviceOrder, deviceShown, deviceRemoved, deviceRev, deviceSynced }；remote 是後台的 { order, shown, removed, rev } 或 null
 */
export function decide({ local, remote, now }) {
  const synced = local?.deviceSynced === true
  const lrev = Number.isSafeInteger(local?.deviceRev) ? local.deviceRev : 0
  if (!remote) return isEmptyPrefs(local) ? { action: 'none', markSynced: true } : { action: 'push', next: lrev > 0 ? undefined : { ...toRemote(local), rev: now } }
  const same = canon(local) === canon(remote)
  if (!synced) {
    if (isEmptyPrefs(local)) return { action: 'adopt', next: remote }
    if (same) return { action: 'adopt', next: remote }
    return { action: 'push', next: unionSeed(remote, local, now) }
  }
  if (same) return remote.rev > lrev ? { action: 'adopt', next: remote } : { action: 'none' }
  return lrev > remote.rev ? { action: 'push' } : { action: 'adopt', next: remote }   // 一樣新但內容不同：後台的算（跟後台 stale 規則一致）
}

/**
 * 同步控制器。prefs 是會被改的那個 reactive 物件（devPrefs）；api＝{ get(): {prefs}, set(prefs): {prefs, stale} }；
 * canSync()＝有登入才同步。schedule／clear／now 可注入（測試用）。
 */
export function createDeviceSync({ prefs, api, canSync = async () => true, now = () => Date.now(), schedule = setTimeout, clear = clearTimeout, gapMs = PUSH_GAP_MS, everyMs = PULL_EVERY_MS, onError = () => {} }) {
  let lastCanon = canon(prefs), lastSent = null, lastPushAt = -Infinity, timer = null, poll = null, busy = false, stopped = false
  const apply = next => {
    const o = { deviceOrder: next.order, deviceShown: next.shown, deviceRemoved: next.removed, deviceRev: next.rev }
    Object.assign(prefs, { deviceOrder: normalizeKeys(o.deviceOrder), deviceShown: normalizeKeys(o.deviceShown), deviceRemoved: normalizeKeys(o.deviceRemoved), deviceRev: o.deviceRev, deviceSynced: true })
    lastCanon = canon(prefs)   // 先記下，之後的變動監看就不會把「採用後台的」當成本機改動
  }
  async function push() {
    if (stopped || busy) return
    const body = toRemote(prefs)
    if (body.rev <= 0) return
    const key = canon(prefs) + '|' + body.rev
    if (key === lastSent) return   // 同內容同版本不重送
    if (!(await canSync())) return
    busy = true
    try {
      lastPushAt = now()
      const r = await api.set(body)
      if (r?.stale && r.prefs) apply(r.prefs)   // 後台比較新：改採用它，不覆蓋
      else { lastSent = key; prefs.deviceSynced = true }
    } catch (e) { onError(e) } finally { busy = false }
  }
  function requestPush() {
    if (stopped || timer) return
    const wait = Math.max(0, lastPushAt + gapMs - now())
    timer = schedule(() => { timer = null; void push() }, wait)
  }
  /** 本機設定可能變了（監看到 devPrefs 變動就呼叫）：內容真的變了才更新 rev 並排推送 */
  function noteLocal() {
    const c = canon(prefs)
    if (c === lastCanon) return
    lastCanon = c
    prefs.deviceRev = Math.max(now(), (prefs.deviceRev || 0) + 1)
    requestPush()
  }
  async function pull() {
    if (stopped || busy) return
    try {
      if (!(await canSync())) return
      const r = await api.get()
      const d = decide({ local: prefs, remote: r?.prefs ?? null, now: now() })
      if (d.markSynced) prefs.deviceSynced = true
      if (d.action === 'adopt') apply(d.next)
      else if (d.action === 'push') { if (d.next) apply(d.next); requestPush() }
    } catch (e) { onError(e) }
  }
  function start() {
    stopped = false
    void pull()
    poll = schedule(function tick() { void pull(); poll = schedule(tick, everyMs) }, everyMs)
  }
  function stop() { stopped = true; if (timer) clear(timer); if (poll) clear(poll); timer = poll = null }
  return { start, stop, pull, push, noteLocal, requestPush }
}
