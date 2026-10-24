// 好友名單視窗：同時是整個程式的「樞紐」——AsnCore 跑在這裡，對話視窗與提示視窗只顯示、用事件下指令。
// 關掉這扇＝結束程式（Rust 端處理）。
import { blockContextMenu } from './lib/nomenu.mjs'
import { AsnCore } from './lib/core.mjs'
import { ADS, AD_MS, FIXED_TABS, goAd, groupHeading, groupRows, moreUnread, nextAd, normalizeTab, AD_PAGE_MS, adImageSrc, adPageUrl, openAdWith, pickAds, prevAd, statusNote } from './lib/tabs.mjs'
import { GUIDES } from './lib/guides.mjs'
import { GuideDoc } from './lib/guide-doc.mjs'
import { buildLogView } from './lib/changelog.mjs'
import { SettingsPanel } from './lib/settings-panel.mjs'
import { PANEL_KINDS, isPanelTab, normalizePanelSize, panelItem, panelTabId, panelTabItem, panelTitle, splitTabs } from './lib/panels.mjs'
import { AsnDialog } from './lib/dialog.mjs'
import { SETTING_CATS, catSummary, normalizeCatKey } from './lib/settings-cats.mjs'
import { DIMS, groupOptions, loadDims, pageTabs, withTabDim } from './lib/dims.mjs'
import { normalizeSearchQuery, rosterShownGroups } from './lib/search.mjs'
import { deviceAsn } from './lib/presence.mjs'
import { POLL_MS as REMOTE_UPD_POLL_MS, mineFromStatus, remoteUpdateView } from './lib/remote-update.mjs'
import { emo, initial, plain } from './lib/text.mjs'
import { ChatPane } from './lib/chatpane.mjs'
import { GroupSheet } from './lib/group-sheet.mjs'
import { createGroupFlow } from './lib/group-flow.mjs'
import { copyText, createGroupApi, roomHue, roomInitial } from './lib/groups.mjs'
import { createRoomHub } from './lib/room-hub.mjs'
import { isRoomChat, roomIdOf, roomPseudoFriend } from './lib/mobile-rooms.mjs'
import { avatarFor, avatarSrc, isAvatarDataUrl, removeAvatarUpload, uploadAvatarFile, selfAvatarSrc } from './lib/avatar.mjs'
import { avatarFromFile } from './lib/avatar-canvas.mjs'
import { BUBBLES, BUBBLE_LABEL, TOOLBARS, TOOLBAR_LABEL, DP_LABEL, DP_MODES, MODES, MODE_LABEL, normalizeBubble, normalizeDpMode, normalizeLook, normalizeMode, normalizeSize, switchMode, tabVisible, toggleCollapsed } from './lib/merge.mjs'
import { normalizeSession, restoreSession, sameSession, snapshotSession, trailingThrottle } from './lib/session.mjs'
import { chatTabSameZone, closeAllChatTabs, closeIdleChatTabs, idleTabIds, withCallState, dropInsertBefore, closeChatTab, closeOtherChatTabs, closeRightChatTabs, isPinned, moveChatTab, normalizePinned, openChatTab, orderTabs, toggleChatPin } from './lib/ctabs.mjs'
import { nowPlayingLine, normalizeNowPlaying } from './lib/now-playing.mjs'
import { CLOSE_CHOICES, CLOSE_LABEL, FRAMES, FRAME_LABEL, normalizeClose, normalizeFrame, totalUnread, notifyFromSaved, notifyPlan, notifyWith } from './lib/prefs.mjs'
import { RESIZE_DIRS, authApi, ctl, emit, initFrame, invoke, listen, photoApi, resizeFrom, shotApi, store, transport } from './lib/tauri.mjs'
import { MODEL_CATALOG, defaultPartnerName, injectPendingGroups, modelUiRow, pendingFriend, resolvePending } from './lib/partner.mjs'
import { CWD_EMPTY_HINT, bumpRecentCwd, cwdChoices, mergeCwdLists, normalizeLaunchPrefs, withPickedCwd } from './lib/launch-prefs.mjs'
import { CONSOLE_QUERY_TIMEOUT_MS, DISPLAY_MODES, buddyConsoleItem, engineForProfile,launchDeviceRows, launchDisableReason, remoteModelRows, showDisplayModeChoice, withTimeout } from './lib/partner-launch-ui.mjs'
import { placeMenu, placeSubmenu, submenuNext } from './lib/menu-place.mjs'
import { PartnerOpDialog, loadOpsContext } from './lib/partner-ops-ui.mjs'
import { initialOpsCtx } from './lib/partner-ops.mjs'
import { contextLabel } from './lib/context-usage.mjs'
import { ARCHIVE_GROUP_KEY, activeFriends, archivedFriends, manageItems, runArchive, withArchivedGroup } from './lib/archive.mjs'
import { backgroundRestoreNoticeText, collectLaunchFailures, findBackgroundTimeouts, launchFailedNoticeText } from './lib/partner-launch-notify.mjs'
import { ONBOARD_STORE, planOnboarding } from './lib/onboard.mjs'
import { friendId } from './lib/roster.mjs'
import { canOfferModelSwitch, confirmText, createModelSwitcher } from './lib/model-switch.mjs'
import { vendorIconSvg } from './lib/vendor-icons.mjs'
import { createMic } from './lib/mic.mjs'
import { browserAudio } from './lib/tts-player.mjs'
import { createVoiceUi } from './lib/voice-ui.mjs'
import { createCallBeats } from './lib/call-beats.mjs'
import { startCallPoll } from './lib/call-poll.mjs'
import { isCallActive } from './lib/call-session.mjs'
import { accountLine, codexLine, createAccountsUi } from './lib/claude-accounts.mjs'
import { buildDeviceTree } from './lib/device-tree.mjs'
import { dialogTitle as deviceAcctTitle, dialogView as deviceAcctViewOf, CONFIRM_NOTE as DEVICE_CONFIRM_NOTE, CLOSE_NOTE as DEVICE_CLOSE_NOTE } from './lib/device-acct-dialog.mjs'
import { applyRename } from './lib/rename.mjs'
import { createUsageUi } from './lib/usage.mjs'
import { CHECK_MS, autoCheckFromSaved, initialUpdateState, manualResultText, progressText, updateNoticeText, withAvailable, withFailure, withInstalling, withProgress, updateStatus } from './lib/update.mjs'
import { AUTO_CHOICES, AUTO_LABEL, STT_LANGS, STT_LANG_LABEL, STT_MODELS, STT_MODEL_LABEL, normalizeCfg, shouldAutoSpeak, sttStatusText } from './lib/voice-prefs.mjs'

const { createApp, reactive, ref, computed, watch, nextTick } = Vue
const STATUS = { online: '線上', busy: '忙碌', away: '暫離', offline: '顯示為離線' }
const CONN_LABEL = { connecting: '連線中…', on: '已連線', off: '連線中斷，重試中' }

// ---------- 音效（WebAudio 合成） ----------
let audioCtx = null
function actx() {
  if (!audioCtx) { try { audioCtx = new AudioContext() } catch { return null } }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
  return audioCtx
}
function tone(freq, start, dur, type = 'sine', gain = 0.16) {
  const a = actx(); if (!a) return
  const o = a.createOscillator(), g = a.createGain(), t = a.currentTime + start
  o.type = type; o.frequency.value = freq
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(gain, t + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  o.connect(g).connect(a.destination)
  o.start(t); o.stop(t + dur + 0.05)
}
const SOUNDS = {
  login: () => { tone(659, 0, 0.35); tone(988, 0.14, 0.7) },
  msg: () => { tone(1175, 0, 0.18, 'triangle', 0.14); tone(880, 0.1, 0.32, 'triangle', 0.14) },
  file: () => { tone(784, 0, 0.14); tone(1047, 0.12, 0.14); tone(1319, 0.24, 0.4) },
  nudge: () => { for (let i = 0; i < 7; i++) tone(95 + (i % 2) * 35, i * 0.07, 0.09, 'square', 0.05) },
}

const info = reactive(await invoke('startup_info'))   // 響應式：改設備名後就地更新，不重載頁面
document.title = `Agent Sync Network Messenger (${info.version})`
if (info.shot) {
  const logFe = (level, msg) => invoke('shot_frontend_log', { level, message: String(msg) }).catch(() => {})
  window.onerror = (msg, src, line, col, err) => { logFe('error', `${msg} @ ${src}:${line}:${col} ${err?.stack ?? ''}`) }
  window.onunhandledrejection = e => logFe('error', e.reason?.stack ?? e.reason ?? 'unhandled rejection')
}
if (info.needs_login) {
  // 沒有節點金鑰（新電腦）：轉到登入畫面，登入後自動建立節點並重新啟動
  location.replace('login.html')
  await new Promise(() => {})
}
// 登入後第一次進來：先走首次登入引導（帳號名稱＋設備名稱）；旗標已設、帳號與設備都有名字、沒登入、取不到帳號資料都直接往下
if (!info.needs_login && !info.error && !info.shot) {
  const plan = await planOnboarding({ store: store(ONBOARD_STORE), status: authApi.status, accountInfo: authApi.accountInfo, startup: info })
  if (plan.steps.length) {
    location.replace('onboard.html')
    await new Promise(() => {})
  }
}
if (info.error) {
  document.body.textContent = `ASN 無法啟動：${info.error}`
  throw new Error(info.error)
}
const meStore = store('me')
const savedMe = (await meStore.load()) ?? {}
// 暱稱＝視窗名＝對外名字；以 Rust 端現用名為準，不再從存檔讀
const me = reactive({ psm: '', status: 'online', ...savedMe.me, nick: info.window_name })
const notifyPrefs = ref(notifyFromSaved(savedMe))   // 通知四開關（舊存檔的 sound 在這裡轉過來）
const frame = ref(normalizeFrame(savedMe.frame))   // 視窗外框：自訂（預設，含舊存檔）／Windows 原生；Rust 端開視窗時讀同一份存檔
await initFrame()
// 關閉視窗時：縮到系統匣（預設，含舊存檔）／結束程式；登入時自動啟動以系統上的真實設定為準（不存檔）。程式在 tray.rs
const closeTo = ref(normalizeClose(savedMe.closeTo))
const trayOk = ref(true)
const showNowPlaying = ref(normalizeNowPlaying(savedMe.showNowPlaying))   // 顯示正在聽的歌（預設關；開了 Rust 端才去讀系統媒體、才送出）
const nowPlaying = ref('')   // 目前正在聽的「歌名 - 歌手」（Rust 端輪詢後推來；沒在聽＝空）
const autoAddClaude = ref(true)   // Claude 帳號自動加入／回存：固定開啟（Rust 背景工作每分鐘執行，不再有開關）
const autostart = reactive({ supported: false, on: false, busy: false, blocked: '' })
try {
  await invoke('set_close_to_tray', { tray: closeTo.value === 'tray' })
  trayOk.value = await invoke('tray_available')
  autostart.supported = await invoke('autostart_supported')
  if (autostart.supported) { autostart.on = await invoke('autostart_get'); autostart.blocked = (await invoke('autostart_blocked').catch(() => null)) || '' }
} catch { /* 沒有這些指令（舊版後端）就不顯示 */ }
// 內建收發室橋（預設關）：狀態以 Rust 端為準，不存檔。程式在 bridge/
const bridge = reactive({ enabled: false, running: false, legacy: false, takeoverAllowed: false, remoteLaunch: false, unaddressedTo: '', error: '', busy: false, confirm: false, shown: false })
const applyBridgeStatus = s => {
  Object.assign(bridge, { enabled: s.enabled === true, running: s.running === true, legacy: s.legacy === true, takeoverAllowed: s.takeover_allowed === true, remoteLaunch: s.remote_launch === true, unaddressedTo: typeof s.unaddressed_to === 'string' ? s.unaddressed_to : '', error: s.error || '', shown: true })
}
try { applyBridgeStatus(await invoke('bridge_status')) } catch { /* 舊版後端沒有這個指令就不顯示 */ }
// 密碼小幫手（asn-askpass）：git／ssh 要密碼時請 ASN 跳窗收。設定頁「啟動設定」的進階裡顯示設定指令，可複製路徑；ASN 不會自動改環境變數。程式在 askpass/
const askpassInfo = reactive({ shown: false, path: '', example: '', copied: false })
try {
  const a = await invoke('askpass_helper_info')
  if (a?.path) Object.assign(askpassInfo, { shown: true, path: String(a.path), example: String(a.example || '') })
} catch { /* 舊版後端沒有這個指令就不顯示 */ }
async function copyAskpassPath() {
  try { await navigator.clipboard.writeText(askpassInfo.path); askpassInfo.copied = true; setTimeout(() => { askpassInfo.copied = false }, 2500) } catch (e) { console.info('[ASN] 複製失敗', e.message) }
}
// 自動更新：啟動與每 6 小時檢查；有新版只在名單上方顯示一條通知，使用者按「更新」才下載安裝（--shot 模式不檢查）。程式在 updater.rs
const autoCheck = ref(autoCheckFromSaved(savedMe.autoUpdate))
const upd = reactive({ ...initialUpdateState(), checking: false, manual: '', lastCheck: 0, checkErr: '' })
// 版本更新記錄：打包時 CHANGELOG.md 轉成 vendor/changelog.json（與同內容的 changelog.mjs），離線也能看（讀不到就當沒有）
const changelogEntries = ref([])
// （CSP 的 connect-src 不放行 fetch；跟 dicebear.mjs 一樣用 import 載入同內容的 .mjs 版）
try { changelogEntries.value = (await import('./vendor/changelog.mjs')).default } catch { /* 沒有記錄檔就不顯示 */ }
const setUpd = next => Object.assign(upd, next)
const checkUpdate = async (manual = false) => {
  if (info.shot || upd.checking || upd.phase === 'installing') return
  upd.checking = true
  if (manual) upd.manual = '檢查中…'
  try {
    const found = await invoke('update_check')
    setUpd(withAvailable(upd, found))
    upd.lastCheck = Date.now(); upd.checkErr = ''
    if (manual) upd.manual = manualResultText(found, info.version)
  } catch (e) {
    upd.checkErr = String(e?.message ?? e)
    if (manual) upd.manual = upd.checkErr
  } finally { upd.checking = false }
}
const installUpdate = async () => {
  if (upd.phase === 'installing') return
  setUpd(withInstalling(upd))
  try { await invoke('update_install') } catch (e) { setUpd(withFailure(upd, e?.message ?? e)) }
}
if (!info.shot) {
  await listen('update-progress', p => setUpd(withProgress(upd, p)))
  setInterval(() => { if (autoCheck.value) void checkUpdate() }, CHECK_MS)
  if (autoCheck.value) void checkUpdate()
}
// 遠端更新：名單上別台設備顯示「有新版」時，本人（已登入、設備在同一帳號下）可按「更新」，請那台自己更新（後台留請求、
// 對方 ASN 回報在線時取走並用內建更新器安裝，不經 AI）。remoteMine＝本人帳號下的設備與請求狀態；程式在 account.rs
const remoteMine = ref({}), remoteErr = reactive({})
const refreshRemoteUpd = async () => {
  try { remoteMine.value = mineFromStatus(await invoke('update_remote_status')) } catch { /* 沒登入、後台還沒部署或連不上：保持上一次的狀態 */ }
}
const remoteBtn = node => remoteUpdateView(remoteMine.value, node, !!asnBadge(node)?.outdated, remoteErr[node])
const requestRemoteUpdate = async node => {
  if (remoteBtn(node)?.busy) return
  remoteErr[node] = ''
  remoteMine.value = { ...remoteMine.value, [node]: { state: 'pending', detail: '' } }   // 先顯示「已送出」，失敗再還原
  try { await invoke('update_remote_request', { node }) } catch (e) {
    remoteMine.value = { ...remoteMine.value, [node]: null }
    remoteErr[node] = e?.message ?? String(e)
  }
  void refreshRemoteUpd()
}
if (!info.shot) {
  void refreshRemoteUpd()
  setInterval(() => void refreshRemoteUpd(), REMOTE_UPD_POLL_MS)
}
const dims = reactive(loadDims(savedMe))   // 分頁依（設備／廠商／狀態）與分組依；舊存檔的 groupMode 在這裡轉換

// 視窗模式：分開（每位好友一扇對話視窗）／整合（一個視窗，右邊是對話分頁）。tabs／active 只在整合模式用，不存檔
// 視窗模式、頭像模式（左／右／整合）、文字底色（透明／色彩／自動）三個設定彼此獨立，分離與整合視窗都有效
const pinnedChat = normalizePinned(savedMe.pinnedChat)
// panel＝指引、設定兩個聊天窗目前顯示哪一篇／哪一類（整合模式是右邊的分頁、分離模式是獨立視窗；不存檔）
const ui = reactive({ mode: normalizeMode(savedMe.winMode), ...normalizeLook(savedMe), tabs: [], active: '', pinnedChat, panel: { guide: '', setting: '' } })
const sizes = reactive({ split: normalizeSize(savedMe.splitSize, 'split'), merged: normalizeSize(savedMe.mergedSize, 'merged'), guide: normalizePanelSize(savedMe.guideSize), setting: normalizePanelSize(savedMe.settingSize) })   // guide／setting＝分離模式兩扇視窗的大小
const winSize = () => ({ w: window.innerWidth, h: window.innerHeight })
let switching = false
// 記住開著的分頁與對話視窗（重啟後回到原狀態）：存在 asn-me.json 的 session。還原完成前不寫新的，免得把上次的狀態蓋成空的
const sess = reactive({ saved: normalizeSession(savedMe.session), ready: false, wins: [], panelWins: [] })
const currentSession = () => snapshotSession({ tabs: ui.tabs, active: ui.active, panel: ui.panel, windows: sess.wins, panelWindows: sess.panelWins }, id => core.friends.get(id))
async function pollOpenWindows() {   // 分開模式開著哪些對話視窗，由 Rust 端的視窗清單為準
  if (!sess.ready || ui.mode !== 'split') { if (sess.wins.length || sess.panelWins.length) { sess.wins = []; sess.panelWins = [] } ; return }
  try {
    const [chats, panels] = await invoke('open_windows')
    if (JSON.stringify(chats) !== JSON.stringify(sess.wins)) sess.wins = chats
    if (JSON.stringify(panels) !== JSON.stringify(sess.panelWins)) sess.panelWins = panels
  } catch { /* 取不到就維持上次 */ }
}

const core = new AsnCore({
  transport, store: store('chats'), selfNode: info.node, windowName: info.window_name,
  // 整合模式：只有「目前分頁」且主視窗開著沒最小化才算看得到
  isChatVisible: async id => (ui.mode === 'merged' ? tabVisible(ui, id, await invoke('main_visible')) : invoke('chat_visible', { id })),
  aliases: info.old_names,
  pollMs: info.poll_ms, rosterMs: info.roster_ms,
  log: m => console.info('[ASN]', m),
})

// ---------- 群組（真人好友與群組）：群組在名單的「群組」分頁，點進去在對話分頁（整合）或對話視窗（分開）聊 ----------
// 群組對話用「假夥伴」接上既有的對話窗：id 是 room:<群組代號>。發言、讀取、同意／拒絕都走 Rust 指令並帶本人簽章
const groupApi = createGroupApi(invoke)
const hub = createRoomHub({ invoke, groupApi, selfNode: info.node, windowName: info.window_name, reactive, visible: () => document.visibilityState === 'visible' })
const roomRows = computed(() => hub.rows())
const roomFriends = computed(() => roomRows.value.map(r => ({ ...roomPseudoFriend(r), unread: r.unread })))
const openedRooms = new Set()   // 開過的群組對話（整合模式的分頁、分開模式的視窗）：這些要持續讀新訊息

const friends = ref([])
const nodeOrder = ref([])
const asnBadge = node => deviceAsn(asnMap.value[node], info.version)
const asnMap = ref({})   // 節點 → 在線的 ASN 視窗（版本與狀態），名單設備分組標題旁的小綠點用
const conn = ref('connecting')
const sync = () => {
  const s = core.snapshot()
  friends.value = s.friends
  nodeOrder.value = s.nodeOrder
  asnMap.value = s.asn ?? {}
  conn.value = s.conn
  emit('asn:state', { ...s, friends: [...s.friends, ...roomFriends.value], me: { ...me }, ui: { dpMode: ui.dpMode, bubble: ui.bubble, toolbar: ui.toolbar, collapsed: ui.collapsed } })
}
const logs = reactive({})   // 整合模式的分頁直接讀這份；分開模式的對話視窗走 asn:log 事件
const pushLog = id => {
  const room = isRoomChat(id)
  const l = room ? (hub.st.logs[roomIdOf(id)] ?? []) : core.viewOf(id)
  logs[id] = l; emit('asn:log', { id, log: l })
  if (room) emit('asn:room', { id, cards: hub.st.cards[roomIdOf(id)] ?? [], note: hub.st.note })
}
const loadOlder = id => (isRoomChat(id) ? Promise.resolve({ more: false, added: 0 }) : core.loadOlder(id))
const tabFriend = id => friends.value.find(f => f.id === id) ?? roomFriends.value.find(f => f.id === id)   // 對話往上捲到頂：載入更舊的信（分開模式的對話視窗經事件請樞紐代跑）

// 設備大頭貼：節點 → data URL。好友顯示用哪張由 avatar.mjs 的規則決定（AI 視窗一律自動產生；名單外的寄件人用他那台設備的圖）
const avatars = ref({})
core.on('avatars', () => {
  avatars.value = core.avatarMap(); emit('asn:avatars', avatars.value)
  // 這台自己設定的大頭貼同步給登入畫面的「上次登入」記憶（只在有圖時寫；Rust 端沒登入過就不動）
  const mine = avatars.value[info.node]
  if (isAvatarDataUrl(mine) && mine !== lastSyncedAvatar) { lastSyncedAvatar = mine; void authApi.setLastAvatar(mine).catch(() => {}) }
})
let lastSyncedAvatar = ''
const avOf = f => avatarSrc(f, { avatars: avatars.value })
const meAv = computed(() => selfAvatarSrc({ selfNode: info.node, windowName: info.window_name, avatars: avatars.value }))

core.on('state', sync)
core.on('log', pushLog)
// 重抓群組列表，並更新開著的群組對話的新訊息與待主持人確認的卡片
async function refreshRooms() {
  await hub.refresh()
  for (const id of openedRooms) {
    const rid = roomIdOf(id)
    if (!hub.raw(rid)) continue
    await hub.read(rid); await hub.loadCards(rid)
    pushLog(id)
  }
  sync()
}

// ---------- 開新夥伴 ----------
const cliTools = ref({})
const remoteLaunchers = ref({})   // node → launcher 摘要
const launchPending = ref([])     // 啟動中列
const launchTrack = ref([])       // { id, node, name, profile } 遠端 launch uuid
const launchNotice = reactive({ open: false, title: '', body: '', logPath: '' })
const launchLogPaths = reactive({ bridgeLog: '', machineDir: '' })
void invoke('relay_log_paths').then(p => { if (p) Object.assign(launchLogPaths, p) }).catch(() => {})
function showLaunchNotice(notice) {
  Object.assign(launchNotice, { open: true, logPath: launchLogPaths.bridgeLog || '', title: notice.title, body: notice.body })
}
function closeLaunchNotice() { launchNotice.open = false }
async function openLaunchLogFolder() {
  try { await invoke('open_machine_log_dir') } catch (e) { console.info('[ASN] 開啟記錄資料夾', e.message) }
}
const launchPrefs = reactive(normalizeLaunchPrefs(null))
const launchCwdText = ref('')
async function refreshCliTools() {
  try {
    const r = await transport.cliDetect()
    const map = {}
    for (const t of r?.tools ?? []) map[t.id] = t
    cliTools.value = map
  } catch (e) { console.info('[ASN] cli detect failed', e.message) }
}
async function refreshLaunchers() {
  try {
    const body = await transport.launchers()
    const map = {}
    for (const m of body?.machines ?? []) if (m?.node) map[m.node] = m.launcher
    remoteLaunchers.value = map
  } catch { /* 非 owner 或後台未就緒 */ }
}
async function loadLaunchPrefs() {
  try {
    const p = normalizeLaunchPrefs(await transport.launchPrefsGet())
    Object.assign(launchPrefs, p)
    launchCwdText.value = (p.cwdAllow.length ? p.cwdAllow : defaultCwdAllowFromCli()).join('\n')
  } catch { launchCwdText.value = defaultCwdAllowFromCli().join('\n') }
}
function defaultCwdAllowFromCli() {
  return cwdChoices({ allow: [], recent: launchPrefs.recentCwd })
}
async function saveLaunchPrefs() {
  const cwdAllow = launchCwdText.value.split('\n').map(s => s.trim()).filter(Boolean)
  const prefs = { ...launchPrefs, cwdAllow, maxPerHour: launchPrefs.maxPerHour ?? 6 }
  try { await transport.launchPrefsSet(prefs) } catch (e) { console.info('[ASN] launch prefs', e.message) }
}
function setLaunchCwdText(text) {
  launchCwdText.value = text
  launchPrefs.cwdAllow = text.split('\n').map(s => s.trim()).filter(Boolean)
  void saveLaunchPrefs()
}
const launchToolRows = computed(() => MODEL_CATALOG.map(m => modelUiRow(m, cliTools.value[m.toolId ?? m.id])))
const partnerModels = computed(() => launchToolRows.value)
// 對話框裡的模型列：本機看偵測到的 CLI；別台設備看那台回報的 profile
const dlgModels = computed(() => (partnerDlg.node && partnerDlg.node !== info.node ? remoteModelRows(remoteLaunchers.value[partnerDlg.node]) : partnerModels.value))
const partnerDlg = reactive({ open: false, node: '', deviceLabel: '', profile: 'claude', name: '', cwd: '', firstMessage: '', busy: false, error: '', modeLabel: '', display: 'foreground' })
const partnerShowDisplay = computed(() => partnerDlg.node === info.node && showDisplayModeChoice(partnerDlg.profile))
const launchCtx = computed(() => ({ selfNode: info.node, partnerModels: partnerModels.value, remoteLaunchers: remoteLaunchers.value }))
const launchDeviceRowsList = computed(() => launchDeviceRows(friends.value, { selfNode: info.node, nodeOrder: nodeOrder.value }))
function launchDisableReasonFor(nodeKey) { return launchDisableReason(nodeKey, launchCtx.value) }
// 本機的候選由 Rust 端合併（白名單＋開著的 Claude 視窗＋信任過的資料夾＋最近用過，去重、略過不存在的、最多 15 筆）
const localCwdList = ref([])
async function refreshCwdCandidates() {
  try {
    const r = await transport.launchCwdCandidates()
    localCwdList.value = Array.isArray(r) ? mergeCwdLists([r]) : []
  } catch (e) { console.info('[ASN] 工作資料夾候選', e.message) }
}
const partnerCwdChoices = computed(() => {
  if (partnerDlg.node === info.node) {
    const fallback = cwdChoices({ allow: launchPrefs.cwdAllow.length ? launchPrefs.cwdAllow : defaultCwdAllowFromCli(), recent: launchPrefs.recentCwd })
    return mergeCwdLists([localCwdList.value, fallback])
  }
  return mergeCwdLists([cwdChoices({ allow: remoteLaunchers.value[partnerDlg.node]?.cwd_allow ?? [], recent: launchPrefs.recentCwd })])
})
// 「瀏覽…」：Rust 端開選擇資料夾對話框，選好的已寫進本機白名單；這裡加進候選並選取
async function browsePartnerCwd() {
  partnerDlg.error = ''
  try {
    const p = await transport.launchCwdBrowse()
    if (!p) return
    localCwdList.value = withPickedCwd(localCwdList.value, p)
    partnerDlg.cwd = p
    await loadLaunchPrefs()
  } catch (e) { partnerDlg.error = e.message }
}
function pickPartnerModel(m) {
  if (!m.installed) return
  partnerDlg.profile = m.profileId
  partnerDlg.modeLabel = m.modeLabel
  partnerDlg.name = defaultPartnerName(friends.value, m.profileId)
}
function openPartnerDlg(nodeKey) {
  closeLaunchPicker()
  const devLabel = friends.value.find(f => f.node === nodeKey)?.device ?? nodeKey
  partnerDlg.open = true
  partnerDlg.node = nodeKey
  partnerDlg.deviceLabel = devLabel
  partnerDlg.error = ''
  partnerDlg.busy = false
  partnerDlg.firstMessage = ''
  partnerDlg.display = launchPrefs.launchDisplay === 'background' ? 'background' : 'foreground'
  const first = dlgModels.value.find(m => m.installed) ?? dlgModels.value[0]
  if (first) pickPartnerModel(first)
  partnerDlg.cwd = partnerCwdChoices.value[0] ?? ''
  if (nodeKey !== info.node) {
    // 別台設備：開對話框時重抓一次它回報的 profile 與資料夾（剛啟用內建橋或剛改設定時才不會看到舊的）
    void refreshLaunchers().then(() => {
      if (!partnerDlg.open || partnerDlg.node !== nodeKey) return
      const cur = dlgModels.value.find(m => m.profileId === partnerDlg.profile)
      if (!cur) { const f = dlgModels.value[0]; if (f) pickPartnerModel(f) }
      if (!partnerDlg.cwd || !partnerCwdChoices.value.includes(partnerDlg.cwd)) partnerDlg.cwd = partnerCwdChoices.value[0] ?? ''
    })
  }
  if (nodeKey === info.node) {
    void refreshCwdCandidates().then(() => {
      if (partnerDlg.open && !partnerDlg.cwd) partnerDlg.cwd = partnerCwdChoices.value[0] ?? ''
    })
  }
}
function closePartnerDlg() { partnerDlg.open = false; partnerDlg.error = '' }
const searchInput = ref(null)
function focusSearch() { searchInput.value?.focus?.() }
const launchPicker = ref(false)
const launchPickerPos = reactive({ x: 0, y: 0 })
function openLaunchPicker(e) {
  closeBuddyMenu()
  const r = e?.currentTarget?.getBoundingClientRect?.()
  launchPickerPos.x = r ? r.right - 4 : (e?.clientX ?? 0)
  launchPickerPos.y = r ? r.bottom + 2 : (e?.clientY ?? 0)
  launchPicker.value = true
}
function closeLaunchPicker() { launchPicker.value = false }
function pickLaunchDevice(nodeKey) {
  if (launchDisableReasonFor(nodeKey)) return
  closeLaunchPicker()
  openPartnerDlg(nodeKey)
}
const buddyMenu = ref('')
const buddyMenuPos = reactive({ x: 0, y: 0 })
const buddyMenuFriend = ref(null)
let buddyMenuOrigin = { x: 0, y: 0 }
const buddyMenuEl = ref(null)   // 主選單、二級選單都放在 overflow 容器外面（position:fixed），位置由 lib/menu-place.mjs 算（翻轉、夾在視窗內）
const buddySubEl = ref(null)
const buddyModelBtn = ref(null)
const buddySubPos = reactive({ x: 0, y: 0, ready: false })
const viewSize = () => ({ w: window.innerWidth, h: window.innerHeight })
async function placeBuddyMenu() {
  await nextTick()
  const r = buddyMenuEl.value?.getBoundingClientRect()
  if (!r) return
  Object.assign(buddyMenuPos, placeMenu(buddyMenuOrigin, { w: r.width, h: r.height }, viewSize()))
}
// 夥伴管理（詳情、改名、關閉視窗、接班換手、喚醒）：項目與判斷全部來自 lib/partner-ops.mjs，和手機同一套
const opsCtx = reactive(initialOpsCtx())
let opsCtxAt = 0
async function refreshOpsCtx() {
  if (Date.now() - opsCtxAt < 15000) return
  opsCtxAt = Date.now()
  const ctx = await loadOpsContext(transport)
  Object.assign(opsCtx, ctx)
  if (ctx.signedIn === null || !ctx.loaded) opsCtxAt = 0   // 查詢失敗不要擋住下一次重查
}
const buddyOpItems = computed(() => manageItems(buddyMenuFriend.value, { ...opsCtx, friends: friends.value, asn: asnMap.value }).filter(i => i.key !== 'model'))   // 切換模型沿用下面原本那個子選單
const opDlg = reactive({ open: false, op: '', friend: null, item: null })
function openPartnerOp(it) {
  const f = buddyMenuFriend.value
  closeBuddyMenu()
  if (!f || !it?.ok) return
  if (it.key === 'archive' || it.key === 'unarchive') { void setArchived(f, it.key === 'archive'); return }
  Object.assign(opDlg, { open: true, op: it.key, friend: f, item: it })
}
// 封存／取消封存：記在帳號層（後台），立刻重新拉名單；結果用名單上方的一行字說明
const archiveNote = ref('')
let archiveNoteTimer = null
async function setArchived(f, archived) {
  const r = await runArchive(transport, f, archived)
  if (r.ok) await core.refreshRoster()
  archiveNote.value = r.text
  clearTimeout(archiveNoteTimer)
  archiveNoteTimer = setTimeout(() => { archiveNote.value = '' }, 6000)
}
function closeOpDlg() { opDlg.open = false }
// 右鍵選單立刻出現（固定有「開啟對話」）；主控台切換項目先顯示「檢查中…」，查到才可按，逾時／查不到就停用
const buddyConsole = reactive({ state: 'none', visible: true, reason: '' })
const buddyConsoleItemView = computed(() => buddyConsoleItem(buddyConsole.state, buddyConsole.reason))
// 「切換模型 ▸」：只有本機的 Claude 視窗會出現；查詢逾時或查不到就停用並說明原因（共用 lib/model-switch.mjs，功能列 #40 也用它）
const modelSwitcher = createModelSwitcher({ transport, log: m => console.info('[ASN]', m) })
const buddyModel = reactive({ show: false, state: 'none', reason: '', current: '', items: [], open: false, st: null })
function resetBuddyModel() { Object.assign(buddyModel, { show: false, state: 'none', reason: '', current: '', items: [], open: false, st: null }) }
const buddySubEnabled = computed(() => buddyModel.state !== 'none' && buddyModel.state !== 'checking' && buddyModel.items.length > 0)
let buddySubTimer = null
watch([() => buddyOpItems.value.length, () => buddyConsole.state, () => buddyModel.show], () => { if (buddyMenu.value) void placeBuddyMenu() })
async function placeBuddySub() {
  Object.assign(buddySubPos, { x: 0, y: 0, ready: false })   // 先放回左上角再量：上一次的位置會把「靠右的剩餘寬度」壓窄，量到的寬度就不準
  await nextTick()
  const a = buddyModelBtn.value?.getBoundingClientRect()
  const r = buddySubEl.value?.getBoundingClientRect()
  if (!a || !r) return
  Object.assign(buddySubPos, placeSubmenu(a, { w: r.width, h: r.height }, viewSize()), { ready: true })
}
// 二級選單：滑過（或點一下、鍵盤右鍵）在右側彈出，移開／選完／Esc 收起；移開有一點延遲，滑鼠從那一項移到子選單的途中不會收掉
function subEvent(ev, delay = 0) {
  clearTimeout(buddySubTimer)
  const run = () => {
    const r = submenuNext({ open: buddyModel.open }, ev, buddySubEnabled.value)
    buddyModel.open = r.open
    if (r.open) void placeBuddySub()
  }
  if (delay) buddySubTimer = setTimeout(run, delay)
  else run()
}
const buddyModelLabel = computed(() => (buddyModel.state === 'checking' ? '切換模型（檢查中…）' : buddyModel.state === 'none' ? '切換模型（無法切換）' : '切換模型 ▸'))
const modelDlg = reactive({ open: false, name: '', target: null, current: '', busy: false, error: '', manual: '', done: '', copied: false, st: null })
const modelDlgText = computed(() => confirmText(modelDlg.name, modelDlg.current, modelDlg.target?.label ?? '', { ownWindow: Boolean(modelDlg.st?.raw?.ownWindow) }))
function closeModelDlg() { if (!modelDlg.busy) modelDlg.open = false }
const buddyConsoleState = () => buddyConsole.state
function closeBuddyMenu() { clearTimeout(buddySubTimer); buddyMenu.value = ''; buddyMenuFriend.value = null; buddyConsole.state = 'none'; resetBuddyModel() }
async function loadBuddyModel(c) {
  buddyModel.state = 'checking'
  const st = await modelSwitcher.query(c.agent || c.nick)
  if (buddyMenuFriend.value !== c) return   // 使用者已經關掉或換開別人的選單
  Object.assign(buddyModel, { state: st.state, reason: st.reason, current: st.current, items: st.items, st })
}
function pickBuddyModel(item) {
  const c = buddyMenuFriend.value
  if (!c || item.disabled || item.checked || !buddyModel.st) return
  Object.assign(modelDlg, { open: true, name: c.agent || c.nick, target: item, current: buddyModel.current, busy: false, error: '', manual: '', done: '', copied: false, st: buddyModel.st })
  closeBuddyMenu()
}
async function submitModelDlg() {
  if (modelDlg.busy || modelDlg.done) return
  modelDlg.busy = true; modelDlg.error = ''; modelDlg.manual = ''
  const r = await modelSwitcher.run(modelDlg.name, modelDlg.st, modelDlg.target.id)
  modelDlg.busy = false
  if (r.ok) modelDlg.done = r.message
  else { modelDlg.error = r.message; modelDlg.manual = r.manual }
}
async function copyModelManual() {
  try { await navigator.clipboard.writeText(modelDlg.manual); modelDlg.copied = true } catch (e) { console.info('[ASN] 複製失敗', e.message) }
}
function buddyMenuOpenChat() {
  const c = buddyMenuFriend.value
  closeBuddyMenu()
  if (c) void openChat(c.id)
}
async function openBuddyMenu(c, e) {
  closeLaunchPicker()
  buddyMenuOrigin = { x: e?.clientX ?? 0, y: e?.clientY ?? 0 }
  buddyMenuPos.x = buddyMenuOrigin.x
  buddyMenuPos.y = buddyMenuOrigin.y
  buddyMenuFriend.value = c
  buddyMenu.value = c.id
  void refreshOpsCtx()
  void placeBuddyMenu()
  buddyConsole.visible = true
  const eng = c.engine || engineForProfile(c.launchProfile || 'claude')
  resetBuddyModel()
  buddyModel.show = canOfferModelSwitch(c, { selfNode: info.node, engine: eng })
  if (buddyModel.show) void loadBuddyModel(c)
  if (c.node !== info.node || c.engine === 'acp' || c.pending) { buddyConsole.state = 'none'; return }
  buddyConsole.state = 'checking'
  buddyConsole.reason = ''
  const q = await withTimeout(transport.partnerConsoleQuery({ engine: eng, name: c.agent || c.nick }), CONSOLE_QUERY_TIMEOUT_MS)
  if (buddyMenuFriend.value !== c) return   // 使用者已經關掉或換開別人的選單
  if (q?.can_toggle ?? q?.canToggle) {
    buddyConsole.state = 'toggle'
    buddyConsole.visible = Boolean(q.visible)
  } else {
    buddyConsole.state = 'none'
    buddyConsole.reason = String(q?.reason || '')
  }
}
async function toggleBuddyConsole() {
  const c = buddyMenuFriend.value
  if (!c || buddyConsole.state !== 'toggle') { closeBuddyMenu(); return }
  const eng = c.engine || engineForProfile(c.launchProfile || 'claude')
  const nextVis = !buddyConsole.visible
  try {
    const r = await transport.partnerConsoleSet({ engine: eng, name: c.agent || c.nick, visible: nextVis })
    if (r?.ok) buddyConsole.visible = Boolean(r.visible)
  } catch (e) { console.info('[ASN] 主控台切換', e.message) }
  closeBuddyMenu()
}
async function submitPartnerDlg() {
  partnerDlg.error = ''
  if (!partnerDlg.name.trim() || !partnerDlg.cwd) { partnerDlg.error = '請填名字與工作資料夾'; return }
  partnerDlg.busy = true
  const mode = MODEL_CATALOG.find(m => m.profileId === partnerDlg.profile)?.mode ?? 'window'
  const display = partnerShowDisplay.value && partnerDlg.display === 'background' ? 'background' : 'foreground'
  const pend = pendingFriend({ node: partnerDlg.node, device: partnerDlg.deviceLabel, name: partnerDlg.name.trim(), profileId: partnerDlg.profile, mode, launchDisplay: display })
  launchPending.value = [...launchPending.value, pend]
  try {
    if (partnerDlg.node === info.node) {
      if (display === 'foreground') launchPrefs.launchDisplay = 'foreground'
      else launchPrefs.launchDisplay = 'background'
      void saveLaunchPrefs()
      await transport.partnerLaunchLocal({ profile: partnerDlg.profile, name: partnerDlg.name.trim(), cwd: partnerDlg.cwd, display })
    } else {
      const r = await transport.launch({ node: partnerDlg.node, profile: partnerDlg.profile, name: partnerDlg.name.trim(), cwd: partnerDlg.cwd, first_message: partnerDlg.firstMessage.trim() || null })
      if (r?.id) launchTrack.value = [...launchTrack.value, { id: r.id, node: partnerDlg.node, name: partnerDlg.name.trim(), profile: partnerDlg.profile }]
    }
    Object.assign(launchPrefs, bumpRecentCwd(launchPrefs, partnerDlg.cwd))
    void saveLaunchPrefs()
    closePartnerDlg()
    if (partnerDlg.node === info.node && partnerDlg.firstMessage.trim()) {
      setTimeout(async () => {
        const id = friendId(partnerDlg.node, partnerDlg.name.trim())
        if (core.friends.has(id)) await core.send(id, partnerDlg.firstMessage.trim())
      }, 8000)
    }
  } catch (e) {
    launchPending.value = launchPending.value.filter(p => p.id !== pend.id)
    partnerDlg.error = e.message
    partnerDlg.open = true
  } finally { partnerDlg.busy = false }
}
async function pollLaunchResults() {
  if (launchTrack.value.length) {
    try {
      const ids = launchTrack.value.map(t => t.id)
      const trackSnap = launchTrack.value
      const body = await transport.launchers(ids)
      for (const fail of collectLaunchFailures(body?.launches, trackSnap)) {
        console.info('[ASN] 開新夥伴失敗', fail.detail)
        showLaunchNotice(launchFailedNoticeText(fail.name, fail.detail))
      }
      for (const row of body?.launches ?? []) {
        if (row.status === 'ok' || row.status === 'failed') {
          launchTrack.value = launchTrack.value.filter(t => t.id !== row.id)
        }
      }
    } catch { /* 略過 */ }
  }
  const still = resolvePending(launchPending.value, friends.value)
  const now = Date.now()
  for (const p of findBackgroundTimeouts(launchPending.value, still, now, info.node)) {
    p.trustRestored = true
    const eng = engineForProfile(p.launchProfile || 'claude')
    const notice = backgroundRestoreNoticeText(p.agent)
    void transport.partnerConsoleSet({ engine: eng, name: p.agent, visible: true }).then(() => {
      console.info('[ASN] 背景啟動可能卡在「信任此資料夾」，已改為前台顯示，請到電腦前按一次 Enter')
      showLaunchNotice(notice)
    }).catch(() => {})
  }
  launchPending.value = still
}
void refreshCliTools()
void refreshLaunchers()
void loadLaunchPrefs()
setInterval(() => { void refreshLaunchers(); void pollLaunchResults() }, 15_000)
// 語音：整合模式的對話分頁用這一份；設定存在 Rust 端的 voice.json（對話視窗也讀同一份）
const voice = createVoiceUi({ invoke, listen, createMic, createAudio: browserAudio, reactive })
const callTick = ref(0)                 // 通話狀態變動時加一，讓「關閉閒置」的可用判斷重算
const mergedCalls = reactive({})        // 整合模式：哪些分頁的 chat-pane 正在通話（chat-pane 的 call-state 事件）
const setPaneCall = (id, on) => { if (on) mergedCalls[id] = true; else delete mergedCalls[id]; callTick.value++ }
const callBeats = createCallBeats({ isLocalCall: isCallActive })   // 通話中（本視窗或對話視窗）不自動念，通話自己會念回信
await listen('asn:call', p => { callBeats.onBeat(p); callTick.value++ })   // 分開模式：對話視窗的通話廣播
startCallPoll({ anyCall: () => callBeats.anyCall(), pull: why => core.pull(why) })   // 通話中每 2 秒多收一次信，結束就停
const voiceCfg = reactive(normalizeCfg(await invoke('voice_cfg_get').catch(() => null)))
core.on('notify', n => {
  const plan = notifyPlan(n, notifyPrefs.value, me.status)
  if (plan.sound) SOUNDS[plan.sound]?.()
  if (shouldAutoSpeak(n, voiceCfg, me.status) && !callBeats.anyCall()) voice.speakAuto(`auto:${n.friend.id}:${Date.now()}`, n.line)   // 預設關
  if (n.shake) void invoke('shake', { id: n.friend.id, main: ui.mode === 'merged' })   // 整合模式抖整個主視窗
  if (plan.toast) void invoke('show_toast', { toast: { cid: n.friend.id, title: plain(n.friend.nick), line: n.line, status: n.friend.status, hue: n.friend.hue, dp: n.friend.dp, av: (a => (a.kind === 'upload' ? a.src : null))(avatarFor(n.friend, { avatars: avatars.value })) } })
})

// 打開一個群組的對話（整合模式開分頁、分開模式開視窗），並讀它的新訊息與確認卡片
async function openRoomChat(id) {
  const rid = roomIdOf(id)
  const f = roomFriends.value.find(x => x.id === id)
  if (!f) return
  openedRooms.add(id)
  if (ui.mode === 'merged') {
    Object.assign(ui, openChatTab(ui, id, ui.pinnedChat))
    pushLog(id)
    await invoke('show_main')
    sync()
  } else {
    await invoke('open_chat', { id, title: `${plain(f.nick)} - 對話` })
    sync(); pushLog(id)
  }
  await hub.open(rid)
  pushLog(id); sync()
}
// 對話上方「⋯」：邀請別人加入、成員與設定（開在名單視窗；分開模式的對話視窗也是請名單視窗代開）
async function openGroupMenu(chatId, what) {
  await invoke('show_main').catch(() => {})
  if (isRoomChat(chatId)) {
    const rid = roomIdOf(chatId), r = hub.raw(rid)
    if (what === 'manage') groupFlow.openManage(rid)
    else if (what === 'addai') groupFlow.openManage(rid, { focusAdd: true })
    else groupFlow.openInvite({ type: 'room', roomId: rid, name: String(r?.name ?? '') })
    return
  }
  const f = friends.value.find(x => x.id === chatId)
  if (f) groupFlow.openInvite({ type: 'friend', friend: f })
}
async function decideCard(chatId, cardId, approve) {
  await hub.decide(roomIdOf(chatId), cardId, approve)
  pushLog(chatId)
}
const groupFlow = createGroupFlow({
  api: groupApi, copy: copyText, reactive,
  openRoom: rid => void openChat(`room:${rid}`),
  refreshRooms: () => refreshRooms(),
  getFriends: () => friends.value,
  getRoom: rid => hub.raw(rid),
  logOf: f => core.viewOf(f.id),
})
// 邀請連結一鍵開啟（asn://invite/<碼>）：Rust 端收到後通知；啟動前就收到的用 invite_pending 補取
const onInviteCode = code => { if (typeof code === 'string' && code) { void invoke('show_main').catch(() => {}); groupFlow.openJoin(code) } }
await listen('asn:invite', onInviteCode)
void invoke('invite_pending').then(onInviteCode).catch(() => {})

async function openChat(id) {
  if (isRoomChat(id)) return openRoomChat(id)
  if (String(id).startsWith('pending:')) return
  const f = core.friends.get(id); if (!f) return
  core.markRead(id)
  void core.syncHistory(id)   // 打開對話：向後台補這位夥伴的往來（以後台為準；失敗就用本機快取）
  if (ui.mode === 'merged') {   // 整合模式：在右邊開分頁（或切過去），不開新視窗
    Object.assign(ui, openChatTab(ui, id, ui.pinnedChat))
    pushLog(id)
    await invoke('show_main')
    sync()
    return
  }
  await invoke('open_chat', { id, title: `${plain(f.nick)} - 對話` })
  sync(); pushLog(id)
}

// 指引、設定的聊天窗（跟 openChat 同一套）：整合模式＝右邊開（或換內容並切到）那個分頁；分離模式＝開（或叫出）那扇視窗並換內容
async function openPanel(kind, key) {
  if (!panelItem(kind, key)) return
  if (kind === 'setting') key = normalizeCatKey(key)   // 舊的 accounts 併進 devices
  ui.panel[kind] = key
  if (ui.mode === 'merged') {
    Object.assign(ui, openChatTab(ui, panelTabId(kind), ui.pinnedChat))
    await invoke('show_main')
    sync()
    return
  }
  const { w, h } = sizes[kind]
  await invoke('open_panel', { kind, title: panelTitle(kind, key), w, h })
  emit('asn:panel', { kind, key })
}
async function closePanel(kind) {
  if (ui.mode === 'merged') { Object.assign(ui, closeChatTab(ui, panelTabId(kind))); sync() }
  else await invoke('close_panels', { kind })
}

// 對話視窗的指令
await listen('asn:cmd', async c => {
  if (c.op === 'hello') { sync(); emit('asn:avatars', avatars.value); pushLog(c.id); core.markRead(c.id) }
  else if (c.op === 'read') core.markRead(c.id)
  else if (c.op === 'dp') ui.collapsed = toggleCollapsed(ui.collapsed)
  else if (c.op === 'send') {
    if (isRoomChat(c.id)) { await hub.post(roomIdOf(c.id), c.text, { replySeq: c.replySeq }); pushLog(c.id) }
    else { const r = await core.send(c.id, c.text, { voice: c.voice === true }); if (!r.ok) console.info('[ASN] send failed', r.error) }
  }
  else if (c.op === 'group-menu') await openGroupMenu(c.id, c.what)
  else if (c.op === 'group-decide') await decideCard(c.id, c.cardId, c.approve === true)
  else if (c.op === 'nudge') { if (!isRoomChat(c.id)) await core.nudge(c.id) }
  else if (c.op === 'attach') await sendAttachTo(c.id, c.photo, c.caption)
  else if (c.op === 'older') { const r = isRoomChat(c.id) ? { more: false, added: 0 } : await core.loadOlder(c.id); emit('asn:older', { id: c.id, ...r }) }
})
const sendTo = async (id, text, opts) => { const r = await core.send(id, text, opts); if (!r.ok) console.info('[ASN] send failed', r.error) }
// 對話窗的送出：群組走群組發言（本人簽章），其餘照舊寄信給夥伴
const sendMsg = async (id, text, opts) => {
  if (isRoomChat(id)) { await hub.post(roomIdOf(id), text, { replySeq: opts?.replySeq }); pushLog(id); return }
  await sendTo(id, text, opts)
}
const nudgeTo = id => (isRoomChat(id) ? undefined : core.nudge(id))
const sendAttachTo = async (id, item, caption) => { if (isRoomChat(id)) { await hub.postAttachment(roomIdOf(id), item, caption); pushLog(id); return } const r = await core.sendAttachment(id, item, caption); if (!r.ok) console.info('[ASN] attachment failed', r.error) }
const activateTab = id => { ui.active = id; core.markRead(id); sync() }   // 指引、設定的分頁 id 不是好友，markRead 會直接略過
const closeOneChatTab = id => { Object.assign(ui, closeChatTab(ui, id)); if (ui.active) core.markRead(ui.active); sync() }
const applyChatTabClose = patch => { Object.assign(ui, patch); if (ui.active) core.markRead(ui.active); sync() }
const toggleDp = () => { ui.collapsed = toggleCollapsed(ui.collapsed) }

// 切換視窗模式：已開的對話接得上（分開→整合：對話視窗關掉變分頁；整合→分開：分頁開成視窗）
async function setMode(to) {
  to = normalizeMode(to)
  const from = ui.mode
  if (to === from || switching) return
  switching = true
  try {
    sizes[from] = normalizeSize(winSize(), from)
    const closed = from === 'split' ? await invoke('close_chats') : []
    const closedPanels = from === 'split' ? (await invoke('close_panels')).filter(k => PANEL_KINDS.includes(k)) : []   // 開著的指引、設定視窗
    // 指引、設定也跟著轉：分離→整合＝視窗變分頁；整合→分開＝分頁開成視窗。好友的對話照舊交給 switchMode
    const { chats: chatTabs, panels: panelTabs } = splitTabs(ui.tabs)
    const plan = switchMode(from, to, { tabs: chatTabs, active: isPanelTab(ui.active) ? '' : ui.active, windowIds: closed })
    ui.mode = to
    ui.tabs = orderTabs([...plan.tabs, ...closedPanels.map(panelTabId)], ui.pinnedChat); ui.active = plan.active || ui.tabs.at(-1) || ''
    await invoke('main_layout', { merged: to === 'merged', w: sizes[to].w, h: sizes[to].h, recenter: false })
    if (ui.active) core.markRead(ui.active)
    for (const id of plan.openWindows) await openChat(id)
    if (to === 'split') for (const kind of panelTabs) await openPanel(kind, ui.panel[kind])
    for (const id of plan.tabs) pushLog(id)
    sync()
  } finally { switching = false }
}
// 視窗大小記住：每種模式各記各的（拖到邊界 resize 事件很多，停下來才存）
let sizeTimer = null
window.addEventListener('resize', () => {
  clearTimeout(sizeTimer)
  sizeTimer = setTimeout(() => { if (!switching) sizes[ui.mode] = normalizeSize(winSize(), ui.mode) }, 400)
})
if (ui.mode === 'merged') await invoke('main_layout', { merged: true, w: sizes.merged.w, h: sizes.merged.h, recenter: true })

await listen('relay-bell', () => { void core.pull('bell'); core.refreshRosterSoon(); void refreshRooms() })   // Rust 端的 Realtime 門鈴：收信，也立刻重拉名單（別台設備的忙碌／閒置變了也是敲這個鈴）
window.addEventListener('focus', () => core.refreshRosterSoon())   // 回到前景立刻更新名單
await listen('asn:open', c => void openChat(c.cid))   // 提示被點了

watch([me, showNowPlaying, notifyPrefs, frame, closeTo, autoAddClaude, autoCheck, dims, () => ui.mode, () => ui.dpMode, () => ui.bubble, () => ui.toolbar, () => ui.collapsed, () => ui.pinnedChat, sizes, () => ui.tabs, () => ui.active, () => ui.panel, () => sess.wins, () => sess.panelWins, () => sess.ready], () => { sync(); saveMe() }, { deep: true })
const saveMe = trailingThrottle(() => { const { nick, ...rest } = me; void meStore.save({ me: rest, showNowPlaying: showNowPlaying.value, notify: notifyPrefs.value, frame: frame.value, closeTo: closeTo.value, autoAddClaude: autoAddClaude.value, autoUpdate: autoCheck.value, tabDim: dims.tabDim, groupDim: dims.groupDim, winMode: ui.mode, dpMode: ui.dpMode, bubble: ui.bubble, toolbar: ui.toolbar, dpCollapsed: ui.collapsed, pinnedChat: ui.pinnedChat, splitSize: sizes.split, mergedSize: sizes.merged, guideSize: sizes.guide, settingSize: sizes.setting, session: sess.ready ? currentSession() : sess.saved }) }, 600)
addEventListener('pagehide', () => saveMe.flush())
// 系統匣圖示的提示文字帶未讀總數
watch(() => totalUnread(friends.value), n => { void invoke('set_tray_unread', { n }).catch(() => {}) }, { immediate: true })
// 在線狀態：狀態下拉與個人訊息交給 Rust 端回報（每 60 秒一次，改了立刻送；後台沒部署就靜默不送）
watch(() => [me.status, me.psm], () => { void invoke('set_presence', { status: me.status, psm: me.psm ?? '' }).catch(() => {}) }, { immediate: true })
// 正在聽的歌：開關交給 Rust 端（關著不讀不送）；歌變了 Rust 端推 asn:now-playing，自己的名單頭顯示
await listen('asn:now-playing', ev => { nowPlaying.value = showNowPlaying.value ? String(ev.payload ?? '') : '' })
watch(showNowPlaying, on => {
  if (!on) nowPlaying.value = ''
  void invoke('set_now_playing', { on }).then(t => { nowPlaying.value = on ? String(t ?? '') : '' }).catch(() => {})
}, { immediate: true })
// 設定頁改「分頁依」：分組若撞到自動換成剩下兩個裡的第一個
const setTabDim = v => Object.assign(dims, withTabDim(dims, v))
const pages = computed(() => pageTabs(friends.value, dims.tabDim, { selfNode: info.node, selfName: info.window_name, nodeOrder: nodeOrder.value }))

// 起始頁籤：平常是設備維度的本機；--shot 可用設定檔的 shotTab 指定固定頁籤（已拿掉的「通知」或任何不認得的值都忽略）
const startTab = info.shot ? normalizeTab(savedMe.shotTab) : ''
const shotTab = ref(startTab || (dims.tabDim === 'device' ? info.node : ''))
const adI = ref(0)   // 底部小廣告與「開始」頁大幅廣告共用同一個目前位置
// 廣告：預設是打包備用（ADS）；啟動時與每 6 小時由 Rust 的 ads_fetch 從官網抓一次（--shot 模式不抓），抓不到（回空）就維持現況。內容一律當純文字顯示
const ads = ref(ADS)
const pageFail = reactive({})   // key → true：這則的網頁載入失敗或逾時，改用樣板
const refreshAds = async () => {
  if (info.shot) return
  try {
    const next = pickAds(await invoke('ads_fetch'), null)
    if (next) { ads.value = next; for (const k of Object.keys(pageFail)) delete pageFail[k]; if (adI.value >= next.length) adI.value = 0 }
  } catch { /* 抓不到就沿用目前的 */ }
}
void refreshAds()
setInterval(() => void refreshAds(), 6 * 3600_000)
const app = createApp({
  setup() {
    const tab = shotTab, moreOpen = ref(false)
    let adTimer = null
    const startAds = () => { clearInterval(adTimer); adTimer = setInterval(() => { adI.value = nextAd(adI.value, ads.value.length) }, AD_MS) }
    // --shot 模式可用設定檔的 shotAd 固定停在某一則廣告（截圖用）；平常照常輪播
    if (info.shot && Number.isInteger(savedMe.shotAd)) adI.value = savedMe.shotAd
    else startAds()
    // 大幅廣告的左右鍵與小圓點：換了就重新計時，不會剛點完又被自動換掉
    const stepAd = d => { adI.value = d < 0 ? prevAd(adI.value, ads.value.length) : nextAd(adI.value, ads.value.length); if (!info.shot) startAds() }
    const jumpAd = i => { adI.value = goAd(i, ads.value.length); if (!info.shot) startAds() }
    setInterval(() => void refreshRooms(), 60_000)
    void refreshRooms()
    const query = ref(''), nickErr = ref('')
    const collapsed = reactive({ [ARCHIVE_GROUP_KEY]: true })   // 「已封存」群組預設收合
    const dev = pages
    const isDevice = computed(() => !FIXED_TABS.some(t => t.key === tab.value))   // 名單頁（設備／廠商／狀態的頁籤）；其餘是群組、指引、設定
    const moreOn = computed(() => dev.value.more.some(d => d.key === tab.value))
    const moreUnreadN = computed(() => moreUnread(dev.value.more))
    // 選到的頁籤不在現在的清單（改了維度、設備消失…）時退回第一個（設備維度的第一個就是本機）
    watch(dev, d => { if (!normalizeTab(tab.value, d.all.map(x => x.key))) tab.value = d.all[0]?.key ?? '' }, { immediate: true })
    const shown = computed(() => {
      if (!isDevice.value) return []
      const o = { tabDim: dims.tabDim, tabKey: tab.value, groupDim: dims.groupDim, selfNode: info.node, selfName: info.window_name, query: query.value, plainText: plain }
      const base = rosterShownGroups(activeFriends(friends.value), o)
      // 已封存的不放進名單，另成最底下一個預設收合的「已封存（N）」群組（同一個分頁與搜尋字）
      const archived = rosterShownGroups(archivedFriends(friends.value), o).flatMap(g => g.items)
      return withArchivedGroup(injectPendingGroups(base, launchPending.value.filter(p => !tab.value || p.node === tab.value)), archived)
    })
    const emptyText = computed(() => (normalizeSearchQuery(query.value) ? '沒有符合的聯絡人。' : conn.value !== 'on' ? '還沒連上收發室。' : '這一頁目前沒有視窗。'))
    const openAd = a => openAdWith(a, url => void invoke('open_url', { url }))
    // 改最上面的暱稱＝改對外名字；Rust 端驗證，不合法就還原並提示
    const commitNick = async () => {
      const want = String(me.nick ?? '').trim()
      if (want === info.window_name) { me.nick = info.window_name; nickErr.value = ''; return }
      try { applyRename({ info, core, me }, await invoke('set_window_name', { name: want })); nickErr.value = '' }
      catch (e) { me.nick = info.window_name; nickErr.value = e.message; setTimeout(() => { nickErr.value = '' }, 5000) }
    }
    // 設定頁「大頭貼」：選圖 → 前端裁成正方形縮成 96×96（webp／png，≤ 32 KB）→ 上傳；也可以移除改回自動產生
    const avBusy = ref(false), avMsg = ref(''), avFile = ref(null)
    const selfHasUpload = computed(() => isAvatarDataUrl(avatars.value[info.node]))
    const say = t => { avMsg.value = t; setTimeout(() => { if (avMsg.value === t) avMsg.value = '' }, 6000) }
    const avMenu = ref(false)
    const avApi = { toDataUrl: avatarFromFile, setAvatar: v => core.setSelfAvatar(v) }
    async function pickAvatar(ev) {
      const file = ev.target.files?.[0]; ev.target.value = ''
      if (!file) return
      avBusy.value = true
      try { say((await uploadAvatarFile(file, avApi)).message) } finally { avBusy.value = false }
    }
    async function removeAvatar() {
      avBusy.value = true
      try { say((await removeAvatarUpload(avApi)).message); lastSyncedAvatar = ''; void authApi.setLastAvatar(null).catch(() => {}) } finally { avBusy.value = false }
    }
    // 設定頁改「視窗外框」：Rust 端立刻改所有視窗的外框並通知各視窗的頁面換樣式
    const setFrame = async v => {
      frame.value = normalizeFrame(v)
      try { await invoke('set_frame', { native: frame.value === 'native' }) } catch (e) { say(e.message) }
    }
    // 設定頁改「關閉視窗時」「登入時自動啟動」：立刻通知 Rust 端
    const setCloseTo = async v => {
      closeTo.value = normalizeClose(v)
      try { await invoke('set_close_to_tray', { tray: closeTo.value === 'tray' }) } catch (e) { say(e.message) }
    }
    const setAutostart = async on => {
      autostart.busy = true
      try { await invoke('autostart_set', { on }); autostart.on = on } catch (e) { say(String(e?.message ?? e)); autostart.on = await invoke('autostart_get').catch(() => autostart.on) } finally { autostart.busy = false }
    }
    // 設定頁「讓 ASN 負責這台的收發室」與「改由 ASN 負責」（停舊版收發室橋，要再按一次確認）
    const runBridge = async fn => {
      bridge.busy = true
      try { applyBridgeStatus(await fn()) } catch (e) { bridge.error = String(e?.message ?? e); say(bridge.error) } finally { bridge.busy = false; bridge.confirm = false }
    }
    const setBridgeRemoteLaunch = on => runBridge(() => invoke('bridge_set_remote_launch', { on }))
    const setBridgeUnaddressed = name => runBridge(() => invoke('bridge_set_unaddressed_to', { name: String(name ?? '') }))
    const takeoverBridge = () => runBridge(() => invoke('bridge_takeover', { confirmed: true }))
    // 指引、設定的聊天窗（openPanel／closePanel 在上面）：列表只負責「點一項就開」，內容在右邊分頁或獨立視窗
    const panelGuide = computed(() => panelItem('guide', ui.panel.guide))
    const catSub = key => catSummary(key, {
      devices: deviceTree.value,
      hasUpload: selfHasUpload.value, nowPlayingOn: showNowPlaying.value, accountCount: accounts.state.list.length, accountCurrent: accounts.state.current?.email ?? '',
      frame: frame.value, mode: ui.mode, dpMode: ui.dpMode, toolbar: ui.toolbar, bubble: ui.bubble, tabDim: dims.tabDim, groupDim: dims.groupDim,
      notify: notifyPrefs.value, voiceEnabled: ttsVoices.value.enabled, ttsAuto: voiceCfg.tts_auto, sttLang: voiceCfg.stt_lang,
      closeTo: closeTo.value, trayOk: trayOk.value, autostartSupported: autostart.supported, autostartOn: autostart.on,
      maxPerHour: launchPrefs.maxPerHour, cwdCount: launchCwdText.value.split('\n').filter(x => x.trim()).length, autoCheck: autoCheck.value, version: info.version,
    })
    const view = computed(() => (ui.tabs.length ? 'chat' : 'home'))
    // 大幅廣告的網頁（iframe）：--shot 不載入；載入失敗或 5 秒內沒載入完就退回樣板（load 事件才算成功）
    const pageSrc = a => (info.shot || pageFail[a.key] ? '' : adPageUrl(a))
    const pageLoaded = reactive({})
    let pageTimer = null
    watch([adI, ads, view], () => {
      clearTimeout(pageTimer)
      const a = ads.value[adI.value]
      if (view.value !== 'home' || !a || !pageSrc(a)) return
      pageLoaded[a.key] = false
      pageTimer = setTimeout(() => { if (!pageLoaded[a.key]) pageFail[a.key] = true }, AD_PAGE_MS)
    }, { immediate: true })
    const pageDone = a => { pageLoaded[a.key] = true }
    const pageBroken = a => { pageFail[a.key] = true }
    // 分頁列：好友的對話分頁，加上「指引：…」「設定：…」兩種面板分頁（各最多一個）
    const tabItems = computed(() => ui.tabs.map(id => (isPanelTab(id) ? panelTabItem(id.slice(1), ui.panel[id.slice(1)]) : tabFriend(id))).filter(Boolean))
    const mergedTabs = computed(() => tabItems.value.filter(t => !t.panel))   // 只有好友的對話才有對話窗
    const chatTabMenu = ref('')
    const chatTabMenuPin = computed(() => (chatTabMenu.value ? isPinned(chatTabMenu.value, ui.pinnedChat) : false))
    const closeChatTabMenu = () => { chatTabMenu.value = '' }
    const chatTabMenuPos = reactive({ x: 0, y: 0 })   // 選單出現在滑鼠位置（position:fixed），不受分頁列裁切
    const openChatTabMenu = (id, e) => { chatTabMenuPos.x = e?.clientX ?? 0; chatTabMenuPos.y = e?.clientY ?? 0; chatTabMenu.value = id }
    // 按選單以外任何地方（含拖曳區、別的元件攔掉 click 的地方、右鍵）、按 Esc、視窗失焦都收起選單。
    // 用 pointerdown 捕獲階段：不靠 click 冒泡到 #app（有些區域會 stopPropagation 或是拖曳區不送 click）。
    document.addEventListener('pointerdown', e => {
      const el = e.target instanceof Element ? e.target : null
      if (chatTabMenu.value && !el?.closest('.ctab-menu')) closeChatTabMenu()
      if (buddyMenu.value && !el?.closest('.buddy-menu')) closeBuddyMenu()
      if (launchPicker.value && !el?.closest('.launch-picker') && !el?.closest('.search-ic')) closeLaunchPicker()
      if (deviceMenu.value && !el?.closest('.device-menu')) closeDeviceMenu()
    }, true)
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && chatTabMenu.value) closeChatTabMenu() })
    // Esc：先收二級選單，再按一次才關主選單
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !buddyMenu.value) return
      const r = submenuNext({ open: buddyModel.open }, 'escape')
      if (r.consumed) buddyModel.open = false
      else closeBuddyMenu()
      e.preventDefault(); e.stopPropagation()
    }, true)
    window.addEventListener('blur', () => { if (chatTabMenu.value) closeChatTabMenu(); if (buddyMenu.value) closeBuddyMenu(); if (launchPicker.value) closeLaunchPicker(); if (deviceMenu.value) closeDeviceMenu() })
    const tabPinLabel = computed(() => (chatTabMenuPin.value ? '取消固定分頁' : '固定分頁'))
    const runTabMenu = fn => { const id = chatTabMenu.value; closeChatTabMenu(); if (id) fn(id) }
    const menuCloseTab = () => runTabMenu(id => applyChatTabClose(closeChatTab(ui, id)))
    const menuCloseOther = () => runTabMenu(id => applyChatTabClose(closeOtherChatTabs(ui, id, ui.pinnedChat)))
    const menuCloseRight = () => runTabMenu(id => applyChatTabClose(closeRightChatTabs(ui, id, ui.pinnedChat)))
    const menuCloseAll = () => { closeChatTabMenu(); applyChatTabClose(closeAllChatTabs(ui, ui.pinnedChat)) }
    const tabFriendOf = id => withCallState(tabFriend(id), mergedCalls[id] || callBeats.isCalling(id))   // 通話中的分頁算忙碌，關閉閒置不關
    const hasIdleTabs = computed(() => callTick.value >= 0 && idleTabIds(ui.tabs, ui.pinnedChat, tabFriendOf).length > 0)
    const menuCloseIdle = () => { closeChatTabMenu(); applyChatTabClose(closeIdleChatTabs(ui, ui.pinnedChat, tabFriendOf)) }
    const menuTogglePin = () => runTabMenu(id => { const r = toggleChatPin(ui, id, ui.pinnedChat); ui.pinnedChat = r.pinned; ui.tabs = r.tabs })
    const chatTabMenuPanel = computed(() => isPanelTab(chatTabMenu.value))   // 指引、設定的分頁不能固定，選單不給「固定分頁」
    const isChatTabPinned = id => isPinned(id, ui.pinnedChat)
    const tabDragId = ref('')
    const tabDrop = reactive({ over: '', after: false })   // 拖到哪個分頁上、左半還是右半（右半＝插在它後面，才放得到最後一個）
    const clearTabDrag = () => { tabDragId.value = ''; tabDrop.over = ''; tabDrop.after = false }
    const onTabDragStart = (id, e) => {
      tabDragId.value = id
      tabDrop.over = ''
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', id)
    }
    const onTabDragEnd = () => clearTabDrag()
    const onTabDragOver = (beforeId, e) => {
      const dragId = tabDragId.value
      if (!dragId || dragId === beforeId) return
      if (!chatTabSameZone(dragId, beforeId, ui.pinnedChat)) {
        e.dataTransfer.dropEffect = 'none'
        return
      }
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const r = e.currentTarget.getBoundingClientRect()
      tabDrop.over = beforeId
      tabDrop.after = e.clientX > r.left + r.width / 2
    }
    const onTabDrop = (beforeId, e) => {
      e.preventDefault()
      const dragId = tabDragId.value || e.dataTransfer.getData('text/plain')
      if (!dragId || dragId === beforeId || !chatTabSameZone(dragId, beforeId, ui.pinnedChat)) {
        clearTabDrag()
        return
      }
      const r = moveChatTab(ui.tabs, ui.pinnedChat, dragId, dropInsertBefore(ui.tabs, ui.pinnedChat, beforeId, tabDrop.over === beforeId && tabDrop.after))
      ui.pinnedChat = r.pinned
      ui.tabs = r.tabs
      clearTabDrag()
    }
    const tabDragClass = id => ({
      'tab-dragging': tabDragId.value === id,
      'tab-drop-before': tabDrop.over === id && !tabDrop.after,
      'tab-drop-after': tabDrop.over === id && tabDrop.after,
    })
    // 設定頁「語音」：改了就寫回 Rust 端（驗證在那裡；失敗就還原成存檔的值並提示）
    const ttsVoices = ref({ enabled: true, voices: [], default: '' }), sttSt = ref(null), voiceMsg = ref('')
    const sttText = computed(() => sttStatusText(sttSt.value))
    const refreshVoice = async () => {
      try { ttsVoices.value = await invoke('tts_voices') } catch (e) { voiceMsg.value = e.message }
      try { sttSt.value = await invoke('stt_status') } catch { /* 取不到就不顯示 */ }
    }
    void refreshVoice()
    const saveVoice = async patch => {
      const next = normalizeCfg({ ...voiceCfg, ...patch })
      try { await invoke('voice_cfg_set', { cfg: next }); Object.assign(voiceCfg, next); voiceMsg.value = ''; void refreshVoice() }
      catch (e) { voiceMsg.value = e.message }
    }
    // 設定頁「帳號」（檔案操作全在 Rust 端）：Claude 帳號庫、Codex 目前登入、遠端設備的 Claude 帳號切換
    const accounts = createAccountsUi({
      invoke, reactive,
      devices: () => launchDeviceRowsList.value.filter(d => d.key !== info.node && asnMap.value[d.key]),
      nodeLabel: n => launchDeviceRowsList.value.find(d => d.key === n)?.label ?? n,
    })
    void accounts.refresh()
    // 設定頁「用量」：打開那一頁才讀本機記錄（Rust 端有快取，不會每次重掃）
    const usage = createUsageUi({ invoke, reactive })
    void accounts.loadTrust()
    // 本機帳號庫清單定期回報給收發室（只有 email、方案、使用中）；別台送來的切換指令定期取走（預設要本機按確認才切）。--shot 不輪詢指令。
    setTimeout(() => void accounts.report(), 5_000)
    setInterval(() => void accounts.report(), 5 * 60_000)
    void listen('claude-mod-status', e => { accounts.state.mod = String(e.payload ?? '') })   // Rust 背景安裝 Claude 外掛完成
    void listen('claude-account-auto', e => void accounts.onAuto(e.payload))   // Rust 背景工作自動加入／回存之後
    if (!info.shot) {
      setInterval(() => void accounts.pollIncoming(), 15_000)
      void listen('relay-bell', () => void accounts.pollIncoming())
    }
    // 有人要求切換這台的帳號：把視窗叫到前面，讓使用者看得到確認框
    watch(() => accounts.state.incoming.length, n => { if (n) void invoke('show_main').catch(() => {}) })
    // 名單設備標題右鍵：切換那台設備的 Claude 帳號
    const deviceMenu = ref('')
    const deviceMenuPos = reactive({ x: 0, y: 0 })
    const deviceAcct = reactive({ node: '', label: '', selected: '' })   // 右鍵「切換這台的 Claude 帳號」的專屬對話框
    const openDeviceMenu = (g, e) => {
      if (g.kind !== 'device' || g.node === info.node || !asnMap.value[g.node]) return
      closeBuddyMenu(); closeLaunchPicker()
      deviceMenuPos.x = e?.clientX ?? 0; deviceMenuPos.y = e?.clientY ?? 0
      deviceMenu.value = g.node
    }
    const closeDeviceMenu = () => { deviceMenu.value = '' }
    // 打開「切換這台的 Claude 帳號」專屬對話框（名單右鍵與設定的「設備」分類共用）
    const openDeviceAcct = async (node, email = '') => {
      if (!node) return
      deviceAcct.node = node; deviceAcct.label = deviceTree.value.find(d => d.key === node)?.label ?? accounts.remoteNodes().find(d => d.key === node)?.label ?? ''; deviceAcct.selected = email   // 設備頁籤上點某個帳號的「切換」＝預先選好那個帳號，仍要在對話框按送出
      void invoke('show_main').catch(() => {})
      await accounts.remoteSelect(node)
    }
    const deviceMenuSwitch = async () => {
      const node = deviceMenu.value
      closeDeviceMenu()
      await openDeviceAcct(node)
    }
    // 設定「設備」分類：設備 → 廠商 → 帳號。其他設備的帳號回報在有新設備出現時讀一次，也可按「重新整理」
    const deviceTree = computed(() => buildDeviceTree({
      friends: friends.value, nodeOrder: nodeOrder.value, selfNode: info.node, asn: asnMap.value, launchers: {
        ...remoteLaunchers.value,
        [info.node]: { profiles: partnerModels.value.filter(m => m.installed).map(m => ({ id: m.profileId ?? m.id })) },
      },
      reports: accounts.state.reports,
      self: { claude: accounts.state.list, codex: { loggedIn: Boolean(accounts.state.codex), text: codexLine(accounts.state.codex, accounts.state.codexErr) } },
    }))
    const otherDeviceNodes = () => launchDeviceRowsList.value.map(d => d.key).filter(k => k && k !== info.node).slice(0, 20)
    const refreshDeviceReports = () => accounts.loadReports(otherDeviceNodes())
    watch(() => otherDeviceNodes().join(','), () => {
      const missing = otherDeviceNodes().filter(k => !accounts.state.reports[k])
      if (missing.length) void accounts.loadReports(missing)
    }, { immediate: true })
    const closeDeviceAcct = () => { deviceAcct.node = '' }
    const deviceAcctView = computed(() => deviceAcctViewOf(accounts.state.remote, deviceAcct.selected))
    const deviceAcctTitleText = computed(() => deviceAcctTitle(deviceAcct.label))
    const deviceAcctSubmit = () => { const v = deviceAcctView.value; if (v.canSwitch) void accounts.remoteSwitch(v.switchEmail) }
    const installFromSettings = async () => {
      voiceMsg.value = '正在下載…'
      await voice.installStt()
      voiceMsg.value = voice.state.note
      void refreshVoice()
    }
    // ---------- 設定聊天窗的狀態快照與指令 ----------
    // 設定的狀態與動作都留在這裡（名單視窗的樞紐）。整合模式的分頁直接讀這份快照；分離模式的設定視窗用 asn:settings 事件收同一份，
    // 改了什麼用 asn:set 事件送回來，一律進同一個 applySetting。金鑰、存檔、Rust 指令都不離開這個視窗。
    const settingsState = computed(() => ({
      nowPlaying: { on: showNowPlaying.value, current: nowPlaying.value },
      status: me.status, hasUpload: selfHasUpload.value, avBusy: avBusy.value, avMsg: avMsg.value,
      notify: notifyPrefs.value, frame: frame.value, mode: ui.mode, dpMode: ui.dpMode, toolbar: ui.toolbar, bubble: ui.bubble,
      tabDim: dims.tabDim, groupDim: dims.groupDim,
      voice: { cfg: { tts_voice: voiceCfg.tts_voice, tts_auto: voiceCfg.tts_auto, stt_lang: voiceCfg.stt_lang, stt_model: voiceCfg.stt_model }, enabled: ttsVoices.value.enabled, voices: ttsVoices.value.voices, sttReady: Boolean(sttSt.value?.ready), installBusy: voice.state.install.busy, note: voice.state.install.text || voiceMsg.value || sttText.value },
      devices: deviceTree.value,
      accounts: {
        list: accounts.state.list, current: accounts.state.current, codexLine: codexLine(accounts.state.codex, accounts.state.codexErr),
        busy: accounts.state.busy, confirmDel: accounts.state.confirmDel, msg: accounts.state.msg, trustOwn: accounts.state.trustOwn, autoAdd: autoAddClaude.value, autoNote: accounts.state.autoNote,
        remote: { node: accounts.state.remote.node, devices: accounts.remoteNodes(), list: accounts.state.remote.list, loading: accounts.state.remote.loading, busy: accounts.state.remote.busy, msg: accounts.state.remote.msg },
      },
      closeTo: closeTo.value, trayOk: trayOk.value, autostart: { supported: autostart.supported, on: autostart.on, busy: autostart.busy, blocked: autostart.blocked },
      bridge: bridge.shown ? { enabled: bridge.enabled, running: bridge.running, legacy: bridge.legacy, takeoverAllowed: bridge.takeoverAllowed, remoteLaunch: bridge.remoteLaunch, unaddressedTo: bridge.unaddressedTo, error: bridge.error, busy: bridge.busy, confirm: bridge.confirm } : null,
      askpass: askpassInfo.shown ? { path: askpassInfo.path, example: askpassInfo.example, copied: askpassInfo.copied } : null,
      autoCheck: autoCheck.value, upd: { checking: upd.checking, installing: upd.phase === 'installing', manual: upd.manual, status: updateStatus({ checking: upd.checking, phase: upd.phase, info: upd.info, lastCheck: upd.lastCheck, error: upd.checkErr, current: info.version }) },
      usage: { loading: usage.state.loading, error: usage.state.error, data: usage.state.data, updated: usage.state.updated },
      launch: { tools: launchToolRows.value, maxPerHour: launchPrefs.maxPerHour, cwdText: launchCwdText.value },
      version: info.version,
      log: buildLogView({ entries: changelogEntries.value, current: info.version, available: upd.phase === 'idle' ? null : upd.info }),
    }))
    const applySetting = async (op, value) => {
      switch (op) {
        case 'notify': notifyPrefs.value = notifyWith(notifyPrefs.value, value?.key, value?.on); break
        case 'now-playing': showNowPlaying.value = value === true; break
        case 'frame': await setFrame(value); break
        case 'mode': await setMode(value); break
        case 'dpMode': ui.dpMode = normalizeDpMode(value); break
        case 'toolbar': ui.toolbar = TOOLBARS.includes(value) ? value : ui.toolbar; break
        case 'bubble': ui.bubble = normalizeBubble(value); break
        case 'tabDim': setTabDim(value); break
        case 'groupDim': dims.groupDim = value; break
        case 'voice-save': await saveVoice(value); break
        case 'voice-install': await installFromSettings(); break
        case 'acct-switch': await accounts.switchTo(value); break
        case 'acct-remove': await accounts.remove(value); break
        case 'acct-trust': await accounts.setTrust(value === true); break
        case 'devices-refresh': await refreshDeviceReports(); break
        case 'device-switch': await (typeof value === 'object' && value ? openDeviceAcct(String(value.node ?? ''), String(value.email ?? '')) : openDeviceAcct(String(value ?? ''))); break
        case 'closeTo': await setCloseTo(value); break
        case 'autostart': await setAutostart(value === true); break
        case 'bridge-launch': await setBridgeRemoteLaunch(value === true); break
        case 'bridge-unaddressed': await setBridgeUnaddressed(value); break
        case 'bridge-takeover': bridge.confirm = true; break
        case 'bridge-takeover-yes': await takeoverBridge(); break
        case 'bridge-takeover-no': bridge.confirm = false; break
        case 'askpass-copy': await copyAskpassPath(); break
        case 'autoCheck': autoCheck.value = value === true; break
        case 'check-update': await checkUpdate(true); break
        case 'usage-refresh': await usage.refresh(); break
        case 'launch-max': launchPrefs.maxPerHour = Number.isFinite(value) ? value : 6; await saveLaunchPrefs(); break
        case 'launch-cwd': setLaunchCwdText(String(value ?? '')); break
        case 'avatar-remove': await removeAvatar(); break
        case 'avatar-upload': avBusy.value = true; try { say((await uploadAvatarFile(value, { toDataUrl: async u => u, setAvatar: v => core.setSelfAvatar(v) })).message) } finally { avBusy.value = false } break   // 分離視窗已在自己那邊裁好圖，送來的是 data URL
        default: break
      }
    }
    // 分離模式的指引、設定視窗：開起來先問一聲（hello），樞紐回目前要顯示哪一篇與設定快照；之後設定一變就推新快照
    watch(() => ui.panel.setting, k => { if (k === 'usage') void usage.refresh() }, { immediate: true })
    const pushSettings = () => { if (ui.mode === 'split') emit('asn:settings', settingsState.value) }
    watch(settingsState, pushSettings, { deep: true })
    void listen('asn:cmd', c => {
      if (c.op !== 'panel-hello' || !PANEL_KINDS.includes(c.kind)) return
      sync()   // 設定視窗的大頭貼要用 asn:state 裡的自己的節點與視窗名
      emit('asn:panel', { kind: c.kind, key: ui.panel[c.kind] })
      if (c.kind === 'setting') pushSettings()
      emit('asn:avatars', avatars.value)
    })
    void listen('asn:set', c => {
      if (c.op === 'panel-size') { if (PANEL_KINDS.includes(c.kind)) sizes[c.kind] = normalizePanelSize({ w: c.w, h: c.h }) }
      else void applySetting(c.op, c.value)
    })
    const pickAvatarFile = file => applySetting('avatar-upload', file)
    return {
      version: info.version, accounts, accountLine, deviceMenu, deviceMenuPos, openDeviceMenu, closeDeviceMenu, deviceMenuSwitch, deviceAcct, deviceAcctView, deviceAcctTitleText, closeDeviceAcct, deviceAcctSubmit, DEVICE_CONFIRM_NOTE, DEVICE_CLOSE_NOTE, voice, voiceCfg, ttsVoices, sttSt, sttText, voiceMsg, saveVoice, installFromSettings, AUTO_CHOICES, AUTO_LABEL, STT_LANGS, STT_LANG_LABEL, STT_MODELS, STT_MODEL_LABEL,
      upd, autoCheck, checkUpdate, installUpdate, updateNoticeText, progressText,
      frame, FRAMES, FRAME_LABEL, setFrame, closeTo, CLOSE_CHOICES, CLOSE_LABEL, setCloseTo, trayOk, autostart, setAutostart, RESIZE_DIRS, resizeFrom, avMenu,
      contextLabel, avOf, meAv, avBusy, avMsg, avFile, selfHasUpload, pickAvatar, removeAvatar,
      ui, MODES, MODE_LABEL, setMode, tabItems, mergedTabs, logs, sendTo: sendMsg, nudgeTo, sendAttachTo, loadOlder, photoApi, shotApi, activateTab, closeChatTab: closeOneChatTab, toggleDp, plain,
      chatTabMenu, chatTabMenuPanel, chatTabMenuPos, openChatTabMenu, closeChatTabMenu, tabPinLabel, menuCloseTab, menuCloseOther, menuCloseRight, menuCloseAll, menuCloseIdle, hasIdleTabs, setPaneCall, menuTogglePin, isChatTabPinned,
      onTabDragStart, onTabDragEnd, onTabDragOver, onTabDrop, tabDragClass,
      STATUS, CONN_LABEL, FIXED_TABS, ads, adImageSrc, pageSrc, pageDone, pageBroken, DIMS, dims, setTabDim, groupOptions, dev, dimTab: computed(() => dims.tabDim), isDevice, moreOn, moreOpen, moreUnreadN, me, nowPlayingText: computed(() => nowPlayingLine(nowPlaying.value)), notifyPrefs, friends, conn, shown, query, collapsed, nickErr, commitNick,
      tab, adI, hub, roomRows, roomHue, roomInitial, groupFlow, openGroupMenu, decideCard, emptyText, openAd, stepAd, jumpAd, groupHeading, statusNote, asnBadge, remoteBtn, requestRemoteUpdate,
      GUIDES, view, SETTING_CATS, catSub, PANEL_KINDS, panelTabId, panelGuide, panelTitle, openPanel, closePanel, settingsState, applySetting, pickAvatarFile,
      selfNode: info.node, transport, emo, initial, openChat, ctl, vendorIcon: vendorIconSvg,
      searchInput, focusSearch, launchPicker, launchPickerPos, openLaunchPicker, closeLaunchPicker, launchDeviceRows: launchDeviceRowsList, launchDisableReason: launchDisableReasonFor, pickLaunchDevice,
      DISPLAY_MODES, partnerShowDisplay,
      openPartnerDlg, closePartnerDlg, partnerDlg, partnerModels, dlgModels, partnerCwdChoices, browsePartnerCwd, CWD_EMPTY_HINT, pickPartnerModel, submitPartnerDlg,
      launchNotice, closeLaunchNotice, openLaunchLogFolder,
      opDlg, closeOpDlg, buddyOpItems, openPartnerOp, archiveNote, buddyMenuEl, buddySubEl, buddyModelBtn, buddySubPos, buddySubEnabled, subEvent,
      buddyMenu, buddyMenuPos, openBuddyMenu, closeBuddyMenu, buddyConsoleItemView, buddyMenuOpenChat, toggleBuddyConsole,
      buddyModel, buddyModelLabel, pickBuddyModel, modelDlg, modelDlgText, closeModelDlg, submitModelDlg, copyModelManual,
      launchToolRows, launchPrefs, launchCwdText, saveLaunchPrefs, setLaunchCwdText,
    }
  },
})
app.component('chat-pane', ChatPane)
app.component('group-sheet', GroupSheet)
app.component('asn-dialog', AsnDialog)
app.component('partner-op-dialog', PartnerOpDialog)
app.component('guide-doc', GuideDoc)
app.component('settings-panel', SettingsPanel)
const root = app.mount('#app')

await core.start()
sync()

// 還原上次開著的分頁與對話視窗：要等名單載入（夥伴 ID 才對得上）；名單一直連不上就維持存檔不動，不會把它蓋掉
async function restoreOpenSession() {
  const r = restoreSession(sess.saved, { friends: core.friends, pinned: ui.pinnedChat })
  if (JSON.stringify(r.pinned) !== JSON.stringify(ui.pinnedChat)) ui.pinnedChat = r.pinned
  for (const k of PANEL_KINDS) if (!ui.panel[k]) ui.panel[k] = k === 'setting' ? normalizeCatKey(r.panel[k]) : r.panel[k]
  if (ui.mode === 'merged') {
    const tabs = orderTabs([...r.tabs, ...ui.tabs.filter(id => !r.tabs.includes(id))], ui.pinnedChat)
    ui.tabs = tabs
    if (!ui.active || !tabs.includes(ui.active)) ui.active = r.active || tabs.at(-1) || ''
    for (const id of tabs) if (!isPanelTab(id)) pushLog(id)
    if (ui.active && !isPanelTab(ui.active)) { core.markRead(ui.active); void core.syncHistory(ui.active) }
  } else {
    for (const id of r.windows) await openChat(id)
    for (const kind of r.panelWindows) await openPanel(kind, ui.panel[kind])
  }
  sess.ready = true
  sync()
}
if (!info.shot) {
  let restoring = false
  const go = () => { if (restoring || !core.rosterLoaded) return; restoring = true; void restoreOpenSession() }
  go(); core.on('state', go)
  setInterval(() => void pollOpenWindows(), 3000)
}

// ---------- --shot 模式：開一個對話、寄一封信＋一個震動、彈一則提示，然後截圖並結束 ----------
// 設定檔（asn-me.json）可帶：winMode（'merged' 才是整合模式，欄位名就是 winMode，不是 mode）、shotNoChat（true＝不開任何對話，
// 整合模式停在「開始」大幅廣告）、shotAd（固定停在第幾則廣告）、shotTab（起始頁籤）、shotSetting（逐頁籤截圖時設定聊天窗顯示哪一類，預設 look）、shotSettingSet（[{ op, value }…]：在設定窗裡改值的模擬）、shotLaunchNotice（true＝只拍背景逾時通知對話框）、shotPartnerDlg（true＝只拍開新夥伴對話框）。
if (info.shot) {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const waitPaint = async (frames = 3) => {
    for (let i = 0; i < frames; i++) await new Promise(r => requestAnimationFrame(r))
    await sleep(350)
  }
  if (savedMe.shotPartnerDlg) {
    // 開新夥伴對話框：停在本機（候選來自 Rust 端的真實合併；截圖用暫存家目錄）
    openPartnerDlg(info.node)
    await refreshCwdCandidates()
    if (!partnerDlg.cwd) partnerDlg.cwd = partnerCwdChoices.value[0] ?? ''
    await waitPaint()
    await invoke('show_main').catch(() => {})
    await waitPaint()
    await sleep(900)
    await invoke('capture_ui_ready', { tag: 'partner-dlg-ready' })
    await invoke('take_shot', { tab: 'partner-dlg' })
    closePartnerDlg()
  } else if (savedMe.shotLaunchNotice) {
    showLaunchNotice(backgroundRestoreNoticeText('夥伴-7'))
    await waitPaint()
    await invoke('show_main').catch(() => {})
    await waitPaint()
    await invoke('capture_ui_ready', { tag: 'launch-notice-ready' })
    await invoke('take_shot', { tab: 'launch-notice' })
    closeLaunchNotice()
  } else {
  const all = core.snapshot().friends
  const target = savedMe.shotNoChat ? null : (all.find(f => f.unread > 0) ?? all.find(f => f.status !== 'offline') ?? all[0])
  if (target) {
    await openChat(target.id)
    if (ui.mode === 'merged') { const other = all.find(f => f.id !== target.id && f.status !== 'offline'); if (other) await openChat(other.id); await openChat(target.id) }
    await sleep(600)
    await core.send(target.id, '收到！我晚點看一下 :)')
    await core.nudge(target.id)
    await sleep(400)
    core.emit('notify', { kind: 'login', friend: core.friends.get(target.id), line: '已經登入', toast: true })
  }
  await sleep(1500)
  await invoke('take_shot')
  // 沒開對話的整合模式：再各拍一張別則大幅廣告（正見、招租＝按鈕不可點）
  if (savedMe.shotNoChat && ui.mode === 'merged') {
    for (const [name, i] of [['ad-policy', Math.max(0, ads.value.findIndex(a => a.key === 'policy'))], ['ad-rent', ads.value.length - 1]]) { adI.value = i; await sleep(700); await invoke('take_shot', { tab: name }) }
    adI.value = Number.isInteger(savedMe.shotAd) ? savedMe.shotAd : 0
  }
  // 逐頁籤截圖：本機、第二台設備、群組、指引（清單與一篇內容）、設定
  const p = pages.value.all
  // 指引、設定各拍一張「清單」與一張「點了一項之後的聊天窗」：整合模式＝右邊的分頁（拍名單視窗就看得到）；分離模式＝獨立視窗（另存 panel-*.png）
  for (const [name, key] of [['local', p[0]?.key], ['device', p[1]?.key], ['last', p.at(-1)?.key], ['groups', 'groups'], ['guide', 'guide'], ['guide-doc', 'guide'], ['settings', 'settings'], ['settings-doc', 'settings']]) {
    if (!key) continue
    shotTab.value = key
    if (name === 'guide-doc') await root.openPanel('guide', 'bridge')
    if (name === 'settings-doc') {
      await root.openPanel('setting', savedMe.shotSetting || 'look')
      // shotSettingSet：[{ op, value }…]，模擬在設定窗裡改值——走跟分離視窗一樣的 asn:set 事件（整合模式也一樣），驗證改了馬上生效、也寫進存檔
      if (Array.isArray(savedMe.shotSettingSet)) for (const c of savedMe.shotSettingSet) { emit('asn:set', c); await sleep(400) }
    }
    await sleep(name.endsWith('-doc') ? 900 : 500)
    await invoke('take_shot', { tab: name })
    if (name === 'guide-doc') await root.closePanel('guide')
    if (name === 'settings-doc') await root.closePanel('setting')
  }
  }
  await core.stop()
  await invoke('quit_app')
}
blockContextMenu(document)
