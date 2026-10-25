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
  partnerOp: body => invoke('relay_partner_op', { body }),          // 管理夥伴視窗（詳情、改名、關閉、接班換手、喚醒；要本人簽章）→ { id }
  partnerOps: ids => invoke('relay_partner_ops', { ids }),          // 查上面那些操作的進度 → { ops: [...] }
  readSync: body => invoke('relay_read_sync', { body }),            // 已讀多端同步：送出我這端的已讀位置、取回整個帳號的（要本人簽章；沒登入或舊後台就回錯，前端靜默）
  partnerArchive: body => invoke('relay_partner_archive', { body }),  // 封存／取消封存夥伴（記在帳號層，要本人簽章）→ { ok, archived }
  authStatus: () => invoke('auth_status'),                           // → { signed_in, email }
  sentStatus: ids => invoke('relay_sent_status', { ids }).then(r => r?.status ?? []),
  avatar: node => invoke('relay_avatar', { node }),                 // 某台設備上傳的大頭貼（按需取）
  setAvatar: avatar => invoke('relay_set_avatar', { avatar }),      // 上傳自己這台的大頭貼；null＝移除
  sendAttachment: payload => invoke('relay_send_attachment', { payload }),   // 寄照片或檔案：Rust 端檢查、要上傳網址、上傳、確認、寄信
  launch: body => invoke('relay_launch', { body }),
  launchers: ids => invoke('relay_launchers', { ids: ids ?? null }),
  cliDetect: () => invoke('ai_cli_detect'),
  partnerLaunchLocal: req => invoke('partner_launch_local', { req }),
  partnerConsoleQuery: req => invoke('partner_console_query', { req }),
  partnerConsoleSet: req => invoke('partner_console_set', { req }),
  modelSwitchQuery: req => invoke('model_switch_query', { req }),   // 讀這個 Claude 視窗的目前模型與是否閒置
  modelSwitchRun: req => invoke('model_switch_run', { req }),       // 關掉那一個視窗、照原參數重開（--resume＋新 --model）
  subagentsQuery: req => invoke('subagents_query', { req }),         // 這個 Claude 視窗正在跑的子代理（讀對話記錄檔）
  launchCwdCandidates: () => invoke('launch_cwd_candidates'),   // 白名單＋自動建議（Rust 端合併、去重、略過不存在的）
  launchCwdBrowse: () => invoke('launch_cwd_browse'),   // Rust 端開「選擇資料夾」；→ 路徑（已寫進本機白名單）或 null
  launchPrefsGet: () => invoke('launch_prefs_get'),
  launchPrefsSet: prefs => invoke('launch_prefs_set', { prefs }),
}
// 照片放大與另存（對話視窗各自呼叫，不經樞紐）：Rust 端換短效下載網址、下載、檢查
export const photoApi = {
  fetch: id => invoke('relay_attachment_fetch', { id }),   // → { name, mime, data_url }
  save: (id, name) => invoke('relay_attachment_save', { id, name }),   // Rust 端跳出「另存新檔」對話框：→ 存檔路徑；使用者按取消 → null（不下載）
  reveal: () => invoke('relay_attachment_reveal'),          // 開啟「剛存檔的那個資料夾」（路徑 Rust 記著，前端不帶參數）
}
// 截圖（Rust 端隱藏 ASN 視窗、擷取所有螢幕、開框選視窗）：capture 回 PNG 的 Blob，使用者取消回 null；Linux 版 supported 為 false（按鈕隱藏）
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
  logout: () => invoke('auth_logout'),                       // 只清登入權杖，不刪節點金鑰；之後自動重新啟動，回到登入畫面
  accountInfo: () => invoke('auth_account_info'),            // → { email, created, node_count, this_node_mine }
  setAccountName: name => invoke('auth_account_name_set', { name }),   // 改帳號名稱（我的名字，所有設備共用）→ 存好的名字
  getAiWakeLimit: () => invoke('auth_ai_wake_limit_get'),   // 帳號設定：AI 之間互相叫醒的上限（0～20，預設 5）
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
