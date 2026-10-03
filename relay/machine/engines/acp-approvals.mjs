// 「問我」模式的授權簿：工作者要做政策標 ask 的動作時，轉接器把摘要寄給指定的人，等他回「允許／拒絕／這次全部允許」。
// 回覆走一般信件（寄給工作者本人），由轉接器的 deliver() 先問這裡認不認得；逾時一律當拒絕。
// 純邏輯（時間、計時器、寄信都從外面注入），方便測試。
import crypto from 'node:crypto'

export const DEFAULT_ASK_TIMEOUT_MS = 300_000   // 5 分鐘
const ID_RE = /(?:#|編號\s*|id\s*[=:]?\s*)?\b([A-Z0-9]{4})\b/

// 解析回覆文字 → 'allow_all' | 'allow' | 'deny' | null。順序很重要：「全部允許」先於「允許」，「不允許」先於「允許」
export function parseVerdict(text) {
  const t = String(text ?? '').trim().toLowerCase()
  if (/(全部允許|全部同意|都允許|都可以|這次全部|allow\s*all|approve\s*all|yes\s*to\s*all)/.test(t)) return 'allow_all'
  if (/(不允許|不同意|不可以|不行|不要|拒絕|禁止|否決|別做)|^\s*(no|n|deny|reject|否)(?![a-z])/.test(t)) return 'deny'
  if (/(允許|同意|核可|批准|沒問題)|^\s*(好的?|可以|ok|okay|yes|y|allow|approve)(?![a-z])/.test(t)) return 'allow'
  return null
}

// 信件全文 → { node, agent, body }。橋交給轉接器的 text 第一行是 `[RELAY 來信] trust=… from=<節點>/<視窗> to=… id=…`
export function parseMailText(text) {
  const s = String(text ?? '')
  const m = /^\[RELAY 來信\][^\n]*?\bfrom=([^\s/]*)\/(\S*)/.exec(s)
  const body = s.replace(/^\[RELAY 來信\][^\n]*\n?/, '').replace(/^\[收發室\][^\n]*\n?/, '')
  return { node: m?.[1] ?? '', agent: m?.[2] ?? '', body }
}

// 沒附編號時，整則回覆只能是一個表態（可帶句號驚嘆號）
const BARE_RE = /^(這次全部允許|全部允許|全部同意|都可以|不允許|不同意|不可以|不行|不要|拒絕|允許|同意|可以|核可|批准|好的?|否|ok|okay|yes|y|no|n|deny|reject|allow(?:\s+all)?|approve(?:\s+all)?)[\s。.!！]*$/i

export function createApprovals({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, newId, log = () => {} } = {}) {
  const items = new Map()   // id -> { id, worker, summary, targets, expires, resolve, timer, askedAt }
  const mkId = newId ?? (() => crypto.randomBytes(3).toString('hex').slice(0, 4).toUpperCase())

  // targets：[{ node, agent? }]，只有這些人的回覆算數。回傳 { id, promise }，promise 解成 'allow'|'allow_all'|'deny'|'timeout'
  function ask({ worker, summary, targets, timeoutMs = DEFAULT_ASK_TIMEOUT_MS }) {
    let id = mkId()
    while (items.has(id)) id = mkId()
    let resolve
    const promise = new Promise(r => { resolve = r })
    const timer = setTimer(() => finish(id, 'timeout'), timeoutMs)
    timer.unref?.()
    items.set(id, { id, worker, summary, targets, askedAt: now(), timeoutMs, resolve, timer })
    return { id, promise }
  }
  function finish(id, verdict) {
    const it = items.get(id)
    if (!it) return false
    items.delete(id)
    clearTimer(it.timer)
    it.resolve(verdict)
    return true
  }
  const allowed = (it, from) => it.targets.some(t => t.node === from.node && (!t.agent || t.agent === from.agent))

  const pendingFor = worker => [...items.values()].filter(i => i.worker === worker)

  // 一封寄給工作者的信：是不是在回覆授權？回傳 { handled, note?, id?, verdict? }
  function handleReply({ worker, from, text }) {
    const mine = pendingFor(worker).filter(i => allowed(i, from))
    if (!mine.length) return { handled: false }
    const verdict = parseVerdict(text)
    if (!verdict) return { handled: false }
    const hit = (String(text).toUpperCase().match(/\b[A-Z0-9]{4}\b/g) ?? []).map(c => mine.find(i => i.id === c)).find(Boolean)
    if (!hit && !BARE_RE.test(String(text).trim())) return { handled: false }   // 沒編號就只認「單純一個表態」（允許／拒絕／好／ok…），免得「好的，我晚點看」被當成放行
    if (!hit && mine.length > 1) {
      return { handled: true, note: `有 ${mine.length} 筆授權在等：${mine.map(i => `${i.id}（${i.summary}）`).join('；')}。請附上編號再回一次，例如「允許 ${mine[0].id}」。` }
    }
    const it = hit ?? mine[0]
    finish(it.id, verdict)
    log(`approval ${it.id} worker=${worker} verdict=${verdict} by=${from.node}/${from.agent}`)
    return { handled: true, id: it.id, verdict, note: `已收到：${verdict === 'deny' ? '拒絕' : verdict === 'allow_all' ? '這次全部允許' : '允許'}（${it.id}）` }
  }

  function cancelAll(worker, verdict = 'deny') { for (const i of pendingFor(worker)) finish(i.id, verdict) }
  return { ask, handleReply, pendingFor, cancelAll, size: () => items.size, finish }
}

// 寄給人看的授權詢問信
export function askText({ worker, id, summary, requester, timeoutMs }) {
  const mins = Math.max(1, Math.round(timeoutMs / 60000))
  return `［授權詢問 ${id}］${worker} 想做這件事，要不要放行？\n`
    + `${summary}\n`
    + (requester ? `起因：${requester} 的來信\n` : '')
    + `請回信給「${worker}」，寫「允許 ${id}」、「拒絕 ${id}」或「全部允許 ${id}」（全部允許＝這一輪之後的同類請求都放行）。${mins} 分鐘內沒回覆會自動拒絕。`
}
