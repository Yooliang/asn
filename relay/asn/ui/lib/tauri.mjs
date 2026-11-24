// Tauri 前端小橋：invoke／事件。錯誤一律包成 Error(字串)，讓 AsnCore 用 e.message 處理。
import { shownPhotos } from './photo.mjs'
import { makeSnapMax } from './snap-max.mjs'
const T = globalThis.__TAURI__

// 出口失敗寫記錄（#2106）：只記指令名與原文（限長），不記 args（可能含信件內容、路徑、金鑰）。
// 同一指令＋同一原文 60 秒內只記一行：輪詢類指令（收信、視窗狀態、終端狀態）失敗時會每幾秒重來，不去重 ui.log 會被洗掉。
// ui_log 自己不記：它失敗→記一行→排進佇列→再呼叫 ui_log 失敗，會繞圈。
export const INVOKE_LOG_TEXT_MAX = 300
export const INVOKE_LOG_DEDUP_MS = 60000
const INVOKE_LOG_SKIP = new Set(['ui_log'])
const recentFail = new Map()
const logFail = (cmd, msg) => {
  try {
    if (INVOKE_LOG_SKIP.has(cmd)) return
    const text = String(msg).replace(/\s+/g, ' ').trim().slice(0, INVOKE_LOG_TEXT_MAX)
    const key = `${cmd}\n${text}`
    const now = Date.now()
    const last = recentFail.get(key)
    if (last !== undefined && now - last < INVOKE_LOG_DEDUP_MS) return
    if (recentFail.size >= 200) for (const [k, t] of recentFail) if (now - t >= INVOKE_LOG_DEDUP_MS) recentFail.delete(k)
    if (recentFail.size >= 200) recentFail.clear()
    recentFail.set(key, now)
    console.warn('[ASN]', `invoke 失敗：${cmd} ${text}`)
  } catch { /* 記錄本身出錯不能影響呼叫端 */ }
}
export const invoke = async (cmd, args) => {
  try { return await T.core.invoke(cmd, args) } catch (e) {
    const msg = typeof e === 'string' ? e : (e?.message ?? String(e))
    logFail(cmd, msg)   // log 保留完整原文（含代號）
    // 後端的錯誤開頭有固定代號 `[前綴:名稱]`（設定層 `settings`、回報匯流排 `report`）：在這個唯一的出口拆開——message 是去掉代號的白話句（畫面直接顯示不會冒出代號），
    // 代號放在 err.code（`前綴:名稱`），要判斷的程式只認 code，不比對文字
    const m = /^\s*\[(settings|report):([a-z_]+)\]\s*/.exec(msg)
    const err = new Error(m ? msg.slice(m[0].length) : msg)
    if (m) err.code = `${m[1]}:${m[2]}`
    throw err
  }
}
// 開外部連結：沒有 Tauri（純網頁、測試）就什麼都不做，回 undefined（維持 chatpane 以前的 ?. 行為）
export const openLink = url => (T?.core?.invoke ? invoke('open_link', { url }) : undefined)
export const listen = (evt, fn) => T.event.listen(evt, e => fn(e.payload))
export const emit = (evt, payload) => T.event.emit(evt, payload)
export const ctl = op => invoke('win_ctl', { op })
// 附件快取清空了（換帳號、登入、登出）：這個視窗記著的大圖也丟掉（#1493）
if (T?.event) void listen('attach-cache-cleared', () => shownPhotos.clear()).catch(() => {})

// 給 AsnCore 的 transport：HTTP 與金鑰都在 Rust 端，這裡拿不到金鑰
export const transport = {
  list: () => invoke('relay_list'),
  taskManagerList: () => invoke('task_manager_list'),   // 電腦版工作管理員：這台電腦上 ASN 管的程式清單（只讀）→ { rows, known, now_ms }
  taskManagerRestartAsn: () => invoke('task_manager_restart_asn'),   // 工作管理員「重啟 ASN」：失敗回白話字串（成功後本程序會結束，ASN 自己重開）
  taskManagerRestartMux: () => invoke('task_manager_restart_mux'),   // 工作管理員「重啟終端服務」：新服務起好就回；失敗回白話字串
  localWindows: () => invoke('local_windows'),   // 電腦版：直接讀本機視窗狀態（手機沒有這個指令）
  partnerRepo: name => invoke('partner_repo', { name }),   // 電腦版：這個視窗工作資料夾對應的 GitHub 倉庫「擁有者/repo」（讀 .git 設定檔，不碰網路）；讀不到回 null（手機沒有這個指令，也不會有人叫）
  inbox: () => invoke('relay_inbox'),
  ack: ids => invoke('relay_ack', { ids }),
  rooms: () => invoke('relay_rooms'),
  send: payload => invoke('relay_send', { payload }),
  history: (node, agent, partnerId, before, limit) => invoke('relay_chat_history', { node, agent: agent || null, partnerId: partnerId || null, before: before || null, limit: limit || null }),   // 後台的往來記錄（要登入；本機只當快取）
  partnerOp: body => invoke('relay_partner_op', { body }),          // 管理夥伴視窗（詳情、改名、關閉、換班接手、喚醒；要本人簽章）→ { id }
  selfWindowDefault: taken => invoke('self_window_default', { taken }),   // 「接進收發室」的預設名字（agy-1…）
  selfWindowRegister: req => invoke('self_window_register', req),       // { pid, name, taken } → { name }；本人按「接進收發室」後才呼叫，電腦端核對程序與名字
  partnerOps: ids => invoke('relay_partner_ops', { ids }),          // 查上面那些操作的進度 → { ops: [...] }
  readSync: body => invoke('relay_read_sync', { body }),            // 已讀多端同步：送出我這端的已讀位置、取回整個帳號的（要本人簽章；沒登入或舊後台就回錯，前端靜默）
  partnerArchive: body => invoke('relay_partner_archive', { body }),  // 封存／取消封存夥伴（記在帳號層，要本人簽章）→ { ok, archived }
  authStatus: () => invoke('auth_status'),                           // → { signed_in, email }
  sentStatus: ids => invoke('relay_sent_status', { ids }).then(r => r?.status ?? []),
  avatar: node => invoke('relay_avatar', { node }),                 // 某台設備上傳的大頭貼（按需取）
  partnerAvatar: partner => invoke('relay_partner_avatar', { partner }),   // 夥伴自己換的頭像（按需取；名單帶 avatar_updated_at 才取）
  setAvatar: avatar => invoke('relay_set_avatar', { avatar }),      // 上傳自己這台的大頭貼；null＝移除
  sendAttachment: payload => invoke('relay_send_attachment', { payload }),   // 寄照片或檔案：Rust 端檢查、要上傳網址、上傳、確認、寄信
  launch: body => invoke('relay_launch', { body }),
  launchers: ids => invoke('relay_launchers', { ids: ids ?? null }),
  accountSwitch: (vendor, email) => invoke(vendor === 'grok' ? 'grok_account_switch' : 'claude_account_switch', { email }),   // 帳號卡「這台」那一列的切換（#2111 ③）：vendor＝claude|grok → 切換結果（失敗丟白話原因）
  cliDetect: () => invoke('ai_cli_detect'),
  cliStatus: force => invoke('ai_cli_status', { force: force === true }),   // 設定頁「已安裝的工具」：[{ id, installed, version, version_state, latest, login, login_count }]；force＝重新檢查（略過快取）
  cliInstall: toolId => invoke('ai_cli_install', { toolId }),   // 設定頁 Claude 那一列「進行安裝／進行更新」（#1548 ⑤）：已驗數位簽章的流程 → { ok, message, opened_login }；使用者同意後才呼叫
  partnerLaunchLocal: req => invoke('partner_launch_local', { req }),
  partnerConsoleQuery: req => invoke('partner_console_query', { req }),
  partnerConsoleSet: req => invoke('partner_console_set', { req }),
  termStart: req => invoke('term_start', { req }),           // { profile: 'grok'|'agy', cwd } → { id }；只在使用者於「開終端…」按「開啟」後呼叫
  termEnvNotice: () => invoke('term_env_notice'),            // 共用終端服務開著、而且使用者環境變數裡有看起來像金鑰的變數時回一句話（只含變數名字），否則 null（只在電腦版）
  partnerPermissionPrompt: name => invoke('partner_permission_prompt', { name }),   // { name, text, hash, complete }
  partnerPermissionChoose: (name, hash, n) => invoke('partner_permission_choose', { name, hash, n }),
  partnerPermissionAnswer: (name, hash, allow) => invoke('partner_permission_answer', { name, hash, allow }),
  autoResumeStatus: () => invoke('auto_resume_status'),      // 電腦重開後自動接回的結果（#767）；沒有就是 null
  partnerNoticesActive: () => invoke('partner_notices_active'),   // 讀畫面這次實際有沒有在跑（true/false）；查不到由呼叫端當成沒在跑
  partnerNotices: () => invoke('partner_notices'),           // 夥伴卡住的提醒：[{ name, code }]（只有視窗名與固定代號）
  termList: () => invoke('term_list'),                       // 這次由 ASN 開啟的終端：[{ id, profile, pid, started_ms, cwd }]（只在電腦版）
  termStatus: req => invoke('term_status', { req }),         // { id } → { state, prompt? }；等你回答時帶 prompt
  termRead: req => invoke('term_read', { req }),             // { id, lines } → 畫面最後幾行的純文字（只讀，不送任何鍵）
  termSend: req => invoke('term_send', { req }),             // { id, text, enter }；只在使用者按下「確認送出」後呼叫（後端另外檢查資料夾授權）
  compactHandoffRequest: name => invoke('compact_handoff_request', { name }),   // 工作管理員「交接」鈕（#1852）：只送視窗名，由內建收發室驗證後執行
  termStop: req => invoke('term_stop', { req }),             // { id }；對接手的窗格只是「解除接手」，不會結束那個程式
  termAdoptCandidates: () => invoke('term_adopt_candidates'), // [{ pid, pane_id, started_ms, profile, tab_title, cwd_raw, cwd_authorized, version_verified, version_note, already_adopted }]
  termAdopt: req => invoke('term_adopt', { req }),           // { pid, pane_id, started_ms } → { id }；使用者按「接手」後才呼叫
  termAdoptUnlock: req => invoke('term_adopt_unlock', { req }), // { id, allow_answer, allow_send }；只在使用者確認後呼叫，只有本機桌面能開
  termAnswer: req => invoke('term_answer', { req }),         // { id, prompt_kind, n } → { keys }；只在使用者按下送出後呼叫
  modelSwitchQuery: req => invoke('model_switch_query', { req }),   // 讀這個 Claude 視窗的目前模型與是否閒置
  modelSwitchRun: req => invoke('model_switch_run', { req }),       // 關掉那一個視窗、照原參數重開（--resume＋新 --model）
  subagentsQuery: req => invoke('subagents_query', { req }),         // 這個 Claude 視窗正在跑的子代理（讀對話記錄檔）
  tasksQuery: req => invoke('tasks_query', { req }),                 // 這個 Claude 視窗正在跑的背景工作（讀外掛寫的狀態檔，#539 之三）
  launchCwdCandidates: () => invoke('launch_cwd_candidates'),   // 白名單＋自動建議（Rust 端合併、去重、略過不存在的）
  launchCwdBrowse: () => invoke('launch_cwd_browse'),   // Rust 端開「選擇資料夾」；→ 路徑（已寫進本機白名單）或 null
  launchCwdRemove: cwd => invoke('launch_cwd_remove', { cwd }),   // 設定頁「移除」：依路徑從本機白名單拿掉一筆 → 移除後的清單；找不到丟白話原因
  launchPrefsGet: () => invoke('launch_prefs_get'),
  launchPrefsSet: prefs => invoke('launch_prefs_set', { prefs }),
  claudeQuotaState: () => invoke('claude_quota_state'),             // 這台目前登入的 Claude 帳號的額度查詢狀態（#1883）：→ { email, status: ok|login_expired|rate_limited|unavailable|none, read_at, windows }
  siteReleases: force => invoke('site_releases', { force: force === true }),   // 版本紀錄（後台公開表 asn_site_releases）：→ [{ version, date, lines }]；讀不到丟「暫時讀不到版本紀錄」（#462）
  piModels: force => invoke('pi_models', { force: force === true }),               // 經 pi 開新夥伴（#351）：→ [{ provider, model, context, thinking, images }]，只含已設好憑證的提供者；沒有 pi 回 []
  piProviders: force => invoke('pi_providers', { force: force === true }),         // → [{ provider, state: ready|not_ready|missing|unknown }]；不讀憑證
  piSetupStatus: () => invoke('pi_setup_status'),     // 讓自己開的 pi 連上 ASN（#240 方案 A）：→ { pi, ext, installed, stale }
  piSetupInstall: () => invoke('pi_setup_install'),   // 使用者同意後才呼叫：pi install 擴充 → 新狀態
  piSetupRemove: () => invoke('pi_setup_remove'),     // 移除我們裝的那一筆 → 新狀態
}
// 照片放大與另存（對話視窗各自呼叫，不經樞紐）：Rust 端換短效下載網址、下載、檢查
export const photoApi = {
  fetch: (id, expiresAt = null) => invoke('relay_attachment_fetch', { id, expiresAt }),   // → { name, mime, data_url }；expiresAt＝附件到期（毫秒），快取只存到那時
  save: (id, name) => invoke('relay_attachment_save', { id, name }),   // Rust 端跳出「另存新檔」對話框：→ 存檔路徑；使用者按取消 → null（不下載）
  reveal: () => invoke('relay_attachment_reveal'),          // 開啟「剛存檔的那個資料夾」（路徑 Rust 記著，前端不帶參數）
}
// 截圖（Rust 端隱藏 ASN 視窗、擷取所有螢幕、開框選視窗）：capture 回 PNG 的 Blob，使用者取消回 null；Linux 版 supported 為 false（按鈕隱藏）
// 在畫面裡看終端（#597）：只有電腦版的畫面傳這個給 chat-pane
export const termViewApi = {
  open: ({ id, name }) => invoke('term_view_open', { id: id ?? null, name: name ?? null }),   // → 觀看編號
  close: viewId => invoke('term_view_close', { viewId }),
  // 分頁不在畫面上就暫停讀取窗格（連線和畫面留著），切回來再恢復並補推最新的一幅。舊版沒有這個指令，呼叫會失敗（畫面端吞掉）
  pause: (viewId, paused) => invoke('term_view_set', { viewId, paused: !!paused }),
  available: name => invoke('term_view_available', { name }),   // 這位夥伴在不在共用終端服務裡（#900）→ true／false
  // 在畫面裡打字（#597 D）：只有這個本機命令，Rust 端檢查開著的畫面、視窗在前景、窗格是 ASN 開的、授權
  input: (viewId, data, paste, ime) => invoke('term_view_input', { viewId, data, paste: !!paste, ime: !!ime }),
  // 往上看更早的內容（#904 B3）：一次回 { text, lines, truncated, meta }，text 最後 meta.rows 行是目前畫面、之前都是歷史；失敗丟字串
  history: (viewId, lines) => invoke('term_view_history', { viewId, lines }),
  notices: () => invoke('partner_notices'),   // 畫面上的一行提示用：只有視窗名與固定代號
  listen,
}

// 看別台電腦上夥伴的畫面（#597）：只能看，沒有打字的命令。只有電腦版的畫面傳這個給 chat-pane
export const remoteViewApi = {
  available: node => invoke('term_view_remote_available', { node }),   // 這台能不能看那台 → true／false（不跳提示）
  start: (toNode, partner, machine) => invoke('term_view_remote_start', { toNode, partner, machine: machine || null }),   // 直接發起（不確認本人）→ { id, expires_s }
  pause: (id, paused) => invoke('term_view_remote_set', { id, paused: !!paused }),
  stop: id => invoke('term_view_remote_stop', { id }),
  listen,
}

// 別台打字（0.2.10）：和看畫面分開。開始時直接發起（0.2.33 起那台不再跳確認框）；字在 Rust 端編號、加密、補送
export const remoteInputApi = {
  start: (toNode, partner, machine) => invoke('term_view_remote_start', { toNode, partner, machine: machine || null, scope: 'input' }),
  send: (id, data, paste) => invoke('term_view_remote_input', { id, data, paste: !!paste }),
  pause: (id, paused) => invoke('term_view_remote_set', { id, paused: !!paused }),
  stop: id => invoke('term_view_remote_stop', { id }),
  listen,
}

export const shotApi = {
  supported: () => invoke('shot_supported').catch(() => false),
  capture: async () => {
    const r = await invoke('shot_begin')
    const bytes = r instanceof ArrayBuffer ? new Uint8Array(r) : Array.isArray(r) ? Uint8Array.from(r) : new Uint8Array(0)
    return bytes.length ? new Blob([bytes], { type: 'image/png' }) : null
  },
}
// 帳號登入：權杖與節點金鑰都只在 Rust 端，這裡只拿得到狀態與文字
export const authApi = {
  status: () => invoke('auth_status'),                       // → { signed_in, email }
  login: provider => { shownPhotos.clear(); return invoke('auth_login', { provider }) },     // 開系統瀏覽器登入，等回呼（最久 5 分鐘）→ 狀態
  cancel: () => invoke('auth_cancel'),
  logout: (stop = false) => { shownPhotos.clear(); return invoke('auth_logout', { stop: stop === true }) },   // 只清登入權杖，不刪節點金鑰；之後自動重新啟動，回到登入畫面（收發信照常）；stop＝true 是本人選了「一併停止」：登出後直接結束 ASN
  accountInfo: () => invoke('auth_account_info'),            // → { email, created, node_count, this_node_mine }
  setAccountName: name => invoke('auth_account_name_set', { name }),   // 改帳號名稱（我的名字，所有設備共用）→ 存好的名字
  getAiWakeLimit: () => invoke('auth_ai_wake_limit_get'),   // 帳號設定：AI 之間互相叫醒的上限（0～200，預設 20）
  setAiWakeLimit: limit => invoke('auth_ai_wake_limit_set', { limit }),   // 改上限 → 存好的值
  getDevicePrefs: () => invoke('auth_device_prefs_get'),   // 帳號層設備順序：→ { prefs: { order, shown, removed, rev } | null }
  getChatPins: () => invoke('auth_chat_pins_get'),   // 帳號層對話釘選：→ { pins: { pins, unpinned, rev } | null }
  setChatPins: pins => invoke('auth_chat_pins_set', { pins }),   // 寫（rev 必須是後台現有＋1）→ { pins, stale, rate_limited }；stale＝沒寫入、pins 是後台現有那份
  setDevicePrefs: prefs => invoke('auth_device_prefs_set', { prefs }),   // 寫（整份以 rev 較新為準）→ { prefs, stale }；stale＝後台比較新、沒覆蓋
  bind: () => invoke('auth_bind'),                           // 登入後自動處理金鑰 → { state: created | bound | pending, note }；created 時稍後自動重新啟動
  setLastAvatar: avatar => invoke('last_login_set_avatar', { avatar }),   // 這台大頭貼有變 → 同步到「上次登入」的記憶
  skip: () => invoke('auth_skip_login'),                     // 「暫時不登入」（這台已有節點金鑰時才准）
}
// 新設備第一次連上時「是不是取代舊的」（#1860 H，電腦與手機同一組命令；要本人簽章，Rust 端沒憑證就不送）。call 可注入
export const makeDeviceReplaceApi = (call = invoke) => ({
  candidates: () => call('relay_device_replace_candidates'),            // → { cards: [{ node, name, platform, created_at, candidates: [{ node, name, last_seen }] }] }
  replace: (newNode, oldNode) => call('relay_device_replace', { new: newNode, old: oldNode }),   // → { ok, already, renamed }
  dismiss: newNode => call('relay_device_replace_dismiss', { new: newNode }),                    // → { ok }
})
export const deviceReplaceApi = makeDeviceReplaceApi()
// 邀請雲端代理（設定頁）：登入憑證在 Rust 端。create 的結果裡有一次性的金鑰，只給畫面顯示一次，不存任何地方
export const cloudApi = {
  create: name => invoke('cloud_agent_create', { name }),   // → { id, name, key, invite }
  list: () => invoke('cloud_agent_list'),                    // → { nodes: [{ id, name, last_seen_at, online }] }
  revoke: node => invoke('cloud_agent_revoke', { node }),
  rename: (node, name) => invoke('cloud_agent_rename', { node, name }),   // → 後台確認後的名字（只改設備名）
  approve: (code, name, nodeId) => invoke('cloud_agent_approve', { code, name, nodeId: nodeId || null }),   // 核准無畫面主機的短碼 → { id, name }（金鑰不經過這裡）
}
// 存檔寫入改在背景執行緒跑之後（todo-next-191），兩支同時送出時後端不保證照順序寫完：同一個存檔名一支寫完才送下一支，
// 內容在呼叫當下就轉成文字（之後改了資料不影響這一次）。前一支失敗不擋後一支
const saveChain = new Map()
// 存檔的具名出口（#2162 ⑦）：load／save 沿用 store_load／store_save（整份文字），patch 走 settings_patch（只送變動的頂層欄位，
// 值是 null 代表刪掉該欄，沒提到的欄位後端原樣保留，version 由後端管）。參數 call 預設就是 invoke；測試可以換成假的
export const makeSettingsApi = (call = invoke) => ({
  load: name => call('store_load', { name }),   // → 原文字串或 null（store(name).load 會再 parse）
  save: (name, text) => call('store_save', { name, text }),
  patch: (name, patch) => call('settings_patch', { name, patch }),
})
const settingsStoreApi = makeSettingsApi()
// 同一個存檔名的 save、patch 共用一條排隊（兩支同時送出時後端不保證照順序寫完）；前一支失敗不擋後一支
const queued = (name, run) => {
  const next = (saveChain.get(name) ?? Promise.resolve()).catch(() => {}).then(run)
  saveChain.set(name, next)
  return next
}
export const makeStore = (name, api = settingsStoreApi) => ({
  load: async () => { const s = await api.load(name); try { return s ? JSON.parse(s) : null } catch { return null } },
  save: data => { const text = JSON.stringify(data); return queued(name, () => api.save(name, text)) },
  // 注意：目前所有呼叫都經過 settings-save.mjs 的 patchWithFallback（它先把頂層 undefined 轉成 null）；直接呼叫 patch 的話，頂層 undefined 會被 JSON 拿掉、後端不會刪欄
  patch: fields => { const patch = JSON.parse(JSON.stringify(fields)); return queued(name, () => api.patch(name, patch)) },   // 內容在呼叫當下就複製（之後改了資料不影響這一次）；undefined 的欄位不送
})
export const store = name => makeStore(name)

// ---------- 具名出口（#2106 ②）：電腦版與手機版都經這裡呼叫後端 ----------
// 參數 call 預設就是上面的 invoke；測試可以換成假的。方法名＝指令的駝峰寫法，參數形狀與以前直接 invoke 時完全相同。
// 語音（念出訊息＋語音輸入）。辨識與金鑰都在 Rust 端
export const makeVoiceApi = (call = invoke) => ({
  ttsSpeak: text => call('tts_speak', { text }),   // → base64 音檔
  sttStatus: () => call('stt_status'),             // → { ready }；辨識引擎與模型下載了沒
  sttTranscribe: (wav, names) => call('stt_transcribe', names?.length ? { wav, names } : { wav }),   // → 辨識出的文字；沒有名字就不帶 names
  sttCancel: () => call('stt_cancel'),             // 請 Rust 端結束正在跑的辨識程式
  sttInstall: () => call('stt_install'),           // 下載辨識引擎與目前選的模型
  ttsVoices: () => call('tts_voices'),             // 設定頁「語音」：→ { enabled, voices, default }
  cfgGet: () => call('voice_cfg_get'),             // 設定頁「語音」：目前存的設定
  cfgSet: cfg => call('voice_cfg_set', { cfg }),   // 存回 Rust 端（驗證在那裡）
})
export const voiceApi = makeVoiceApi()
// 群組（房間）：讀、發言、附件。電腦版與手機版用同一組方法，只差指令名（手機是 android_room_*），由 cmds 帶進來
export const makeRoomApi = (call = invoke, cmds = {}) => {
  const { readCmd = 'relay_room_read', postCmd = 'relay_room_post', attachCmd = 'relay_send_attachment' } = cmds
  return {
    rooms: () => call('relay_rooms'),                    // → { rooms, signed, reason? }
    read: args => call(readCmd, args),                   // { room, agent, since, limit, mark } → { messages, reads, wakes }
    post: body => call(postCmd, { body }),               // body＝{ room, body, from_agent?, reply_to? } → { seq, ... }
    attach: payload => call(attachCmd, { payload }),     // 在群組傳照片或檔案；Rust 端上傳後以本人簽章發言
  }
}
// 手機的「認得的電腦」：確認指紋、忘記。憑證與判斷都在 Rust（android.rs）
export const makeKnownPeerApi = (call = invoke) => ({
  token: (action, node) => call('android_known_token', { action, node }),   // → 一次性憑證字串（action: confirm｜forget｜scan）
  list: () => call('android_known_list'),                                    // → { peers: [...] }
  challenge: node => call('android_known_challenge', { node }),              // → { state: ok｜locked｜blocked, ... }；那台還沒記住丟 not_ready
  answer: (id, pick) => call('android_known_answer', { id, pick }),          // → right｜wrong｜none｜expired｜locked｜blocked
  confirm: (id, challenge) => call('android_known_confirm', { id, challenge }),   // → true｜false
  forget: (node, challenge) => call('android_known_forget', { node, challenge }),
  scanConfirm: (node, challenge) => call('android_known_scan_confirm', { node, challenge }),   // → ok｜mismatch｜bad_qr｜blocked｜locked｜not_verified
})
// 設備細部頁「安裝並登入 Claude Code」：確認、取消、開關。安裝與驗證全在 Rust（agent_setup）
export const makeAgentSetupApi = (call = invoke) => ({
  remoteAllowGet: () => call('agent_setup_remote_allow_get'),                // → true｜false
  remoteAllowSet: on => call('agent_setup_remote_allow_set', { on }),
  plan: () => call('agent_setup_plan'),                                      // → 要做什麼的說明句
  start: () => call('agent_setup_start', { confirmed: true }),               // 本人在確認窗按過才會呼叫
  cancel: () => call('agent_setup_cancel'),                                  // 請它在這一步做完後停下
  cliLogin: toolId => call('ai_cli_login', { toolId }),                      // 開登入用的終端機
})
// 手機看／打字那台電腦的終端：發起前的本人確認在 mobile-remote-view.mjs，這裡只管送指令
export const makeRemoteStartApi = (call = invoke) => ({
  available: node => call('term_view_remote_available', { node }),           // → true｜false
  start: (toNode, partner, machine) => call('term_view_remote_start', { toNode, partner, machine: machine || null }),   // → { id, expires_s }
  startInput: (toNode, partner, machine, challenge) => call('term_view_remote_start', { toNode, partner, machine: machine || null, scope: 'input', challenge }),   // 帶本人驗證的一次性憑證
})
// 截圖覆蓋視窗（ui/shot.js）：每個螢幕一扇，各自取凍結畫面、回報選取範圍
export const shotOverlayApi = {
  image: index => invoke('shot_image', { index }),
  ready: () => invoke('shot_ready'),
  focus: () => invoke('shot_focus'),
  cancel: () => invoke('shot_cancel'),
  pick: (index, x, y, w, h) => invoke('shot_pick', { index, x, y, w, h }),
}

// 引導／登入視窗的啟動資訊與收尾（#2106 ④）：startup_info 是這個視窗要知道的版本、節點、能不能略過登入等
export const shellApi = {
  startupInfo: () => invoke('startup_info'),
  quitApp: () => invoke('quit_app'),
  showMain: () => invoke('show_main'),                              // --shot 截圖時才用：把主視窗顯示出來
  captureUiReady: tag => invoke('capture_ui_ready', { tag }),       // --shot：畫面畫好的標記
  takeShot: tab => (tab === undefined ? invoke('take_shot') : invoke('take_shot', { tab })),   // --shot：截圖存檔（不給 tab 就不帶參數）
  shotFrontendLog: (level, msg) => invoke('shot_frontend_log', { level, message: String(msg) }),   // --shot：前端錯誤寫進截圖記錄
}
// 電腦主視窗的視窗開關與版面（#2106 ⑧）：對話／面板視窗、主視窗顯示與版面、抖動、提示小窗
export const windowApi = {
  openChat: (id, title) => invoke('open_chat', { id, title }),
  openPanel: (kind, title, w, h) => invoke('open_panel', { kind, title, w, h }),
  closePanels: kind => invoke('close_panels', { kind }),
  closeAllPanels: () => invoke('close_panels'),
  closeChats: () => invoke('close_chats'),
  mainLayout: (merged, w, h, recenter) => invoke('main_layout', { merged, w, h, recenter }),
  shake: (id, main) => invoke('shake', { id, main }),
  showToast: toast => invoke('show_toast', { toast }),
  openWindows: () => invoke('open_windows'),
  mainVisible: () => invoke('main_visible'),
  chatVisible: id => invoke('chat_visible', { id }),
}
// 引導第 3 步「連接你的 AI 工具」：檢查／安裝 Claude 的擴充
export const claudeModApi = {
  check: () => invoke('claude_mod_check'),
}
// 設備細部頁「重新登入 Claude」：別台走手機同一套請求（mode 'relogin'），本機開官方登入終端（#1645）
export const makeReloginApi = (call = invoke) => ({
  remoteStatus: () => call('setup_remote_status'),                           // → { nodes: [...] }
  remoteRequest: node => call('setup_remote_request', { node, mode: 'relogin' }),
  cliLogin: toolId => call('ai_cli_login', { toolId }),                      // 開登入用的終端機
})

// ---------- 小檔的出口（#2106 ⑤）：參數形狀與以前直接 invoke 時完全相同 ----------
// 密碼輸入小窗（askpass）：絕不記錄輸入內容；出口失敗只記指令名與原文，不記 args
export const askpassApi = {
  info: id => invoke('askpass_info', { id }),
  answer: (id, secret) => invoke('askpass_answer', { id, secret }),   // secret＝輸入的內容或 null（取消）
}
// 安裝進度小窗（ui/setup-progress.js）
export const setupProgressApi = {
  snapshot: () => invoke('setup_progress_snapshot'),
  cancel: () => invoke('agent_setup_cancel'),
}
// 提示小窗（ui/toast.js）
export const toastApi = {
  click: cid => invoke('toast_click', { cid }),
  painted: () => invoke('toast_painted'),
}
// 改名與啟動對齊（device-rename.mjs；phone＝手機走 android_known_rename）。call 可注入
/** 改名要叫的 Rust 命令：手機是 android_known_rename、電腦是 device_rename（兩個命令都送後台並替本機視窗名跟上） */
export const renameCommandOf = phone => (phone === true ? 'android_known_rename' : 'device_rename')
export const makeDeviceNameApi = (call = invoke) => ({
  rename: (phone, node, name) => call(renameCommandOf(phone), { node, name }),
  align: () => call('device_name_align'),
})
// 開記錄檔／記錄資料夾（view-log.mjs）
export const makeLogViewApi = (call = invoke) => ({
  openUiLog: () => call('open_ui_log'),
  openMachineLogDir: () => call('open_machine_log_dir'),   // 前端不能帶路徑參數
  relayLogPaths: () => call('relay_log_paths'),            // → { bridgeLog, machineDir }（只回路徑，通知上「看記錄」用）
})
export const logViewApi = makeLogViewApi()
// 送記錄給開發者（#2129 ②）：範圍 '1h'｜'24h'｜'7d'（沒給＝24 小時）。遮罩在 Rust 端送出那一層做，前端拿到的就是遮過的
// preview → { text, lines, bytes, masked: { email, token, home }, range }；send 收件處沒設定時回白話錯誤，不碰網路
export const makeLogReportApi = (call = invoke) => ({
  preview: range => call('log_report_preview', { range }),
  send: range => call('log_report_send', { range }),
})
export const logReportApi = makeLogReportApi()
// 電腦版設定頁「認得的電腦」（#2106 ⑨）：這台自己的指紋、認得的別台、允許手機替這台登入、忘記。判斷都在 Rust（device_id.rs）
export const makeKnownDeviceApi = (call = invoke) => ({
  ownFingerprint: () => call('device_own_fingerprint'),
  ownFingerprintQr: () => call('device_own_fingerprint_qr'),
  list: () => call('device_known_list'),
  setLoginOk: (node, on) => call('device_known_login_ok', { node, on: !!on }),
  forget: node => call('device_known_forget', { node }),
})
export const knownDeviceApi = makeKnownDeviceApi()
// 電腦版終端遠端（#2106 ⑨）：別台正在看這台、本機替手機代答／代送、手機確認狀態。字與按鍵都在 Rust 編號加密
export const makeTermRemoteApi = (call = invoke) => ({
  viewedStop: id => call('term_viewed_stop', { id }),
  viewActive: name => call('term_view_active', { name }),
  offerAnswer: req => call('term_remote_offer_answer', { req }),
  offerSend: req => call('term_remote_offer_send', { req }),
  withdraw: id => call('term_remote_withdraw', { id }),
  pending: () => call('term_remote_pending'),
})
export const termRemoteApi = makeTermRemoteApi()
// 開外部網址與邀請（#2106 ⑨）：open_link 只放行 http／https；open_url 開廣告網址；invite_pending 補取啟動前就收到的邀請碼
export const linkApi = {
  openLink: url => invoke('open_link', { url }),
  openUrl: url => invoke('open_url', { url }),
  invitePending: () => invoke('invite_pending'),
}
// 系統匣與狀態回報（#2106 ⑨）：未讀總數、在線狀態、正在聽的歌、官網廣告。開關與讀取都在 Rust
export const trayApi = {
  setUnread: n => invoke('set_tray_unread', { n }),
  setPresence: (status, psm) => invoke('set_presence', { status, psm }),
  setNowPlaying: on => invoke('set_now_playing', { on }),
  adsFetch: () => invoke('ads_fetch'),
}
// 群組動作（groups.mjs）：後台的群組操作都走 relay_group，以 action 區分
export const makeGroupActApi = (call = invoke) => ({
  act: (action, body) => call('relay_group', { action, body }),
})
// 登入頁的開機自啟動開關（login-panel.mjs）
export const autostartApi = {
  get: () => invoke('autostart_get'),
  supported: () => invoke('autostart_supported'),
  blocked: () => invoke('autostart_blocked'),   // → 被擋住的原因文字，沒有就空
  set: on => invoke('autostart_set', { on }),
}
// 手機登入憑證有沒有封存（mobile-login-seal.mjs）
export const makeLoginSealApi = (call = invoke) => ({
  sealed: () => call('android_login_sealed'),
})
// 用量統計（usage.mjs）
export const makeUsageApi = (call = invoke) => ({
  summary: tzOffsetMin => call('usage_summary', { tzOffsetMin }),
})
// 前端記錄寫進 ui.log（ui-log.mjs）：invoke 出口對 ui_log 特別不記失敗，所以這條失敗不會再繞圈
export const makeUiLogApi = (call = invoke) => ({
  send: lines => call('ui_log', { lines }),
})

// ---------- 設定頁的出口（#2106 ⑦）：參數形狀與以前直接 invoke 時完全相同 ----------
// 外框、關閉視窗時、托盤、意外關閉自動重開（guard）、密碼小幫手資訊
export const settingsApi = {
  ...makeSettingsApi(),   // load(name)／save(name, text)／patch(name, fields)：個人設定與引導存檔（#2162 ⑦）
  setFrame: native => invoke('set_frame', { native }),
  setCloseToTray: tray => invoke('set_close_to_tray', { tray }),
  trayAvailable: () => invoke('tray_available'),
  guardGet: () => invoke('guard_get'),
  guardSet: on => invoke('guard_set', { on }),
  guardResume: () => invoke('guard_resume'),
  askpassHelperInfo: () => invoke('askpass_helper_info'),
}
// 內建收發室橋的設定（狀態以 Rust 端為準）：每個設定都回新的狀態
export const bridgeApi = {
  status: () => invoke('bridge_status'),
  setRemoteLaunch: on => invoke('bridge_set_remote_launch', { on }),
  setAutoResume: on => invoke('bridge_set_auto_resume', { on }),
  setCompactHandoff: (on, n) => invoke('bridge_set_compact_handoff', { on, n }),
  setTermServer: on => invoke('bridge_set_term_server', { on }),
  retryTermFetch: () => invoke('bridge_retry_term_fetch'),
  setPermPhone: on => invoke('bridge_set_perm_phone', { on }),
  setMobileView: on => invoke('bridge_set_mobile_view', { on }),
  setRemoteInput: on => invoke('bridge_set_remote_input', { on }),
  setScreenWatch: on => invoke('bridge_set_screen_watch', { on }),
  setUnaddressedTo: name => invoke('bridge_set_unaddressed_to', { name }),
  takeover: () => invoke('bridge_takeover', { confirmed: true }),
}
// 自動更新與遠端更新（updater.rs／account.rs）
export const updateApi = {
  check: () => invoke('update_check'),
  install: () => invoke('update_install'),
  remoteStatus: () => invoke('update_remote_status'),
  remoteRequest: node => invoke('update_remote_request', { node }),   // 請別台設備自己更新
}

// 帳號卡（claude-accounts.mjs，#2106 ⑫）：Claude／Grok／Codex 帳號與遠端設備切換。檔案操作全在 Rust，帳號以 email 識別，權杖不經過前端。
// 失敗記錄只記指令名不記參數，所以 email 不會進 ui.log
export const makeAccountsApi = (call = invoke) => ({
  roster: () => call('acct_roster'),                                          // 後台的帳號列表
  list: () => call('claude_accounts_list'),
  current: () => call('claude_account_current'),
  grokList: () => call('grok_accounts_list'),                                 // 舊版 Rust 沒有這個指令
  codexCurrent: () => call('codex_account_current'),
  modReport: () => call('claude_mod_report'),                                 // 舊版 Rust 沒有這個指令
  loginFailed: () => call('claude_login_failed'),
  quotaState: () => call('claude_quota_state'),
  save: () => call('claude_account_save'),                                    // 加入目前登入的帳號 → { email }
  switchTo: email => call('claude_account_switch', { email }),                // → { email }
  remove: email => call('claude_account_delete', { email }),
  undo: () => call('claude_account_undo'),                                    // 還原到切換前
  grokSwitch: email => call('grok_account_switch', { email }),                // → { notice }
  remoteReport: () => call('acct_remote_report'),
  remoteList: node => call('acct_remote_list', { node }),
  remoteRequest: (node, email, vendor) => call('acct_remote_request', { node, email, vendor }),   // → { id }
  remoteStatus: ids => call('acct_remote_status', { ids }),
  remotePending: () => call('acct_remote_pending'),
  remoteApply: (id, confirmed) => call('acct_remote_apply', { id, confirmed }),
  remoteDecline: id => call('acct_remote_decline', { id }),
  allowGet: () => call('acct_remote_allow_get'),
  allowSet: on => call('acct_remote_allow_set', { on }),
})
// 啟動指引與設定頁的「登入」按鈕：開官方登入終端（list.js）
export const cliLoginApi = {
  login: toolId => invoke('ai_cli_login', { toolId }),
}

// ---------- 回報匯流排出口（#2161 2c-2）：指令名與事件名只寫在這裡 ----------
// send：後台寫入一筆回報（kind＋data）；get：批次讀同一個 kind 的多台最新回報 → { ok, reports: [{ node, kind, payload, updated_at, changed_at }] }
// 錯誤是固定白話字串（invoke 出口已包成 Error 並記一行，不記 args）
// 錯誤由 invoke 出口拆成 err.code：report:unknown_kind／report:bad_request（永久）、report:rate／network／server／not_ready（暫時）；message 是白話句
export const reportApi = {
  send: (kind, data) => invoke('report_send', { kind, data }),
  get: (kind, nodes) => invoke('report_get', { kind, nodes }),
}
// 後台寫入且內容有變時 Rust 轉出的門鈴：payload { kind, node }，不含內容（要內容再呼叫 reportApi.get）。回傳取消函式（同步回傳，不必等 listen 完成）
export const onReport = cb => {
  let off = null, dead = false
  try {
    void listen('relay-report-bell', cb).then(f => { if (dead) { try { f() } catch {} } else off = f }).catch(() => {})
  } catch { /* 沒有 Tauri（純網頁、測試）：什麼都不聽 */ }
  return () => { dead = true; if (off) { try { off() } catch {} off = null } }
}

// ---------- 視窗外框（自訂／Windows 原生） ----------
// 原生外框：html 加 frame-native，樣式把自畫的標題列、邊框與拖邊緣的把手藏起來
export const applyFrame = native => document.documentElement.classList.toggle('frame-native', native === true)
// 每扇視窗載入時問一次現在是哪種，之後設定頁一改就會收到 asn:frame
export async function initFrame() {
  try { applyFrame(await invoke('frame_native')) } catch { /* 問不到就維持自訂 */ }
  await listen('asn:frame', native => applyFrame(native))
  // #1788 放大鈕的分割版面：只有帶 data-snap-max 的視窗（名單、對話、指引設定）會真的回報
  try { await makeSnapMax({ call: invoke, listen, doc: document, win: window }).start() } catch { /* 沒有也只是少了分割版面 */ }
}
// 自訂外框的八個拖邊緣調整大小的把手
export const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
const RESIZE_NAME = { n: 'North', s: 'South', e: 'East', w: 'West', ne: 'NorthEast', nw: 'NorthWest', se: 'SouthEast', sw: 'SouthWest' }
export const resizeFrom = dir => { try { return T.window.getCurrentWindow().startResizeDragging(RESIZE_NAME[dir]) } catch { return undefined } }

// ---- #2106 ⑩：手機（m.js）第一批。方法名＝指令的駝峰寫法，參數形狀與以前直接 invoke 時完全相同 ----
// 手機只用得到這幾個 Rust 指令（金鑰與權杖都在 Rust 端，這裡拿不到）：給 AsnCore 的 transport
export const makeMobileRelayApi = (call = invoke) => ({
  list: () => call('relay_list'),
  inbox: () => call('relay_inbox'),
  ack: ids => call('relay_ack', { ids }),
  send: payload => call('relay_send', { payload }),
  history: (node, agent, partnerId, before, limit) => call('relay_chat_history', { node, agent: agent || null, partnerId: partnerId || null, before: before || null, limit: limit || null }),   // 後台的往來記錄（90 天；要登入，本機只當快取）
  sentStatus: ids => call('relay_sent_status', { ids }).then(r => r?.status ?? []),
  readSync: body => call('relay_read_sync', { body }),   // 已讀多端同步（要本人簽章；沒登入或舊後台就回錯，前端靜默）
  avatar: node => call('relay_avatar', { node }),
  partnerAvatar: partner => call('relay_partner_avatar', { partner }),
  setAvatar: avatar => call('relay_set_avatar', { avatar }),
  sendAttachment: payload => call('relay_send_attachment', { payload }),
})
export const mobileRelayApi = makeMobileRelayApi()
// 管理夥伴視窗（⋯ 選單）：手機只下指令，視窗在那台電腦上；要本人簽章（Rust 端沒憑證就不送）
export const makeMobileOpsApi = (call = invoke) => ({
  partnerOp: body => call('android_partner_op', { body }),
  partnerOps: ids => call('android_partner_ops', { ids }),
  partnerArchive: body => call('android_partner_archive', { body }),
})
export const mobileOpsApi = makeMobileOpsApi()
// 手機的照片放大與收到的檔案：取回、存進 App 私有資料夾（再由外殼複製到「下載/ASN」）
export const makeMobilePhotoApi = (call = invoke) => ({
  fetch: (id, expiresAt = null) => call('relay_attachment_fetch', { id, expiresAt }),
  save: (id, name) => call('relay_attachment_save', { id, name }),
})
export const mobilePhotoApi = makeMobilePhotoApi()
// 手機端的三種「電腦在等本人」請求：密碼詢問、權限詢問、終端請求。清單與回覆都由 Rust 簽章與加密
export const makeMobileAskApi = (call = invoke) => ({
  secretPending: () => call('android_secret_pending'),
  secretReply: (id, secret) => call('android_secret_reply', { id, secret }),
  permReqList: () => call('android_perm_req_list'),
  permReqDecide: args => call('android_perm_req_decide', { id: args.id, choiceN: args.choiceN, hash: args.hash }),
  termReqList: () => call('android_term_req_list'),
  termReqDecide: args => call('android_term_req_decide', { id: args.id, decision: args.decision, choiceN: args.choiceN, hash: args.hash }),
})
export const mobileAskApi = makeMobileAskApi()

// ---- #2106 ⑪：手機（m.js）第二批。方法名＝指令的駝峰寫法，參數形狀與以前直接 invoke 時完全相同 ----
// 「在別台電腦安裝並登入 Claude Code」：手機只送請求與查結果，安裝與驗證都在那台電腦；登入走裝置碼（網址與代碼只留在畫面，不進記錄）
export const makeMobileSetupApi = (call = invoke) => ({
  remoteStatus: () => call('setup_remote_status'),   // → { nodes: [...] }
  remoteRequest: (node, relogin) => call('setup_remote_request', relogin === true ? { node, mode: 'relogin' } : { node }),
  deviceRequest: (node, vendor) => call('setup_device_request', { node, vendor }),
  deviceFetch: rid => call('setup_device_fetch', { rid }),
  deviceCancel: rid => call('setup_device_cancel', { rid }),   // 連 Rust 端記著的一次性私鑰一起丟掉
})
export const mobileSetupApi = makeMobileSetupApi()
// 在線狀態與前景狀態：每次切換與定時續報都會呼叫，失敗時出口的 invoke 已記一行並去重，呼叫端不再多記
export const makeMobileStateApi = (call = invoke) => ({
  presence: (status, psm) => call('set_presence', { status, psm }),
  foreground: fg => call('set_foreground', { foreground: fg === true }),
  invitePending: () => call('invite_pending'),   // → 開 App 時帶進來的邀請碼（沒有就空）
})
export const mobileStateApi = makeMobileStateApi()
// 在手機上替電腦開新夥伴（啟動器）：查可開的電腦與送出請求，都由 Rust 簽章
export const makeMobileLaunchApi = (call = invoke) => ({
  launchers: ids => call('android_launchers', Array.isArray(ids) ? { ids } : {}),
  launch: body => call('android_launch', { body }),
})
export const mobileLaunchApi = makeMobileLaunchApi()
// 官網的版本紀錄（關於頁）：→ [{ version, date, lines }]；讀不到丟「暫時讀不到版本紀錄」
export const makeMobileSiteApi = (call = invoke) => ({
  releases: force => call('site_releases', { force: force === true }),
})
export const mobileSiteApi = makeMobileSiteApi()
// 推播權杖：註冊與取消（權杖只在 Rust 與後台之間流動）
export const makeMobilePushApi = (call = invoke) => ({
  register: token => call('android_push_register', { token }),
  unregister: () => call('android_push_unregister'),
})
export const mobilePushApi = makeMobilePushApi()
// 手機自己更新：查新版與下載（Rust 端下載並驗 sha256，不符就拒絕）
export const makeMobileUpdateApi = (call = invoke) => ({
  check: args => call('android_update_check', args),
  download: args => call('android_update_download', args),
})
export const mobileUpdateApi = makeMobileUpdateApi()

// 手機替電腦切換帳號（設備卡的按鈕，m.js；#2106 ⑬）：只下指令，要本人簽章由 Rust 處理。失敗記錄只記指令名不記參數，所以 email 不會進 ui.log
export const makeMobileAccountApi = (call = invoke) => ({
  list: node => call('android_acct_list', { node }),
  switchTo: (node, email) => call('android_acct_switch', { node, email }),
  status: ids => call('android_acct_status', { ids }),   // 輪詢切換結果：失敗時出口已記一行，呼叫端不再多記
  roster: () => call('android_acct_roster'),             // 帳號列表（#374），輪詢用
})
export const mobileAccountApi = makeMobileAccountApi()
// 讀額度設定與查詢代碼（quota-readers.mjs，#2106 ⑬）：金鑰與代碼都在 Rust，記錄只記指令名不記參數
export const makeQuotaReadersApi = (call = invoke) => ({
  get: () => call('quota_readers_get'),
  set: (source, on) => call('quota_readers_set', { source, on }),
  minimaxAdd: (email, key) => call('quota_minimax_add', { email, key }),
  minimaxRemove: email => call('quota_minimax_remove', { email }),
  shareCreate: (vendor, account) => call('quota_share_create', { vendor, account }),
  shareRevoke: (vendor, account) => call('quota_share_revoke', { vendor, account }),
})
