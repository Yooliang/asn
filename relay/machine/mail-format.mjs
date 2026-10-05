// 信件格式共用（純函式，bridge.mjs／engines/acp.mjs 共用，方便單獨測試）：
//   - 「要不要回信」：信件有獨立欄位 expects_reply（true／false；舊信是 null），由寄件人明說，收發室自己決定要不要計時。
//   - 來信抬頭 `[RELAY 來信] … engine=<id> reply=yes|no|?`（? ＝舊信沒有欄位）。
//   - 代寄抬頭 `[RELAY 寄信] to=<節點>[/<視窗>] [re=<信件id>] reply=yes|no`（reply 必填，由橋檢查）。
// 為什麼不用內文標記：內文有沒有「不需回覆」沒辦法用程式可靠判斷，所以改成寄件時多送一個欄位（小良哥 10/05）。

// 舊式的內文標記。【過渡期相容】只有欄位是 null 的信（舊版寄件工具、舊信）才退回看它；
// 所有寄件工具與機器都換成會帶 expects_reply 的版本之後，這份正則與 wantsReply 的退路就可以拿掉。
export const NO_REPLY_RE = /（不需回覆）|\[no-reply\]/i

// 逾時提醒結尾那句：告訴寄件人怎麼避免誤報
export const NO_REPLY_TIP = '只是告知的信，寄件時用 --no-reply（代寄寫 reply=no）就不會提醒'

// 欄位值 → true／false／null。接受 boolean，也接受抬頭上的 yes／no 字樣；其他一律當「不知道」
export const toReplyFlag = v => (v === true || v === 'yes' ? true : v === false || v === 'no' ? false : null)

// 抬頭上顯示的字：yes／no／?
export const replyLabel = v => { const f = toReplyFlag(v); return f === true ? 'yes' : f === false ? 'no' : '?' }

// 這封信寄件人要不要等回信：欄位有明說就【只看欄位】；欄位是 null（舊版寄件工具、舊信）才退回看內文有沒有舊式標記
export function wantsReply(field, body) {
  const f = toReplyFlag(field)
  if (f !== null) return f
  return !NO_REPLY_RE.test(String(body ?? ''))
}

// 來信抬頭（第一行）。reply 放在最後（engine= 之後），前面各欄位的順序不動，舊的前綴式解析照樣有效
export const mailHead = (m, engine = 'claude') =>
  `[RELAY 來信] trust=${m.trust} from=${m.from_node}/${m.from_agent ?? ''} to=${m.to_agent ?? ''} id=${m.id} engine=${engine} reply=${replyLabel(m.expects_reply)}`

// 從轉接器收到的信件全文取出抬頭上的 reply 欄位：'yes'｜'no'｜'?'；不是來信抬頭或沒有這個欄位回 null。
// 只認第一行【最後面】那個 reply=（橋寫在最後；寄件人自填的視窗名就算含 " reply=no" 也排在它前面，騙不到）
export function headReply(text) {
  const m = /^\[RELAY 來信\][^\n]*\sreply=(yes|no|\?)[ \t\r]*(?:\n|$)/.exec(String(text ?? ''))
  return m ? m[1] : null
}

// 代寄：視窗傳給收發室的訊息第一行
//   [RELAY 寄信] to=<節點>[/<視窗>] [re=<信件id>] reply=yes|no   （「[RELAY 回信]」同義；re 與 reply 順序不拘）
// 同一行抬頭後面若還接著別的字，當成內文的開頭（原本就是這樣）
export const SEND_HEAD_RE = /^\s*\[RELAY (?:寄信|回信)\]\s*to=([A-Za-z0-9_-]+)(?:\/(\S+))?((?:\s+re=[0-9a-f-]{36}|[^\S\r\n]+reply=(?:[Nn][Oo]|[Yy][Ee][Ss])(?=\s|$))*)[^\S\r\n]*\r?\n?/
export function parseSendHead(text) {
  const m = String(text).match(SEND_HEAD_RE)
  if (!m) return null
  const opts = m[3] || ''
  const reply = /\breply=(\w+)/.exec(opts)?.[1]?.toLowerCase()
  return { to_node: m[1], to_agent: m[2] || undefined, re: /\bre=([0-9a-f-]{36})/.exec(opts)?.[1], reply, body: String(text).slice(m[0].length).trim() }
}
