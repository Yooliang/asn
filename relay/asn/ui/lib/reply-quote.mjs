// 針對某則訊息回覆（#225）的純邏輯：摘要、引用行、回覆對象、組出要送的內文、點引用找回原訊息。電腦版與手機版共用。
// 引用以固定格式的「第一行」寫進內文：「↩ 回覆 作者：摘要」。這樣舊版用戶端看到的就是這行文字，
// AI 收到的信也有明確的引用；新版用戶端把這一行拆出來畫成引用列。群組另外由後台記下被回覆的序號（用來點回原訊息、自動 @ 原作者）。
// 給人看的文字純繁體中文；不顯示任何成員鍵或代號。

export const QUOTE_PREFIX = '↩ 回覆 '
export const EXCERPT_MAX = 40
const QUOTE_RE = /^↩ 回覆 ([^：\n]{1,60})：([^\n]*)(?:\n|$)/

// 拆出第一行的引用：{ quote: { author, excerpt } | null, body }
export function splitQuote(text) {
  const t = String(text ?? '')
  const m = QUOTE_RE.exec(t)
  if (!m) return { quote: null, body: t }
  return { quote: { author: m[1].trim(), excerpt: m[2].trim() }, body: t.slice(m[0].length) }
}

// 一行摘要：去掉開頭的引用行、空白壓成一個、超過 n 字加刪節號
export function excerptOf(text, n = EXCERPT_MAX) {
  const body = splitQuote(text).body
  const t = body.replace(/\s+/g, ' ').trim()
  const chars = [...t]
  if (chars.length <= n || (chars.length === n + 1 && t.endsWith('…'))) return t
  return `${chars.slice(0, n).join('')}…`
}

const cleanAuthor = a => [...String(a ?? '').replace(/[\u0000-\u001f\u007f：「」『』[\]【】]/g, '')].slice(0, 40).join('').trim()
export const quoteLine = (author, text) => `${QUOTE_PREFIX}${cleanAuthor(author) || '對方'}：${excerptOf(text)}`

// 點了某一則的「回覆」：回 { author, excerpt, seq, index, mention }；系統訊息、沒有文字的不能回覆。
// mention：群組裡回覆別人，自動 @ 對方（只在對方是可點名的成員時）；回覆自己、個人聊天不 @
export function replyTarget(m, { friend, meName, index } = {}) {
  if (!m || m.k === 'sys') return null
  const excerpt = excerptOf(m.text)
  if (!excerpt) return null
  const mine = m.k === 'me'
  const author = mine ? String(meName || '我') : String(m.who || friend?.nick || '對方')
  const can = friend?.room === true && !mine && (friend.mentionable ?? []).some(t => t.label === author)
  return { author, excerpt, seq: Number.isInteger(m.seq) ? m.seq : undefined, index, mention: can ? author : '' }
}

// 組出要送的內文：引用行＋（自動 @ 對方）＋使用者打的字；沒打字回空字串
export function composeReply(target, draft) {
  let d = String(draft ?? '').trim()
  if (!d) return ''
  if (!target) return d
  if (target.mention && !d.includes(`@${target.mention}`)) d = `@${target.mention} ${d}`
  return `${QUOTE_PREFIX}${cleanAuthor(target.author) || '對方'}：${target.excerpt}\n${d}`
}

// 點引用找回原訊息，回記錄裡的位置（-1＝找不到，可能在更早、還沒載入的紀錄）。
// 有序號（群組）用序號；否則在這則之前找作者相符、內文以摘要開頭的最近一則
export function findQuoted(log, index, quote, { meName } = {}) {
  if (!quote || !Array.isArray(log)) return -1
  if (Number.isInteger(quote.seq)) {
    const i = log.findIndex(m => m?.seq === quote.seq)
    if (i >= 0) return i
  }
  const ex = String(quote.excerpt ?? '').replace(/…$/, '').trim()
  if (!ex) return -1
  const byMe = meName != null && quote.author === meName
  for (let i = Math.min(index, log.length) - 1; i >= 0; i--) {
    const m = log[i]
    if (!m || m.k === 'sys') continue
    if (byMe ? m.k !== 'me' : m.k !== 'them' || (m.who && m.who !== quote.author)) continue
    if (excerptOf(m.text, 1e9).startsWith(ex)) return i
  }
  return -1
}
