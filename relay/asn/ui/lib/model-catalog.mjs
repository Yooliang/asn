// 開新夥伴 UI 用模型清單（瀏覽器可載入；勿 import Node 模組）。
// 與 relay/shared/launcher-profiles.mjs 的 MODEL_CATALOG 保持同步（test/partner.test.mjs 會比對）。

/** @typedef {'window'|'background'} LaunchMode */

export const MODEL_CATALOG = [
  { id: 'claude', toolId: 'claude', profileId: 'claude', label: 'Claude', mode: 'window', modeLabel: '開在 ASN 終端，可以收發信', channels: { term: { status: 'window', why: '開在 ASN 終端，靠 ASN 外掛收發信' }, acp: { status: 'no', why: 'Claude 不支援' }, pi: { status: 'untested', why: 'pi 可以用 Claude 訂閱登入' } } },
  { id: 'codex', toolId: 'codex', profileId: 'codex', label: 'Codex', mode: 'window', modeLabel: '開在 ASN 終端', channels: { term: { status: 'window', why: '開在 ASN 終端' }, acp: { status: 'no', why: 'Codex 不支援' }, pi: { status: 'untested', why: 'pi 有 openai-codex 提供者' } } },
  { id: 'gemini', toolId: 'agy', profileId: 'gemini', label: 'Gemini', mode: 'background', modeLabel: '沒有畫面，收到信才起來', channels: { term: { status: 'noinbox', why: '可以開在 ASN 終端，但收不到信' }, acp: { status: 'ok', why: '沒有畫面，可以收發信' }, pi: { status: 'no', why: 'pi 不支援 Gemini 訂閱登入' } } },
  { id: 'grok', toolId: 'grok', profileId: 'grok', label: 'Grok', mode: 'background', modeLabel: '沒有畫面，收到信才起來', channels: { term: { status: 'noinbox', why: '可以開在 ASN 終端，但收不到信' }, acp: { status: 'ok', why: '沒有畫面，可以收發信' }, pi: { status: 'untested', why: 'pi 有 xai 提供者' } } },
  { id: 'pi', toolId: 'pi', profileId: 'pi', label: 'pi', mode: 'window', modeLabel: '開在 ASN 終端，只能開在前台', foregroundOnly: true, channelOnly: true, channels: { term: { status: 'window', why: '開在 ASN 終端，靠 pi 擴充收發信' }, acp: { status: 'no', why: 'pi 不支援' }, pi: { status: 'ok', why: '可以切換提供者和模型' } } },
]

/**
 * 每個模型的三條通道（#351 第 1 步，只是資料與文字）：term＝asn終端（原生 cli）、acp＝acp通道（無介面）、pi＝asn終端（pi shell）。
 * status：ok 可用／window 開在 ASN 終端（終端服務沒開時退回原生主控台）／noinbox 開得起來但收不到信／untested 理論可行但沒實測／no 不支援或刻意不做。
 * channels.*.why 會直接顯示在畫面上：只寫使用者能據以行動的話，議題編號、版本、內部原因寫在註解（#931）。
 * 給開發者的背景：Claude 的 acp 是刻意不做（帳務風險，#273）；Gemini／Grok 的終端 0.1.84／0.1.86 起可開、acp 0.1.70 起有真機。
 * 回 [{ key, label, status, statusText, why }]；目錄上沒有 channels 的（自訂設定）回空陣列。
 */
// 排列順序＝優先序（小良哥 10/27 決定）：acp通道＞asn終端（pi shell）＞asn終端（原生 cli）；使用者自己開的 CLI 加外掛排最後、不在這裡
export const CHANNEL_LABEL = { acp: 'acp通道', pi: 'asn終端（pi shell）', term: 'asn終端（原生 cli）' }
export const CHANNEL_STATUS_TEXT = { ok: '可用', window: '開在 ASN 終端', noinbox: '收不到信', untested: '可以試試看', no: '不支援' }
export function channelRows(row) {
  const ch = row?.channels
  if (!ch || typeof ch !== 'object') return []
  const rows = Object.keys(CHANNEL_LABEL).filter(k => ch[k]).map(k => ({ key: k, label: CHANNEL_LABEL[k], status: ch[k].status, statusText: CHANNEL_STATUS_TEXT[ch[k].status] ?? '', why: String(ch[k].why ?? ''), recommended: false }))
  const best = rows.find(r => r.status === 'ok')   // 依優先序第一個「可用」的就是推薦；都沒有就不標
  if (best) best.recommended = true
  return rows
}

/**
 * 開新夥伴的「模型」清單只列廠家（小良哥 10/27：pi 是通道，不是廠家）。目錄上 channelOnly 的（pi）不列進廠家清單，只在「運行」的「經 pi」出現。
 * 目錄裡仍留著 pi 這一列，因為後端啟動設定的 profile 叫 pi，經 pi 開的時候要用它。
 */
export const vendorRows = rows => (Array.isArray(rows) ? rows : []).filter(r => r && !r.channelOnly)

/**
 * 開新夥伴的「運行」四選一（#351，小良哥 10/27：開終端不是獨立功能，是開新夥伴的一個選項；名稱 #931 小良哥 11/06 定案，手機與電腦版共用）。
 * 順序＝優先序（#931 小良哥 11/07 定：asn終端優先，Claude 在 pi 已登入時也不再預設經 pi）：
 *   term asn終端（原生 cli）＞ acp acp通道（無介面）＞ pi asn終端（pi shell）＞ self 原始 cli 視窗（始終不能選，只顯示說明與接手入口）。
 *   例外：term 收不到信時（Grok／Gemini 開在 ASN 終端）不當預設，改用下一個能選的；都不行才用它。
 * row：目錄列（有 channels 與 toolId）；local：選的是這台電腦；piInstalled：這台偵測到 pi；piReady：ASN 已能帶提供者／模型開 pi（0.1.90 起）。
 * 回 { options: [{ key, label, ok, why, note }], selected }；selected＝依序第一個 ok 的（收不到信的 term 排到最後；沒有就 null）。
 * why／note 會直接顯示在畫面上（#931 文案規則：給使用者能據以行動的話，不寫議題編號、版本、內部原因）。
 */
export const RUN_OPTION_LABEL = { acp: 'acp通道（無介面）', pi: 'asn終端（pi shell）', term: 'asn終端（原生 cli）', self: '原始 cli 視窗' }
const TERM_PROFILES = ['grok', 'agy']   // 後端 term_start 只收這兩個（launch/term.rs resolve_command）
export function runOptions(row, { local = false, piInstalled = false, piReady = false } = {}) {
  const ch = row?.channels ?? {}
  const st = k => ch[k]?.status
  const why = k => String(ch[k]?.why ?? '')
  const isPiItself = row?.id === 'pi'
  const opt = (key, ok, reason, note = '') => ({ key, label: RUN_OPTION_LABEL[key], ok, why: ok ? '' : reason, note })
  const acpOk = st('acp') === 'ok'
  const piOk = st('pi') !== undefined && st('pi') !== 'no' && piInstalled && (isPiItself || piReady)
  // piReady 為 false＝這台的 ASN 還不能帶提供者和模型開 pi（0.1.90 以前）
  const piWhy = st('pi') === 'no' || st('pi') === undefined ? (why('pi') || '這個模型不支援') : !piInstalled ? '這台電腦沒偵測到 pi（PATH 和 npm、pnpm、scoop 的安裝資料夾都找過）；剛裝好的話，把 ASN 關掉重開再試' : '這台的 ASN 版本太舊，更新後才能用'
  // 終端：Claude、Codex、pi 走開窗點（終端服務開著就開進 ASN 終端，沒開退回原生主控台；別台設備也能遠端開）；Grok、Gemini 走 term_start，只能在這台開
  const termWindow = st('term') === 'window'
  const termWez = ['ok', 'noinbox'].includes(st('term')) && TERM_PROFILES.includes(row?.toolId)
  const termOk = termWindow || (termWez && local)
  const termWhy = termWez ? '只能在那台電腦上開' : (why('term') || '不支援')
  const termNote = termWindow ? '開在 ASN 終端，可以看畫面、喚醒' : termWez && st('term') === 'noinbox' ? '收不到信，只能看畫面、送字；也只能在這台電腦上開' : ''
  const selfNote = row?.id === 'claude' ? '自己開 claude，裝了 ASN 外掛就會出現在名單上' : isPiItself ? '自己開 pi，裝了 ASN 擴充就會出現在名單上' : '已開著的可以用「接手已開著的終端視窗」接進來'
  const options = [
    opt('term', termOk, termWhy, termOk ? termNote : ''),
    opt('acp', acpOk, why('acp') || '這個模型不支援'),
    opt('pi', piOk, piWhy),
    opt('self', false, '要自己開，不能從這裡開', selfNote),   // 小良哥 10/27 #723：這一項始終不能選，只顯示說明
  ]
  // 預設：優先序第一個能選的，但收不到信的 term 不搶預設（排到最後）；三條都不行就沒有預設（null），開啟按鈕要反灰
  const mailless = o => o.key === 'term' && st('term') === 'noinbox'
  const first = options.find(o => o.ok && !mailless(o)) ?? options.find(o => o.ok)
  return { options, selected: first ? first.key : null }
}

/**
 * 目錄上沒有的項目（自訂設定）的「運行」：只看那台回報的 mode，背景＝acp通道、其餘＝asn終端（原生 cli）。
 * 手機（mobile-launch.mjs launchRun）與電腦版（list.js partnerRun）共用這一份（#931）。回 { options, selected }
 */
export function customRunOptions(row) {
  const bg = row?.mode === 'background'
  return {
    options: [
      { key: 'acp', label: RUN_OPTION_LABEL.acp, ok: bg, why: bg ? '' : '這個設定不支援', note: '' },
      { key: 'term', label: RUN_OPTION_LABEL.term, ok: !bg, why: bg ? '這個設定只能用 acp通道' : '', note: '' },
    ],
    selected: bg ? 'acp' : 'term',
  }
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

/**
 * Gemini（agy 內建通道）可選的型號（#539 之四）：取自 `agy models` 的輸出（2026-10-30，只取 gemini 開頭的代號與顯示名）。
 * 真正能不能用以那台 agy 為準：切換時後端會再跑一次 `agy models` 比對，清單外的會被拒絕並列出可選的。
 */
export const GEMINI_MODELS = [
  { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
  { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
  { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
]

/**
 * 「切換模型」與「開新夥伴選型號」共用的型號清單（#539 之四，asn真 #1556 第 4 點：兩邊是同一份）。
 * engine：claude／pi／gemini／grok／codex…（ACP 工作者用名單上的 engine，例如 gemini）。
 * pi 沒有固定清單：傳入向 pi 查到的清單（pi-models.mjs 的 cleanPiModels 結果），原樣回傳。
 * 回 [{ id, label }]；回空陣列＝這家沒有清單，畫面退回手動輸入代號（grok、codex 目前如此）。
 */
export function switchModelsFor(engine, { piModels = null } = {}) {
  switch (String(engine ?? '').toLowerCase()) {
    case 'claude': return CLAUDE_MODELS
    case 'gemini': return GEMINI_MODELS
    case 'pi': return Array.isArray(piModels) ? piModels : []
    default: return []
  }
}

/**
 * 開新夥伴第 2 頁「型號」（#539 之四）：選完廠牌與運行後，這家有清單才出現（預設＝不指定，照原本的開法）。
 * 只有開在這台電腦才能選（遠端開帶型號要改後台開窗表，還沒做）；Claude 只在開成視窗時帶 --model，Gemini 只在內建通道時記下型號。
 * 跟後端 launch_model_plan（launch/local.rs）同一個判斷：內建通道（背景）照記；開成視窗只認 profile 明寫 engine "claude"，
 * 沒寫 engine 的自訂 profile 後端會回錯誤，所以不出下拉。engine＝這次要用的 profile 的 engine（partner-launch-ui.mjs 的 localProfileEngine）。
 * 回 { show, models }。
 */
export const LAUNCH_MODEL_RUN = { claude: 'term', gemini: 'acp' }
const engineAccepts = (run, engine) => run === 'acp' || engine === 'claude'
export function launchModelChoices(vendorId, run, { local = false, engine = '' } = {}) {
  const models = switchModelsFor(vendorId)
  const ok = local && models.length > 0 && LAUNCH_MODEL_RUN[vendorId] === run && engineAccepts(run, engine)
  return { show: ok, models: ok ? models : [] }
}
