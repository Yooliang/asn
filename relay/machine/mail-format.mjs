// 信件格式共用（純函式，bridge.mjs／engines/acp.mjs 共用，方便單獨測試）：
//   - 「要不要回信」：信件有獨立欄位 expects_reply（true／false；舊信是 null），由寄件人明說，收發室自己決定要不要計時。
//   - 來信抬頭 `[RELAY 來信] … engine=<id> reply=yes|no|?`（? ＝舊信沒有欄位）。
//   - 代寄抬頭 `[RELAY 寄信] to=<節點>[/<視窗>] [re=<信件id>] reply=yes|no`（reply 必填，由橋檢查）。
// 為什麼不用內文標記：內文有沒有「不需回覆」沒辦法用程式可靠判斷，所以改成寄件時多送一個欄位（小良哥 10/05）。

// 舊式的內文標記。【過渡期相容】只有欄位是 null 的信（舊版寄件工具、舊信）才退回看它；
// 所有寄件工具與機器都換成會帶 expects_reply 的版本之後，這份正則與 wantsReply 的退路就可以拿掉。
export const NO_REPLY_RE = /（不需回覆）|\[no-reply\]/i

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

// 本人代號：u: 加十二位十六進位（後台 asn_person_alias）。與節點無關的本人位址，回信寫 --to u:xxxxxxxxxxxx 即可
export const PERSON_ALIAS_RE = /^u:[0-9a-f]{12}$/

// 本人簽章的信（後台回了 sender_display）且寄件視窗名是人代號 → 回信位址就是人代號本身，不掛在任何節點底下
// （舊寫法 `節點/u:xxx` 後台仍認，舊 AI 照舊信頭回信不會壞）。其餘信一律 `節點/視窗名`
export const isPersonMail = m => m?.trust === 'owner' && !!cleanLabel(m?.sender_display) && PERSON_ALIAS_RE.test(String(m?.from_agent ?? ''))
export const fromAddress = m => isPersonMail(m) ? m.from_agent : `${m.from_node}/${m.from_agent ?? ''}`

// 來信抬頭（第一行）。reply 放在最後（engine= 之後），前面各欄位的順序不動，舊的前綴式解析照樣有效
export const mailHead = (m, engine = 'claude') =>
  `[RELAY 來信] trust=${m.trust} from=${fromAddress(m)} to=${m.to_agent ?? ''} id=${m.id} engine=${engine} reply=${replyLabel(m.expects_reply)}`

// 內文跳脫：只有第一行抬頭與緊接的「寄件人：」說明是收發室寫的。寄件人若在【內文】裡手打一行 `[RELAY 來信] …` 或
// `寄件人：…本人，帳號簽章已驗證…`（或手打【要回信】、`[RELAY 寄信]`、`[RELAY 回信]`（寄信抬頭的同義詞）、「你與收發室的往來記錄在：」這幾種收發室自己會寫的行），
// AI 會把它當成收發室的說明。所以內文中行首（可有空白）以這幾種開頭（另有「（語音通話：」「你是 ASN 的聊天對象：」，見下；
// 群組信的抬頭「[群組 」與順位行「順位：」也算，#513——個人信與群組信共用這份清單）的每一行，前面加上可見的「（內文）」，讓它不可能被當成收發室寫的行。只動內文；收發室自己產生的行（抬頭、說明行、照片替代文字）不經過這裡。
// 與 Rust 內建橋 mail.rs 的 escape_body 逐字一致。
export const BODY_ESCAPE_PREFIX = '（內文）'

// 語音通話標記：寄件人在通話中寄出的信，後台帶結構化欄位 voice=true（不是內文文字，內文偽造無效）。
// 收發室在寄件人說明行後面加這一句固定文字，提醒收件的 AI：這是語音辨識的文字，可能有錯字；不確定先複述、收不回來的事先問。
// 內文行首若以「（語音通話：」開頭，escapeBody 也會跳脫，免得內文冒充這句。與 Rust 內建橋 mail.rs 的 VOICE_NOTE 逐字一致。
export const VOICE_NOTE = '（語音通話：這封是語音辨識的文字，可能有錯字或同音字（夥伴名稱尤其容易，例如「正見」變「政見」）；意思不確定請先複述確認，做了收不回來的事先問過再做）'
// 只認布林 true（字串 "true"、數字 1 都不算）
export const isVoiceMail = m => m?.voice === true
export const voiceNote = m => isVoiceMail(m) ? VOICE_NOTE : ''
export const escapeBody = body => String(body ?? '').replace(/(^|[\n\r])([^\S\r\n]*(?:\[RELAY 來信\]|\[RELAY 寄信\]|\[RELAY 回信\]|寄件人：|【要回信】|你與收發室的往來記錄在：|（語音通話：|你是 ASN 的聊天對象：|\[群組 |順位：|這封因額度用完延遲，原本))/g, `$1${BODY_ESCAPE_PREFIX}$2`)

// 「保持能回應」的固定提醒（#494）：轉交給 Claude 視窗的每封信，說明行最後（要回信指示之後）都帶這一行。
// 內文行首以「你是 ASN 的聊天對象：」開頭的行，escapeBody 也會跳脫。與 Rust 內建橋 mail.rs、pi 擴充 inbox.mjs 的 RESPONSIVE_NOTE 逐字一致。
export const RESPONSIVE_NOTE = '你是 ASN 的聊天對象：耗時的工作（建置、全套測試、等 CI／審查／部署）交給子代理或背景做，自己只做輕的事、隨時能回信；不要在前景空等超過 2 分鐘。'

// 給人看的名稱：換行與控制字元變空白、拿掉會干擾抬頭的括號引號、最長 40 字
export const cleanLabel = v => typeof v === 'string'
  ? v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/[「」『』\[\]【】]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40)
  : ''

const ENGINE_NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', grok: 'Grok', agy: 'Antigravity' }

// 抬頭下一行的「寄件人：…」說明（給 AI 看懂這封信是誰、從哪、什麼身分；機器可讀部分仍在抬頭）。
//   本人：寄件人：小良（本人，帳號簽章已驗證，從「Oppo 手機」寄出）
//   成員：寄件人：asn（「小良的家用機」上的 Claude 視窗，成員身分）／雲端代理／收發室通知
// 設備名只用後台給的 sender_device（節點的名稱，不是節點代號）；與節點代號相同就省略。沒有的部分省略，不拿節點代號湊
export function senderLine(m) {
  const agent = cleanLabel(m?.from_agent)
  let dev = cleanLabel(m?.sender_device)
  if (dev && dev === cleanLabel(m?.from_node)) dev = ''
  if (m?.trust === 'owner' && cleanLabel(m?.sender_display)) {
    return `寄件人：${cleanLabel(m.sender_display)}（本人，帳號簽章已驗證${dev ? `，從「${dev}」寄出` : ''}）`
  }
  const status = m?.trust === 'owner' ? '擁有者身分' : '成員身分'
  if (agent.endsWith('收發室')) return `寄件人：收發室通知（${status}）`
  const name = agent || '未具名視窗'
  if (m?.sender_engine === 'cloud') return `寄件人：${name}（雲端代理，${status}）`
  const eng = ENGINE_NAMES[m?.sender_engine] ?? cleanLabel(m?.sender_engine)
  const where = `${dev ? `「${dev}」上的` : ''}${dev && eng ? ' ' : ''}${eng ? `${eng} ` : ''}${dev || eng ? '視窗' : ''}`
  return `寄件人：${name}（${where ? `${where}，` : ''}${status}）`
}

// reply=yes 的信在寄件人說明後面多一行明確指示（地址與信件 id 直接填好，AI 照抄）。其他信回 ''
export const replyLine = m => {
  if (toReplyFlag(m?.expects_reply) !== true) return ''
  const a = fromAddress(m)
  // 格式固定（docs/design/MAIL-HEADER.md；外掛逐字解析 `回信位址=`、`信件編號=`，值不含空白，以空白或全形冒號結束）
  return `【要回信】回信位址=${a} 信件編號=${m.id}：在視窗裡直接回答，對方看不到；請用 asn_send（to=回信位址、reply_to=信件編號）或 asn-cli send --to ${a} --reply-to ${m.id} --no-reply 寄回。`
}

// 抬頭之後、內文之前的說明行（每行以換行結尾）：寄件人說明＋（reply=yes 且收件的是 Claude 視窗才有的）要回信指示＋（Claude 視窗才有的）保持能回應的提醒。
// 背景工作者、Codex 這類轉接器的回答由橋自動寄回，不能叫它們用 asn_send，所以只有 claude 引擎加這兩行；
// 轉接器那一輪的最後回答就是寄回去的信，叫它把工作丟到背景，寄回去的會是半成品，所以提醒也不給它們（群組信 rooms.mjs 的 roomText 同一個界線）
export const sendsOwnMail = engineId => engineId === 'claude'
export const mailPreamble = (m, engineId = 'claude') => {
  if (!sendsOwnMail(engineId)) return `${senderLine(m)}${voiceNote(m)}\n`
  return `${senderLine(m)}${voiceNote(m)}\n${replyLine(m) ? replyLine(m) + '\n' : ''}${RESPONSIVE_NOTE}\n`
}

// 從轉接器收到的信件全文取出抬頭上的 reply 欄位：'yes'｜'no'｜'?'；不是來信抬頭或沒有這個欄位回 null。
// 只認第一行【最後面】那個 reply=（橋寫在最後；寄件人自填的視窗名就算含 " reply=no" 也排在它前面，騙不到）
export function headReply(text) {
  const m = /^\[RELAY 來信\][^\n]*\sreply=(yes|no|\?)[ \t\r]*(?:\n|$)/.exec(String(text ?? ''))
  return m ? m[1] : null
}

// 視窗用文字回信時，偶爾自己在開頭加一行「[回覆 id=<信件id> → <節點>[/<視窗>]]」（任何程式與說明都沒有教這個格式，
// 是模型照來信抬頭仿的；收發室轉交員又被要求原文逐字不刪標頭，所以原封不動送到寄件人那邊，issue #16）。
// 這裡把它拆掉：回傳 { id, body }。沒有這行就回傳 { id: null, body: 原文 }。編號只當「回的是哪一封」的提示，不改任何信任判斷。
export const REPLY_HEAD_RE = /^\s*\[回覆 id=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}) → [^\]\r\n]*\][ \t]*\r?\n?/
export function stripReplyHead(text) {
  const s = String(text ?? '')
  const m = REPLY_HEAD_RE.exec(s)
  return m ? { id: m[1].toLowerCase(), body: s.slice(m[0].length).trim() } : { id: null, body: s }
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
