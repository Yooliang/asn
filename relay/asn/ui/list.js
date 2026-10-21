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
import { SETTING_CATS, catSummary } from './lib/settings-cats.mjs'
import { DIMS, groupOptions, loadDims, pageTabs, withTabDim } from './lib/dims.mjs'
import { normalizeSearchQuery, rosterShownGroups } from './lib/search.mjs'
import { deviceAsn } from './lib/presence.mjs'
import { emo, initial, plain } from './lib/text.mjs'
import { ChatPane } from './lib/chatpane.mjs'
import { avatarFor, avatarSrc, isAvatarDataUrl, removeAvatarUpload, uploadAvatarFile, selfAvatarSrc } from './lib/avatar.mjs'
import { avatarFromFile } from './lib/avatar-canvas.mjs'
import { BUBBLES, BUBBLE_LABEL, TOOLBARS, TOOLBAR_LABEL, DP_LABEL, DP_MODES, MODES, MODE_LABEL, normalizeBubble, normalizeDpMode, normalizeLook, normalizeMode, normalizeSize, switchMode, tabVisible, toggleCollapsed } from './lib/merge.mjs'
import { chatTabSameZone, closeAllChatTabs, dropInsertBefore, closeChatTab, closeOtherChatTabs, closeRightChatTabs, isPinned, moveChatTab, normalizePinned, openChatTab, orderTabs, toggleChatPin } from './lib/ctabs.mjs'
import { CLOSE_CHOICES, CLOSE_LABEL, FRAMES, FRAME_LABEL, SOUND_CHOICES, SOUND_LABEL, normalizeClose, normalizeFrame, totalUnread, soundChoice, soundFromChoice, soundFromSaved } from './lib/prefs.mjs'
import { RESIZE_DIRS, ctl, emit, initFrame, invoke, listen, photoApi, resizeFrom, shotApi, store, transport } from './lib/tauri.mjs'
import { MODEL_CATALOG, defaultPartnerName, injectPendingGroups, modelUiRow, pendingFriend, resolvePending } from './lib/partner.mjs'
import { CWD_EMPTY_HINT, bumpRecentCwd, cwdChoices, mergeCwdLists, normalizeLaunchPrefs, withPickedCwd } from './lib/launch-prefs.mjs'
import { CONSOLE_QUERY_TIMEOUT_MS, DISPLAY_MODES, buddyConsoleItem, engineForProfile,launchDeviceRows, launchDisableReason, showDisplayModeChoice, withTimeout } from './lib/partner-launch-ui.mjs'
import { backgroundRestoreNoticeText, collectLaunchFailures, findBackgroundTimeouts, launchFailedNoticeText } from './lib/partner-launch-notify.mjs'
import { friendId } from './lib/roster.mjs'
import { canOfferModelSwitch, confirmText, createModelSwitcher } from './lib/model-switch.mjs'
import { vendorIconSvg } from './lib/vendor-icons.mjs'
import { createMic } from './lib/mic.mjs'
import { browserAudio } from './lib/tts-player.mjs'
import { createVoiceUi } from './lib/voice-ui.mjs'
import { accountLine, codexLine, createAccountsUi } from './lib/claude-accounts.mjs'
import { CHECK_MS, autoCheckFromSaved, initialUpdateState, manualResultText, progressText, updateNoticeText, withAvailable, withFailure, withInstalling, withProgress, updateStatus } from './lib/update.mjs'
import { AUTO_CHOICES, AUTO_LABEL, STT_LANGS, STT_LANG_LABEL, STT_MODELS, STT_MODEL_LABEL, normalizeCfg, shouldAutoSpeak, sttStatusText } from './lib/voice-prefs.mjs'

const { createApp, reactive, ref, computed, watch } = Vue
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
  nudge: () => { for (let i = 0; i < 7; i++) tone(95 + (i % 2) * 35, i * 0.07, 0.09, 'square', 0.05) },
}

const info = await invoke('startup_info')
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
if (info.error) {
  document.body.textContent = `ASN 無法啟動：${info.error}`
  throw new Error(info.error)
}
const meStore = store('me')
const savedMe = (await meStore.load()) ?? {}
// 暱稱＝視窗名＝對外名字；以 Rust 端現用名為準，不再從存檔讀
const me = reactive({ psm: '', status: 'online', ...savedMe.me, nick: info.window_name })
const soundOn = ref(soundFromSaved(savedMe.sound))
const frame = ref(normalizeFrame(savedMe.frame))   // 視窗外框：自訂（預設，含舊存檔）／Windows 原生；Rust 端開視窗時讀同一份存檔
await initFrame()
// 關閉視窗時：縮到系統匣（預設，含舊存檔）／結束程式；登入時自動啟動以系統上的真實設定為準（不存檔）。程式在 tray.rs
const closeTo = ref(normalizeClose(savedMe.closeTo))
const trayOk = ref(true)
const autostart = reactive({ supported: false, on: false, busy: false })
try {
  await invoke('set_close_to_tray', { tray: closeTo.value === 'tray' })
  trayOk.value = await invoke('tray_available')
  autostart.supported = await invoke('autostart_supported')
  if (autostart.supported) autostart.on = await invoke('autostart_get')
} catch { /* 沒有這些指令（舊版後端）就不顯示 */ }
// 內建收發室橋（預設關）：狀態以 Rust 端為準，不存檔。程式在 bridge/
const bridge = reactive({ enabled: false, running: false, legacy: false, takeoverAllowed: false, error: '', busy: false, confirm: false, shown: false })
const applyBridgeStatus = s => {
  Object.assign(bridge, { enabled: s.enabled === true, running: s.running === true, legacy: s.legacy === true, takeoverAllowed: s.takeover_allowed === true, error: s.error || '', shown: true })
}
try { applyBridgeStatus(await invoke('bridge_status')) } catch { /* 舊版後端沒有這個指令就不顯示 */ }
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
const dims = reactive(loadDims(savedMe))   // 分頁依（設備／廠商／狀態）與分組依；舊存檔的 groupMode 在這裡轉換

// 視窗模式：分開（每位好友一扇對話視窗）／整合（一個視窗，右邊是對話分頁）。tabs／active 只在整合模式用，不存檔
// 視窗模式、頭像模式（左／右／整合）、文字底色（透明／色彩／自動）三個設定彼此獨立，分離與整合視窗都有效
const pinnedChat = normalizePinned(savedMe.pinnedChat)
// panel＝指引、設定兩個聊天窗目前顯示哪一篇／哪一類（整合模式是右邊的分頁、分離模式是獨立視窗；不存檔）
const ui = reactive({ mode: normalizeMode(savedMe.winMode), ...normalizeLook(savedMe), tabs: [], active: '', pinnedChat, panel: { guide: '', setting: '' } })
const sizes = reactive({ split: normalizeSize(savedMe.splitSize, 'split'), merged: normalizeSize(savedMe.mergedSize, 'merged'), guide: normalizePanelSize(savedMe.guideSize), setting: normalizePanelSize(savedMe.settingSize) })   // guide／setting＝分離模式兩扇視窗的大小
const winSize = () => ({ w: window.innerWidth, h: window.innerHeight })
let switching = false

const core = new AsnCore({
  transport, store: store('chats'), selfNode: info.node, windowName: info.window_name,
  // 整合模式：只有「目前分頁」且主視窗開著沒最小化才算看得到
  isChatVisible: async id => (ui.mode === 'merged' ? tabVisible(ui, id, await invoke('main_visible')) : invoke('chat_visible', { id })),
  aliases: info.old_names,
  pollMs: info.poll_ms, rosterMs: info.roster_ms,
  log: m => console.info('[ASN]', m),
})

const friends = ref([])
const nodeOrder = ref([])
const asnMap = ref({})   // 節點 → 在線的 ASN 視窗（版本與狀態），名單設備分組標題旁的小綠點用
const conn = ref('connecting')
const sync = () => {
  const s = core.snapshot()
  friends.value = s.friends
  nodeOrder.value = s.nodeOrder
  asnMap.value = s.asn ?? {}
  conn.value = s.conn
  emit('asn:state', { ...s, me: { ...me }, ui: { dpMode: ui.dpMode, bubble: ui.bubble, toolbar: ui.toolbar, collapsed: ui.collapsed } })
}
const logs = reactive({})   // 整合模式的分頁直接讀這份；分開模式的對話視窗走 asn:log 事件
const pushLog = id => { const l = core.logOf(id).slice(-200); logs[id] = l; emit('asn:log', { id, log: l }) }

// 設備大頭貼：節點 → data URL。好友顯示用哪張由 avatar.mjs 的規則決定（AI 視窗一律自動產生；名單外的寄件人用他那台設備的圖）
const avatars = ref({})
core.on('avatars', () => { avatars.value = core.avatarMap(); emit('asn:avatars', avatars.value) })
const avOf = f => avatarSrc(f, { avatars: avatars.value })
const meAv = computed(() => selfAvatarSrc({ selfNode: info.node, windowName: info.window_name, avatars: avatars.value }))

core.on('state', sync)
core.on('log', pushLog)
const rooms = ref([]), roomsErr = ref(false)
async function refreshRooms() {
  try { rooms.value = groupRows((await invoke('relay_rooms'))?.rooms); roomsErr.value = false } catch { roomsErr.value = true }
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
  const first = partnerModels.value.find(m => m.installed) ?? partnerModels.value[0]
  if (first) pickPartnerModel(first)
  partnerDlg.cwd = partnerCwdChoices.value[0] ?? ''
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
// 右鍵選單立刻出現（固定有「開啟對話」）；主控台切換項目先顯示「檢查中…」，查到才可按，逾時／查不到就停用
const buddyConsole = reactive({ state: 'none', visible: true })
const buddyConsoleItemView = computed(() => buddyConsoleItem(buddyConsole.state, buddyConsole.visible))
// 「切換模型 ▸」：只有本機的 Claude 視窗會出現；查詢逾時或查不到就停用並說明原因（共用 lib/model-switch.mjs，功能列 #40 也用它）
const modelSwitcher = createModelSwitcher({ transport, log: m => console.info('[ASN]', m) })
const buddyModel = reactive({ show: false, state: 'none', reason: '', current: '', items: [], open: false, st: null })
function resetBuddyModel() { Object.assign(buddyModel, { show: false, state: 'none', reason: '', current: '', items: [], open: false, st: null }) }
const buddyModelLabel = computed(() => (buddyModel.state === 'checking' ? '切換模型（檢查中…）' : buddyModel.state === 'none' ? '切換模型（無法切換）' : '切換模型 ▸'))
const modelDlg = reactive({ open: false, name: '', target: null, current: '', busy: false, error: '', manual: '', done: '', copied: false, st: null })
const modelDlgText = computed(() => confirmText(modelDlg.name, modelDlg.current, modelDlg.target?.label ?? ''))
function closeModelDlg() { if (!modelDlg.busy) modelDlg.open = false }
function closeBuddyMenu() { buddyMenu.value = ''; buddyMenuFriend.value = null; buddyConsole.state = 'none'; resetBuddyModel() }
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
  buddyMenuPos.x = e?.clientX ?? 0
  buddyMenuPos.y = e?.clientY ?? 0
  buddyMenuFriend.value = c
  buddyMenu.value = c.id
  buddyConsole.visible = true
  const eng = c.engine || engineForProfile(c.launchProfile || 'claude')
  resetBuddyModel()
  buddyModel.show = canOfferModelSwitch(c, { selfNode: info.node, engine: eng })
  if (buddyModel.show) void loadBuddyModel(c)
  if (c.node !== info.node || c.engine === 'acp' || c.pending) { buddyConsole.state = 'none'; return }
  buddyConsole.state = 'checking'
  const q = await withTimeout(transport.partnerConsoleQuery({ engine: eng, name: c.agent || c.nick }), CONSOLE_QUERY_TIMEOUT_MS)
  if (buddyMenuFriend.value !== c) return   // 使用者已經關掉或換開別人的選單
  if (q?.can_toggle ?? q?.canToggle) {
    buddyConsole.state = 'toggle'
    buddyConsole.visible = Boolean(q.visible)
  } else {
    buddyConsole.state = 'none'
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
const voiceCfg = reactive(normalizeCfg(await invoke('voice_cfg_get').catch(() => null)))
core.on('notify', n => {
  if (n.sound && soundOn.value && me.status !== 'busy') SOUNDS[n.sound]?.()
  if (shouldAutoSpeak(n, voiceCfg, me.status)) voice.speakAuto(`auto:${n.friend.id}:${Date.now()}`, n.line)   // 預設關
  if (n.shake) void invoke('shake', { id: n.friend.id, main: ui.mode === 'merged' })   // 整合模式抖整個主視窗
  if (n.toast) void invoke('show_toast', { toast: { cid: n.friend.id, title: plain(n.friend.nick), line: n.line, status: n.friend.status, hue: n.friend.hue, dp: n.friend.dp, av: (a => (a.kind === 'upload' ? a.src : null))(avatarFor(n.friend, { avatars: avatars.value })) } })
})

async function openChat(id) {
  if (String(id).startsWith('pending:')) return
  const f = core.friends.get(id); if (!f) return
  core.markRead(id)
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
  else if (c.op === 'send') { const r = await core.send(c.id, c.text); if (!r.ok) console.info('[ASN] send failed', r.error) }
  else if (c.op === 'nudge') await core.nudge(c.id)
  else if (c.op === 'attach') await sendAttachTo(c.id, c.photo, c.caption)
})
const sendTo = async (id, text) => { const r = await core.send(id, text); if (!r.ok) console.info('[ASN] send failed', r.error) }
const nudgeTo = id => core.nudge(id)
const sendAttachTo = async (id, item, caption) => { const r = await core.sendAttachment(id, item, caption); if (!r.ok) console.info('[ASN] attachment failed', r.error) }
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

await listen('relay-bell', () => void core.pull('bell'))   // Rust 端的 Realtime 門鈴
await listen('asn:open', c => void openChat(c.cid))   // 提示被點了

watch([me, soundOn, frame, closeTo, autoCheck, dims, () => ui.mode, () => ui.dpMode, () => ui.bubble, () => ui.toolbar, () => ui.collapsed, () => ui.pinnedChat, sizes], () => { const { nick, ...rest } = me; void meStore.save({ me: rest, sound: soundOn.value, frame: frame.value, closeTo: closeTo.value, autoUpdate: autoCheck.value, tabDim: dims.tabDim, groupDim: dims.groupDim, winMode: ui.mode, dpMode: ui.dpMode, bubble: ui.bubble, toolbar: ui.toolbar, dpCollapsed: ui.collapsed, pinnedChat: ui.pinnedChat, splitSize: sizes.split, mergedSize: sizes.merged, guideSize: sizes.guide, settingSize: sizes.setting }); sync() }, { deep: true })
// 系統匣圖示的提示文字帶未讀總數
watch(() => totalUnread(friends.value), n => { void invoke('set_tray_unread', { n }).catch(() => {}) }, { immediate: true })
// 在線狀態：狀態下拉與個人訊息交給 Rust 端回報（每 60 秒一次，改了立刻送；後台沒部署就靜默不送）
watch(() => [me.status, me.psm], () => { void invoke('set_presence', { status: me.status, psm: me.psm ?? '' }).catch(() => {}) }, { immediate: true })
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
    const collapsed = reactive({})
    const dev = pages
    const isDevice = computed(() => !FIXED_TABS.some(t => t.key === tab.value))   // 名單頁（設備／廠商／狀態的頁籤）；其餘是群組、指引、設定
    const moreOn = computed(() => dev.value.more.some(d => d.key === tab.value))
    const moreUnreadN = computed(() => moreUnread(dev.value.more))
    // 選到的頁籤不在現在的清單（改了維度、設備消失…）時退回第一個（設備維度的第一個就是本機）
    watch(dev, d => { if (!normalizeTab(tab.value, d.all.map(x => x.key))) tab.value = d.all[0]?.key ?? '' }, { immediate: true })
    const shown = computed(() => {
      if (!isDevice.value) return []
      const base = rosterShownGroups(friends.value, {
        tabDim: dims.tabDim, tabKey: tab.value, groupDim: dims.groupDim, selfNode: info.node, selfName: info.window_name, query: query.value, plainText: plain,
      })
      return injectPendingGroups(base, launchPending.value.filter(p => !tab.value || p.node === tab.value))
    })
    const emptyText = computed(() => (normalizeSearchQuery(query.value) ? '沒有符合的聯絡人。' : conn.value !== 'on' ? '還沒連上收發室。' : '這一頁目前沒有視窗。'))
    const openAd = a => openAdWith(a, url => void invoke('open_url', { url }))
    // 改最上面的暱稱＝改對外名字；Rust 端驗證，不合法就還原並提示
    const commitNick = async () => {
      const want = String(me.nick ?? '').trim()
      if (want === info.window_name) { me.nick = info.window_name; nickErr.value = ''; return }
      try { await invoke('set_window_name', { name: want }); location.reload() }
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
      try { say((await removeAvatarUpload(avApi)).message) } finally { avBusy.value = false }
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
    const setBridgeEnabled = on => runBridge(() => invoke('bridge_set_enabled', { on }))
    const takeoverBridge = () => runBridge(() => invoke('bridge_takeover', { confirmed: true }))
    // 指引、設定的聊天窗（openPanel／closePanel 在上面）：列表只負責「點一項就開」，內容在右邊分頁或獨立視窗
    const panelGuide = computed(() => panelItem('guide', ui.panel.guide))
    const catSub = key => catSummary(key, {
      hasUpload: selfHasUpload.value, accountCount: accounts.state.list.length, accountCurrent: accounts.state.current?.email ?? '',
      frame: frame.value, mode: ui.mode, dpMode: ui.dpMode, toolbar: ui.toolbar, bubble: ui.bubble, tabDim: dims.tabDim, groupDim: dims.groupDim,
      soundOn: soundOn.value, voiceEnabled: ttsVoices.value.enabled, ttsAuto: voiceCfg.tts_auto, sttLang: voiceCfg.stt_lang,
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
    const tabItems = computed(() => ui.tabs.map(id => (isPanelTab(id) ? panelTabItem(id.slice(1), ui.panel[id.slice(1)]) : friends.value.find(f => f.id === id))).filter(Boolean))
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
    window.addEventListener('blur', () => { if (chatTabMenu.value) closeChatTabMenu(); if (buddyMenu.value) closeBuddyMenu(); if (launchPicker.value) closeLaunchPicker(); if (deviceMenu.value) closeDeviceMenu() })
    const tabPinLabel = computed(() => (chatTabMenuPin.value ? '取消固定分頁' : '固定分頁'))
    const runTabMenu = fn => { const id = chatTabMenu.value; closeChatTabMenu(); if (id) fn(id) }
    const menuCloseTab = () => runTabMenu(id => applyChatTabClose(closeChatTab(ui, id)))
    const menuCloseOther = () => runTabMenu(id => applyChatTabClose(closeOtherChatTabs(ui, id, ui.pinnedChat)))
    const menuCloseRight = () => runTabMenu(id => applyChatTabClose(closeRightChatTabs(ui, id, ui.pinnedChat)))
    const menuCloseAll = () => { closeChatTabMenu(); applyChatTabClose(closeAllChatTabs(ui, ui.pinnedChat)) }
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
    void accounts.loadTrust()
    // 本機帳號庫清單定期回報給收發室（只有 email、方案、使用中）；別台送來的切換指令定期取走（預設要本機按確認才切）。--shot 不輪詢指令。
    setTimeout(() => void accounts.report(), 5_000)
    setInterval(() => void accounts.report(), 5 * 60_000)
    if (!info.shot) {
      setInterval(() => void accounts.pollIncoming(), 15_000)
      void listen('relay-bell', () => void accounts.pollIncoming())
    }
    // 有人要求切換這台的帳號：把視窗叫到前面，讓使用者看得到確認框
    watch(() => accounts.state.incoming.length, n => { if (n) void invoke('show_main').catch(() => {}) })
    // 名單設備標題右鍵：切換那台設備的 Claude 帳號
    const deviceMenu = ref('')
    const deviceMenuPos = reactive({ x: 0, y: 0 })
    const openDeviceMenu = (g, e) => {
      if (g.kind !== 'device' || g.node === info.node || !asnMap.value[g.node]) return
      closeBuddyMenu(); closeLaunchPicker()
      deviceMenuPos.x = e?.clientX ?? 0; deviceMenuPos.y = e?.clientY ?? 0
      deviceMenu.value = g.node
    }
    const closeDeviceMenu = () => { deviceMenu.value = '' }
    const deviceMenuSwitch = async () => {
      const node = deviceMenu.value
      closeDeviceMenu()
      if (!node) return
      await openPanel('setting', 'accounts')
      await accounts.remoteSelect(node)
    }
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
      status: me.status, hasUpload: selfHasUpload.value, avBusy: avBusy.value, avMsg: avMsg.value,
      soundOn: soundOn.value, frame: frame.value, mode: ui.mode, dpMode: ui.dpMode, toolbar: ui.toolbar, bubble: ui.bubble,
      tabDim: dims.tabDim, groupDim: dims.groupDim,
      voice: { cfg: { tts_voice: voiceCfg.tts_voice, tts_auto: voiceCfg.tts_auto, stt_lang: voiceCfg.stt_lang, stt_model: voiceCfg.stt_model }, enabled: ttsVoices.value.enabled, voices: ttsVoices.value.voices, sttReady: Boolean(sttSt.value?.ready), installBusy: voice.state.install.busy, note: voice.state.install.text || voiceMsg.value || sttText.value },
      accounts: {
        list: accounts.state.list, current: accounts.state.current, codexLine: codexLine(accounts.state.codex, accounts.state.codexErr),
        busy: accounts.state.busy, confirmDel: accounts.state.confirmDel, msg: accounts.state.msg, trustOwn: accounts.state.trustOwn,
        remote: { node: accounts.state.remote.node, devices: accounts.remoteNodes(), list: accounts.state.remote.list, loading: accounts.state.remote.loading, busy: accounts.state.remote.busy, msg: accounts.state.remote.msg },
      },
      closeTo: closeTo.value, trayOk: trayOk.value, autostart: { supported: autostart.supported, on: autostart.on, busy: autostart.busy },
      bridge: bridge.shown ? { enabled: bridge.enabled, running: bridge.running, legacy: bridge.legacy, takeoverAllowed: bridge.takeoverAllowed, error: bridge.error, busy: bridge.busy, confirm: bridge.confirm } : null,
      autoCheck: autoCheck.value, upd: { checking: upd.checking, installing: upd.phase === 'installing', manual: upd.manual, status: updateStatus({ checking: upd.checking, phase: upd.phase, info: upd.info, lastCheck: upd.lastCheck, error: upd.checkErr, current: info.version }) },
      launch: { tools: launchToolRows.value, maxPerHour: launchPrefs.maxPerHour, cwdText: launchCwdText.value },
      version: info.version,
      log: buildLogView({ entries: changelogEntries.value, current: info.version, available: upd.phase === 'idle' ? null : upd.info }),
    }))
    const applySetting = async (op, value) => {
      switch (op) {
        case 'sound': soundOn.value = soundFromChoice(value); break
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
        case 'acct-add': await accounts.addCurrent(); break
        case 'acct-remote-node': await accounts.remoteSelect(String(value ?? '')); break
        case 'acct-remote-switch': await accounts.remoteSwitch(String(value ?? '')); break
        case 'acct-trust': await accounts.setTrust(value === true); break
        case 'closeTo': await setCloseTo(value); break
        case 'autostart': await setAutostart(value === true); break
        case 'bridge-enable': await setBridgeEnabled(value === true); break
        case 'bridge-takeover': bridge.confirm = true; break
        case 'bridge-takeover-yes': await takeoverBridge(); break
        case 'bridge-takeover-no': bridge.confirm = false; break
        case 'autoCheck': autoCheck.value = value === true; break
        case 'check-update': await checkUpdate(true); break
        case 'launch-max': launchPrefs.maxPerHour = Number.isFinite(value) ? value : 6; await saveLaunchPrefs(); break
        case 'launch-cwd': setLaunchCwdText(String(value ?? '')); break
        case 'avatar-remove': await removeAvatar(); break
        case 'avatar-upload': avBusy.value = true; try { say((await uploadAvatarFile(value, { toDataUrl: async u => u, setAvatar: v => core.setSelfAvatar(v) })).message) } finally { avBusy.value = false } break   // 分離視窗已在自己那邊裁好圖，送來的是 data URL
        default: break
      }
    }
    // 分離模式的指引、設定視窗：開起來先問一聲（hello），樞紐回目前要顯示哪一篇與設定快照；之後設定一變就推新快照
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
      version: info.version, accounts, accountLine, deviceMenu, deviceMenuPos, openDeviceMenu, closeDeviceMenu, deviceMenuSwitch, voice, voiceCfg, ttsVoices, sttSt, sttText, voiceMsg, saveVoice, installFromSettings, AUTO_CHOICES, AUTO_LABEL, STT_LANGS, STT_LANG_LABEL, STT_MODELS, STT_MODEL_LABEL,
      upd, autoCheck, checkUpdate, installUpdate, updateNoticeText, progressText,
      frame, FRAMES, FRAME_LABEL, setFrame, closeTo, CLOSE_CHOICES, CLOSE_LABEL, setCloseTo, trayOk, autostart, setAutostart, SOUND_CHOICES, SOUND_LABEL, soundChoice, soundFromChoice, RESIZE_DIRS, resizeFrom, avMenu,
      avOf, meAv, avBusy, avMsg, avFile, selfHasUpload, pickAvatar, removeAvatar,
      ui, MODES, MODE_LABEL, setMode, tabItems, mergedTabs, logs, sendTo, nudgeTo, sendAttachTo, photoApi, shotApi, activateTab, closeChatTab: closeOneChatTab, toggleDp, plain,
      chatTabMenu, chatTabMenuPanel, chatTabMenuPos, openChatTabMenu, closeChatTabMenu, tabPinLabel, menuCloseTab, menuCloseOther, menuCloseRight, menuCloseAll, menuTogglePin, isChatTabPinned,
      onTabDragStart, onTabDragEnd, onTabDragOver, onTabDrop, tabDragClass,
      STATUS, CONN_LABEL, FIXED_TABS, ads, adImageSrc, pageSrc, pageDone, pageBroken, DIMS, dims, setTabDim, groupOptions, dev, dimTab: computed(() => dims.tabDim), isDevice, moreOn, moreOpen, moreUnreadN, me, soundOn, friends, conn, shown, query, collapsed, nickErr, commitNick,
      tab, adI, rooms, roomsErr, emptyText, openAd, stepAd, jumpAd, groupHeading, statusNote, asnBadge: node => deviceAsn(asnMap.value[node], info.version),
      GUIDES, view, SETTING_CATS, catSub, PANEL_KINDS, panelTabId, panelGuide, panelTitle, openPanel, closePanel, settingsState, applySetting, pickAvatarFile,
      selfNode: info.node, emo, initial, openChat, ctl, vendorIcon: vendorIconSvg,
      searchInput, focusSearch, launchPicker, launchPickerPos, openLaunchPicker, closeLaunchPicker, launchDeviceRows: launchDeviceRowsList, launchDisableReason: launchDisableReasonFor, pickLaunchDevice,
      DISPLAY_MODES, partnerShowDisplay,
      openPartnerDlg, closePartnerDlg, partnerDlg, partnerModels, partnerCwdChoices, browsePartnerCwd, CWD_EMPTY_HINT, pickPartnerModel, submitPartnerDlg,
      launchNotice, closeLaunchNotice, openLaunchLogFolder,
      buddyMenu, buddyMenuPos, openBuddyMenu, closeBuddyMenu, buddyConsoleItemView, buddyMenuOpenChat, toggleBuddyConsole,
      buddyModel, buddyModelLabel, pickBuddyModel, modelDlg, modelDlgText, closeModelDlg, submitModelDlg, copyModelManual,
      launchToolRows, launchPrefs, launchCwdText, saveLaunchPrefs, setLaunchCwdText,
    }
  },
})
app.component('chat-pane', ChatPane)
app.component('asn-dialog', AsnDialog)
app.component('guide-doc', GuideDoc)
app.component('settings-panel', SettingsPanel)
const root = app.mount('#app')

await core.start()
sync()

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
