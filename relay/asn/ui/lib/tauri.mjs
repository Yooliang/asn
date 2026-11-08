// Tauri 前端小橋：invoke／事件。錯誤一律包成 Error(字串)，讓 AsnCore 用 e.message 處理。
const T = globalThis.__TAURI__

export const invoke = async (cmd, args) => {
  try { return await T.core.invoke(cmd, args) } catch (e) { throw new Error(typeof e === 'string' ? e : (e?.message ?? String(e))) }
}
export const listen = (evt, fn) => T.event.listen(evt, e => fn(e.payload))
export const emit = (evt, payload) => T.event.emit(evt, payload)
export const ctl = op => invoke('win_ctl', { op })

// 給 AsnCore 的 transport：HTTP 與金鑰都在 Rust 端，這裡拿不到金鑰
export const transport = {
  list: () => invoke('relay_list'),
  localWindows: () => invoke('local_windows'),   // 電腦版：直接讀本機視窗狀態（手機沒有這個指令）
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
  cliDetect: () => invoke('ai_cli_detect'),
  partnerLaunchLocal: req => invoke('partner_launch_local', { req }),
  partnerConsoleQuery: req => invoke('partner_console_query', { req }),
  partnerConsoleSet: req => invoke('partner_console_set', { req }),
  termStart: req => invoke('term_start', { req }),           // { profile: 'grok'|'agy', cwd } → { id }；只在使用者於「開終端…」按「開啟」後呼叫
  termEnvNotice: () => invoke('term_env_notice'),            // 共用終端服務開著、而且使用者環境變數裡有看起來像金鑰的變數時回一句話（只含變數名字），否則 null（只在電腦版）
  partnerPermissionPrompt: name => invoke('partner_permission_prompt', { name }),   // { name, text, hash, complete }
  partnerPermissionAnswer: (name, hash, allow) => invoke('partner_permission_answer', { name, hash, allow }),
  autoResumeStatus: () => invoke('auto_resume_status'),      // 電腦重開後自動接回的結果（#767）；沒有就是 null
  partnerNoticesActive: () => invoke('partner_notices_active'),   // 讀畫面這次實際有沒有在跑（true/false）；查不到由呼叫端當成沒在跑
  partnerNotices: () => invoke('partner_notices'),           // 夥伴卡住的提醒：[{ name, code }]（只有視窗名與固定代號）
  termList: () => invoke('term_list'),                       // 這次由 ASN 開啟的終端：[{ id, profile, pid, started_ms, cwd }]（只在電腦版）
  termStatus: req => invoke('term_status', { req }),         // { id } → { state, prompt? }；等你回答時帶 prompt
  termRead: req => invoke('term_read', { req }),             // { id, lines } → 畫面最後幾行的純文字（只讀，不送任何鍵）
  termSend: req => invoke('term_send', { req }),             // { id, text, enter }；只在使用者按下「確認送出」後呼叫（後端另外檢查資料夾授權）
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
  launchPrefsGet: () => invoke('launch_prefs_get'),
  launchPrefsSet: prefs => invoke('launch_prefs_set', { prefs }),
  quotaHookStatus: () => invoke('claude_quota_hook_status'),         // 額度回報（#228）：→ { state: off|on|stale|blocked, current, hasOriginal }
  quotaHookConnect: () => invoke('claude_quota_hook_connect'),       // 使用者同意後才呼叫：改 Claude Code 狀態列那一個欄位 → 新狀態
  quotaHookDisconnect: () => invoke('claude_quota_hook_disconnect'), // 取消接上（只在指令還是我們寫的才還原）→ 新狀態
  siteReleases: force => invoke('site_releases', { force: force === true }),   // 版本紀錄（後台公開表 asn_site_releases）：→ [{ version, date, lines }]；讀不到丟「暫時讀不到版本紀錄」（#462）
  piModels: force => invoke('pi_models', { force: force === true }),               // 經 pi 開新夥伴（#351）：→ [{ provider, model, context, thinking, images }]，只含已設好憑證的提供者；沒有 pi 回 []
  piProviders: force => invoke('pi_providers', { force: force === true }),         // → [{ provider, state: ready|not_ready|missing|unknown }]；不讀憑證
  piSetupStatus: () => invoke('pi_setup_status'),     // 讓自己開的 pi 連上 ASN（#240 方案 A）：→ { pi, ext, installed, stale }
  piSetupInstall: () => invoke('pi_setup_install'),   // 使用者同意後才呼叫：pi install 擴充 → 新狀態
  piSetupRemove: () => invoke('pi_setup_remove'),     // 移除我們裝的那一筆 → 新狀態
}
// 照片放大與另存（對話視窗各自呼叫，不經樞紐）：Rust 端換短效下載網址、下載、檢查
export const photoApi = {
  fetch: id => invoke('relay_attachment_fetch', { id }),   // → { name, mime, data_url }
  save: (id, name) => invoke('relay_attachment_save', { id, name }),   // Rust 端跳出「另存新檔」對話框：→ 存檔路徑；使用者按取消 → null（不下載）
  reveal: () => invoke('relay_attachment_reveal'),          // 開啟「剛存檔的那個資料夾」（路徑 Rust 記著，前端不帶參數）
}
// 截圖（Rust 端隱藏 ASN 視窗、擷取所有螢幕、開框選視窗）：capture 回 PNG 的 Blob，使用者取消回 null；Linux 版 supported 為 false（按鈕隱藏）
// 在畫面裡看終端（#597）：只有電腦版的畫面傳這個給 chat-pane
export const termViewApi = {
  open: ({ id, name }) => invoke('term_view_open', { id: id ?? null, name: name ?? null }),   // → 觀看編號
  close: viewId => invoke('term_view_close', { viewId }),
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

// 別台打字（0.2.10）：和看畫面分開。開始時這台先確認本人，那台會再請那邊的人同意；字在 Rust 端編號、加密、補送
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
  login: provider => invoke('auth_login', { provider }),     // 開系統瀏覽器登入，等回呼（最久 5 分鐘）→ 狀態
  cancel: () => invoke('auth_cancel'),
  logout: (stop = false) => invoke('auth_logout', { stop: stop === true }),   // 只清登入權杖，不刪節點金鑰；之後自動重新啟動，回到登入畫面（收發信照常）；stop＝true 是本人選了「一併停止」：登出後直接結束 ASN
  accountInfo: () => invoke('auth_account_info'),            // → { email, created, node_count, this_node_mine }
  setAccountName: name => invoke('auth_account_name_set', { name }),   // 改帳號名稱（我的名字，所有設備共用）→ 存好的名字
  getAiWakeLimit: () => invoke('auth_ai_wake_limit_get'),   // 帳號設定：AI 之間互相叫醒的上限（0～200，預設 20）
  setAiWakeLimit: limit => invoke('auth_ai_wake_limit_set', { limit }),   // 改上限 → 存好的值
  getDevicePrefs: () => invoke('auth_device_prefs_get'),   // 帳號層設備順序：→ { prefs: { order, shown, removed, rev } | null }
  setDevicePrefs: prefs => invoke('auth_device_prefs_set', { prefs }),   // 寫（整份以 rev 較新為準）→ { prefs, stale }；stale＝後台比較新、沒覆蓋
  bind: () => invoke('auth_bind'),                           // 登入後自動處理金鑰 → { state: created | bound | pending, note }；created 時稍後自動重新啟動
  setLastAvatar: avatar => invoke('last_login_set_avatar', { avatar }),   // 這台大頭貼有變 → 同步到「上次登入」的記憶
  skip: () => invoke('auth_skip_login'),                     // 「暫時不登入」（這台已有節點金鑰時才准）
}
// 邀請雲端代理（設定頁）：登入憑證在 Rust 端。create 的結果裡有一次性的金鑰，只給畫面顯示一次，不存任何地方
export const cloudApi = {
  create: name => invoke('cloud_agent_create', { name }),   // → { id, name, key, invite }
  list: () => invoke('cloud_agent_list'),                    // → { nodes: [{ id, name, last_seen_at, online }] }
  revoke: node => invoke('cloud_agent_revoke', { node }),
  rename: (node, name) => invoke('cloud_agent_rename', { node, name }),   // → 後台確認後的名字（只改設備名）
  approve: (code, name, nodeId) => invoke('cloud_agent_approve', { code, name, nodeId: nodeId || null }),   // 核准無畫面主機的短碼 → { id, name }（金鑰不經過這裡）
}
export const store = name => ({
  load: async () => { const s = await invoke('store_load', { name }); try { return s ? JSON.parse(s) : null } catch { return null } },
  save: data => invoke('store_save', { name, text: JSON.stringify(data) }),
})

// ---------- 視窗外框（自訂／Windows 原生） ----------
// 原生外框：html 加 frame-native，樣式把自畫的標題列、邊框與拖邊緣的把手藏起來
export const applyFrame = native => document.documentElement.classList.toggle('frame-native', native === true)
// 每扇視窗載入時問一次現在是哪種，之後設定頁一改就會收到 asn:frame
export async function initFrame() {
  try { applyFrame(await invoke('frame_native')) } catch { /* 問不到就維持自訂 */ }
  await listen('asn:frame', native => applyFrame(native))
}
// 自訂外框的八個拖邊緣調整大小的把手
export const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
const RESIZE_NAME = { n: 'North', s: 'South', e: 'East', w: 'West', ne: 'NorthEast', nw: 'NorthWest', se: 'SouthEast', sw: 'SouthWest' }
export const resizeFrom = dir => { try { return T.window.getCurrentWindow().startResizeDragging(RESIZE_NAME[dir]) } catch { return undefined } }
