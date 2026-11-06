// 手機回答 Claude 夥伴的權限框（#853；後台見 _shared/perm_request.ts）的畫面邏輯。
// 手機只能選電腦給的選項，按一個就送那個數字；沒有文字欄位。雜湊由電腦算、這裡原樣帶回。
// 全文只用來給本人看（不寫儲存、不放網址、不進 console、不放系統通知）。
import { clean, errorText as baseError } from './term-ask.mjs'

export const POLL_MS = 30_000
/** 框開著時多久查一次這筆還在不在（電腦撤回不會通知手機，#921） */
export const WATCH_MS = 5_000
/** 框跳出來後多久才能按，免得正在點別的東西時按到 */
export const ARM_MS = 700
/** 按了之後等電腦回報多久（電腦每 3 秒領一次，重查要一點時間） */
export const RESULT_TRIES = 10
export const RESULT_EVERY_MS = 2_000
/** 輪詢發現電腦那邊已經處理掉之後，顯示一行字多久才自動收框 */
export const AUTOCLOSE_MS = 2_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH_RE = /^[0-9a-f]{64}$/
const TEXT_MAX = 16000

export const errorText = baseError

/** 後台清單 → 畫面用的列。欄位壞掉的、已過期的丟掉 */
export function normalizeList(raw, nameOf = () => '', nowMs = Date.now()) {
  const list = Array.isArray(raw?.requests) ? raw.requests : []
  const out = []
  for (const r of list) {
    if (!r || typeof r.id !== 'string' || !UUID_RE.test(r.id) || typeof r.body_hash !== 'string' || !HASH_RE.test(r.body_hash)) continue
    const until = Date.parse(r.expires_at)
    if (!Number.isFinite(until) || until <= nowMs) continue
    const options = Array.isArray(r.options)
      ? r.options.filter(o => o && Number.isInteger(o.n) && o.n >= 1 && o.n <= 9 && typeof o.label === 'string').map(o => ({ n: o.n, label: clean(o.label, 200) }))
      : []
    if (typeof r.prompt_text !== 'string') continue   // 選項可以是空的：多選、一次多題看得到但不能按
    out.push({
      id: r.id, hash: r.body_hash, deviceName: clean(nameOf(r.node), 60) || '某台電腦', window: clean(r.window_name, 64),
      text: clean(r.prompt_text, TEXT_MAX), complete: r.complete === true, options,
    })
  }
  return out
}

/** 下一筆：跳過「先不處理」的 */
export const nextToAsk = (list, dismissed) => list.find(r => !dismissed.has(r.id)) ?? null

/** 手機按了一個選項：回給 android_perm_req_decide 的參數；不在清單裡回 null（不送） */
export function decideArgs(cur, n) {
  if (!cur || !cur.options.some(o => o.n === n)) return null
  return { id: cur.id, choiceN: n, hash: cur.hash }
}

/** 這筆請求還在不在清單裡。回 true＝還在、false＝已經結束（撤回、過期、被處理）、null＝這次查不到（失敗或格式不對），不能當成結束 */
export function stillPending(raw, id) {
  if (!raw || !Array.isArray(raw.requests) || typeof id !== 'string') return null
  return raw.requests.some(x => x?.id === id)
}

/** 5 秒輪詢的結果怎麼呈現（只給輪詢用，本人沒按過選項）。已經結束（alive===false）→ 一行說明＋自動收框；其他（還在、查不到）→ null 不動。
 *  本人按了選項之後才得到 cancelled，走 resultOf：紅字，不自動收 */
export function watchOutcome(alive) {
  return alive === false ? { ok: true, text: TEXT.handled, auto: true } : null
}

/** 按了之後的結果。還沒有最終結果回 null，繼續等 */
export function resultOf(raw, id) {
  const r = Array.isArray(raw?.recent) ? raw.recent.find(x => x?.id === id) : null
  if (!r) return null
  if (r.status === 'done') return { ok: true, text: TEXT.done }
  if (r.status === 'failed') return { ok: false, text: `${TEXT.failed}${r.detail ? `：${clean(r.detail, 200)}` : ''}` }
  if (r.status === 'cancelled') return { ok: false, text: TEXT.gone }
  if (r.status === 'expired') return { ok: false, text: TEXT.noReply }
  return null
}

export const TEXT = {
  title: '夥伴在問你',
  lead: '按一個選項就會送到那台電腦，送出後收不回。',
  deviceLabel: '哪台電腦',
  windowLabel: '哪個夥伴',
  textLabel: '內容',
  incomplete: '內容太長，這裡只看得到一部分，所以只能拒絕。要允許請到電腦上看完整內容。',
  viewOnly: '這題要到電腦上回答（多選、一次多題，或要自己打字）。',
  noType: '要自己打字，請到電腦上回答。',
  optionLabel: '選項',
  later: '先不處理',
  waiting: '已送出，等電腦確認…',
  done: '電腦已經送出你的選擇',
  failed: '沒有送出',
  gone: '電腦上已經沒有這個提示，沒有送出',
  handled: '電腦上已經處理了這個提示',
  noReply: '電腦沒有回應，沒有送出',
  unknown: '電腦還沒有回報。請到電腦上確認',
  close: '關閉',
}
