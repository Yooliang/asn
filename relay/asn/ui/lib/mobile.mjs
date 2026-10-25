// 手機版（ui/m.html）的純邏輯：單欄導覽、名單分組、提示規則、安卓外殼橋。node 與瀏覽器都能跑，不碰 DOM、不碰 Tauri。
// 手機三個大分頁：夥伴、對話（最後使用的那一位）、設置。沒有多視窗、系統匣、設定分頁。
import { groupItems } from './dims.mjs'
import { friendMatchesQuery, normalizeSearchQuery, sortFriends } from './search.mjs'
import { engineKey } from './tabs.mjs'
import { withoutAsn } from './roster.mjs'
import { modelVendorKey, vendorIconSvg } from './vendor-icons.mjs'
import { noticeOf } from './photo.mjs'
import { guideNav } from './mobile-guides.mjs'
import { MOBILE_SETTING_KEYS, settingNav } from './mobile-settings.mjs'

// ---------- 單欄導覽 ----------
// 狀態：{ tab: 'list' | 'chats' | 'me', sheet: '' | 'launch' | 'ops' }。sheet＝蓋在分頁上的一層：「開新夥伴」（滿版）、「⋯」選單（底部浮層）。
// 對話不再是蓋在名單上的一層：第二個分頁「對話」就是最後使用的那一位的對話內容（見 lib/mobile-ops.mjs 的 chatPageState）。
// 每往下一層（夥伴→其他分頁、名單→開新夥伴、對話→選單）就在瀏覽記錄推一筆；系統的返回鍵＝瀏覽器上一頁，外殼（WryActivity）已接好，名單層再按才退到背景。
// 三個大分頁：夥伴（list）、對話（chats）、設置（me）。
export const TABS = ['list', 'chats', 'me']
export const TAB_LABEL = { list: '夥伴', chats: '對話', me: '設置' }
// 分頁列上的字：進了「選項」頁時，第二個分頁（對話）暫時改叫「選項」，離開就恢復
export const tabLabel = (t, nav, acctLabel = '選項') => (t === 'chats' && nav?.sheet === 'acct' ? acctLabel : TAB_LABEL[t])
export const tabIndex = t => Math.max(0, TABS.indexOf(t))
export const normalizeTab = t => (TABS.includes(t) ? t : 'list')
export const initialNav = () => ({ tab: 'list', sheet: '' })
export const tabNav = t => ({ tab: normalizeTab(t), sheet: '' })
export const meNav = () => tabNav('me')
// 開新夥伴分兩頁：第 1 頁只選電腦（沒有 step），第 2 頁（step: 2）選該電腦的模型與資料夾、名字、第一句話。第 2 頁多推一筆瀏覽記錄，返回鍵回第 1 頁
export const launchNav = step => (step === 2 ? { tab: 'list', sheet: 'launch', step: 2 } : { tab: 'list', sheet: 'launch' })
export const opsNav = () => ({ tab: 'chats', sheet: 'ops' })
export const secretNav = () => ({ tab: 'chats', sheet: 'secret' })
export const acctNav = () => ({ tab: 'chats', sheet: 'acct' })   // 名單設備卡的「選項」進入的滿版頁（切換 Claude 帳號）
// 瀏覽記錄裡讀回來的狀態可能是任何東西（壞資料、別的頁面留下的）：整理成合法的導覽狀態
export function normalizeNav(raw) {
  if (raw?.sheet === 'launch') return launchNav(raw?.step)
  if (raw?.sheet === 'ops') return opsNav()
  if (raw?.sheet === 'secret') return secretNav()
  if (raw?.sheet === 'acct') return acctNav()
  if (raw?.sheet === 'setting') return MOBILE_SETTING_KEYS.includes(raw?.cat) ? settingNav(raw.cat) : tabNav('me')   // 設置分頁的某一項滿版頁；沒這個分類退回設置分頁
  if (raw?.sheet === 'guide') return guideNav(raw?.guide)   // 設置分頁的「使用指引」滿版頁
  return tabNav(raw?.tab)
}

// ---------- 左右滑動切換大分頁（跟手、放開吸附；對話畫面裡也能滑） ----------
export const EDGE_PX = 24, LOCK_PX = 14, SWIPE_RATIO = 2, COMMIT_FRAC = 0.22, COMMIT_VELOCITY = 0.5, EDGE_RESIST = 0.3
// 只有離螢幕左右邊緣一段距離才接手（邊緣留給安卓系統的返回手勢）
export const swipeStartOk = (x, width, edge = EDGE_PX) => x >= edge && x <= width - edge
// 這次手指動作算水平滑動（h）、垂直捲動（v），還是還看不出來（null）。水平位移要明顯大於垂直位移（SWIPE_RATIO 倍）才算 h；斜的算 v（文字選取、上下捲動不會被誤判）
export function swipeLock(dx, dy) {
  const ax = Math.abs(dx), ay = Math.abs(dy)
  if (ax < LOCK_PX && ay < LOCK_PX) return null
  if (ay >= LOCK_PX && ax < ay * SWIPE_RATIO) return 'v'
  if (ax >= LOCK_PX && ax >= ay * SWIPE_RATIO) return 'h'
  return null
}
// 跟手位移：到了最左或最右那一頁還往外拉，就打折（橡皮筋）
export function pagerShift(index, dx, count = TABS.length) {
  if ((index <= 0 && dx > 0) || (index >= count - 1 && dx < 0)) return dx * EDGE_RESIST
  return dx
}
// 放開時吸附到哪一頁：拖過寬度的一定比例，或夠快（px/ms）
export function swipeTarget({ index, dx, dt, width, count = TABS.length }) {
  const v = dt > 0 ? Math.abs(dx) / dt : 0
  const far = Math.abs(dx) >= width * COMMIT_FRAC || (v >= COMMIT_VELOCITY && Math.abs(dx) >= 30)
  if (!far) return index
  return Math.max(0, Math.min(count - 1, index + (dx < 0 ? 1 : -1)))
}
// 底部指示條的位置（以分頁為單位的小數，跟著手指）
export const indicatorPos = (index, shift, width, count = TABS.length) => Math.max(0, Math.min(count - 1, index - (width > 0 ? shift / width : 0)))
// 手指按下的地方能不能開始滑：輸入框、下拉選單、可橫向捲動的工具列、放大看照片的畫面都不接手
// 訊息裡橫向可捲動的區塊（寬表格、程式碼）：手指在上面橫向滑是要捲動它，不是換頁。只在「真的寬到需要捲」時才擋，沒溢出的表格照常可換頁
export const SCROLLX_SELECTOR = '.md-tablewrap, .md-code'
export function inScrollableX(target) {
  const el = target?.closest?.(SCROLLX_SELECTOR)
  return !!el && Number(el.scrollWidth) > Number(el.clientWidth) + 1
}
export const SWIPE_BLOCK_SELECTOR = 'input, textarea, select, [contenteditable="true"], .toolbar, .photo-viewer, .picker, .m-dv-grip'

// ---------- 名單 ----------
// 單欄名單：所有設備的夥伴放在同一頁，依設備分組（本機那組在最前），有搜尋字就只留符合的。
// 組內線上在前、離線在後。回傳 [{ key, label, node, items }]
export function rosterGroups(friends, { query = '', selfNode = '', selfName = '', deviceOrder = [], plainText = s => s } = {}) {
  const q = normalizeSearchQuery(query)
  const items = sortFriends(withoutAsn(friends).filter(f => friendMatchesQuery(f, q, plainText)))
  return groupItems(items, 'device', { selfNode, selfName, deviceOrder })
}
export const totalUnread = friends => withoutAsn(friends).reduce((n, f) => n + (Number.isInteger(f?.unread) && f.unread > 0 ? f.unread : 0), 0)

// ---------- 名單每列：廠商小徽章與「最後一句話」 ----------
// 廠商圖：電腦版已有的官方圖（vendor-icons.mjs）；ASN 自己的視窗用機器人 logo。回要放進徽章的 HTML（都是內建的固定字串，沒有外部資料）
export const ASN_BADGE = '<img src="img/logo.svg" alt="" draggable="false">'
export function vendorBadgeHtml(friend) {
  const k = engineKey(friend)
  if (k === 'pi') return vendorIconSvg(modelVendorKey(friend?.model) ?? 'pi')   // pi 只是執行殼：顯示背後實際的模型廠商，對不到才用 pi 的圖
  return k === 'asn' ? ASN_BADGE : vendorIconSvg(k)
}
export const LAST_WORDS_MAX = 80
// 這位夥伴最後說的一句話：只取對方寄來的（k:'them'）；自己寄的、震動、系統提示（k:'sys'）一律跳過找前一則；
// 只有照片或檔案的信顯示「傳來了一張照片」「傳來了一個檔案」。換行與連續空白壓成一個空格，最多 LAST_WORDS_MAX 字
export function lastWords(log) {
  for (let i = (log?.length ?? 0) - 1; i >= 0; i--) {
    const m = log[i]
    if (m?.k !== 'them') continue
    const t = String(m.text ?? '').replace(/\s+/g, ' ').trim()
    if (t) return t.length > LAST_WORDS_MAX ? t.slice(0, LAST_WORDS_MAX) : t
    if (Array.isArray(m.photos) && m.photos.length) return noticeOf(m.photos)
  }
  return ''
}
// 沒有本機記錄的夥伴要向後台補一次往來：依畫面順序、每位最多一次、整個執行期最多這麼多位（不一次對所有成員打請求）
export const BACKFILL_MAX = 40, BACKFILL_GAP_MS = 600
export function backfillQueue(friendsInOrder, { lastOf, tried = new Set(), max = BACKFILL_MAX } = {}) {
  const out = []
  for (const f of friendsInOrder ?? []) {
    if (out.length + tried.size >= max) break
    if (!f?.id || tried.has(f.id) || lastOf(f.id)) continue
    out.push(f.id)
  }
  return out
}

// ---------- 名字：兩層 ----------
// 「我的名字」＝帳號層（租戶稱呼，所有設備共用，例如「啟良」）：對話裡自己的訊息、「我」分頁頂端都用它。
// 「這台設備的名稱」＝這支手機自己的名字（就是視窗名／節點顯示名，例如「手機」）：只用在「從 手機」小標與名單上的設備群組標題。
// 帳號層的名字目前唯讀（後台「改帳號名」的動作上線後再接）。後台沒有取到、或還是建租戶時的預設稱呼「朋友」，退而用 email 的帳號部分，再沒有就「我」。
export const PLACEHOLDER_NAMES = ['朋友', '主人']
export function accountDisplayName(ownerName, email = '') {
  const n = String(ownerName ?? '').trim()
  if (n && !PLACEHOLDER_NAMES.includes(n)) return n
  const local = String(email ?? '').split('@')[0].trim()
  return local || '我'
}

// ---------- 下拉重整（名單頁） ----------
// 手指往下拉 dy 像素 → 頂端那塊的高度（有阻尼，最多 PTR_MAX）；拉過門檻放開才會更新
export const PTR_THRESHOLD = 64, PTR_MAX = 96, PTR_LOADING_H = 84
export const pullHeight = dy => (dy > 0 ? Math.min(PTR_MAX, Math.round(dy * 0.5)) : 0)
export const pullRatio = h => Math.max(0, Math.min(1, h / PTR_THRESHOLD))
// pull＝還沒到門檻（下拉重新整理）、ready＝到了（放開重新整理）、loading＝更新中
export const pullPhase = (h, loading = false) => (loading ? 'loading' : h >= PTR_THRESHOLD ? 'ready' : h > 0 ? 'pull' : 'idle')
export const PULL_TEXT = { idle: '', pull: '下拉重新整理', ready: '放開重新整理', loading: '更新中…' }
// 放開時要不要更新：只有到門檻（且沒在更新）才更新
export const shouldRefreshOnRelease = (h, loading) => !loading && h >= PTR_THRESHOLD

// ---------- 提示 ----------
export const DEFAULT_PREFS = { vibrateMsg: false, vibrateNudge: true, autoUpdate: true }
export const normalizePrefs = raw => ({ vibrateMsg: raw?.vibrateMsg === true, vibrateNudge: raw?.vibrateNudge !== false, autoUpdate: raw?.autoUpdate !== false })
export const NUDGE_VIBRATE_MS = 300
export const MSG_VIBRATE_MS = 60

// core 的 notify 事件 → 該怎麼提示。openId＝目前正在看的對話（沒有就是空），foreground＝App 在前景。
//   banner：頂端橫幅（不是正在看的那位、App 在前景才跳）；vibrate：震動毫秒數（0＝不震）；shake：對話畫面抖一下
// 「對方登入」類的提示不打擾手機（不跳、不震）。
export function notifyPlan(n, { openId = '', foreground = true, prefs = DEFAULT_PREFS } = {}) {
  const none = { banner: null, vibrate: 0, shake: false }
  // 上下文快滿的提醒：前景時跳橫幅（帶「接班換手」按鈕），不震動；正在看那位的對話也要提醒（那正是用量在漲的地方）
  if (n?.kind === 'context') return { banner: foreground ? { ...bannerOf(n), handover: true, ms: CONTEXT_BANNER_MS } : null, vibrate: 0, shake: false }
  if (!n || (n.kind !== 'msg' && n.kind !== 'nudge')) return none
  const id = n.friend?.id ?? ''
  const watching = foreground && openId !== '' && openId === id
  if (n.kind === 'nudge') {
    return { banner: foreground && !watching ? bannerOf(n) : null, vibrate: prefs.vibrateNudge ? NUDGE_VIBRATE_MS : 0, shake: watching }
  }
  return { banner: foreground && !watching ? bannerOf(n) : null, vibrate: prefs.vibrateMsg && !watching ? MSG_VIBRATE_MS : 0, shake: false }
}
const bannerOf = n => ({ id: n.friend.id, nick: n.friend.nick, line: String(n.line ?? ''), status: n.friend.status, hue: n.friend.hue })
export const BANNER_MS = 4000
export const CONTEXT_BANNER_MS = 10000   // 帶按鈕的橫幅多留一會兒，來得及按

// ---------- 安卓外殼橋（MainActivity 掛上的 window.AsnAndroid；沒有就是在一般瀏覽器或測試裡） ----------
export function androidBridge(win) {
  const b = win?.AsnAndroid
  if (!b || typeof b.vibrate !== 'function') return null
  const call = (fn, ...a) => { try { return typeof b[fn] === 'function' ? b[fn](...a) : undefined } catch { return undefined } }
  return {
    vibrate: ms => call('vibrate', ms),
    exportFile: path => String(call('exportFile', path) ?? ''),
    openDownloads: () => call('openDownloads'),
    relaunch: () => call('relaunch'),
    selfUpdateEnabled: () => call('selfUpdateEnabled') === true,   // 自行安裝版才有（Google Play 版是 false）
    installApk: path => String(call('installApk', path) ?? 'error'),   // ok／need_permission／error／unsupported
    call: callBridge(win, b),   // 偽通話用的語音辨識與念出（沒有就是 null，畫面不出現通話鈕）
    keepAwake: on => call('keepAwake', on === true),   // 通話中螢幕不要自己暗掉
  }
}

// 通話的外殼橋（CallVoice.kt）：安卓內建的語音辨識與語音合成。事件由外殼用 window.__asnCallEvent(json字串) 推進來。
// 外殼太舊（沒有這些方法）就回 null。
function callBridge(win, b) {
  if (typeof b.callAvailable !== 'function') return null
  const run = (fn, ...a) => { try { return typeof b[fn] === 'function' ? b[fn](...a) : undefined } catch { return undefined } }
  return {
    available: () => run('callAvailable') === true,
    micState: () => (run('callMicState') === 'granted' ? 'granted' : 'ask'),
    requestMic: () => run('callRequestMic'),
    listen: names => run('callListen', typeof names === 'string' ? names : '[]'),   // names：名字的 JSON 陣列字串（安卓 13 以上用來偏向辨識）
    stopListen: () => run('callStopListen'),
    speak: (id, text) => run('callSpeak', String(id), String(text)),
    stopSpeak: () => run('callStopSpeak'),
    end: () => run('callEnd'),
    onEvent(fn) {
      const h = s => { let e = null; try { e = JSON.parse(s) } catch { return } fn(e) }
      win.__asnCallEvent = h
      return () => { if (win.__asnCallEvent === h) win.__asnCallEvent = null }
    },
  }
}

// 收到的檔案另存：Rust 端先存進 App 私有資料夾，外殼再複製到「下載/ASN」。回給畫面的是給人看的位置。
export async function savePhotoOnPhone(path, bridge) {
  if (!path) return null
  const shown = bridge ? bridge.exportFile(path) : ''
  if (!shown) throw new Error('檔案已下載，但沒辦法放進「下載」資料夾')
  return shown
}

// 第一次登入替這支手機建好節點後：要重新啟動才會用新身分。有外殼就請它重開；沒有就請使用者自己重開。
export function afterBind(out, bridge) {
  if (out?.state !== 'created') return { action: 'enter' }
  if (bridge) return { action: 'relaunch' }
  return { action: 'ask', text: '登入完成，請關掉 ASN 再重新打開。' }
}

// ---------- 自動更新（自行安裝版；Google Play 版不啟用，畫面上根本不出現） ----------
export const UPDATE_CHECK_MS = 6 * 3600 * 1000
// 檢查更新時官網連不上或回錯誤：不顯示原始錯誤，一律這句（官網還沒有 android.json＝404 時 Rust 端回「沒有新版」，畫面顯示「目前已是最新版」）
export const UPDATE_UNAVAILABLE = '暫時無法檢查更新'
export const UPDATE_LATEST = '目前已是最新版'
export const updateCheckErrorText = () => UPDATE_UNAVAILABLE
export const initialUpdate = () => ({ enabled: false, phase: 'idle', version: '', line: '', done: 0, total: 0, error: '', hint: '', checking: false, manual: '' })
// phase：idle（沒有新版）→ available（有新版，等按「更新」）→ downloading → failed（可重試）；下載完交給系統安裝程式
export const withAvailable = (u, found) => (found?.enabled === true && found.available === true
  ? { ...u, enabled: true, phase: 'available', version: String(found.version ?? ''), line: String(found.line ?? ''), error: '', hint: '' }
  : { ...u, enabled: found?.enabled === true, phase: u.phase === 'downloading' ? u.phase : 'idle' })
export const withProgress = (u, p) => ({ ...u, phase: 'downloading', done: Number(p?.done) || 0, total: Number(p?.total) || 0 })
export const withFailure = (u, msg) => ({ ...u, phase: 'failed', error: String(msg ?? '更新失敗') })
export const progressText = (done, total) => (total > 0 ? `下載中 ${Math.min(100, Math.floor((done / total) * 100))}%` : '下載中…')
export const bannerText = u => (u.phase === 'available' ? `有新版本 ${u.version}${u.line ? `：${u.line}` : ''}` : u.phase === 'downloading' ? progressText(u.done, u.total) : u.phase === 'failed' ? `更新失敗：${u.error}` : '')
export const buttonLabel = u => (u.phase === 'failed' ? '重試' : '更新')
// 交給系統安裝程式的結果 → 給人看的提示（ok 時系統會接手，畫面不用多說）
export function installOutcome(result) {
  switch (result) {
    case 'ok': return { ok: true, hint: '' }
    case 'need_permission': return { ok: false, hint: '請在接下來的畫面允許 ASN 安裝應用程式，回來後再按一次「更新」。' }
    case 'unsupported': return { ok: false, hint: '這個版本不提供自動更新。' }
    default: return { ok: false, hint: '沒辦法叫出安裝畫面，請再試一次。' }
  }
}
// 該不該自動檢查：這個版本有更新功能、使用者沒關、不在下載中
export const shouldAutoCheck = (u, prefs) => u.enabled && prefs.autoUpdate !== false && u.phase !== 'downloading'
