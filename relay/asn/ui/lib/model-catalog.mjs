// 開新夥伴 UI 用模型清單（瀏覽器可載入；勿 import Node 模組）。
// 與 relay/shared/launcher-profiles.mjs 的 MODEL_CATALOG 保持同步（test/partner.test.mjs 會比對）。

/** @typedef {'window'|'background'} LaunchMode */

export const MODEL_CATALOG = [
  { id: 'claude', toolId: 'claude', profileId: 'claude', label: 'Claude', mode: 'window', modeLabel: '會開一個視窗', acpWhy: 'Claude 沒有內建通道，只能開成終端機視窗', channels: { term: { status: 'window', why: '開成自己的終端機視窗（不是 ASN 自帶終端），靠 asn 外掛收發信' }, acp: { status: 'no', why: '刻意不做（帳務風險，#273）' }, pi: { status: 'untested', why: 'pi 可以用 Claude 訂閱登入，ASN 裡還沒有實際用過' } } },
  { id: 'codex', toolId: 'codex', profileId: 'codex', label: 'Codex', mode: 'window', modeLabel: '會開一個視窗', acpWhy: 'Codex 還沒有內建通道，只能開成終端機視窗', channels: { term: { status: 'window', why: '開成自己的終端機視窗，還沒有真機實測' }, acp: { status: 'no', why: '還沒有內建通道' }, pi: { status: 'untested', why: 'pi 有 openai-codex 提供者，ASN 裡還沒有實際用過' } } },
  { id: 'gemini', toolId: 'agy', profileId: 'gemini', label: 'Gemini', mode: 'background', modeLabel: '由 ASN 內建通道執行', cliWhy: '終端機版可以從「＋」→「在這台開終端…」開在 ASN 自帶的終端裡，但那樣 ASN 收不到它的信；要收發信請用內建通道', channels: { term: { status: 'noinbox', why: '可以開在 ASN 自帶終端（0.1.86 起），但收不到信' }, acp: { status: 'ok', why: '背景運行，可以收發信（0.1.70 起，有真機）' }, pi: { status: 'no', why: 'pi 已拿掉 Gemini 訂閱登入，不建議' } } },
  { id: 'grok', toolId: 'grok', profileId: 'grok', label: 'Grok', mode: 'background', modeLabel: '由 ASN 內建通道執行', cliWhy: '終端機版可以從「＋」→「在這台開終端…」開在 ASN 自帶的終端裡，但那樣 ASN 收不到它的信；要收發信請用內建通道', channels: { term: { status: 'noinbox', why: '可以開在 ASN 自帶終端（0.1.84 起），但收不到信' }, acp: { status: 'ok', why: '背景運行，可以收發信（0.1.70 起，有真機）' }, pi: { status: 'untested', why: 'pi 有 xai 提供者，ASN 裡還沒有實際用過' } } },
  { id: 'pi', toolId: 'pi', profileId: 'pi', label: 'pi', mode: 'window', modeLabel: '會開一個互動視窗（只能開在前台）', foregroundOnly: true, channelOnly: true, acpWhy: 'pi 沒有內建通道，只能開成終端機視窗', channels: { term: { status: 'window', why: 'pi 自己就是互動視窗，靠 pi 擴充收發信' }, acp: { status: 'no', why: 'pi 沒有內建通道' }, pi: { status: 'ok', why: '可以切換提供者和模型' } } },
]

/**
 * 開新夥伴的「運行」二選一：CLI（開終端機視窗）／內建通道（ACP，背景運行，沒有視窗、要先安裝對應 CLI）。
 * 模型一選，哪種運行方式可用就由目錄決定（mode: window＝CLI、background＝內建通道）；不支援的那個反灰並寫原因（cliWhy／acpWhy）。
 * 目錄上沒有的項目（自訂設定）：只認那台回報的 mode，不支援的那個用通用原因。電腦版對話框與手機第 2 頁共用。
 * 回傳 { choices: [{ key: 'cli'|'acp', label, ok, why }], selected: 'cli'|'acp' }
 */
export const RUN_LABEL = { cli: 'CLI（開終端機視窗）', acp: '內建通道（背景運行）' }
const RUN_GENERIC_WHY = '這個模型的啟動設定不支援這種運行方式'
export function runChoices(row) {
  const acp = row?.mode === 'background'
  const choices = [
    { key: 'cli', label: RUN_LABEL.cli, ok: !acp, why: acp ? (row?.cliWhy || RUN_GENERIC_WHY) : '' },
    { key: 'acp', label: RUN_LABEL.acp, ok: acp, why: acp ? '' : (row?.acpWhy || RUN_GENERIC_WHY) },
  ]
  return { choices, selected: acp ? 'acp' : 'cli' }
}

/**
 * 每個模型的三條通道（#351 第 1 步，只是資料與文字）：term＝終端機（ASN 自帶終端或自己的視窗）、acp＝內建通道、pi＝經 pi 跑。
 * status：ok 可用／window 開成自己的視窗／noinbox 開得起來但收不到信／untested 理論可行但沒實測／no 不支援或刻意不做。
 * 回 [{ key, label, status, statusText, why }]；目錄上沒有 channels 的（自訂設定）回空陣列。
 */
// 排列順序＝優先序（小良哥 10/27 決定）：內建通道（ACP）＞經 pi＞終端機（ASN 開的）；使用者自己開的 CLI 加外掛排最後、不在這裡
export const CHANNEL_LABEL = { acp: '內建通道', pi: '經 pi', term: '終端機' }
export const CHANNEL_STATUS_TEXT = { ok: '可用', window: '開成視窗', noinbox: '收不到信', untested: '沒實測', no: '不支援' }
export function channelRows(row) {
  const ch = row?.channels
  if (!ch || typeof ch !== 'object') return []
  const rows = Object.keys(CHANNEL_LABEL).filter(k => ch[k]).map(k => ({ key: k, label: CHANNEL_LABEL[k], status: ch[k].status, statusText: CHANNEL_STATUS_TEXT[ch[k].status] ?? '', why: String(ch[k].why ?? ''), recommended: false }))
  const best = rows.find(r => r.status === 'ok')   // 依優先序第一個「可用」的就是推薦；都沒有就不標
  if (best) best.recommended = true
  return rows
}

/**
 * 開新夥伴的「運行」四選一（#351，小良哥 10/27：開終端不是獨立功能，是開新夥伴的一個選項）。順序＝優先序：
 *   acp 內建通道 ＞ pi 經 pi ＞ term ASN 開的終端（進階）＞ self 自己開的 CLI（始終不能選，只顯示說明與接手入口）。
 * row：目錄列（有 channels 與 toolId）；local：選的是這台電腦；piInstalled：這台偵測到 pi；piReady：ASN 已能帶提供者／模型開 pi（0.1.90 起）。
 * 回 { options: [{ key, label, ok, why, note }], selected }；selected＝依序第一個 ok 的（沒有就 null）。
 */
/**
 * 開新夥伴的「模型」清單只列廠家（小良哥 10/27：pi 是通道，不是廠家）。目錄上 channelOnly 的（pi）不列進廠家清單，只在「運行」的「經 pi」出現。
 * 目錄裡仍留著 pi 這一列，因為後端啟動設定的 profile 叫 pi，經 pi 開的時候要用它。
 */
export const vendorRows = rows => (Array.isArray(rows) ? rows : []).filter(r => r && !r.channelOnly)

export const RUN_OPTION_LABEL ={ acp: '內建通道（背景運行）', pi: '經 pi', term: 'ASN 開的終端（進階）', self: '原生 CLI（手動開啟）' }
const TERM_PROFILES = ['grok', 'agy']   // 後端 term_start 只收這兩個（launch/term.rs resolve_command）
export function runOptions(row, { local = false, piInstalled = false, piReady = false } = {}) {
  const ch = row?.channels ?? {}
  const st = k => ch[k]?.status
  const why = k => String(ch[k]?.why ?? '')
  const isPiItself = row?.id === 'pi'
  const opt = (key, ok, reason, note = '') => ({ key, label: RUN_OPTION_LABEL[key], ok, why: ok ? '' : reason, note })
  const acpOk = st('acp') === 'ok'
  const piOk = st('pi') !== undefined && st('pi') !== 'no' && piInstalled && (isPiItself || piReady)
  const piWhy = st('pi') === 'no' || st('pi') === undefined ? (why('pi') || '這個模型不能經 pi 開') : !piInstalled ? '這台電腦沒偵測到 pi（PATH 和 npm、pnpm、scoop 的安裝資料夾都找過）；剛裝好的話，把 ASN 關掉重開再試' : '0.1.90 起才能帶提供者和模型開 pi'
  // 終端：Claude、Codex、pi 是 ASN 開成它自己的終端機視窗（原本的開法，別台設備也能遠端開）；Grok、Gemini 是 ASN 內建的 WezTerm，只能在這台開
  const termWindow = st('term') === 'window'
  const termWez = ['ok', 'noinbox'].includes(st('term')) && TERM_PROFILES.includes(row?.toolId)
  const termOk = termWindow || (termWez && local)
  const termWhy = termWez ? '只能在那台電腦上開' : (why('term') || '不支援')
  const termNote = termWindow ? '開成它自己的終端機視窗' : termWez && st('term') === 'noinbox' ? '收不到信，只能看畫面、送字' : ''
  const selfNote = row?.id === 'claude' ? '自己開 claude，裝了 ASN 外掛會出現在名單上' : isPiItself ? '自己開 pi，裝了 ASN 擴充會出現在名單上' : '已開著的可以用「接手已開著的終端視窗」接進來'
  const options = [
    opt('acp', acpOk, why('acp') || '這個模型沒有內建通道'),
    opt('pi', piOk, piWhy),
    opt('term', termOk, termWhy, termOk ? termNote : ''),
    opt('self', false, 'ASN 只負責接手，不能從這裡開', selfNote),   // 小良哥 10/27 #723：這一項始終不能選，只顯示說明
  ]
  // 預設：優先序第一個能選的；三條都不行就沒有預設（null），開啟按鈕要反灰
  const first = options.find(o => o.ok)
  return { options, selected: first ? first.key : null }
}

/**
 * Claude 可切換的模型（對話中途換模型用；--model 接受這些別名）。
 * family 用來和啟動參數裡的 --model 比對（別名 opus、完整名稱 claude-opus-4-5、帶 [1m] 後綴都算同一家）。
 */
export const CLAUDE_MODELS = [
  { id: 'opus', family: 'opus', label: 'Opus' },
  { id: 'sonnet', family: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', family: 'haiku', label: 'Haiku' },
]
