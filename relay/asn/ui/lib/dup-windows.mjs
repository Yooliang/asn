// 同一個名字開了兩個以上視窗（#584）：電腦端寄來的說明最後一行是記號「〔重複視窗 1=1234 2=5678〕」。
// 畫面不顯示這行，改成每個視窗一顆「關掉第 N 個」按鈕；按下去以本人身分寄「/asn-close-dup <pid>」給同一個視窗，
// 電腦端只關那一個（要本人簽章、而且那個 pid 真的是同名的其中一個，見 bridge/partner_ops/dup.rs）。
// 自己寄出的那則指令也不顯示原文，改成一句白話。這裡只管字串。
export const DUP_CLOSE_CMD = '/asn-close-dup'
export const DUP_SENT_TEXT = '（請電腦關掉一個重複的視窗）'

const MARK_RE = /^〔重複視窗((?:\s+\d{1,3}=\d{1,10})+)〕$/
const CMD_RE = /^\/asn-close-dup\s+(\d{1,10})$/

/** 拆出記號：{ text: 去掉記號後的內文, wins: [{ n, pid }] }；不是記號時 text 原樣、wins 空陣列 */
export function splitDupMark(raw) {
  const s = String(raw ?? '')
  const lines = s.replace(/\s+$/, '').split(/\r?\n/)
  const m = MARK_RE.exec(lines[lines.length - 1].trim())
  if (!m) return { text: s, wins: [] }
  const wins = m[1].trim().split(/\s+/).map(p => { const [n, pid] = p.split('='); return { n: Number(n), pid: Number(pid) } })
  if (wins.length < 2 || wins.some(w => !(w.n > 0) || !(w.pid > 0))) return { text: s, wins: [] }
  return { text: lines.slice(0, -1).join('\n').replace(/\s+$/, ''), wins }
}

/** 按下「關掉」要寄出的內文 */
export const dupCloseText = pid => `${DUP_CLOSE_CMD} ${pid}`

/** 按鈕字樣（20 字內） */
export const dupCloseLabel = n => `關掉第 ${n} 個`

/** 自己寄出的關閉指令：畫面改顯示白話；其他內文原樣 */
export const shownMine = text => (CMD_RE.test(String(text ?? '').trim()) ? DUP_SENT_TEXT : String(text ?? ''))
