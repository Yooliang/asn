// 手機上確認「電腦要往終端送字／代答提問」的請求（#285、#296；後台見 _shared/term_request.ts）的畫面邏輯。
// 只有桌面能建立請求，手機只能「確認／拒絕」；內容雜湊由桌面算、這裡原樣帶回，後台比對，不一樣就不會執行。
// 預覽文字只用來給本人看（不寫儲存、不放網址、不進 console）；通知只敲門鈴、不帶內容。手機確認不等於授權資料夾，也不能解鎖接手窗格的寫入。

export const POLL_MS = 30_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH_RE = /^[0-9a-f]{64}$/
const CTRL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g   // 控制字元與雙向文字控制（防視覺偽裝）
export const clean = (s, n) => String(s ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(CTRL_RE, ' ').slice(0, n)

// 後台錯誤（Rust 端字串形如「term_req_decide HTTP 409 hash_mismatch」）→ 中文
const ERR = [
  ['hash_mismatch', '內容已經變了，請重新整理後再確認'],
  ['not_found', '這筆請求已經結束（過期、已處理或不是你的）'],
  ['forbidden', '只有你本人登入的設備能確認'],
  ['bad_choice', '選的項目不在這筆請求的選項裡'],
  ['busy', '這個終端還有一筆請求在處理中'],
  ['rate_limited', '請求太多次了，請稍後再試'],
  ['尚未登入', '請先登入再確認'],
  ['unauthorized', '請先登入再確認'],
]
export function errorText(e) {
  const s = String(e?.message ?? e ?? '')
  for (const [k, t] of ERR) if (s.includes(k)) return t
  return '送出失敗，請稍後再試'
}

/**
 * 後台清單 → 畫面用的列。nameOf(node)＝設備名稱（沒有就空字串）；nowMs＝現在（毫秒，測試可注入）。
 * 欄位壞掉的、已過期的丟掉。選項只收 { n, label }；預覽清掉控制字元後最多 200 字。
 */
export function normalizeList(raw, nameOf = () => '', nowMs = Date.now()) {
  const list = Array.isArray(raw?.requests) ? raw.requests : []
  const out = []
  for (const r of list) {
    if (!r || typeof r.id !== 'string' || !UUID_RE.test(r.id) || typeof r.body_hash !== 'string' || !HASH_RE.test(r.body_hash)) continue
    if (r.kind !== 'send' && r.kind !== 'answer') continue
    const until = Date.parse(r.expires_at)
    const secondsLeft = Number.isFinite(until) ? Math.floor((until - nowMs) / 1000) : 0
    if (secondsLeft <= 0) continue
    const options = r.kind === 'answer' && Array.isArray(r.options)
      ? r.options.filter(o => o && Number.isInteger(o.n) && o.n >= 0 && o.n <= 99 && typeof o.label === 'string').map(o => ({ n: o.n, label: clean(o.label, 120).trim() })).filter(o => o.label)
      : []
    if (r.kind === 'answer' && !options.length) continue
    out.push({
      id: r.id, kind: r.kind, hash: r.body_hash, secondsLeft,
      deviceName: clean(nameOf(r.node), 60) || '某台電腦', term: clean(r.term_id, 16), folder: clean(r.folder_label, 120),
      preview: clean(r.preview, 200), enter: r.enter === true, options,
    })
  }
  return out
}

// 下一筆要問本人的：跳過「先不處理」的
export const nextToAsk = (list, dismissed) => list.find(r => !dismissed.has(r.id)) ?? null

export function countdownText(sec) {
  const s = Math.max(0, Math.floor(sec))
  return `剩 ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * 本人按了「確認」或「拒絕」：回給 android_term_req_decide 的參數；不合格回 null（不送）。
 * 代答要先選一個選項（沒有預設選項）；送字不帶選項。雜湊原樣帶回。
 */
export function decideArgs(cur, decision, choiceN) {
  if (!cur || (decision !== 'approve' && decision !== 'deny')) return null
  const base = { id: cur.id, decision, hash: cur.hash }
  if (decision === 'deny') return { ...base, choiceN: null }
  if (cur.kind === 'answer') return cur.options.some(o => o.n === choiceN) ? { ...base, choiceN } : null
  return { ...base, choiceN: null }
}

export const TEXT = {
  titleSend: '電腦要替你往終端送字',
  titleAnswer: '終端在等你回答',
  leadSend: '確認之後，電腦才會把下面這段文字送進那個終端。你不確認就不會送。',
  leadAnswer: '選一個選項再按確認，電腦才會替你選。沒有預設選項，你不選就不會送。',
  deviceLabel: '哪台電腦',
  termLabel: '哪個終端',
  folderLabel: '資料夾',
  previewLabel: '要送的字',
  optionLabel: '選項',
  enterYes: '送完後會再按一次 Enter',
  enterNo: '只把字打進去，不按 Enter',
  note: '預覽只放前 200 字，已去掉控制字元。你按確認不等於授權這個資料夾。',
  ok: '確認',
  deny: '拒絕',
  later: '先不處理',
  pickFirst: '請先選一個選項',
}
