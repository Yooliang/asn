// 各家 CLI 的型號清單 → 畫面要顯示的狀態（#2355 P1）。純函式，node 與瀏覽器都能跑；不碰畫面、不接線。
// 資料來源是那台電腦回報的摘要 launcher.models（陣列，每家一筆 { vendor, status, code?, stale?, age_s?, models: [{ id, name }] }），
// 或本機命令回的同一個形狀。畫面上只放白話；原因代碼、被丟掉的筆數一律進 console。
import { isValidModelId } from './model-id.mjs'

/**
 * Claude 沒有清單（CLI 沒有列型號的指令），所以只留別名：別名永遠指向最新版，不會過時（#2355 D1）。
 * 內容取自 `claude --help` 的 --model 說明；test/fixtures/claude-help-model.txt 存那段原文，CLI 說明一改測試就會紅。
 */
export const CLAUDE_HELP_ALIASES = Object.freeze(['fable', 'opus', 'sonnet'])
/**
 * 既有別名，保留：`claude --help` 的範例沒列 haiku，但 CLI 的 --model 一直認得它，原本切換模型與手機的按鈕也有它，
 * 拿掉等於讓使用者少一個能選的型號（領隊一審要求）。不跟 fixture 比對；CLI 哪天不認得它再拿掉。
 */
export const CLAUDE_KEPT_ALIASES = Object.freeze(['haiku'])
export const CLAUDE_ALIASES = Object.freeze([...CLAUDE_HELP_ALIASES, ...CLAUDE_KEPT_ALIASES])
/** 畫面上標在 Claude 別名旁邊的說明 */
export const CLAUDE_ALIAS_LABEL = '別名（最新版）'

/** pending 超過這麼久（以那台電腦回報摘要的時間為準）就當讀不到，不讓畫面一直轉圈（#2355 D8） */
export const PENDING_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 固定代碼 → 白話，每個代碼分 local（本機，說「這台電腦」）與 remote（別台，說「那台電腦」）兩句。
 * 鍵必須等於 Rust 端 `Code` 的全部值（test/remote-models.test.mjs 讀原始碼守門）。
 * {廠牌} 由 codeText 換成廠牌名稱。不提到電腦的代碼兩句相同。
 */
const same = (s) => Object.freeze({ local: s, remote: s })
export const CODE_TEXT = Object.freeze({
  ok: same('沒有可選的型號'),
  not_installed: Object.freeze({ local: '這台電腦沒有安裝 {廠牌}', remote: '那台電腦沒有安裝 {廠牌}' }),
  not_logged_in: Object.freeze({ local: '{廠牌} 還沒登入（登入後再試）', remote: '{廠牌} 還沒登入（到那台電腦登入後再試）' }),
  timeout: same('讀取逾時，請稍後重試'),
  spawn_failed: same('讀取失敗'),
  too_large: same('型號太多，放不進回報（清單不完整）'),
  parse_failed: same('讀到了但看不懂格式（版本太新或太舊）'),
  unsupported: same('這家沒有提供型號清單'),
})

/** 不認得的代碼（或沒有代碼）時的整句 */
export const UNKNOWN_FAILURE_TEXT = '讀不到型號清單'
/** 別台電腦沒有回報 models（舊版 ASN／舊後台）。只會出現在別台 */
export const NONE_TEXT = '那台電腦的 ASN 版本較舊，不能選型號，請先更新'
/** 本機沒有回報 models（正常不會發生；保險用，同樣不說「那台」）。本機畫面跟本機 ASN 一定是同一版，所以不寫「請先更新」（領隊 11/26 裁示） */
export const NONE_TEXT_LOCAL = '這台電腦讀不到型號清單'
export const PENDING_TEXT = '正在讀取型號清單…'

/**
 * 別台電腦的清單是那台自己定期更新、再經後台回來的，手機與電腦版都沒辦法叫它馬上重讀（#2355 D5）：
 * 所以按鈕叫「再查一次」（只是重新向後台問一次），並在說明裡講清楚為什麼不一定馬上有新的。
 */
export const REMOTE_RETRY_LABEL = '再查一次'
export const LOCAL_RETRY_LABEL = '重新讀取'
export const REMOTE_REFRESH_HINT = '那台電腦約每 10 分鐘會自己更新一次清單'

/** 畫面狀態（modelState 的結果或 local-models 的讀取結果）加上「別台」才有的說明與按鈕文字；沒有「再查一次」可按的狀態不加說明 */
export function remoteView(view) {
  if (!view || typeof view !== 'object') return view
  const retry = view.canRetry === true
  return { ...view, note: retry ? [view.note, REMOTE_REFRESH_HINT].filter(Boolean).join('。') : view.note, retryLabel: retry ? REMOTE_RETRY_LABEL : '' }
}

const VENDOR_LABEL = Object.freeze({ claude: 'Claude', codex: 'Codex', gemini: 'Gemini', pi: 'pi', grok: 'Grok' })

/**
 * 切換模型／遠端開窗的窄規則（#2387 修好前的暫時過濾）：只收英數與 . _ -，開頭英數，最多 60 字。
 * 與 Rust 的 acp_models::valid_model（launch_model_plan 用）同一條，是各處規則裡最窄的。
 * #2387 做完後，連同 modelState 的 narrow 選項一起刪掉。
 */
export const NARROW_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/

/**
 * CODE_TEXT 的某一句（換上廠牌名稱）；不認得的代碼回 UNKNOWN_FAILURE_TEXT。
 * where：'local'（本機）或 'remote'（別台，預設）；其他值當 remote。
 */
export function codeText(code, vendorLabel = '', where = 'remote') {
  const e = typeof code === 'string' && Object.prototype.hasOwnProperty.call(CODE_TEXT, code) ? CODE_TEXT[code] : null
  const t = e ? (where === 'local' ? e.local : e.remote) : ''
  return t ? t.replaceAll('{廠牌}', vendorLabel || '這個工具') : UNKNOWN_FAILURE_TEXT
}

/** 「讀不到型號清單：{白話原因}」；代碼不認得就只有前半句 */
function failNote(code, label, where) {
  const t = codeText(code, label, where)
  return t === UNKNOWN_FAILURE_TEXT ? t : `${UNKNOWN_FAILURE_TEXT}：${t}`
}

function toMs(t) {
  if (t instanceof Date) return t.getTime()
  if (typeof t === 'number') return Number.isFinite(t) ? t : NaN
  if (typeof t === 'string' && t) return Date.parse(t)
  return NaN
}

/** stale 清單的說明：不到 1 分鐘不寫；超過 1 小時寫小時 */
function staleNote(ageS) {
  if (typeof ageS !== 'number' || !Number.isFinite(ageS) || ageS < 0) return '清單不是最新的，剛才重新讀取失敗'
  if (ageS < 60) return ''
  if (ageS < 3600) return `清單是 ${Math.floor(ageS / 60)} 分鐘前讀到的，剛才重新讀取失敗`
  return `清單是 ${Math.floor(ageS / 3600)} 小時前讀到的，剛才重新讀取失敗`
}

/** 回報裡的 models → 乾淨的 [{ id, label }]：代號不合格、重複的丟掉；narrow 時再丟掉窄規則不收的。丟掉的筆數回在 dropped / narrowed */
function cleanModels(list, narrow) {
  const out = [], seen = new Set()
  let dropped = 0, narrowed = 0
  for (const m of Array.isArray(list) ? list : []) {
    const id = typeof m?.id === 'string' ? m.id : ''
    if (!isValidModelId(id) || seen.has(id)) { dropped++; continue }
    if (narrow && !NARROW_RE.test(id)) { narrowed++; continue }
    seen.add(id)
    const name = typeof m?.name === 'string' ? m.name.trim() : ''
    out.push({ id, label: name && name.length <= 100 ? name : id })
  }
  return { models: out, dropped, narrowed }
}

const result = (state, models, note, canRetry) => ({ state, models, note, canRetry })

function unavailable(note, canRetry = true) { return result('unavailable', [], note, canRetry) }

/**
 * 某廠牌的型號清單 → 畫面狀態。
 * source：launcher（別台，有 models 陣列）或本機命令的回應（同一個形狀）；沒有 models 陣列＝none。
 * ctx：{ now, launcherAt, vendorLabel, narrow, where }
 *   where：'local'（本機，文案說「這台電腦」）或 'remote'（別台，預設，說「那台電腦」）。
 *   now／launcherAt：毫秒數、Date 或 ISO 字串；pending 超過 PENDING_TIMEOUT_MS（以 launcherAt 為準）就當 unavailable。沒給 launcherAt（本機）就不判斷。
 *   narrow：true 時濾掉窄規則不收的型號（#2387 修好前用），被濾掉的筆數寫一行 console.info（只有廠牌與筆數）。
 * 回 { state: 'ready'|'stale'|'pending'|'unavailable'|'none', models: [{ id, label }], note, canRetry }；note 是給使用者看的白話。
 */
export function modelState(source, vendorId, ctx = {}) {
  const list = source?.models
  const where = ctx.where === 'local' ? 'local' : 'remote'
  if (!Array.isArray(list)) return result('none', [], where === 'local' ? NONE_TEXT_LOCAL : NONE_TEXT, false)
  const label = ctx.vendorLabel || VENDOR_LABEL[vendorId] || String(vendorId ?? '')
  const entry = list.find(e => e && e.vendor === vendorId)
  if (!entry) {
    console.info('[型號清單]', vendorId, '摘要裡沒有這家')
    return unavailable(UNKNOWN_FAILURE_TEXT)
  }
  const { status, code } = entry

  if (status === 'pending') {
    const at = toMs(ctx.launcherAt), now = toMs(ctx.now)
    if (Number.isFinite(at) && Number.isFinite(now) && now - at > PENDING_TIMEOUT_MS) {
      console.info('[型號清單]', vendorId, 'pending 太久，當成讀不到')
      return unavailable(failNote('timeout', label, where))
    }
    return result('pending', [], PENDING_TEXT, false)
  }

  if (status === 'ok') {
    const { models, dropped, narrowed } = cleanModels(entry.models, ctx.narrow === true)
    if (dropped) console.info('[型號清單]', vendorId, `有 ${dropped} 筆格式不正確，已略過`)
    if (narrowed) console.info(`[型號清單] ${vendorId} 有 ${narrowed} 筆因切換模型的格式限制先不列出`)
    if (!models.length) return unavailable(failNote('ok', label, where))
    if (entry.stale === true) {
      console.info('[型號清單]', vendorId, '沿用上次的清單', code)
      return result('stale', models, staleNote(entry.age_s), true)
    }
    return result('ready', models, '', false)
  }

  if (status === 'unavailable' || status === 'error') {
    console.info('[型號清單]', vendorId, status, code)
    return unavailable(failNote(code, label, where))
  }

  console.info('[型號清單]', vendorId, '不認得的狀態', status)
  return unavailable(UNKNOWN_FAILURE_TEXT)
}
