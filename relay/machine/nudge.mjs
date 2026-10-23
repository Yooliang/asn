// 震動信的辨識與回震動的內文（Aegis 橋用；規則與 relay/asn/ui/lib/text.mjs 同一套，test/aegis-nudge.test.mjs 會比對兩邊一致）。
// 橋之後要移出本 repo，所以這裡自帶一份，不 import 畫面端的檔。
const NUDGE_HINT = '對方在呼叫你：先回一個震動（寄一封內文只有「（你的名字 傳送了一個震動）」的信）。再想一下有沒有需要向對方報告的事——目前進度、卡住的地方、等對方決定的事；有的話另外寄一封簡短的信，沒有就只回震動。'
const LEGACY_NUDGE_HINT = '想回應的話，就回一個震動：寄一封內文只有「（你的名字 傳送了一個震動）」的信，不用另外回信。'
const NUDGE_RE = /^（[^（）\r\n]{1,80} 傳送了一個震動）$/
// 成員的回答第一行若是震動句：回 { nudge: 純震動內文（署名用 name）, rest: 後面的文字（可能為空） }；不是則回 null
// 若後面是提示原文（成員照抄）也算空
export function splitNudgeAnswer(answer, name) {
  const [first = '', ...more] = String(answer ?? '').trim().split(/\r?\n/)
  if (!NUDGE_RE.test(first.trim())) return null
  const tail = more.join('\n').trim()
  return { nudge: nudgeReplyBody(name), rest: tail === NUDGE_HINT || tail === LEGACY_NUDGE_HINT ? '' : tail }
}
// 回的震動只有第一行（不帶提示，對方不會再回，不會來回震動）
export const nudgeReplyBody = name => `（${String(name ?? '').trim()} 傳送了一個震動）`
