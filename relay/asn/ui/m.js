// 手機版（安卓）主程式：三個大分頁——夥伴、對話（最後使用的那一位）、設置。和電腦版共用 AsnCore（收寄信、記錄）、ChatPane（對話版面）與 Rust 端指令；
// 電腦才有的功能（內建收發室、開 Claude 視窗、密碼小幫手、用量、系統匣、多視窗）手機沒有，這個檔案也不叫它們。
// 打開 App 才收信：前景時照電腦版的節奏輪詢，加上門鈴一響就拉；回到前景時立刻拉一次（推播留給第二期）。
import { AsnCore } from './lib/core.mjs'
import { ChatPane } from './lib/chatpane.mjs'
import { AsnAvatar } from './lib/avatar-badge.mjs'
import { avatarSrc, isAvatarDataUrl, removeAvatarUpload, selfAvatarSrc, uploadAvatarFile } from './lib/avatar.mjs'
import { avatarFromFile } from './lib/avatar-canvas.mjs'
import { PROVIDERS, canStart, errorText, phaseText } from './lib/login.mjs'
import { contextLabel } from './lib/context-usage.mjs'
import { BANNER_MS, DEFAULT_PREFS, TABS, TAB_LABEL, accountDisplayName, SWIPE_BLOCK_SELECTOR, inScrollableX, indicatorPos, pagerShift, swipeLock, swipeStartOk, swipeTarget, tabIndex, tabNav, UPDATE_CHECK_MS, afterBind, androidBridge, bannerText, buttonLabel, initialNav, opsNav, acctNav, tabLabel as tabLabelOf, secretNav, termReqNav, initialUpdate, installOutcome, launchNav, meNav, normalizeNav, normalizePrefs, notifyPlan, rosterGroups, savePhotoOnPhone, PTR_LOADING_H, PULL_TEXT, pullHeight, pullPhase, pullRatio, shouldAutoCheck, shouldRefreshOnRelease, totalUnread, BACKFILL_GAP_MS, backfillQueue, lastWords, updateCheckErrorText, withAvailable, withFailure, withProgress } from './lib/mobile.mjs'
import { LAUNCH_GIVE_UP_MS, LAUNCH_POLL_MS, appearedIn, buildLaunchRequest, initialLaunch, launchChoices, launchDevices, launchEligibility, launchErrorText, launchFormError, machinesByNode, progressView } from './lib/mobile-launch.mjs'
import { OnboardCard } from './lib/onboard-card.mjs'
import { MOBILE_PHASE_TEXT, createMobileCall } from './lib/mobile-call.mjs'
import { canDictate, createMobileDictation } from './lib/mobile-dictation.mjs'
import { startCallPoll } from './lib/call-poll.mjs'
import { ONBOARD_STORE, TEXT as ONBOARD_TEXT, checkName, markOnboarded, planOnboarding } from './lib/onboard.mjs'
import { POLL_MS as SECRET_POLL_MS, TEXT as SECRET_TEXT, countdownText as secretCountdown, errorText as secretError, normalizeList as secretList, nextToAsk as secretNext, secretError as secretValidate } from './lib/secret-ask.mjs'
import { POLL_MS as TQ_POLL_MS, TEXT as TERMREQ_TEXT, countdownText as tqCountdownText, decideArgs as tqDecideArgs, errorText as tqError, normalizeList as tqList, nextToAsk as tqNext } from './lib/term-ask.mjs'
import { friendId } from './lib/roster.mjs'
import { restoreMobileTab } from './lib/session.mjs'
import { MODEL_NOTE, chatPageState, normalizeLastChat, opStep, phoneModels, renamedChatId, runBanner, showsInSheet } from './lib/mobile-ops.mjs'
import { OP_LABEL, opFormError, dialogEngine, partnerEngine, sharedWhy } from './lib/partner-ops.mjs'
import { BUDDY_CONSOLE_LABEL } from './lib/partner-launch-ui.mjs'
import { ACCT_TEXT, ACCT_PAGE_TITLE, acctButtonDevices, acctClaudeRemote, acctDeviceTree, acctNeedsLoad, acctPickDevice, acctErrorText, acctSheetView, confirmText as acctConfirmText, runAcctSwitch } from './lib/mobile-acct.mjs'
import { createDeviceSync } from './lib/device-sync.mjs'
import { deviceFieldsFromSaved, deviceFieldsToSave, dropSlot, moveDevice, moveFlags, pruneRemoved, removeDevice, removedRows, reorderDevice, restoreDevice, showDevice, visibleRows, canRemoveRow, DEVICE_TEXT } from './lib/device-order.mjs'
import { ARCHIVE_GROUP_KEY, activeFriends, archivedFriends, manageItems, runArchive, withArchivedGroup } from './lib/archive.mjs'
import { opDialogText, runPartnerOp } from './lib/partner-ops-ui.mjs'
import { defaultPartnerName } from './lib/partner.mjs'
import { groupHeading, statusNote } from './lib/tabs.mjs'
import { emo, plain } from './lib/text.mjs'
import { headTone } from './lib/head-tone.mjs'
import { RECENT_GROUP_KEY, RECENT_GROUP_LABEL, recentActivity } from './lib/recent.mjs'
import { authApi, invoke, listen, store } from './lib/tauri.mjs'
import { vendorIconSvg } from './lib/vendor-icons.mjs'
import { runChoices } from './lib/model-catalog.mjs'
import { ROOM_GROUP_KEY, ROOM_GROUP_LABEL, ROOM_POLL_MS, ROOM_EMPTY_HINT, ROOM_EMPTY_TEXT, ROOM_LOAD_FAIL_TEXT, isRoomChat, roomChatId, roomIdOf, roomPseudoFriend, totalUnreadWithRooms } from './lib/mobile-rooms.mjs'
import { GroupSheet } from './lib/group-sheet.mjs'
import { createGroupFlow } from './lib/group-flow.mjs'
import { canInviteFrom, copyText, createGroupApi } from './lib/groups.mjs'
import { createRoomHub } from './lib/room-hub.mjs'
import { GUIDE_ENTRY_LABEL, GUIDE_ENTRY_SUB, guideNav, phoneGuide, phoneGuideList } from './lib/mobile-guides.mjs'
import { mobileSettingRows, mobileSettingTitle, settingNav } from './lib/mobile-settings.mjs'
import { applyRename } from './lib/rename.mjs'
import { checkAiWakeLimit, AI_WAKE_LIMIT_LABEL, AI_WAKE_LIMIT_NOTE } from './lib/ai-wake-limit.mjs'
import { GuideDoc } from './lib/guide-doc.mjs'

const { createApp, reactive, ref, computed, watch } = Vue
const STATUS = { online: '線上', busy: '忙碌', away: '暫離', offline: '顯示為離線' }
const CONN_LABEL = { connecting: '連線中…', on: '已連線', off: '連線中斷，重試中' }
const bridge = androidBridge(window)
// 偽通話（#99）：用手機內建的語音辨識與念出（外殼 CallVoice.kt）。外殼沒有、或這支手機沒有辨識服務就沒有通話鈕
const callOn = ref(false)   // 現在有沒有通話（通話中每 2 秒多收一次信）
let liveCall = null

// 手機只用得到這幾個 Rust 指令（金鑰與權杖都在 Rust 端，這裡拿不到）
const transport = {
  list: () => invoke('relay_list'),
  inbox: () => invoke('relay_inbox'),
  ack: ids => invoke('relay_ack', { ids }),
  send: payload => invoke('relay_send', { payload }),
  history: (node, agent, partnerId, before, limit) => invoke('relay_chat_history', { node, agent: agent || null, partnerId: partnerId || null, before: before || null, limit: limit || null }),   // 後台的往來記錄（90 天；要登入，本機只當快取）
  sentStatus: ids => invoke('relay_sent_status', { ids }).then(r => r?.status ?? []),
  readSync: body => invoke('relay_read_sync', { body }),   // 已讀多端同步（要本人簽章；沒登入或舊後台就回錯，前端靜默）
  avatar: node => invoke('relay_avatar', { node }),
  setAvatar: avatar => invoke('relay_set_avatar', { avatar }),
  sendAttachment: payload => invoke('relay_send_attachment', { payload }),
}
// 管理夥伴視窗（⋯ 選單）：手機只下指令，視窗在那台電腦上；要本人簽章（Rust 端沒憑證就不送）
const opsTransport = {
  partnerOp: body => invoke('android_partner_op', { body }),
  partnerOps: ids => invoke('android_partner_ops', { ids }),
  partnerArchive: body => invoke('android_partner_archive', { body }),
}
// 替電腦切換 Claude 帳號（設備卡的按鈕）：手機只下指令；要本人簽章（Rust 端沒憑證就不送）。清單只有 email、方案、是否使用中
const acctTransport = {
  acctList: node => invoke('android_acct_list', { node }),
  acctSwitch: (node, email) => invoke('android_acct_switch', { node, email }),
  acctStatus: ids => invoke('android_acct_status', { ids }),
}
// 照片放大與收到的檔案：另存＝存進 App 私有資料夾，再請外殼複製到「下載/ASN」
const photoApi = {
  fetch: id => invoke('relay_attachment_fetch', { id }),
  save: async (id, name) => savePhotoOnPhone(await invoke('relay_attachment_save', { id, name }), bridge),
  reveal: async () => bridge?.openDownloads(),
}

const info = reactive(await invoke('startup_info'))   // 響應式：改設備名後就地更新，不重載頁面
document.title = 'ASN'

const screen = ref('boot'), fatal = ref('')
const login = reactive({ phase: 'idle', provider: '', error: '' })
const onboard = reactive({ steps: [] })   // 首次登入引導要走的步驟（空＝不用）
const onboardApi = { setAccountName: name => authApi.setAccountName(name), setDeviceName: name => (name === info.window_name ? Promise.resolve() : invoke('set_window_name', { name })) }
const finishOnboard = async () => { await markOnboarded(store(ONBOARD_STORE)).catch(() => {}); location.reload() }
const loginNote = computed(() => (login.phase === 'waiting' ? `${phaseText('waiting', login.provider)}（瀏覽器登入完會自動回到 ASN；沒有回來的話，請自己切回來。）` : phaseText(login.phase, login.provider)))

async function finishLogin() {
  login.phase = 'setting'
  try {
    const out = await authApi.bind()
    const plan = afterBind(out, bridge)
    if (plan.action === 'relaunch') { bridge.relaunch(); return }
    if (plan.action === 'ask') { login.error = plan.text; login.phase = 'error'; return }
    location.reload()
  } catch (e) { login.error = errorText(e); login.phase = 'error' }
}
async function startLogin(key) {
  if (!canStart(login.phase)) return
  login.provider = key; login.error = ''; login.phase = 'waiting'
  try { await authApi.login(key) } catch (e) { login.error = errorText(e); login.phase = 'error'; return }
  await finishLogin()
}
const cancelLogin = () => { void authApi.cancel(); login.phase = 'idle' }

let savedTab = 'list'   // 上次離開時的大分頁（讀存檔後才知道）
const nav = reactive(initialNav())
const lastChat = ref('')   // 最後使用的那一位（對話分頁顯示它；存在手機本機設定，重開 App 仍記得）
const me = reactive({ psm: '', status: 'online', nick: info.window_name })
const prefs = reactive({ ...DEFAULT_PREFS })
const friends = ref([]), conn = ref('connecting'), nodeOrder = ref([])
// 設備順序與手動顯示的隱藏設備：存在這支手機自己的設定（asn-me.json 的 deviceOrder／deviceShown／deviceRemoved）當離線快取，有登入就與帳號層同步（lib/device-sync.mjs）
const devPrefs = reactive({ deviceOrder: [], deviceShown: [], deviceRemoved: [], deviceRev: 0, deviceSynced: false })
const logs = reactive({})
const avatars = ref({})
const query = ref(''), collapsed = reactive({ [ARCHIVE_GROUP_KEY]: true })   // 「已封存」群組預設收合
const archiveNote = ref('')
const banner = ref(null), shake = ref(false), refreshing = ref(false)
// 自動更新（自行安裝版才有；Rust 端與外殼都沒編進 Google Play 版）。測試用的清單網址只收 127.0.0.1（Rust 端再擋一次）
const upd = reactive(initialUpdate())
const ownerName = ref('')   // 帳號層的名字（租戶稱呼）
const updTestUrl = (() => { try { return localStorage.getItem('asnUpdateTestUrl') || null } catch { return null } })()
const updArgs = () => (updTestUrl ? { url: updTestUrl } : {})
async function checkUpdate(manual = false) {
  if (!upd.enabled || upd.checking || upd.phase === 'downloading') return
  upd.checking = true; if (manual) upd.manual = ''
  try {
    const found = await invoke('android_update_check', updArgs())
    Object.assign(upd, withAvailable(upd, found))
    if (manual) upd.manual = found?.available ? `有新版本 ${found.version}。` : '目前已是最新版。'
  } catch (e) { if (manual) upd.manual = updateCheckErrorText(e.message) } finally { upd.checking = false }   // 官網連不上、回錯誤一律說「暫時無法檢查更新」，不顯示原始錯誤
}
async function startUpdate() {
  if (upd.phase === 'downloading') return
  Object.assign(upd, withProgress(upd, { done: 0, total: 0 }), { error: '', hint: '' })
  try {
    const r = await invoke('android_update_download', updArgs())   // Rust 端下載並驗 sha256，不符就拒絕
    const out = installOutcome(bridge ? bridge.installApk(r.path) : 'unsupported')
    upd.phase = 'available'; upd.hint = out.hint
  } catch (e) { Object.assign(upd, withFailure(upd, e.message)) }
}
let core = null
const roomsHook = {}   // 群組更新的入口（畫面掛上後才有；門鈴與回到前景用）
const lastMap = reactive({})   // 夥伴 id → 最後說的一句話（名單第三行）
const refreshLast = id => { lastMap[id] = lastWords(core?.logOf(id)) }
let startCore = null
let bannerTimer = null

if (info.needs_login) {
  screen.value = 'login'
  // 已登入、只差替這支手機建節點（上次建立中斷）：不用再登入一次
  const st = await authApi.status().catch(() => null)
  if (!info.can_skip_login && st?.signed_in) void finishLogin()
} else if (info.error) {
  fatal.value = info.error
  screen.value = 'fatal'
} else {
  // 登入後第一次進來：先走首次登入引導（帳號名稱＋設備名稱）；旗標已設、帳號與設備都有名字、取不到帳號資料就直接進名單
  const plan = await planOnboarding({ store: store(ONBOARD_STORE), status: authApi.status, accountInfo: authApi.accountInfo, startup: info })
  if (plan.steps.length) { onboard.steps = plan.steps; screen.value = 'onboard' } else screen.value = 'main'
}

if (screen.value === 'main') {
  const meStore = store('me')
  const saved = (await meStore.load()) ?? {}
  Object.assign(me, { psm: '', status: 'online', ...saved.me, nick: info.window_name })
  Object.assign(devPrefs, deviceFieldsFromSaved(saved))
  const devSync = createDeviceSync({ prefs: devPrefs, api: { get: authApi.getDevicePrefs, set: authApi.setDevicePrefs }, canSync: async () => (await authApi.status().catch(() => null))?.signed_in === true })
  watch(devPrefs, () => devSync.noteLocal(), { deep: true })
  devSync.start()
  Object.assign(prefs, normalizePrefs(saved.mobilePrefs))
  ownerName.value = typeof saved.ownerName === 'string' ? saved.ownerName : ''
  lastChat.value = normalizeLastChat(saved.lastChat)
  // 重開 App 回到上次的大分頁（名單／對話／設置）；對話那頁的對象就是 lastChat
savedTab = restoreMobileTab(saved.navTab)
watch([me, prefs, devPrefs, ownerName, lastChat, () => nav.tab], () => { const { nick, ...rest } = me; void meStore.save({ ...saved, ...deviceFieldsToSave(devPrefs), me: rest, mobilePrefs: { ...prefs }, ownerName: ownerName.value, lastChat: lastChat.value, navTab: nav.tab }) }, { deep: true })
  watch(() => [me.status, me.psm], () => { void invoke('set_presence', { status: me.status, psm: me.psm ?? '' }).catch(() => {}) }, { immediate: true })

  core = new AsnCore({
    transport, store: store('chats'), selfNode: info.node, windowName: info.window_name,
    isChatVisible: async id => document.visibilityState === 'visible' && nav.tab === 'chats' && nav.sheet !== 'acct' && lastChat.value === id,   // 正在看對話分頁那位才算「看得到」（不算未讀）
    aliases: info.old_names, pollMs: info.poll_ms, rosterMs: info.roster_ms,
    log: m => console.info('[ASN]', m),
  })
  const sync = () => { const s = core.snapshot(); friends.value = s.friends; conn.value = s.conn; nodeOrder.value = s.nodeOrder; for (const f of s.friends) refreshLast(f.id) }
  const pushLog = id => { logs[id] = core.viewOf(id) }
  core.on('state', sync)
  core.on('log', id => { pushLog(id); refreshLast(id) })
  core.on('avatars', () => { avatars.value = core.avatarMap() })
  core.on('notify', n => {
    const plan = notifyPlan(n, { openId: nav.tab === 'chats' && nav.sheet !== 'acct' ? lastChat.value : '', foreground: document.visibilityState === 'visible', prefs })
    if (plan.vibrate) { if (bridge) bridge.vibrate(plan.vibrate); else navigator.vibrate?.(plan.vibrate) }
    if (plan.shake) { shake.value = true; setTimeout(() => { shake.value = false }, 700) }
    if (plan.banner) { banner.value = plan.banner; clearTimeout(bannerTimer); bannerTimer = setTimeout(() => { banner.value = null }, plan.banner.ms ?? BANNER_MS) }
  })
  startCallPoll({ anyCall: () => callOn.value, pull: why => core.pull(why) })   // 通話中每 2 秒多收一次信，結束就停
  await listen('relay-bell', () => { void core.pull('bell'); core.refreshRosterSoon(); void roomsHook.refresh?.() })   // Rust 端的門鈴（前景時有效）
  await listen('android-update-progress', p => { if (upd.phase === 'downloading') Object.assign(upd, withProgress(upd, p)) })   // 下載完才到的進度事件不能把畫面又拉回「下載中」
  upd.enabled = bridge?.selfUpdateEnabled() === true
  setInterval(() => { if (shouldAutoCheck(upd, prefs)) void checkUpdate() }, UPDATE_CHECK_MS)
  // 回到前景：立刻拉一次信、更新名單、補正在看的那位的往來記錄
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    void core.pull('resume'); core.refreshRosterSoon(); void roomsHook.refresh?.()
    if (nav.tab === 'chats' && lastChat.value) { core.markRead(lastChat.value); void core.syncHistory(lastChat.value) }
  })
  startCore = async () => { void (shouldAutoCheck(upd, prefs) && checkUpdate()); await core.start(); sync() }   // 掛上畫面之後才開始（第一次收信要連網，不能讓畫面空等）
}

// ---------- 導覽：每往下一層就推一筆瀏覽記錄，系統返回鍵＝上一頁（名單層再按才退到背景） ----------
history.replaceState(initialNav(), '')
// 回到上次的大分頁：名單那層先放著，再推一筆，系統返回鍵還是回到名單
if (savedTab !== 'list') { const next = tabNav(savedTab); history.pushState(next, ''); Object.assign(nav, next) }
window.addEventListener('popstate', e => {
  // 通話中按返回鍵＝掛斷，畫面留在原處（不跳到上一頁）
  if (callOn.value) { void liveCall?.end(); history.pushState({ tab: nav.tab, sheet: nav.sheet }, ''); return }
  Object.assign(nav, { step: 0 }, normalizeNav(e.state))
})
const go = next => { history.pushState(next, ''); Object.assign(nav, { step: 0 }, next) }
// 切大分頁：從「夥伴」出去推一筆瀏覽記錄（返回鍵回到夥伴）；其他分頁之間互換不增加記錄
function goTab(t) {
  if (nav.sheet === 'acct') {   // 「設備與帳號」頁佔著第二個分頁：點夥伴＝返回，點設置＝直接換過去；點自己不動
    if (t === 'list') history.back()
    else if (t === 'me') { const n = tabNav('me'); history.replaceState(n, ''); Object.assign(nav, n) }
    return
  }
  if (!TABS.includes(t) || t === nav.tab || nav.sheet) return
  if (nav.tab === 'list') go(tabNav(t))
  else if (t === 'list') history.back()
  else { const n = tabNav(t); history.replaceState(n, ''); Object.assign(nav, n) }
}

// 下拉重整的小動畫區（夥伴、對話兩頁各一個）：我們自己的機器人，只用 transform／opacity 動
const PtrZone = {
  props: { ptr: { type: Object, required: true } },
  setup(props) { return { text: Vue.computed(() => PULL_TEXT[props.ptr.phase]) } },
  template: `<div class="m-ptr" :class="[ptr.phase, { dragging: ptr.dragging }]" :style="{ height: ptr.h + 'px', '--p': ptr.ratio }" role="status" :aria-hidden="ptr.h === 0">
    <svg class="m-ptr-bot" viewBox="140 120 220 250" width="56" height="64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="ptrBlue" x1="20%" y1="0%" x2="80%" y2="100%"><stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#1e3a8a"/></linearGradient>
        <linearGradient id="ptrWhite" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#cbd5e1"/></linearGradient>
      </defs>
      <g class="m-ptr-body"><path d="M 180 270 C 180 270, 160 360, 250 360 C 340 360, 320 270, 320 270 Z" fill="url(#ptrBlue)"/><path d="M 190 270 C 190 270, 175 350, 250 350 C 325 350, 310 270, 310 270 Z" fill="url(#ptrWhite)"/><rect x="225" y="300" width="50" height="15" rx="7.5" fill="#f59e0b"/></g>
      <g class="m-ptr-head"><rect x="150" y="130" width="200" height="150" rx="75" fill="url(#ptrBlue)"/><rect x="160" y="140" width="180" height="130" rx="65" fill="url(#ptrWhite)"/><rect x="175" y="155" width="150" height="95" rx="45" fill="#0f172a"/>
        <g class="m-ptr-eyes" stroke="#22d3ee" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M 205 200 L 215 190 L 225 200"/><path d="M 275 200 L 285 190 L 295 200"/></g>
        <path class="m-ptr-smile" d="M 235 215 Q 250 225 265 215" stroke="#22d3ee" stroke-width="7" stroke-linecap="round" fill="none"/></g>
    </svg>
    <span class="m-ptr-tx" v-if="ptr.h > 24">{{ text }}</span>
  </div>`,
}

// 左右滑動切換大分頁的手勢狀態（夥伴／對話／設置的橫向翻頁）
const sw = reactive({ mode: '', locked: '', x0: 0, y0: 0, t0: 0, dx: 0, shift: 0, width: 360, dragging: false })

const app = createApp({
  setup() {
    // 已封存的不放進名單，另成最底下一個預設收合的「已封存（N）」群組（搜尋字同樣適用）
    const groups = computed(() => {
      const o = { query: query.value, selfNode: info.node, selfName: info.window_name, deviceOrder: devPrefs.deviceOrder, plainText: plain }
      return withArchivedGroup(rosterGroups(activeFriends(friends.value), o), rosterGroups(archivedFriends(friends.value), o).flatMap(g => g.items))
    })
    // ---------- 群組對話：名單裡的一個分組（永遠顯示，沒有群組時有「建立群組」「加入群組」）；點進去在對話分頁看訊息、發言（lastChat 記成 room:<代號>） ----------
    // 資料與動作都在 lib/room-hub.mjs（電腦版共用）；發言與讀取走 Rust 指令並帶本人簽章
    const groupApi = createGroupApi(invoke)
    const hub = createRoomHub({ invoke, groupApi, selfNode: info.node, windowName: info.window_name, readCmd: 'android_room_read', postCmd: 'android_room_post', reactive, visible: () => document.visibilityState === 'visible' })
    const rooms = computed(() => hub.st.rooms)
    const roomsLoaded = computed(() => hub.st.loaded), roomsErr = computed(() => hub.st.err)
    const roomLogs = hub.st.logs   // 群組代號 → 對話記錄
    const roomNote = computed({ get: () => hub.st.note, set: v => { hub.st.note = v } })   // 對話頁上方的一行提示（讀不到、發言失敗）
    // 最近有活動：24 小時內有往來的夥伴與群組（名單最上面；同一位在設備分組照常出現）
    const recentTick = ref(Date.now())
    setInterval(() => { recentTick.value = Date.now() }, 60_000)
    const recentRows = computed(() => recentActivity({ friends: groups.value.filter(g => g.kind !== 'archived').flatMap(g => g.items), logOf: id => { void lastMap[id]; return core?.logOf(id) ?? [] }, rooms: roomRows.value, now: Math.max(recentTick.value, Date.now()) }))
    const plusOpen = ref(false)   // 名單右上角「＋」選單
    const pickPlus = op => { plusOpen.value = false; if (op === 'create') groupFlow.openCreate(); else if (op === 'join') groupFlow.openJoin(); else openLaunch('') }
    const roomRows = computed(() => hub.rows({ query: query.value, plainText: plain }))
    const roomRowOf = id => hub.rowOf(id)
    const roomEmptyText = computed(() => (query.value.trim() ? '找不到符合的群組。' : hub.st.err ? ROOM_LOAD_FAIL_TEXT : ROOM_EMPTY_HINT))
    async function refreshRooms() {
      await hub.refresh()
      if (isRoomChat(lastChat.value) && nav.tab === 'chats') await showRoom()
    }
    roomsHook.refresh = refreshRooms
    // 讀這個群組新的訊息（接在已有的後面）與待主持人確認的卡片；在看的時候順便標已讀
    async function showRoom() { const id = roomIdOf(lastChat.value); await hub.read(id); await hub.loadCards(id) }
    const postRoom = (chatId, text, opts) => hub.post(roomIdOf(chatId), text, { replySeq: opts?.replySeq })
    const chatCards = computed(() => (isRoomChat(lastChat.value) ? hub.st.cards[roomIdOf(lastChat.value)] : null) ?? [])
    const decideCard = (chatId, cardId, approve) => hub.decide(roomIdOf(chatId), cardId, approve)
    // 群組的對話框（建立、邀請、加入、成員與設定）：蓋在畫面上的一層，系統返回鍵＝關掉它
    const groupFlow = createGroupFlow({
      api: groupApi, copy: copyText, reactive,
      openRoom: rid => openRoom(roomChatId(rid)),
      refreshRooms: () => refreshRooms(),
      getFriends: () => friends.value,
      getRoom: rid => hub.raw(rid),
      logOf: f => logs[f.id] ?? [],
    })
    watch(() => groupFlow.state.view, v => {
      if (v && nav.sheet !== 'group') go({ tab: nav.tab, sheet: 'group' })
      else if (!v && nav.sheet === 'group') history.back()
    })
    watch(() => nav.sheet, s => { if (s !== 'group' && groupFlow.state.view) groupFlow.close() })
    // 對話標頭「⋯」多出的項目：一對一對話「邀請別人加入」；群組再加「成員與設定」
    const groupItems = computed(() => {
      const f = chatFriend.value
      if (!f) return []
      if (f.room) return [{ key: 'invite', label: '邀請別人加入' }, { key: 'addai', label: '加我的另一個 AI' }, { key: 'manage', label: '成員與設定' }]
      return canInviteFrom(f) ? [{ key: 'invite', label: '邀請別人加入' }] : []
    })
    function pickGroup(key) {
      const f = chatFriend.value
      if (!f) return
      history.back()   // 先收起「⋯」選單，再開群組對話框
      setTimeout(() => {
        if (key === 'manage' && f.room) groupFlow.openManage(roomIdOf(f.id))
        else if (key === 'addai' && f.room) groupFlow.openManage(roomIdOf(f.id), { focusAdd: true })
        else if (f.room) groupFlow.openInvite({ type: 'room', roomId: roomIdOf(f.id), name: f.nick })
        else groupFlow.openInvite({ type: 'friend', friend: f })
      }, 80)
    }
    // 邀請連結（Android App Links：https://asnmessenger.web.app/i/<碼>）：外殼收到後由 Rust 通知；啟動前就收到的用 invite_pending 補取
    const onInviteCode = code => { if (typeof code === 'string' && code && screen.value === 'main') groupFlow.openJoin(code) }
    if (screen.value === 'main') {
      setInterval(() => { if (document.visibilityState === 'visible') void refreshRooms() }, ROOM_POLL_MS)
      void listen('asn:invite', onInviteCode)
      void invoke('invite_pending').then(onInviteCode).catch(() => {})
      void refreshRooms()
    }
    const unreadTotal = computed(() => totalUnreadWithRooms(totalUnread(friends.value), rooms.value))
    const emptyText = computed(() => (query.value.trim() ? '找不到符合的聯絡人。' : conn.value === 'off' ? '連不上 ASN，請檢查網路。' : '名單上還沒有夥伴。'))
    const avOf = f => avatarSrc(f, { avatars: avatars.value })
    const avById = id => { const f = friends.value.find(x => x.id === id); return f ? avOf(f) : '' }
    const meAv = computed(() => selfAvatarSrc({ selfNode: info.node, windowName: info.window_name, avatars: avatars.value }))
    const chatState = computed(() => {
      if (!isRoomChat(lastChat.value)) return chatPageState(friends.value, lastChat.value)
      const row = roomRowOf(roomIdOf(lastChat.value))
      if (row) return { kind: 'friend', friend: roomPseudoFriend(row), text: '' }
      return roomsLoaded.value ? { kind: 'empty', friend: null, text: ROOM_EMPTY_TEXT } : { kind: 'loading', friend: null, text: roomsErr.value ? ROOM_LOAD_FAIL_TEXT : '載入中…' }
    })
    const chatFriend = computed(() => chatState.value.friend)
    const chatEmptyText = computed(() => chatState.value.text)
    const chatLog = computed(() => (isRoomChat(lastChat.value) ? roomLogs[roomIdOf(lastChat.value)] : logs[lastChat.value]) ?? [])
    // 點名單上的群組：成為「最後使用」並切到對話分頁
    function openRoom(chatId) { lastChat.value = chatId; banner.value = null; roomNote.value = ''; goTab('chats') }

    // 點夥伴（或橫幅）：那位成為「最後使用」，並切到對話分頁
    function openChat(id) {
      const f = core.friends.get(id); if (!f) return
      lastChat.value = id
      banner.value = null
      goTab('chats')
    }
    const pushLog = id => { logs[id] = core.viewOf(id) }
    const loadOlder = id => core.loadOlder(id)   // 對話往上捲到頂：載入更舊的信
    // 對話分頁正在顯示某位：標已讀、補往來。切到對話分頁、換了最後使用的那位、名單載入完都會跑
    function showLastChat() {
      const id = lastChat.value
      if (nav.sheet === 'acct') return   // 對話被「選項」頁蓋住，沒有在看，不標已讀
      if (isRoomChat(id)) { if (nav.tab === 'chats') void showRoom(); return }
      if (nav.tab !== 'chats' || !id || !core?.friends.get(id)) return
      core.markRead(id)
      pushLog(id)
      void core.syncHistory(id)   // 向後台補這位夥伴 90 天的往來（以後台為準；失敗就用本機快取）
    }
    watch([() => nav.tab, () => nav.sheet, lastChat, () => friends.value.length, () => rooms.value.length], showLastChat, { immediate: true })
    const back = () => history.back()
    const tabLabel = t => tabLabelOf(t, nav, ACCT_PAGE_TITLE)   // 設備與帳號頁開著時，第二個分頁的標籤跟頁標題一致（#268）
    const openBanner = () => { const b = banner.value; banner.value = null; if (b) openChat(b.id) }
    // 橫幅上的「接班換手」：開啟那位的對話，直接帶到「接班換手」的確認框（不能換手時停在「⋯」選單，由選單說明原因）
    async function bannerHandover() {
      const b = banner.value; banner.value = null
      if (!b) return
      openChat(b.id)
      await Vue.nextTick()
      await loadLaunchers()
      openOps()
      if (opsItems.value.find(i => i.key === 'handover')?.ok) pickOp('handover')
    }

    const callApi = bridge?.call?.available() ? {
      phaseText: MOBILE_PHASE_TEXT,
      newCall: ({ hints } = {}) => (liveCall = createMobileCall({
        hints, native: bridge.call, reactive, log: m => console.info('[ASN]', m),
        send: async (text, opts) => { const r = await core.send(lastChat.value, text, opts); if (!r.ok) throw new Error(r.error || '寄信失敗') },   // 寄給目前這位；換人時通話會先掛斷
      })),
    } : null
    // 語音輸入（純輸入法，不限對象）：同一套外殼；這支手機沒有語音辨識服務就不給（畫面不出現按鈕）
    const dictApi = canDictate(bridge?.call) ? {
      newDictation: ({ hints, onText } = {}) => createMobileDictation({ hints, onText, native: bridge.call, reactive, log: m => console.info('[ASN]', m) }),
    } : null
    const onCallState = on => { callOn.value = on; bridge?.keepAwake(on) }
    const sendTo = async (id, text, opts) => { if (isRoomChat(id)) return postRoom(id, text, opts); const r = await core.send(id, text, opts); if (!r.ok) console.info('[ASN] send failed', r.error) }
    const nudgeTo = id => { if (!isRoomChat(id)) core.nudge(id) }   // 群組沒有震動與傳檔（工具列的鈕在群組畫面已藏起來）
    const sendAttachTo = async (id, item, caption) => { if (isRoomChat(id)) { await hub.postAttachment(roomIdOf(id), item, caption); if (nav.tab === 'chats') void showRoom(); return } const r = await core.sendAttachment(id, item, caption); if (!r.ok) console.info('[ASN] attachment failed', r.error) }
    // ---------- 使用指引：設置分頁的一個項目，點進去是獨立一頁（先列篇目，再看內文），內容沿用電腦版的篇目 ----------
    const guides = phoneGuideList()
    const guideOpen = computed(() => (nav.sheet === 'guide' ? phoneGuide(nav.guide) : null))
    // 設置分頁＝分類列表（每列一行目前值），點一列進該項的滿版頁（左上返回回列表）
    const settingRows = computed(() => mobileSettingRows({ name: myName.value, hasUpload: selfHasUpload.value, vibrateNudge: prefs.vibrateNudge, vibrateMsg: prefs.vibrateMsg, updateEnabled: upd.enabled, autoUpdate: prefs.autoUpdate, version: info.version, devices: acctDevs.value }))
    const settingCat = computed(() => (nav.sheet === 'setting' ? nav.cat : ''))
    const settingTitle = computed(() => mobileSettingTitle(settingCat.value))
    // 設備與帳號（#268）開的是名單設備卡「選項」的同一頁（先看設備列表），其他分類開設置的滿版頁
    const openSetting = key => { if (nav.sheet) return; if (key === 'devices') void openAcct(); else go(settingNav(key)) }
    const openGuides = () => { if (!nav.sheet) go(guideNav()) }
    const openGuide = key => go(guideNav(key))
    // ---------- 開新夥伴（遠端開視窗）：手機只下指令，視窗開在那台電腦上。要本人簽章（Rust 端沒憑證就不送） ----------
    const lch = reactive({ ...initialLaunch(), vphase: 'sending' })
    const lchData = reactive({ machines: {}, loaded: false, error: '' })
    const acctSigned = () => (acct.value.known ? acct.value.signed_in : null)   // 還沒查到登入狀態＝null，不是「沒登入」
    const lchCtx = computed(() => ({ machines: lchData.machines, loaded: lchData.loaded, signedIn: acctSigned(), authError: acct.value.error, friends: friends.value }))
    const lchDevices = computed(() => launchDevices(friends.value, { selfNode: info.node, nodeOrder: nodeOrder.value, removed: devPrefs.deviceRemoved, ...lchCtx.value }))
    const lchElig = computed(() => (lch.node ? launchEligibility(lch.node, lchCtx.value) : { ok: false, reason: '' }))
    const lchFormErr = computed(() => (lch.node ? launchFormError(lch, lchElig.value) : ''))
    const lchChoices = computed(() => launchChoices(lchData.machines[lch.node]))
    // 「運行」二選一：依目前選的模型（目錄決定哪種可用，不支援的反灰並寫原因）
    const lchRun = computed(() => runChoices(lchChoices.value.models.find(m => m.profileId === lch.profile)))
    async function loadLaunchers() {
      lchData.error = ''
      try { lchData.machines = machinesByNode(await invoke('android_launchers', {})); lchData.loaded = true } catch (e) { lchData.loaded = false; lchData.error = launchErrorText(e.message) }
    }
    function pickLaunchDevice(node) {
      if (!launchEligibility(node, lchCtx.value).ok) return
      const c = launchChoices(lchData.machines[node])
      Object.assign(lch, { node, deviceLabel: lchDevices.value.find(d => d.key === node)?.label ?? '', error: '' })
      if (!c.models.some(m => m.profileId === lch.profile)) lch.profile = c.models[0]?.profileId ?? ''
      if (!c.cwds.includes(lch.cwd)) lch.cwd = c.cwds[0] ?? ''
      if (!lch.name.trim()) lch.name = defaultPartnerName(friends.value, lch.profile)
    }
    function openLaunch(node) {
      if (lch.phase === 'progress' && lch.vphase !== 'done' && lch.vphase !== 'failed') { go(launchNav()); return }   // 還在開：回到進度畫面
      Object.assign(lch, initialLaunch(), { vphase: 'sending' })
      go(launchNav())
      void loadLaunchers().then(() => { if (node) { pickLaunchDevice(node); nextLaunch() } })   // 從某台電腦進來＝第 1 頁已選好，直接到第 2 頁
    }
    // 第 2 頁才顯示該電腦可用的模型與資料夾；沒選電腦或那台不能開就留在第 1 頁
    const lchStep2 = computed(() => nav.sheet === 'launch' && nav.step === 2 && !!lch.node && lch.phase === 'form')
    const lchCanNext = computed(() => !!lch.node && lchElig.value.ok)
    function nextLaunch() { if (!lchCanNext.value || nav.step === 2) return; lch.error = ''; go(launchNav(2)) }
    // 開好後或失敗後關閉整個面板：在第 2 頁要退兩筆記錄
    const closeLaunch = () => history.go(nav.step === 2 ? -2 : -1)
    // ---------- 設備卡「切換 Claude 帳號」：選帳號 → 確認 → 送出並等對方電腦回報 ----------
    const acctKeys = computed(() => new Set(acctButtonDevices(groups.value, info.node).filter(g => !devPrefs.deviceRemoved.includes(g.node)).map(g => g.key)))
    // 整頁＝電腦版「設備與帳號」：資料用電腦版同一份整理函式；別台電腦的帳號逐台向後台讀（只讀選到的那台）
    const acctSw = reactive({ phase: 'pick', page: 'list', node: '', picked: '', reports: {}, view: null, removedOpen: false })
    const acctAllDevs = computed(() => acctDeviceTree({ friends: friends.value, nodeOrder: nodeOrder.value, deviceOrder: devPrefs.deviceOrder, shown: devPrefs.deviceShown, removed: devPrefs.deviceRemoved, selfNode: info.node, reports: acctSw.reports, launchers: lchData.machines }))
    // 整台離線、夥伴全封存、沒未讀的設備不列頁籤；收在「已隱藏的設備」，可手動顯示
    const acctDevs = computed(() => visibleRows(acctAllDevs.value))   // 列表＝全部設備（含已隱藏，淡色標「已隱藏」）；永久移除的收在底部
    const acctRemoved = computed(() => removedRows(acctAllDevs.value))
    const acctFlags = computed(() => moveFlags(acctDevs.value, info.node))
    const showHiddenDevice = key => { devPrefs.deviceShown = showDevice(devPrefs.deviceShown, key) }
    // 細部頁：只有 page 是 detail 且那台還在列表裡才有（被移除或消失就退回列表）
    const acctCur = computed(() => (acctSw.page === 'detail' ? acctDevs.value.find(d => d.key === acctSw.node) ?? null : null))
    const acctCanRemove = computed(() => canRemoveRow(acctCur.value))
    // 設備活過來（又有在線視窗或未讀）就自動從永久移除名單解除
    watch([() => friends.value, () => devPrefs.deviceRemoved], () => { const next = pruneRemoved(devPrefs.deviceRemoved, friends.value, { selfNode: info.node }); if (next.length !== devPrefs.deviceRemoved.length) devPrefs.deviceRemoved = next }, { deep: true })
    const acctLabel = computed(() => acctCur.value?.label ?? '')
    const acctRep = computed(() => acctSw.reports[acctCur.value?.key] ?? null)
    const acctView = computed(() => acctSheetView(acctClaudeRemote(acctRep.value), acctSw.picked))
    const acctConfirm = computed(() => acctConfirmText(acctLabel.value, acctView.value.currentEmail, acctView.value.pickEmail))
    let acctToken = 0, acctEpoch = 0
    async function loadAcct(node, force = false) {
      if (!acctNeedsLoad(acctDevs.value.find(d => d.key === node))) return
      const old = acctSw.reports[node]
      if (!force && old && (old.loading || !old.msg)) return   // 讀過或正在讀就不重讀；上次失敗的再點一次會重試
      const epoch = acctEpoch
      acctSw.reports[node] = { loading: true, asnOnline: false, reportedAt: '', msg: '', list: [] }
      try {
        const v = await acctTransport.acctList(node)
        if (epoch === acctEpoch) acctSw.reports[node] = { loading: false, asnOnline: v?.asn_online === true, reportedAt: v?.reported_at ?? '', msg: '', list: v?.accounts ?? [] }
      } catch (e) { if (epoch === acctEpoch) acctSw.reports[node] = { loading: false, asnOnline: false, reportedAt: '', msg: acctErrorText(e), list: [] } }
    }
    async function openAcct(g) {
      if (nav.sheet) return
      acctEpoch++
      Object.assign(acctSw, { phase: 'pick', page: 'list', picked: '', view: null, reports: {}, removedOpen: false })
      // 從夥伴列表某台設備旁的「選項」進來：直接開那一台的細部頁；從別處進來先看列表
      if (g?.node && acctDevs.value.some(d => d.key === g.node)) { acctSw.node = g.node; acctSw.page = 'detail' } else acctSw.node = ''
      go(acctNav())
      if (!lchData.loaded) void loadLaunchers()
      if (acctSw.page === 'detail') void loadAcct(g.node)
    }
    function openAcctDevice(key) {
      if (acctSw.phase !== 'pick') return
      acctSw.node = key; acctSw.picked = ''; acctSw.page = 'detail'
      void loadAcct(key)
    }
    // 返回：細部頁回列表；列表就離開這一頁。標題列的返回鍵與細部頁頂端的「‹ 返回」共用
    const acctBackToList = () => { acctSw.phase = 'pick'; acctSw.picked = ''; acctSw.page = 'list' }
    const acctHeaderBack = () => { if (acctSw.page === 'detail' && acctSw.phase !== 'run') acctBackToList(); else back() }
    // 被隱藏的設備：顯示回名單／永久移除（要先看過二次確認）／恢復
    const acctShowBack = () => { if (acctCur.value) showHiddenDevice(acctCur.value.key) }
    const acctAskRemove = () => { if (acctSw.phase === 'pick' && acctCanRemove.value) acctSw.phase = 'rm' }
    const acctRemoveText = computed(() => DEVICE_TEXT.confirmRemove(acctCur.value?.label))
    function acctRemoveNow() {
      if (acctSw.phase !== 'rm' || !acctCanRemove.value) return
      devPrefs.deviceRemoved = removeDevice(devPrefs.deviceRemoved, acctCur.value.key, { selfNode: info.node })
      acctBackToList()
    }
    const acctRestore = key => { devPrefs.deviceRemoved = restoreDevice(devPrefs.deviceRemoved, key) }
    // 排序：每列左邊有「排序把手」，只有按住把手才會拖（把手 touch-action:none），其餘地方照常捲動、點一下進細部頁；把手聚焦後也能用上下鍵移動
    const acctDrag = reactive({ key: '', over: '', after: false })
    const acctOrderKeys = () => acctAllDevs.value.map(d => d.key)
    const acctVisibleKeys = () => acctDevs.value.map(d => d.key)
    function acctMove(key, dir) { devPrefs.deviceOrder = moveDevice(acctOrderKeys(), key, dir, { selfNode: info.node, visible: acctVisibleKeys() }) }
    function gripDown(key, e) {
      if (key === info.node || acctSw.phase !== 'pick') return
      e.currentTarget?.setPointerCapture?.(e.pointerId)
      acctDrag.key = key; acctDrag.over = ''; acctDrag.after = false
    }
    function gripMove(e) {
      if (!acctDrag.key) return
      const rows = [...document.querySelectorAll('.m-dv-row')].map(el => { const r = el.getBoundingClientRect(); return { key: el.dataset.dev, top: r.top, height: r.height } })
      const s = dropSlot(rows, e.clientY)
      acctDrag.over = s.target; acctDrag.after = s.after
    }
    function gripUp() {
      if (acctDrag.key && acctDrag.over) devPrefs.deviceOrder = reorderDevice(acctOrderKeys(), acctDrag.key, acctDrag.over, acctDrag.after, { selfNode: info.node })
      Object.assign(acctDrag, { key: '', over: '', after: false })
    }
    const gripKey = (key, e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); acctMove(key, e.key === 'ArrowUp' ? -1 : 1) } }
    // 點某個帳號的「切換」＝選好它並進確認畫面（要先看過確認才能送出）
    function startAcctSwitch(email) {
      if (acctSw.phase !== 'pick') return
      acctSw.picked = email
      if (acctView.value.canPick && acctView.value.pickEmail) acctSw.phase = 'confirm'
      else acctSw.picked = ''
    }
    const acctBackToPick = () => { acctSw.phase = 'pick'; acctSw.picked = '' }
    async function submitAcct() {
      if (acctSw.phase !== 'confirm' || !acctView.value.pickEmail) return   // 一定要先看過確認畫面才送
      const token = ++acctToken, email = acctView.value.pickEmail, node = acctCur.value.key
      acctSw.phase = 'run'
      acctSw.view = await runAcctSwitch(acctTransport, node, email, { onUpdate: v => { if (token === acctToken) acctSw.view = v }, cancelled: () => token !== acctToken })
    }
    watch(() => nav.sheet, s => { if (s !== 'acct') { acctToken++; acctEpoch++ } })
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    async function trackLaunch(t) {
      const stop = Date.now() + LAUNCH_GIVE_UP_MS
      while (lch.id === t.id && Date.now() < stop) {
        await sleep(LAUNCH_POLL_MS)
        let row = null
        try { row = ((await invoke('android_launchers', { ids: [t.id] }))?.launches ?? []).find(l => l.id === t.id) } catch { /* 下一輪再問 */ }
        if (row?.status === 'ok' || row?.status === 'unconfirmed') await core.refreshRoster()
        const appeared = appearedIn(friends.value, t.node, t.name)
        const v = progressView(row, appeared, t.name)
        if (lch.id !== t.id) return
        Object.assign(lch, { vphase: v.phase, text: v.text })
        if (appeared) {
          lch.friendId = friendId(t.node, t.name)
          if (nav.sheet !== 'launch') banner.value = { id: lch.friendId, nick: t.name, line: '已經開好了，點一下開始對話', status: 'online', hue: 200 }
          return
        }
        if (v.phase === 'failed') return
      }
      if (lch.id === t.id) Object.assign(lch, { vphase: 'waiting', text: '還沒看到新視窗出現在名單上。可以稍後再看看名單。' })
    }
    async function submitLaunch() {
      lch.error = lchFormErr.value
      if (lch.error || lch.busy) return   // 不能開的電腦（不在線、沒開放、沒登入）或欄位不對：不送出
      lch.busy = true
      try {
        const name = lch.name.trim()
        const r = await invoke('android_launch', { body: buildLaunchRequest(lch) })
        if (!r?.id) throw new Error('送出失敗')
        Object.assign(lch, { phase: 'progress', id: r.id, since: Date.now(), friendId: '', detail: '', ...(({ phase, text }) => ({ vphase: phase, text }))(progressView(null, false)) })
        void trackLaunch({ id: r.id, node: lch.node, name })
      } catch (e) { lch.error = launchErrorText(e.message) } finally { lch.busy = false }
    }
    function openLaunched() { const id = lch.friendId; if (!id) return; closeLaunch(); setTimeout(() => openChat(id), 50) }
    // ---------- 「⋯」選單：管理這位夥伴的視窗（詳情、改名、切換模型、關閉視窗、接班換手；離線的只有喚醒） ----------
    // 判斷全部用 lib/partner-ops.mjs 的 menuItems／opFormError／progressView，手機不另寫一套。手機只下指令，視窗在那台電腦上
    const opsCtx = computed(() => ({ machines: lchData.machines, loaded: lchData.loaded, signedIn: acctSigned(), authError: acct.value.error, friends: friends.value, nonWindowNodes: [info.node] }))
    const opsItems = computed(() => (chatFriend.value ? manageItems(chatFriend.value, opsCtx.value) : []))
    // 選單畫面上的列：最前面固定「背景／前台切換」（手機不能切換，永遠反灰並說明），接著 manageItems 的全部項目，順序和電腦版一致
    const opsRows = computed(() => (opsItems.value.length ? [{ key: 'console', label: BUDDY_CONSOLE_LABEL, ok: false, reason: '手機不能切換視窗的前景或背景，要到放著這個視窗的電腦上操作' }, ...opsItems.value] : []))
    const opsView = computed(() => sharedWhy(opsRows.value))   // 同一個原因只在選單最上方寫一次
    const ops = reactive({ phase: 'menu', newName: '', note: '', ack: false, model: '', error: '', view: null })
    const opsText = computed(() => opDialogText(ops.phase, chatFriend.value?.agent || chatFriend.value?.nick || '', chatFriend.value?.device || '', dialogEngine(chatFriend.value)))
    const opsTitle = computed(() => (ops.phase === 'menu' ? (chatFriend.value?.nick ?? '') : opsText.value.title || OP_LABEL[ops.phase] || ''))
    const opsModels = phoneModels(), opsModelNote = MODEL_NOTE
    const opsIsPi = computed(() => ['pi', 'acp'].includes(partnerEngine(chatFriend.value)))   // pi 與內建通道的工作者沒有固定的模型清單：改成輸入框（Claude 的常用清單對它們不適用）
    const opsRun = ref(null)   // 對話頁頂端的進度：{ op, view }
    const opsBanner = computed(() => runBanner(opsRun.value))
    let opsToken = 0
    function openOps() {
      if ((!opsItems.value.length && !groupItems.value.length) || nav.sheet) return
      Object.assign(ops, { phase: 'menu', newName: chatFriend.value?.agent ?? '', note: '', ack: false, model: '', error: '', view: null })
      opsToken++
      go(opsNav())
      void loadLaunchers()   // 各台電腦的在線與開放狀態（選單的可按條件）
    }
    function pickOp(op) {
      const item = opsItems.value.find(i => i.key === op)
      if (!item || !item.ok) return
      ops.error = ''
      if (op === 'archive' || op === 'unarchive') { history.back(); void setArchived(chatFriend.value, op === 'archive'); return }
      if (opStep(op) === 'run') void submitOp(op)
      else ops.phase = op
    }
    async function submitOp(op) {
      const f = chatFriend.value
      if (!f) return
      const item = opsItems.value.find(i => i.key === op)
      const input = { newName: ops.newName, model: ops.model, note: ops.note, ack: ops.ack }
      const err = opFormError(f, op, input, item)
      if (err) { ops.error = err; return }
      const token = ++opsToken
      const inSheet = showsInSheet(op)
      if (inSheet) ops.phase = 'info'
      else history.back()
      const set = v => { if (inSheet) { if (token === opsToken) ops.view = v } else opsRun.value = { op, view: v } }
      set({ phase: 'sent', done: false, text: '正在發送指令…' })
      const v = await runPartnerOp(opsTransport, f, op, input, { onUpdate: set, cancelled: () => inSheet && token !== opsToken })
      if (!inSheet && v?.phase === 'done') {
        await core.refreshRoster()   // 狀態與名字變了：重新拉名單；改名後對話分頁跳到新名字
        const next = renamedChatId(f, op, input, v)
        if (next && core.friends.get(next)) lastChat.value = next
      }
    }
    // 封存／取消封存：記在帳號層（後台），立刻重新拉名單；結果用名單上方的一行字說明（對話頁在進度條上顯示）
    let archiveNoteTimer = null
    async function setArchived(f, archived) {
      if (!f) return
      const r = await runArchive(opsTransport, f, archived)
      if (r.ok) await core.refreshRoster()
      archiveNote.value = r.text
      clearTimeout(archiveNoteTimer)
      archiveNoteTimer = setTimeout(() => { archiveNote.value = '' }, 6000)
      opsRun.value = { op: 'archive', view: { phase: r.ok ? 'done' : 'failed', done: true, text: r.text } }
    }
    const dismissRun = () => { opsRun.value = null }
    // ---------- 別台電腦／雲端代理要密碼（#26 第二期）：跳出確認面板，本人輸入後在 Rust 端加密才送出 ----------
    // 查清單、取公鑰、加密、送回全在 Rust 端（android_secret_*）；這裡只顯示說明與收輸入。沒登入或後台還沒部署就靜默略過
    const sec = reactive({ cur: null, secret: '', error: '', busy: false, left: 0 })
    const secDismissed = new Set()
    let secTimer = 0
    const secCountdown = computed(() => secretCountdown(sec.left))
    const secClose = () => { clearInterval(secTimer); sec.secret = ''; sec.cur = null; sec.busy = false }
    async function checkSecrets() {
      if (sec.busy || sec.cur || nav.sheet || !acct.value.signed_in || document.visibilityState !== 'visible') return
      let list
      try { list = secretList(await invoke('android_secret_pending')) } catch { return }
      const next = secretNext(list, secDismissed)
      if (!next || nav.sheet) return
      Object.assign(sec, { cur: next, secret: '', error: '', busy: false, left: next.secondsLeft })
      clearInterval(secTimer)
      secTimer = setInterval(() => { if (sec.left > 0) sec.left -= 1; else { secDismissed.add(sec.cur?.id); history.back() } }, 1000)
      go(secretNav())
    }
    async function answerSecret(deny) {
      const cur = sec.cur
      if (!cur || sec.busy) return
      if (!deny) { const err = secretValidate(sec.secret); if (err) { sec.error = err; return } }
      sec.busy = true; sec.error = ''
      const value = deny ? null : sec.secret
      sec.secret = ''
      try { await invoke('android_secret_reply', { id: cur.id, secret: value }); history.back() }
      catch (e) { sec.error = secretError(e); sec.busy = false }
    }
    const laterSecret = () => { if (sec.cur) secDismissed.add(sec.cur.id); history.back() }
    watch(() => nav.sheet, s => { if (s !== 'secret' && sec.cur) secClose() })
    document.addEventListener('visibilitychange', () => { void checkSecrets() })
    setInterval(() => { void checkSecrets() }, SECRET_POLL_MS)
    void listen('relay-bell', () => { void checkSecrets() })
    // ---------- 電腦要往終端送字／代答提問（#285、#296）：跳出確認面板，本人按確認或拒絕；桌面才能建立請求，手機只能決定 ----------
    // 預覽文字只給本人看（不寫儲存、不進 console）；沒登入或後台還沒部署就靜默略過；通知只敲門鈴，不帶內容
    const tq = reactive({ cur: null, choice: null, error: '', busy: false, left: 0 })
    const tqDismissed = new Set()
    let tqTimer = 0
    const tqCountdown = computed(() => tqCountdownText(tq.left))
    const tqClose = () => { clearInterval(tqTimer); tq.cur = null; tq.choice = null; tq.busy = false }
    const tqDeviceName = node => friends.value.find(f => f.node === node && f.device)?.device ?? ''
    async function checkTermReqs() {
      if (tq.busy || tq.cur || sec.cur || nav.sheet || !acct.value.signed_in || document.visibilityState !== 'visible') return
      let list
      try { list = tqList(await invoke('android_term_req_list'), tqDeviceName) } catch { return }
      const next = tqNext(list, tqDismissed)
      if (!next || nav.sheet) return
      Object.assign(tq, { cur: next, choice: null, error: '', busy: false, left: next.secondsLeft })
      clearInterval(tqTimer)
      tqTimer = setInterval(() => { if (tq.left > 0) tq.left -= 1; else { tqDismissed.add(tq.cur?.id); history.back() } }, 1000)
      go(termReqNav())
    }
    async function decideTermReq(decision) {
      const cur = tq.cur
      if (!cur || tq.busy) return
      const args = tqDecideArgs(cur, decision, tq.choice)
      if (!args) { tq.error = TERMREQ_TEXT.pickFirst; return }
      tq.busy = true; tq.error = ''
      try { await invoke('android_term_req_decide', { id: args.id, decision: args.decision, choiceN: args.choiceN, hash: args.hash }); history.back() }
      catch (e) { tq.error = tqError(e); tq.busy = false }
    }
    const laterTermReq = () => { if (tq.cur) tqDismissed.add(tq.cur.id); history.back() }
    watch(() => nav.sheet, s => { if (s !== 'termreq' && tq.cur) tqClose() })
    document.addEventListener('visibilitychange', () => { void checkTermReqs() })
    setInterval(() => { void checkTermReqs() }, TQ_POLL_MS)
    void listen('relay-bell', () => { void checkTermReqs() })
    // 名單第三行「最後一句話」：本機有記錄就用；沒有的（例如剛裝）向後台補一次往來（每位最多一次、依畫面順序、慢慢來、整個執行期有上限），補到的記錄存在本機當快取
    const lastOf = id => lastMap[id] ?? ''
    const backfillTried = new Set()
    let backfilling = false
    async function backfillLast() {
      if (backfilling || !acct.value.signed_in) return
      backfilling = true
      try {
        for (;;) {
          const order = groups.value.flatMap(g => g.items)
          const [id] = backfillQueue(order, { lastOf, tried: backfillTried })
          if (!id) break
          backfillTried.add(id)
          await core.syncHistory(id)
          refreshLast(id)
          await new Promise(r => setTimeout(r, BACKFILL_GAP_MS))
        }
      } finally { backfilling = false }
    }
    const refreshAll = async () => { refreshing.value = true; try { await Promise.all([core.refreshRoster(), core.pull('manual')]) } finally { refreshing.value = false } }
    // 下拉重整：頁面捲到最上面時往下拉，頂端長出機器人；拉過門檻放開才更新，完成後收回。夥伴與對話兩頁各一組（設置頁沒有）
    function makePtr() {
      const ptr = reactive({ h: 0, ratio: 0, phase: 'idle', dragging: false, el: null })
      let y0 = null
      const set = h => { ptr.h = h; ptr.ratio = pullRatio(h); ptr.phase = pullPhase(h, refreshing.value) }
      const start = e => { y0 = !refreshing.value && (ptr.el?.scrollTop ?? 1) <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null }
      const move = e => {
        if (y0 === null) return
        if (sw.locked === 'h') { y0 = null; ptr.dragging = false; set(0); return }   // 已經是左右滑動：不拉重整
        const dy = e.touches[0].clientY - y0
        if (dy <= 0 || (ptr.el?.scrollTop ?? 1) > 0) { if (ptr.h) { set(0); ptr.dragging = false } return }
        if (e.cancelable) e.preventDefault()   // 拉到頂時不讓系統的捲動／回彈搶走手勢
        ptr.dragging = true
        set(pullHeight(dy))
      }
      const end = async () => {
        if (y0 === null) return
        y0 = null; ptr.dragging = false
        if (!shouldRefreshOnRelease(ptr.h, refreshing.value)) { set(0); return }
        const t0 = Date.now()
        ptr.h = PTR_LOADING_H; ptr.phase = 'loading'
        await refreshAll()
        await new Promise(r => setTimeout(r, Math.max(0, 700 - (Date.now() - t0))))   // 至少讓「更新中…」看得到一下
        set(0)
      }
      return { ptr, start, move, end }
    }
    const pf = makePtr()

    // 左右滑動切換大分頁。夥伴／對話／設置三頁並排，手指拖動時整排跟著動，放開吸附到最近的一頁。
    // 邊緣 24px 留給系統的返回手勢；輸入框、工具列、放大照片上不接手；水平位移要明顯大於垂直（2 倍）才算，所以上下捲動與文字選取不會被誤判。
    const idx = computed(() => tabIndex(nav.tab))
    const pagerStyle = computed(() => ({ transform: `translate3d(calc(${-idx.value * 100 / 3}% + ${sw.shift}px), 0, 0)` }))
    const indicator = computed(() => indicatorPos(idx.value, sw.mode === 'pager' ? sw.shift : 0, sw.width))
    function swipeStart(e, mode) {
      sw.mode = ''; sw.locked = ''
      if (e.touches.length !== 1 || nav.sheet) return
      const t = e.touches[0]
      if (!swipeStartOk(t.clientX, window.innerWidth)) return
      if (e.target?.closest?.(SWIPE_BLOCK_SELECTOR)) return
      if (inScrollableX(e.target)) return   // 在橫向可捲的表格／程式碼上滑：只捲它，不換頁
      if (String(window.getSelection?.() ?? '').length > 0) return   // 正在選文字
      Object.assign(sw, { mode, x0: t.clientX, y0: t.clientY, t0: Date.now(), dx: 0, shift: 0, width: window.innerWidth })
    }
    function swipeMove(e) {
      if (!sw.mode) return
      const t = e.touches[0]
      const dx = t.clientX - sw.x0, dy = t.clientY - sw.y0
      if (!sw.locked) {
        const l = swipeLock(dx, dy)
        if (l === 'v') { sw.mode = ''; return }
        if (l !== 'h') return
        sw.locked = 'h'; sw.dragging = true
        for (const z of [pf]) { z.ptr.dragging = false; if (z.ptr.h && !refreshing.value) { z.ptr.h = 0; z.ptr.ratio = 0; z.ptr.phase = 'idle' } }
      }
      if (e.cancelable) e.preventDefault()
      sw.dx = dx
      sw.shift = pagerShift(idx.value, dx)
    }
    function swipeEnd() {
      const { mode, locked, dx, t0, width } = sw
      if (!mode || locked !== 'h') { sw.mode = ''; sw.locked = ''; sw.dragging = false; return }
      sw.dragging = false; sw.locked = ''
      const target = swipeTarget({ index: idx.value, dx, dt: Date.now() - t0, width })
      sw.shift = 0; sw.mode = ''
      if (target !== idx.value) goTab(TABS[target])
    }

    // 「我」：暱稱（Rust 端驗證，不合法就還原並提示）、大頭貼（裁成正方形縮成 96×96 上傳）
    const nickErr = ref('')
    const commitNick = async () => {
      const want = String(me.nick ?? '').trim()
      if (want === info.window_name) { me.nick = info.window_name; nickErr.value = ''; return }
      try { applyRename({ info, core, me }, await invoke('set_window_name', { name: want })); nickErr.value = '' }
      catch (e) { me.nick = info.window_name; nickErr.value = e.message; setTimeout(() => { nickErr.value = '' }, 5000) }
    }
    const avBusy = ref(false), avMsg = ref(''), avFile = ref(null)
    const selfHasUpload = computed(() => isAvatarDataUrl(avatars.value[info.node]))
    const say = t => { avMsg.value = t; setTimeout(() => { if (avMsg.value === t) avMsg.value = '' }, 6000) }
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

    // 我的名字（帳號層）可改：走後台 account_name，所有設備共用；不合格或失敗就還原並提示
    const nameErr = ref('')
    const nameDraft = ref('')
    const commitName = async () => {
      const c = checkName(nameDraft.value)
      if (!c.ok) { nameErr.value = c.error; nameDraft.value = myName.value; setTimeout(() => { nameErr.value = '' }, 5000); return }
      if (c.name === myName.value) { nameDraft.value = myName.value; nameErr.value = ''; return }
      try { ownerName.value = await authApi.setAccountName(c.name); nameErr.value = ''; nameDraft.value = c.name }
      catch (e) { nameDraft.value = myName.value; nameErr.value = e.message; setTimeout(() => { nameErr.value = '' }, 5000) }
    }
    // 群組裡 AI 之間互相叫醒的上限（帳號層設定，預設 5）：改了存後台；不合格或失敗就還原並提示
    const wakeDraft = ref('5'), wakeErr = ref('')
    const commitWake = async () => {
      const c = checkAiWakeLimit(wakeDraft.value)
      if (!c.ok) { wakeErr.value = c.error; setTimeout(() => { wakeErr.value = '' }, 5000); void loadWake(); return }
      try { wakeDraft.value = String(await authApi.setAiWakeLimit(c.value)); wakeErr.value = '' }
      catch (e) { wakeErr.value = e.message; setTimeout(() => { wakeErr.value = '' }, 5000); void loadWake() }
    }
    const loadWake = () => authApi.getAiWakeLimit().then(n => { wakeDraft.value = String(n) }).catch(() => {})
    void loadWake()
    const acct = ref({ signed_in: false, email: '', known: false, error: '' })
    // 要放在 acct 定義之後：watch 的來源函式會立刻執行一次，放前面會踩到「初始化之前就取用」而整個監看失效
    watch([() => friends.value.length, () => acct.value.signed_in], () => { void backfillLast() })
    void authApi.status().then(s => { acct.value = s ? { ...s, known: true, error: '' } : { ...acct.value, error: '沒有收到回應' } }).catch(e => { acct.value = { ...acct.value, error: String(e?.message ?? e).slice(0, 80) } })
    // 我的名字（帳號層）：先用上次存的，登入帳號的資料取到後更新並存起來（離線也有名字可顯示）
    void authApi.accountInfo().then(i => { if (typeof i?.owner_name === 'string') ownerName.value = i.owner_name }).catch(() => {})
    const myName = computed(() => accountDisplayName(ownerName.value, acct.value.email))
    watch(myName, v => { nameDraft.value = v }, { immediate: true })
    const meForChat = computed(() => ({ ...me, nick: myName.value }))   // 對話裡自己的名字用帳號名；設備名只在「從 …」小標
    const accountText = computed(() => (acct.value.signed_in ? `已登入：${acct.value.email || '（沒有 email）'}` : '尚未登入'))
    const loggingOut = ref(false)
    async function doLogout() {
      if (loggingOut.value) return
      loggingOut.value = true
      try { await authApi.logout(); location.reload() } catch (e) { loggingOut.value = false; say(e.message) }
    }

    return {
      onboard, onboardApi, finishOnboard, ONBOARD_TEXT, acct, nameDraft, nameErr, commitName, wakeDraft, wakeErr, commitWake, AI_WAKE_LIMIT_LABEL, AI_WAKE_LIMIT_NOTE,
      screen, fatal, login, loginNote, PROVIDERS, canStart, startLogin, cancelLogin,
      upd, updText: computed(() => bannerText(upd)), updButton: computed(() => buttonLabel(upd)), startUpdate, checkUpdate,
      pf, sw, pagerStyle, indicator, swipeStart, swipeMove, swipeEnd, goTab, TABS, TAB_LABEL, tabLabel, myName, meForChat, lastOf,
      nav, me, prefs, conn, query, collapsed, groups, unreadTotal, emptyText, STATUS, headTone, CONN_LABEL, info, banner, shake, refreshing,
      sec, SECRET_TEXT, secCountdown, answerSecret, laterSecret,
      tq, TERMREQ_TEXT, tqCountdown, decideTermReq, laterTermReq,
      avOf, avById, meAv, chatFriend, chatEmptyText, chatLog, opsItems, opsRows, opsView, ops, opsText, opsTitle, opsModels, opsModelNote, opsIsPi, opsBanner, openOps, pickOp, submitOp, dismissRun, setArchived, archiveNote, photoApi, emo, groupHeading, statusNote,
      acctSw, acctDevs, acctRemoved, acctFlags, acctCanRemove, acctDrag, acctShowBack, acctAskRemove, acctRemoveText, acctRemoveNow, acctRestore, acctHeaderBack, acctBackToList, openAcctDevice, gripDown, gripMove, gripUp, gripKey, acctMove, DEVICE_TEXT, acctCur, acctRep, acctView, acctConfirm, ACCT_TEXT, ACCT_PAGE_TITLE, vendorIconSvg, acctKeys, openAcct, startAcctSwitch, acctBackToPick, submitAcct,
      lch, lchData, lchDevices, lchElig, lchFormErr, lchChoices, lchStep2, lchRun, lchCanNext, nextLaunch, closeLaunch, openLaunch, pickLaunchDevice, submitLaunch, openLaunched,
      recentRows, RECENT_GROUP_KEY, RECENT_GROUP_LABEL, plusOpen, pickPlus, rooms, roomRows, roomsErr, roomsLoaded, roomNote, openRoom, ROOM_GROUP_KEY, ROOM_GROUP_LABEL, roomEmptyText, groupFlow, groupItems, pickGroup, chatCards, decideCard, guides, guideOpen, openGuides, openGuide, GUIDE_ENTRY_LABEL, GUIDE_ENTRY_SUB,
      friends, callApi, dictApi, onCallState, openChat, back, openBanner, bannerHandover, contextLabel, sendTo, nudgeTo, sendAttachTo, loadOlder, refreshAll,
      settingRows, settingCat, settingTitle, openSetting, nickErr, commitNick, avBusy, avMsg, avFile, selfHasUpload, pickAvatar, removeAvatar, accountText, loggingOut, doLogout,
    }
  },
})
app.component('chat-pane', ChatPane)
app.component('asn-avatar', AsnAvatar)
app.component('group-sheet', GroupSheet)
app.component('onboard-card', OnboardCard)
app.component('guide-doc', GuideDoc)
app.component('ptr-zone', PtrZone)
app.mount('#app')
// 根元素（#app）自己的屬性不在 Vue 編譯的樣板裡，:class 綁不上去；登入畫面的背景類別在這裡手動切
watch(screen, s => document.getElementById('app').classList.toggle('is-login', s === 'login' || s === 'onboard'), { immediate: true })
document.getElementById('splash')?.remove()
void startCore?.()
