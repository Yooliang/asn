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

// 震動：寄一封內文為 [震動] 的信（expects_reply:false）；收到內文含 [震動] 就抖視窗
export const NUDGE_TAG = '[震動]'
export const hasNudge = body => String(body ?? '').includes(NUDGE_TAG)
export const stripNudge = body => String(body ?? '').split(NUDGE_TAG).join('').trim()

// 好友頭像底色：由 id 算出固定色相
export function hueOf(id) {
  let h = 0
  for (const ch of String(id)) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return h % 360
}
