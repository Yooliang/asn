// 夥伴選單收成一份（#1559）：電腦名單右鍵、對話頁 Aero「管理」、現代／LINE「更多」、手機「⋯」的管理段都從 buildPartnerMenu 組。
// 能不能按、為什麼變灰照舊由 partner-ops.mjs（menuItems）與 archive.mjs（封存）判斷；這裡只決定「這個入口放哪幾項、什麼順序、
// 用不到的藏起來還是變灰、說明寫長句還是 20 字內」。各入口只負責畫出來。
// 「把這台電腦上開著的終端納入管理」不是夥伴自己的操作，不在任何夥伴選單裡（#1557 搬到工作管理員，task-manager.mjs）。
import { REASON } from './partner-ops.mjs'
import { manageItems } from './archive.mjs'
import { phoneOpApplies, phoneOpsRows } from './mobile-ops.mjs'

// ---------- 反灰原因（20 字內） ----------
export const WHY_MAX = 20
const BRIEF = new Map([
  [REASON.closed, '這台電腦沒開放遠端管理'],
  [REASON.deviceOffline, '電腦不在線，叫不醒'],
  [REASON.cloud, '雲端代理，沒有視窗可管'],
  [REASON.otherEngine, '這個引擎暫不開放管理'],
  [REASON.restartOnlyAcp, '只用在內建通道的工作者'],
  [REASON.removeOnlyAcp, '只用在內建通道的工作者'],
])
const BRIEF_RE = [
  [/^這是這台電腦上自己開的/, '自己開的程式，只能顯示'],
  [/^這個 pi 視窗已離線/, 'pi 視窗已離線'],
  [/^這個內建通道的工作者已離線/, '工作者已離線'],
  [/^這個視窗已離線，要先喚醒/, '視窗已離線，要先喚醒'],
  [/^查不到這台電腦的設定/, '查不到這台電腦的設定'],
  [/^查不到登入狀態/, '查不到登入狀態'],
  [/不需要喚醒；要重新啟動/, '不用喚醒，請用「重開」'],
]
/** 反灰的說明縮成 20 字內（大按鈕提示、管理選單、名單右鍵共用）；已經夠短的原樣，認得的長句換成短說法，其餘截斷。 */
export function briefWhy(reason) {
  const s = String(reason ?? '').trim()
  if (s.length <= WHY_MAX) return s
  const hit = BRIEF.get(s) ?? BRIEF_RE.find(([re]) => re.test(s))?.[1]
  return hit ?? `${s.slice(0, WHY_MAX - 1)}…`
}

/** 入口：context＝電腦名單右鍵、panel＝對話頁 Aero「管理」、more＝現代／LINE「更多」、phone＝手機「⋯」 */
export const MENU_SURFACES = Object.freeze(['context', 'panel', 'more', 'phone'])

// 電腦版右鍵與「管理」：名稱後面加「…」（按了會跳對話框）；這幾項按了直接做，不加
const NO_DOTS = ['close', 'archive', 'unarchive', 'resume']

/** 「更多」裡「管理」那段的一列：key 加 p: 前綴（接回「管理」選單原本的 handler）；切換模型、喚醒的能不能按看電腦大按鈕那一格。 */
function moreRow(item, slots) {
  const key = `p:${item.key}`
  if (item.key === 'model' && slots.model) return { key, label: item.label, ok: slots.model.ok, reason: slots.model.ok ? '' : briefWhy(slots.model.reason) }
  if (item.key === 'resume') {
    const w = slots.window
    const ok = Boolean(item.ok && w?.wake && w.ok)
    return { key, label: item.label, ok, reason: ok ? '' : briefWhy(item.reason || w?.reason || '現在不能喚醒') }
  }
  return { key, label: item.label, ok: item.ok !== false, reason: item.ok === false ? briefWhy(item.reason) : '' }
}

// 右鍵與 Aero「管理」：其他項目每一種夥伴都列（用不到的變灰），拿掉「切換模型」（大按鈕與右鍵各有自己那一格）。
// 喚醒只在用得到時才列（#1557：離線、而且不是內建通道的工作者；在線時不再顯示灰色的「不需要喚醒」），規則跟手機、「更多」同一條（phoneOpApplies）
function deskRows(friend, ctx) {
  return manageItems(friend, ctx)
    .filter(i => i.key !== 'model' && (i.key !== 'resume' || phoneOpApplies('resume', friend)))
    .map(i => ({ key: `p:${i.key}`, label: `${i.label}${NO_DOTS.includes(i.key) ? '' : '…'}`, ok: i.ok, reason: i.ok ? '' : briefWhy(i.reason) }))
}

/**
 * 這個入口的管理段：回 [{ key, label, ok, reason }]，順序就是畫面上的順序。不是 AI 夥伴回空陣列。
 * - context：全部項目（用不到的變灰；喚醒只在離線時才列）、key 加 p:、名稱加「…」、說明 20 字內
 * - panel：同 context，但拿掉喚醒（Aero 的喚醒在大按鈕第 2 格）
 * - more：跟手機同一組（用不到的藏起來，喚醒、切換模型排最前），key 加 p:、說明 20 字內；切換模型、喚醒看大按鈕那一格（opts.slots）
 * - phone：用不到的藏起來，喚醒、切換模型排最前，說明是完整長句，key 不加前綴
 */
export function buildPartnerMenu(friend, ctx = {}, surface, opts = {}) {
  if (surface === 'context') return deskRows(friend, ctx)
  if (surface === 'panel') return deskRows(friend, ctx).filter(i => i.key !== 'p:resume')
  if (surface === 'phone') return phoneOpsRows(manageItems(friend, ctx), friend)
  if (surface === 'more') return phoneOpsRows(manageItems(friend, ctx), friend).map(i => moreRow(i, opts.slots ?? {}))
  throw new Error(`不認得的選單入口：${surface}`)
}
