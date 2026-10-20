// 文字工具（純函式，介面與測試共用）：跳脫、舊式表情代碼、震動標記。
// 信件內文與好友名稱都是外部資料：一律先 esc 再進 v-html，絕不把原文直接塞進 v-html。

// 那個年代的表情代碼
export const EMO = [
  [":'(", '😢'], ['(L)', '❤️'], ['(U)', '💔'], [':)', '🙂'], [':D', '😄'], [';)', '😉'],
  [':(', '🙁'], [':P', '😛'], [':$', '😳'], [':@', '😠'], ['(H)', '😎'], ['(A)', '😇'],
  ['(Y)', '👍'], ['(N)', '👎'], ['(K)', '💋'], ['(F)', '🌹'], ['(*)', '⭐'], ['(S)', '🌙'],
  ['(C)', '☕'], ['(^)', '🎂'], ['(G)', '🎁'], ['(8)', '🎵'], ['(6)', '😈'], ['(Z)', '💤'],
]
const emoMap = Object.fromEntries(EMO.map(([k, v]) => [k.toLowerCase(), v]))
const emoRe = new RegExp(EMO.map(([k]) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi')

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// 跳脫後把表情代碼換成圖示；輸出可安全給 v-html
export function emo(s = '') {
  s = String(s ?? '')
  let out = '', last = 0
  s.replace(emoRe, (m, off) => {
    out += esc(s.slice(last, off)) + `<span class="emo" title="${esc(m)}">${emoMap[m.toLowerCase()]}</span>`
    last = off + m.length
    return m
  })
  return out + esc(s.slice(last))
}
export const plain = (s = '') => String(s ?? '').replace(emoRe, m => emoMap[m.toLowerCase()])
export const initial = s => (plain(s).match(/\p{Script=Han}|\p{L}|\p{N}/u) || ['?'])[0]

const pad = n => String(n).padStart(2, '0')
export const fmt = t => { const d = new Date(t); return `${d.getHours()}:${pad(d.getMinutes())}` }
export const fmtDate = t => { const d = new Date(t); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${fmt(t)}` }

// 震動：寄出的內文是「（<視窗名> 傳送了一個震動）」（expects_reply:false；內文由 Rust 端用視窗名組成），AI 看了才懂意思。
// 收信端兩種都認：新格式要「整段內文」就是這句才算（避免一般訊息裡提到這句話被誤判）；舊版（尚未升級的 ASN）寄的 [震動] 照舊，內文含它就算。
export const NUDGE_TAG = '[震動]'   // 舊格式，只用於辨識
export const nudgeBody = name => `（${String(name ?? '').trim()} 傳送了一個震動）`
const NUDGE_RE = /^（[^（）\r\n]{1,80} 傳送了一個震動）$/
export const hasNudge = body => { const s = String(body ?? ''); return s.includes(NUDGE_TAG) || NUDGE_RE.test(s.trim()) }
export const stripNudge = body => {
  const s = String(body ?? '').trim()
  return NUDGE_RE.test(s) ? '' : s.split(NUDGE_TAG).join('').trim()
}

// 經機器橋轉回來的回信，內文整段包著 <cross-session-message …>…</cross-session-message>（斜線可能寫成 <\ 與 <\/）。
// 只在「首尾都對得上」時剝最外層一次；內文中間出現的同字串不動；只有開頭沒有結尾就不剝。剝完仍要經 esc 才能顯示。
const SHELL_OPEN = /^\s*<\\?cross-session-message(?:\s[^>]*)?>/
const SHELL_CLOSE = /<\\?\/cross-session-message>\s*$/
const SHELL_CLOSE_ANY = /<\\?\/cross-session-message>/
const SHELL_OPEN_ANY = /<\\?cross-session-message(?:\s[^>]*)?>/
export function unwrapShell(body) {
  const s = String(body ?? '')
  const o = SHELL_OPEN.exec(s), c = SHELL_CLOSE.exec(s)
  if (!o || !c || c.index < o[0].length) return s
  const inner = s.slice(o[0].length, c.index)
  // 兩段各自獨立的外殼接在一起（<a>…</a> <a>…</a>）不是「一整段包著」，不動
  const firstClose = SHELL_CLOSE_ANY.exec(inner)
  if (firstClose && SHELL_OPEN_ANY.test(inner.slice(firstClose.index + firstClose[0].length)) && !SHELL_OPEN_ANY.test(inner.slice(0, firstClose.index))) return s
  return inner.trim()
}

// 好友頭像底色：由 id 算出固定色相
export function hueOf(id) {
  let h = 0
  for (const ch of String(id)) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return h % 360
}
