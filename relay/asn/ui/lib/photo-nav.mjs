// 看大圖左右切換（#1728）：同一個對話（或群組）裡的照片依信件時間攤平成一串，上一張／下一張、到頭停住、手機滑動與鍵盤的判斷。
// 純計算，瀏覽器與 node 測試都能跑；畫面與事件接線在 chatpane.mjs。
import { photoExpired } from './photo.mjs'

export const SWIPE_MIN_PX = 50     // 手指水平移動至少這麼多才算切換
export const SWIPE_RATIO = 1       // 水平位移要大於「垂直位移 × 這個倍數」，斜著滑不算
export const NEXT = 1              // 下一張（較新）
export const PREV = -1             // 上一張（較舊）

/**
 * 這個對話的照片串：log 是這個畫面（一個對話或一個群組）的訊息，所以不會混進別的對話。
 * 只收圖片（一般檔案不預覽）、略過已過期打不開的；依訊息時間排序，同時間維持原本先後。
 * who(m) 由畫面提供（寄件人顯示名）。每一筆：{ id, p（附件）, t（訊息時間）, who }
 */
export function photoSeq(log, { who = () => '', now = Date.now() } = {}) {
  const out = []
  let k = 0
  for (const m of Array.isArray(log) ? log : []) {
    if (!m || !Array.isArray(m.photos)) continue
    for (const p of m.photos) {
      if (!p || p.kind !== 'image' || photoExpired(p, now)) continue
      out.push({ id: p.id, p, t: Number.isFinite(m.t) ? m.t : 0, who: who(m), k: k++ })
    }
  }
  return out.sort((a, b) => a.t - b.t || a.k - b.k).map(({ k: _k, ...e }) => e)
}

/** 這張在串裡的位置；找不到回 -1 */
export const locate = (seq, id) => seq.findIndex(e => e.id === id)

/** 往 dir（NEXT／PREV）走一張；到頭、到尾就停在原地（不繞回） */
export function stepIndex(i, dir, n) {
  if (!(n > 0) || !(i >= 0 && i < n)) return -1
  return Math.min(n - 1, Math.max(0, i + (dir < 0 ? -1 : 1)))
}

/** 畫面要的：第 N 張、共 M 張、前後還有沒有 */
export function navState(i, n) {
  return { n: i + 1, total: n, hasPrev: i > 0, hasNext: i < n - 1 }
}

/**
 * 手機滑動：左滑（dx 負）＝下一張（較新）、右滑＝上一張（較舊）。
 * 放大中（scale > 1）滑動是平移不切換；水平位移不夠、或不比垂直位移大就不算。回 NEXT、PREV 或 0。
 */
export function swipeDir(dx, dy, scale = 1, min = SWIPE_MIN_PX) {
  if (scale > 1.01) return 0
  const ax = Math.abs(dx), ay = Math.abs(dy)
  if (!(ax > min) || !(ax > ay * SWIPE_RATIO)) return 0
  return dx < 0 ? NEXT : PREV
}

/** 鍵盤：← 上一張、→ 下一張；在輸入框、下拉、可編輯區裡打字時不攔（方向鍵留給游標）；有組合鍵也不攔 */
export function keyDir(e) {
  if (!e || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return 0
  const t = e.target
  const tag = String(t?.tagName ?? '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return 0
  return e.key === 'ArrowLeft' ? PREV : e.key === 'ArrowRight' ? NEXT : 0
}

// #1910：擁有者回報電腦上箭頭切不了圖，但重現不出來。先把切換與抓圖的結果寫進 ui.log（console.info 的 [ASN] 開頭會進 ui.log），
// 下次發生才有證據。只記方向、第幾張、成功失敗、毫秒、失敗類別；不記檔名、照片編號與內容。
const ERR_CODE_RE = /^[a-z][a-z0-9_:]{0,40}$/

/** 失敗原因的類別：後端帶的固定代號（err.code）才照抄，其他一律 other；沒有錯誤是 ok */
export function fetchErrClass(e) {
  if (!e) return 'ok'
  const c = typeof e.code === 'string' ? e.code : ''
  return ERR_CODE_RE.test(c) ? c : 'other'
}

/** 切換那一行：從哪個入口（箭頭、鍵盤、滑動）、往哪邊、切到第幾張；到頭到尾沒切也記 */
export function stepLogLine(via, dir, from, to, total) {
  const way = dir === PREV ? '上一張' : dir === NEXT ? '下一張' : '不明'
  const moved = to >= 0 && to !== from
  return `[ASN] 看圖切換 ${via} ${way}：${moved ? `第 ${from + 1} → ${to + 1} 張` : `停在第 ${from + 1} 張（已到頭或到尾）`}／共 ${total} 張`
}

/** 抓圖那一行：成功或失敗、花幾毫秒、失敗類別 */
export function fetchLogLine(ok, ms, e = null) {
  const t = Math.max(0, Math.round(Number(ms) || 0))
  return ok ? `[ASN] 看圖抓圖 成功 ${t}ms` : `[ASN] 看圖抓圖 失敗 ${t}ms 類別=${fetchErrClass(e)}`
}
