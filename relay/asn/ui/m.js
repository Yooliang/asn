// 手機版（安卓）主程式：四個大分頁——夥伴、對話、設定、通知（#1429）。和電腦版共用 AsnCore（收寄信、記錄）、ChatPane（對話版面）與 Rust 端指令；
// 電腦才有的功能（內建收發室、開 Claude 視窗、密碼小幫手、用量、系統匣、多視窗）手機沒有，這個檔案也不叫它們。
// 打開 App 才收信：前景時照電腦版的節奏輪詢，加上門鈴一響就拉；回到前景時立刻拉一次（推播留給第二期）。
import { AsnCore } from './lib/core.mjs'
import { getLocal } from './lib/local-prefs.mjs'
import { plainMessage } from './lib/plain-errors.mjs'
import { patchWithFallback } from './lib/settings-save.mjs'
import { ChatPane } from './lib/chatpane.mjs'
import { LineIcon, itemIcon, isDangerItem, tabIcon } from './lib/line-icons.mjs'
import { FpMark, phoneFpMark } from './lib/fp-mark.mjs'
import { DeviceIdentity, IDENTITY_TEXT } from './lib/device-identity.mjs'
import { setNodePlatforms } from './lib/node-platform.mjs'
import { ACTION_TEXT } from './lib/device-order.mjs'
import { listTimeText } from './lib/line-chat.mjs'
import { AsnAvatar } from './lib/avatar-badge.mjs'
import { PinDot } from './lib/pin-dot.mjs'
import { createRowPress, rowPressBind } from './lib/row-press.mjs'
import { isPinned, pinMenuLabel, pinnedTargets, renamedChatId as renamedPinId, togglePin } from './lib/chat-pins.mjs'
import { createPinsSync } from './lib/pins-sync.mjs'
import { READ_VISIBLE_POLL_MS } from './lib/read-sync.mjs'
import { avatarSrc, isAvatarDataUrl, removeAvatarUpload, selfAvatarSrc, uploadAvatarFile } from './lib/avatar.mjs'
import { avatarFromFile } from './lib/avatar-canvas.mjs'
import { PROVIDERS, canStart, errorText, phaseText } from './lib/login.mjs'
import { contextLabel } from './lib/context-usage.mjs'
import { elevatedBadge } from './lib/elevated.mjs'
import { BANNER_MS, DEFAULT_PREFS, TAB_LABEL, tabList, accountDisplayName, SWIPE_BLOCK_SELECTOR, SCROLL_TERM_SELECTOR, inScrollableX, indicatorPos, pagerShift, PAGER_SETTLE_MS, swipeLock, swipeStartOk, swipeTarget, tabIndex, tabNav, UPDATE_CHECK_MS, afterBind, androidBridge, bannerText, sideloadLastText, buttonLabel, initialNav, opsNav, offlineNav, photoNav, tabLabel as tabLabelOf, secretNav, termReqNav, permReqNav, initialUpdate, installOutcome, meNav, normalizeNav, normalizePrefs, notifyPlan, rosterGroups, savePhotoOnPhone, PTR_LOADING_H, PULL_TEXT, pullHeight, pullPhase, pullRatio, shouldAutoCheck, shouldRefreshOnRelease, totalUnread, BACKFILL_GAP_MS, backfillQueue, lastWords, updateCheckErrorText, withAvailable, withFailure, withProgress } from './lib/mobile.mjs'
import { sharePhoto } from './lib/photo-inline.mjs'
import { LAUNCH_GIVE_UP_MS, LAUNCH_POLL_MS, PI_REMOTE_VERSION_NOTE, LAUNCH_DISPLAY_NOTE, showDisplayNote, appearedIn, appearedModel, buildLaunchRequest, initialLaunch, launchChoices, launchDevices, launchEligibility, launchErrorText, launchFormError, launchPiChoice, launchRun, launchVendors, machinesByNode, pickedRun, progressView, launchInProgress } from './lib/mobile-launch.mjs'
import { OnboardCard } from './lib/onboard-card.mjs'
import { UI_KIT } from './lib/ui-kit.mjs'
import { MOBILE_PHASE_TEXT, createMobileCall } from './lib/mobile-call.mjs'
import { PUSH_TEXT, createPushSync, pushSettingView } from './lib/mobile-push.mjs'
import { canDictate, createMobileDictation } from './lib/mobile-dictation.mjs'
import { startCallPoll } from './lib/call-poll.mjs'
import { ONBOARD_STORE, TEXT as ONBOARD_TEXT, checkName, markOnboarded, planOnboarding } from './lib/onboard.mjs'
import { POLL_MS as SECRET_POLL_MS, TEXT as SECRET_TEXT, countdownText as secretCountdown, errorText as secretError, normalizeList as secretList, nextToAsk as secretNext, secretError as secretValidate } from './lib/secret-ask.mjs'
import { HELD_HINT, heldTitle, isHeldOptions } from './lib/held.mjs'
import { ARM_MS as PQ_ARM_MS, POLL_MS as PQ_POLL_MS, RESULT_EVERY_MS as PQ_RESULT_MS, RESULT_TRIES as PQ_RESULT_TRIES, TEXT as PERMREQ_TEXT, askTitle as pqAskTitle, WATCH_MS as PQ_WATCH_MS, decideArgs as pqDecideArgs, errorText as pqError, normalizeList as pqList, nextToAsk as pqNext, resultOf as pqResult, stillPending as pqStill, watchOutcome as pqWatchOutcome, AUTOCLOSE_MS as PQ_AUTOCLOSE_MS, ruleSegments as permSegs, optionsView as pqOptionsView, riskView as pqRiskView, truncNote as pqTruncNote } from './lib/perm-ask.mjs'
import { createHold } from './lib/hold-press.mjs'
import { POLL_MS as TQ_POLL_MS, TEXT as TERMREQ_TEXT, countdownText as tqCountdownText, decideArgs as tqDecideArgs, errorText as tqError, normalizeList as tqList, nextToAsk as tqNext } from './lib/term-ask.mjs'
import { friendId } from './lib/roster.mjs'
import { restoreMobileTab } from './lib/session.mjs'
import { MODEL_NOTE, chatPageState, normalizeLastChat, opLineNote, opStep, phoneModels, renamedChatId, runFor, setRun, showsInSheet } from './lib/mobile-ops.mjs'
import { chatGroupItems, nameplateView } from './lib/actionbar.mjs'
import { buildPartnerMenu } from './lib/partner-menu.mjs'
import { headCallView } from './lib/head-call.mjs'
import { offlineView } from './lib/group-offline.mjs'
import { OP_LABEL, OP_PROGRESS_TEXT, PI_MODEL_PICK_ERR, PI_MODEL_REMOTE_NOTE, opFormError, dialogEngine, partnerEngine, piModelChoices, sharedWhy } from './lib/partner-ops.mjs'
import { cleanPiModels } from './lib/pi-models.mjs'
import { accountCardKey, accountStatusOf } from './lib/device-account-lines.mjs'
import { DEVICE_BUTTON_TEXT, DEVICE_ROW_TEXT, LOGIN_LOST_TEXT, SUB_LAPSED_TEXT, accountDeviceRows, accountInUse, accountLoginLost, loginLostNotices, fetchRoster, ROSTER_POLL_MS, ROSTER_TEXT, usedOnText } from './lib/account-roster.mjs'
import { PLAN_UNKNOWN, planLabel } from './lib/account-quota.mjs'
import { CURRENT_FAILED_ARIA, CURRENT_LABEL, INCOMPLETE_LABEL, INCOMPLETE_REASON, LOGIN_FAILED_LABEL } from './lib/claude-accounts.mjs'
import { POLL_MS as SETUP_POLL_MS, SETUP_TEXT, RELOGIN_TEXT, setupErrorText, setupStateOf, setupStep, setupLeadOf } from './lib/mobile-setup.mjs'
import { LOGIN_TEXT, POLL_MS as LOGIN_POLL_MS, VENDORS as LOGIN_VENDORS, fetchView, loginErrorText, requestView, secondsLeft } from './lib/mobile-device-login.mjs'
import { loadCloudNodes, saveCloudNodes, nextCloudNodes, sameNodes } from './lib/cloud-memory.mjs'
import { GUIDE_TEXT, GUIDE_VENDORS, guideRows, guideVisible, guideReshowVisible, loadGuideHidden, saveGuideHidden } from './lib/new-computer-guide.mjs'
import { NewGuideCard } from './lib/new-computer-guide-view.mjs'
import { STATE } from './lib/device-state.mjs'
import { createSwitchTracker, switchRowKey, switchResultOf, switchBusyNode } from './lib/switch-result.mjs'
import { createReportScheduler, reportsDue } from './lib/report-reload.mjs'
import { isSwitchTarget, ACCT_TEXT, acctPageTitle, acctHeadView, acctButtonDevices, acctRosterView, acctClaudeRemote, acctDeviceTree, acctNeedsLoad, acctPickDevice, acctErrorText, acctSheetView, confirmText as acctConfirmText, runAcctSwitch, acctResultToast, ACCT_TOAST_MS, ACCT_TABS, acctTabOf, acctSwitchTargets as acctSwitchTargetsOf, createReportPrefetch, isFailedReport, acctReportEntry } from './lib/mobile-acct.mjs'
import { createDeviceSync } from './lib/device-sync.mjs'
import { deviceFieldsFromSaved, deviceFieldsToSave, dropSlot, moveDevice, deviceRowLine, pruneRemoved, removeDevice, reorderDevice, restoreDevice, showDevice, visibleRows, canRemoveRow, canShowBackRow, DEVICE_TEXT } from './lib/device-order.mjs'
import { ARCHIVE_GROUP_KEY, activeFriends, archivedFriends, manageItems, runArchive, setLocalArchiver, withArchivedGroup } from './lib/archive.mjs'
import { acpSwitchChoices, createOpRunner, makeOpRun, opDialogText, runPartnerOp } from './lib/partner-ops-ui.mjs'
import { defaultPartnerName } from './lib/partner.mjs'
import { groupHeading, statusNote } from './lib/tabs.mjs'
import { NOTICE_ID, isMergedAway, isNoticeFriend, noticeGoRows } from './lib/notice.mjs'
import { REPLACE_TEXT, createReplaceFlow, newReplaceState, syncAfterReplace } from './lib/device-replace.mjs'
import { HOME_TAB, chatNav, isNewNotice, noticeLastAt, noticeUnread, tabDot, viewedChatId } from './lib/mobile.mjs'
import { emo, plain } from './lib/text.mjs'
import { headTone } from './lib/head-tone.mjs'
import { applySkin, SKINS, SKIN_LABEL } from './lib/skin.mjs'
import { UNREAD_GROUP_KEY, UNREAD_GROUP_LABEL, chatListRows, lastTrafficAt, chatRowsUnread, showUnreadGroup, unreadChatRows } from './lib/recent.mjs'
import { friendMatchesQuery, normalizeSearchQuery } from './lib/search.mjs'
import { authApi, cloudApi, deviceReplaceApi, invoke, listen, makeFpShowApi, mobileAccountApi, mobileAskApi, mobileLaunchApi, mobileOpsApi, mobilePhotoApi, mobilePushApi, mobileRelayApi, mobileSetupApi, mobileSiteApi, mobileStateApi, mobileUpdateApi, openLink, shellApi, store } from './lib/tauri.mjs'
import { mobileRemoteInputApi, mobileRemoteViewApi } from './lib/mobile-remote-view.mjs'
import { joinKnown, removedDevices, deviceNameError, deviceNameOf, unnamedLabelOf } from './lib/device-known.mjs'
import { TEXT as KNOWN_TEXT, NAME_MAX, errorText as knownErrorText, renameErrorText, knownPeers, needsConfirm as knownNeedsConfirm, peerOf as knownPeerOf } from './lib/mobile-known-peers.mjs'
import { FP_SHOW_POLL_MS, FP_SHOW_TEXT, createFpShowFlow, newFpShowState } from './lib/fp-show.mjs'
import { CLOUD_KEY_KEEP_MS, CLOUD_LEAVE_TEXT, CLOUD_TEXT, COPY_NOTE as CLOUD_COPY_NOTE, INVITE_NOTE as CLOUD_INVITE_NOTE, POLL_MS as CLOUD_POLL_MS, createMobileCloud } from './lib/mobile-cloud.mjs'
import { buildLogView } from './lib/changelog.mjs'
import { PLAY_BUTTON_LABEL, PLAY_LATEST_TEXT, PLAY_NOTICE_NOT_AUTO, openPlayStore, playNewText as playNewTextOf, playUpdateVersion, playUpdateView } from './lib/play-update.mjs'
import { RETRY_LABEL, createReleasesRefresher, initialReleases, loadReleases, releasesNote, releasesStale, stampReleases } from './lib/releases.mjs'
import { vendorIconSvg } from './lib/vendor-icons.mjs'
import { ROOM_GROUP_KEY, ROOM_GROUP_LABEL, ROOM_POLL_MS, ROOM_EMPTY_HINT, ROOM_EMPTY_TEXT, ROOM_LOAD_FAIL_TEXT, isRoomChat, roomChatId, roomIdOf, roomPseudoFriend } from './lib/mobile-rooms.mjs'
import { GroupSheet } from './lib/group-sheet.mjs'
import { createGroupFlow } from './lib/group-flow.mjs'
import { MEMBER_NOT_FRIEND, copyText, createGroupApi, memberFriendId } from './lib/groups.mjs'
import { createRoomHub } from './lib/room-hub.mjs'
import { ReloginBar, ROSTER_CONNECTING_TEXT, ROSTER_LOAD_FAIL_TEXT, createReloginWatch, roomsNoteText } from './lib/relogin-bar.mjs'
import { aboutView, isAboutUrl } from './lib/about-info.mjs'
import { GUIDE_ENTRY_LABEL, GUIDE_ENTRY_SUB, phoneGuide, phoneGuideList } from './lib/mobile-guides.mjs'
import { ACCT_SETTING_KEYS, mobileSettingRows, mobileSettingTitle } from './lib/mobile-settings.mjs'
import { PAGE_TAB, FOURTH_KEEP_MS, LEAVE_ASK_TEXT, acctPage, fourthExpired, fourthMsLeft, guidePage, launchPage, needsLeaveAsk, pageIcon, settingPage } from './lib/mobile-fourth.mjs'
import { createLeaveAsk, createMobileNav, pageTitle } from './lib/mobile-nav.mjs'
import { alignDeviceName, followSelfRename } from './lib/device-rename.mjs'
import { renameDevice, setDeviceNameOnboard, syncPendingDeviceName } from './lib/device-rename.mjs'
import { checkAiWakeLimit, AI_WAKE_LIMIT_LABEL, AI_WAKE_LIMIT_NOTE } from './lib/ai-wake-limit.mjs'
import { GuideDoc } from './lib/guide-doc.mjs'
import { loginUnsealedNote } from './lib/mobile-login-seal.mjs'

const { createApp, reactive, ref, computed, watch } = Vue
let fgListener = null   // 版本紀錄的重讀（#1501）掛在這裡：外殼的前景事件與 visibilitychange 都會走到 tellFg，不另掛一套監聽
const FG_RENEW_MS = 30_000   // 前景續命間隔（#1281）；Rust 端前景告知 90 秒過期（FG_TTL_MS）
import { AWAITING_LABEL } from './lib/awaiting.mjs'
import { installUiLog } from './lib/ui-log.mjs'
// 手機的 [ASN] 記錄也寫進 App 自己資料夾的 ui.log（#2129 ①，規則同電腦版）；越早裝越好，啟動過程的失敗也記得到
installUiLog({ source: 'mobile' })
const friendStatusText = f => (f?.awaiting === true ? AWAITING_LABEL : STATUS[f?.status])
const STATUS = { online: '線上', busy: '忙碌', running: '執行中・僅顯示', away: '暫離', offline: '顯示為離線' }
const CONN_LABEL = { connecting: '連線中…', on: '已連線', off: '連線中斷，重試中' }
const bridge = androidBridge(window)
// 推播（#797）：App 關著也要響。權杖由外殼向 Firebase 取、經這裡交給 Rust；沒有 Firebase 的建置 state 是 unavailable，什麼都不做
const pushSt = reactive({ state: bridge?.push?.state() ?? 'unavailable' })   // 通知權限的狀態（設定頁「App 關著時也通知我」那一列看這個）
const refreshPushSt = () => { pushSt.state = bridge?.push?.state() ?? 'unavailable' }
const push = bridge?.push ? createPushSync({ native: bridge.push, register: token => mobilePushApi.register(token), unregister: () => mobilePushApi.unregister(), enabled: () => prefs.push !== false, onChange: refreshPushSt, log: m => console.info('[ASN]', m) }).start() : null
// 偽通話（#99）：用手機內建的語音辨識與念出（外殼 CallVoice.kt）。外殼沒有、或這支手機沒有辨識服務就沒有通話鈕
const callOn = ref(false)   // 現在有沒有通話（通話中每 2 秒多收一次信）
let liveCall = null

// 手機只用得到這幾個 Rust 指令（金鑰與權杖都在 Rust 端，這裡拿不到）
const transport = mobileRelayApi   // 指令名與參數形狀在 lib/tauri.mjs（mobileRelayApi）
// 管理夥伴視窗（⋯ 選單）：手機只下指令，視窗在那台電腦上；要本人簽章（Rust 端沒憑證就不送）
const opsTransport = mobileOpsApi   // android_partner_*（lib/tauri.mjs）
// 替電腦切換 Claude 帳號（設備卡的按鈕）：手機只下指令；要本人簽章（Rust 端沒憑證就不送）。清單只有 email、方案、是否使用中
const acctTransport = {   // 指令名與參數形狀在 lib/tauri.mjs（mobileAccountApi，#2106 ⑬）
  acctList: node => mobileAccountApi.list(node),
  acctSwitch: (node, email) => mobileAccountApi.switchTo(node, email),
  acctStatus: ids => mobileAccountApi.status(ids),
  acctRoster: () => mobileAccountApi.roster(),   // 帳號列表（#374）：跟電腦版同一個後台動作
}
// 照片放大與收到的檔案：另存＝存進 App 私有資料夾，再請外殼複製到「下載/ASN」
const photoApi = {
  fetch: (id, expiresAt = null) => mobilePhotoApi.fetch(id, expiresAt),
  save: async (id, name) => savePhotoOnPhone(await mobilePhotoApi.save(id, name), bridge),
  reveal: async () => bridge?.openDownloads(),
  share: (id, name) => sharePhoto({ fetchFull: i => mobilePhotoApi.fetch(i, null), id, name }),   // 「分享」：交給系統的分享面板（#1911）
}

const info = reactive(await shellApi.startupInfo())   // 響應式：改設備名後就地更新，不重載頁面
document.title = 'ASN'

const screen = ref('boot'), fatal = ref('')
const login = reactive({ phase: 'idle', provider: '', error: '' })
const onboard = reactive({ steps: [] })   // 首次登入引導要走的步驟（空＝不用）
const onboardApi = { setAccountName: name => authApi.setAccountName(name), setDeviceName: name => (name === info.window_name ? Promise.resolve() : setDeviceNameOnboard(invoke, store(ONBOARD_STORE), { node: info.node, name, phone: true, base: info.window_name })) }
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
// 「需要重新登入」提醒條（#1764）：和電腦版同一個元件、同一份文字、同一套判斷（lib/relogin-bar.mjs）。
// 收到清掉登入的事件、群組列表回報登入失效、後台回 401、App 回到前景時都立刻再查，平常每分鐘也看一次；不能只在開 App 時查一次
const reloginWatch = createReloginWatch({ status: () => authApi.status(), listen, canSkipLogin: () => info.can_skip_login === true, reactive })
const reloginBar = reloginWatch.st
const dismissReloginBar = reloginWatch.dismiss
// 按「登入」走現有的登入畫面（同一組登入鈕）；有金鑰的手機可以按「先不要」回名單
const goLogin = () => { login.phase = 'idle'; login.error = ''; screen.value = 'login' }
const backFromLogin = () => { screen.value = 'main' }

let savedTab = HOME_TAB   // 上次離開時的大分頁（讀存檔後才知道）
const nav = reactive(initialNav())
// 內頁（#461）：設備與帳號、設定的某一項、使用指引、開新夥伴，暫時佔用第四格（#1429）。null＝沒有；{ page, from, leftAt }（lib/mobile-fourth.mjs）
const fourthSt = reactive({ fourth: null })
const fourthNav = createMobileNav({ history, nav, st: fourthSt })
const lastChat = ref('')   // 最後使用的那一位（對話分頁點進去的那一則；存在手機本機設定，重開 App 仍記得）
// 從群組點成員跳過去（#1515）：記在記憶體裡的 { from（群組）, to（那一位） }。換到這兩位以外的人就作廢，返回鍵不會再把人拉回群組
let memberJump = null
watch(lastChat, v => { if (memberJump && v !== memberJump.from && v !== memberJump.to) memberJump = null })
const me = reactive({ psm: '', status: 'online', nick: info.window_name })
const prefs = reactive({ ...DEFAULT_PREFS })
const friends = ref([]), conn = ref('connecting'), nodeOrder = ref([]), nodeFacts = ref({}), nodeNames = ref({})   // nodeNames＝節點 → 後台記的設備名（手機自己沒有夥伴列，名字只在這裡）
// 設備順序與手動顯示的隱藏設備：存在這支手機自己的設定（asn-me.json 的 deviceOrder／deviceShown／deviceRemoved）當離線快取，有登入就與帳號層同步（lib/device-sync.mjs）
const devPrefs = reactive({ deviceOrder: [], deviceShown: [], deviceRemoved: [], deviceRev: 0, deviceSynced: false })
const logs = reactive({})
const avatars = ref({})
const query = ref(''), collapsed = reactive({ [ARCHIVE_GROUP_KEY]: true })   // 「已封存」群組預設收合
const archiveNote = ref('')
const banner = ref(null), shake = ref(false), refreshing = ref(false)
// 一句話的提示（底部，幾秒後自己消失）：例如離開進行中的畫面後，帳號切換完成或失敗
const toast = ref('')
let toastTimer = 0
const showToast = (text, ms = ACCT_TOAST_MS) => { if (!text) return; toast.value = text; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.value = '' }, ms) }
// 自動更新（自行安裝版才有；Rust 端與外殼都沒編進 Google Play 版）。測試用的清單網址只收 127.0.0.1（Rust 端再擋一次）
const upd = reactive(initialUpdate())
const ownerName = ref('')   // 帳號層的名字（租戶稱呼）
const updTestUrl = (() => getLocal('asnUpdateTestUrl') || null)()
const updArgs = () => (updTestUrl ? { url: updTestUrl } : {})
async function checkUpdate(manual = false) {
  if (!upd.enabled || upd.checking || upd.phase === 'downloading') return
  upd.checking = true; if (manual) upd.manual = ''
  try {
    const found = await mobileUpdateApi.check(updArgs())
    Object.assign(upd, withAvailable(upd, found))
    if (manual) upd.manual = found?.available ? `有新版本 ${found.version}。` : '目前已是最新版。'
  } catch (e) { if (manual) upd.manual = updateCheckErrorText(e.message) } finally { upd.checking = false }   // 官網連不上、回錯誤一律說「暫時無法檢查更新」，不顯示原始錯誤
}
async function startUpdate() {
  if (upd.phase === 'downloading') return
  Object.assign(upd, withProgress(upd, { done: 0, total: 0 }), { error: '', hint: '' })
  try {
    const r = await mobileUpdateApi.download(updArgs())   // Rust 端下載並驗 sha256，不符就拒絕
    const out = installOutcome(bridge ? bridge.installApk(r.path) : 'unsupported')
    upd.phase = 'available'; upd.hint = out.hint
  } catch (e) { Object.assign(upd, withFailure(upd, plainMessage(e))) }
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
  // 對話釘選同步到帳號層（lib/pins-sync.mjs）：有登入才同步，後台 rev 是遞增版本號（寫入要＝現有＋1），衝突時在這裡合併重送；沒登入就只存本機
  const pinsSync = createPinsSync({ getPins: () => prefs.chatPins, setPins: s => { prefs.chatPins = s }, api: { get: authApi.getChatPins, set: authApi.setChatPins }, canSync: async () => (await authApi.status().catch(() => null))?.signed_in === true })
  watch(() => prefs.chatPins, () => pinsSync.noteLocal(), { deep: true })
  pinsSync.start()
  watch(() => prefs.skin, v => applySkin(v), { immediate: true })   // 外觀（lib/skin.mjs）：選了馬上換
  ownerName.value = typeof saved.ownerName === 'string' ? saved.ownerName : ''
  lastChat.value = normalizeLastChat(saved.lastChat)
  // 重開 App 回到上次的大分頁（夥伴／對話／設定／通知，存的是分頁鍵）；上次正在看某一則對話就直接回到那一則
savedTab = restoreMobileTab(saved.navTab)
watch([me, prefs, devPrefs, ownerName, lastChat, () => nav.tab, () => nav.chat], () => { const { nick, ...rest } = me; const f = { ...deviceFieldsToSave(devPrefs), me: rest, mobilePrefs: { ...prefs }, ownerName: ownerName.value, lastChat: lastChat.value, navTab: nav.tab === PAGE_TAB ? fourthSt.fourth?.from || HOME_TAB : nav.tab, navChat: nav.tab === 'chats' && !!nav.chat }; void patchWithFallback(meStore, f, () => ({ ...saved, ...f })) }, { deep: true })
  watch(() => [me.status, me.psm], () => { void mobileStateApi.presence(me.status, me.psm ?? '').catch(() => { /* 出口的 invoke 已記一行並去重，這裡不再多記，避免洗記錄 */ }) }, { immediate: true })
  // #1281：進前景／進背景立刻告知 Rust（在線回報帶 foreground，後台推播只看前景）。外殼在 onStart／onStop 呼叫 window.__asnFgEvent，
  // 再用 visibilitychange 補強；啟動時也告知一次目前狀態（推播喚醒時 Rust 預設在背景）。
  // 前景時每 30 秒再告知一次（續命）：Rust 的前景告知 90 秒就過期，背景時網頁計時器被凍住不會續命，所以「進背景」的告知就算遺失也只會多撐一下
  const tellFg = fg => { void mobileStateApi.foreground(fg).catch(() => { /* 出口的 invoke 已記一行並去重，這裡不再多記，避免洗記錄 */ }); try { fgListener?.(fg === true) } catch {}; if (fg === true) void reloginWatch.onForeground() }   // 回到前景也查一次登入狀態（#1764）
  window.__asnFgEvent = tellFg
  document.addEventListener('visibilitychange', () => tellFg(document.visibilityState === 'visible'))
  tellFg(document.visibilityState === 'visible')
  setInterval(() => { if (document.visibilityState === 'visible') tellFg(true) }, FG_RENEW_MS)
  void reloginWatch.start()

  core = new AsnCore({
    transport, store: store('chats'), selfNode: info.node, windowName: info.window_name,
    isChatVisible: async id => document.visibilityState === 'visible' && viewedChatId({ tab: nav.tab, chat: nav.chat, lastChat: lastChat.value }) === id,   // 正在看的那一位（對話分頁點進去的那位，或通知分頁）才算「看得到」（不算未讀）
    aliases: info.old_names, pollMs: info.poll_ms, rosterMs: info.roster_ms, backlogAfterMs: 5 * 60_000,
    log: m => console.info('[ASN]', m),
  })
  setLocalArchiver((f, a) => core.setLocalArchived(f, a))   // 後台沒有的舊好友封存時改記在本機
  const sync = () => { const s = core.snapshot(); friends.value = s.friends; conn.value = s.conn; nodeOrder.value = s.nodeOrder; nodeNames.value = s.nodeNames ?? {}; nodeFacts.value = s.nodeFacts ?? {}; for (const f of s.friends) refreshLast(f.id) }
  const pushLog = id => { logs[id] = core.viewOf(id) }
  core.on('state', sync)
  core.on('log', id => { pushLog(id); refreshLast(id) })
  core.on('avatars', () => { avatars.value = core.avatarMap() })
  core.on('notify', n => {
    const plan = notifyPlan(n, { openId: viewedChatId({ tab: nav.tab, chat: nav.chat, lastChat: lastChat.value }), foreground: document.visibilityState === 'visible', prefs })
    if (plan.vibrate) { if (bridge) bridge.vibrate(plan.vibrate); else navigator.vibrate?.(plan.vibrate) }
    if (plan.shake) { shake.value = true; setTimeout(() => { shake.value = false }, 700) }
    if (plan.banner) { banner.value = plan.banner; clearTimeout(bannerTimer); bannerTimer = setTimeout(() => { banner.value = null }, plan.banner.ms ?? BANNER_MS) }
  })
  startCallPoll({ anyCall: () => callOn.value, pull: why => core.pull(why) })   // 通話中每 2 秒多收一次信，結束就停
  await listen('relay-bell', () => { void core.pull('bell'); core.refreshRosterSoon(); void roomsHook.refresh?.() })   // Rust 端的門鈴（前景時有效）
  await listen('android-update-progress', p => { if (upd.phase === 'downloading') Object.assign(upd, withProgress(upd, p)) })   // 下載完才到的進度事件不能把畫面又拉回「下載中」
  upd.enabled = bridge?.selfUpdateEnabled() === true
  setInterval(() => { if (shouldAutoCheck(upd, prefs)) void checkUpdate() }, UPDATE_CHECK_MS)
  setInterval(() => { if (document.visibilityState === 'visible') void core.syncReads() }, READ_VISIBLE_POLL_MS)   // 別台讀過的紅點不用等 60 秒才消（#856）
  // 回到前景：立刻拉一次信、更新名單、補正在看的那位的往來記錄
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    void core.pull('resume'); void core.resumeSentStatus(); core.refreshRosterSoon(); void core.syncReads(); void roomsHook.refresh?.(); push?.sync(); refreshPushSt()
    if (nav.tab === 'chats' && lastChat.value) { core.markRead(lastChat.value); void core.syncHistory(lastChat.value) }
    else if (viewedChatId({ tab: nav.tab, chat: nav.chat, lastChat: '' }) === NOTICE_ID) { core.markRead(NOTICE_ID); logs[NOTICE_ID] = core.viewOf(NOTICE_ID) }
  })
  startCore = async () => { void (shouldAutoCheck(upd, prefs) && checkUpdate()); await core.start(); sync(); push?.sync(); void (async () => { await syncPendingDeviceName(invoke, store(ONBOARD_STORE), { info, core, me }, { node: info.node, phone: true, notify: showToast }); await alignDeviceName(invoke, { info, core, me }, showToast) })() }   // 掛上畫面之後才開始（第一次收信要連網，不能讓畫面空等）
}

// ---------- 導覽：每往下一層就推一筆瀏覽記錄，系統返回鍵＝上一頁（對話清單層再按才退到背景）；分頁與內頁的規則在 lib/mobile-nav.mjs ----------
history.replaceState(initialNav(), '')
// 回到上次的大分頁：對話清單那層先放著，再推一筆，系統返回鍵還是回到對話清單
if (savedTab !== HOME_TAB) fourthNav.go(tabNav(savedTab))
// 上次停在對話分頁：對話分頁本身就是最後那一則（#1438），不必再推一層
let keyBackGuard = () => false   // setup 裡接上（雲端代理的金鑰還在畫面上時，返回鍵先問一次）
window.addEventListener('popstate', e => {
  if (keyBackGuard()) return
  // 通話中按返回鍵＝掛斷，畫面留在原處（不跳到上一頁）；切頁時程式自己退的記錄不算
  if (callOn.value && !fourthNav.busy()) { void liveCall?.end(); history.pushState(fourthNav.state(), ''); return }
  // 從群組點成員跳過去的一對一（#1515），按返回回到原本的群組：跳之前在群組那一筆記錄記了 jumpFrom／jumpTo。
  // 三個條件都成立才換回群組：不是程式自己在退記錄（切頁、開對話）、記憶體裡的這一次跳轉還有效（沒換過別人）、跟記錄上的標記一致；
  // 標記只用一次：不管有沒有換回，都從記錄上拿掉，之後再退到這一筆不會被錯拉回群組
  const j = e.state && typeof e.state.jumpFrom === 'string' && e.state.jumpFrom ? e.state : null
  if (j) {
    const back = !fourthNav.busy() && memberJump && memberJump.from === j.jumpFrom && memberJump.to === j.jumpTo && lastChat.value === memberJump.to
    const { jumpFrom, jumpTo, ...rest } = j
    history.replaceState(rest, '')
    if (back) { memberJump = null; lastChat.value = jumpFrom }
  }
  fourthNav.onPop(e.state)
})
const go = next => fourthNav.go(next)
// 切大分頁（點頁籤、左右滑）：從「夥伴」出去推一筆瀏覽記錄（返回鍵回到夥伴）；其他分頁之間互換不增加記錄；浮層開著時不動
const goTab = t => fourthNav.goTab(t)
// 內頁離開後的 3 分鐘：切走時排一個計時器到點檢查；App 在背景時計時器可能不跑，回到前景再用絕對時間檢查一次
let fourthTimer = 0
let fourthKeepMs = () => FOURTH_KEEP_MS   // setup 裡接上：金鑰還在畫面上時較長
let checkFourth = () => fourthNav.check()
watch(() => fourthSt.fourth?.leftAt, at => {
  clearTimeout(fourthTimer)
  if (at) fourthTimer = setTimeout(() => checkFourth(), Math.min(fourthMsLeft(fourthSt.fourth, Date.now(), fourthKeepMs()), fourthKeepMs()) + 50)
})
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkFourth() })

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

// 左右滑動切換大分頁的手勢狀態（夥伴／對話／設定／通知的橫向翻頁）
const sw = reactive({ mode: '', locked: '', x0: 0, y0: 0, t0: 0, dx: 0, shift: 0, width: 360, dragging: false, moving: false })

const app = createApp({
  setup() {
    // 已封存的不放進名單，另成最底下一個預設收合的「已封存（N）」群組（搜尋字同樣適用）
    const groups = computed(() => {
      const o = { query: query.value, selfNode: info.node, selfName: deviceNameOf(info.node, { nodeNames: nodeNames.value, friends: friends.value, fallback: info.window_name }) || info.window_name, nodeNames: nodeNames.value, deviceOrder: devPrefs.deviceOrder, plainText: plain, pins: prefs.chatPins }
      return withArchivedGroup(rosterGroups(activeFriends(friends.value), o), rosterGroups(archivedFriends(friends.value), o).flatMap(g => g.items))   // 通知有自己的分頁，不再列在夥伴名單最上面
    })
    // ---------- 群組對話：名單裡的一個分組（永遠顯示，沒有群組時有「建立群組」「加入群組」）；點進去在對話分頁看訊息、發言（lastChat 記成 room:<代號>） ----------
    // 資料與動作都在 lib/room-hub.mjs（電腦版共用）；發言與讀取走 Rust 指令並帶本人簽章
    const groupApi = createGroupApi(invoke)
    const hub = createRoomHub({ invoke, groupApi, selfNode: info.node, windowName: info.window_name, readCmd: 'android_room_read', postCmd: 'android_room_post', photos: true, reactive, visible: rid => core.isChatVisible(roomChatId(rid)), onRooms: r => reloginWatch.noteRooms(r), onFail: e => reloginWatch.noteError(e) })   // 跟 1 對 1 同一套：只有正在看的那個群組才標已讀
    const rooms = computed(() => hub.st.rooms)
    const roomsLoaded = computed(() => hub.st.loaded), roomsErr = computed(() => hub.st.err)
    const roomNote = computed({ get: () => hub.st.note, set: v => { hub.st.note = v } })   // 對話頁上方的一行提示（讀不到、發言失敗）
    // 最近有活動：24 小時內有往來的夥伴與群組（名單最上面；同一位在設備分組照常出現）
    const recentTick = ref(Date.now())
    setInterval(() => { recentTick.value = Date.now() }, 60_000)
    // 有往來的對話（lib/recent.mjs 的 chatListRows：活動中的對話＋最後使用的那一位＋有未讀的夥伴＋所有群組）；夥伴頁「未讀」與「夥伴」分頁的紅點都從這一份算
    const chatAll = computed(() => chatListRows({ friends: activeFriends(friends.value).filter(f => !isNoticeFriend(f) && !isMergedAway(f)), logOf: id => { void lastMap[id]; return core?.logOf(id) ?? [] }, rooms: hub.rows({ plainText: plain }), now: Math.max(recentTick.value, Date.now()), lastId: lastChat.value }))
    // 夥伴頁最上面的「未讀」（#1438）：只放有未讀的夥伴與群組，最新的在前；「夥伴」分頁的紅點用同一份算（不套搜尋字，兩邊一定對得上）
    const unreadRows = computed(() => unreadChatRows(chatAll.value))
    // 夥伴頁有搜尋字時藏起「未讀」那一組（#1442）：它不套搜尋字（和紅點同一份），搜尋時留著會像是沒篩到；紅點照舊
    const unreadShown = computed(() => showUnreadGroup(unreadRows.value, normalizeSearchQuery(query.value)))
    // 釘選（#1479）：存在手機本機設定 mobilePrefs.chatPins（格式就是之後帳號層同步用的那一份）。夥伴頁最上面多一組「釘選」，依釘選時間由早到晚；
    // 釘選的對話不管有沒有近期往來都列（不從 chatListRows 篩），找不到的（夥伴已不在名單、群組已退出）就不列
    const PIN_GROUP_KEY = 'pinned', PIN_GROUP_LABEL = '釘選'
    const isChatPinned = id => isPinned(prefs.chatPins, id)
    function togglePinChat(id) {
      const r = togglePin(prefs.chatPins, id)
      if (r.ok) prefs.chatPins = r.state
      else showToast(r.text)   // 滿 50 個：底部一句話說明，不動原本的釘選
    }
    // 搜尋時照搜尋條件過濾、仍排最上面（跟電腦版一致，#1479）；封存優先：已封存的不顯示（activeFriends 已排除），釘選紀錄照留
    const pinnedRowsM = computed(() => {
      const out = pinnedTargets(prefs.chatPins, activeFriends(friends.value).filter(f => !isNoticeFriend(f) && !isMergedAway(f)), hub.rows({ plainText: plain })).map(t => (t.friend
        ? { kind: 'friend', id: t.friend.id, at: lastTrafficAt(core?.logOf(t.friend.id) ?? []), friend: t.friend }
        : { kind: 'room', id: t.room.chatId, at: Number.isFinite(t.room.at) ? t.room.at : 0, room: t.room }))
      const q = normalizeSearchQuery(query.value)
      return q ? out.filter(x => friendMatchesQuery(x.kind === 'room' ? { nick: x.room.name } : x.friend, q, plain)) : out   // 比對規則和名單搜尋一樣（跟電腦版對話分頁搜尋同一條）
    })
    const topGroups = computed(() => {
      return [
        { key: PIN_GROUP_KEY, label: PIN_GROUP_LABEL, cls: 'm-pinned', rows: pinnedRowsM.value, shown: pinnedRowsM.value.length > 0 },
        { key: UNREAD_GROUP_KEY, label: UNREAD_GROUP_LABEL, cls: 'm-unread', rows: unreadRows.value, shown: unreadShown.value },
      ].filter(g => g.shown)
    })
    // 名單列長按（電腦版是右鍵）：叫出那一列的選單（名稱、釘選、一對一的管理項目／群組的三項）。選單沿用對話頁「⋯」那一份（opsRows）
    const rowPress = createRowPress({ onLong: id => openRowMenu(id) })
    const rowPressOf = id => rowPressBind(rowPress, id)
    const plusOpen = ref(false)   // 名單右上角「＋」選單
    const pickPlus = op => { plusOpen.value = false; if (op === 'create') groupFlow.openCreate(); else if (op === 'join') groupFlow.openJoin(); else openLaunch('') }
    const roomRows = computed(() => hub.rows({ query: query.value, plainText: plain }))
    const roomsNote = computed(() => roomsNoteText(hub.st))   // 群組清單原位的說明（讀不到、或登入失效只列得出這台的群組）；正常時是空字串
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
      const f = opsFriend.value
      if (!f) return []
      return chatGroupItems(f)   // 跟電腦版「群組」按鈕、現代外觀的「更多」同一份（#539 之四、#1421）
    })
    function pickGroup(key) {
      const f = opsFriend.value
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
      void mobileStateApi.invitePending().then(onInviteCode).catch(() => { /* 出口已留警告記錄；沒帶邀請碼進來照常使用 */ })
      void refreshRooms()
    }
    const unreadTotal = computed(() => chatRowsUnread(unreadRows.value))   // 「夥伴」分頁的紅點（#1429）：和夥伴頁最上面的「未讀」那一組同一份（#1438）
    const noticeDot = computed(() => noticeUnread(friends.value))
    // Play 安裝的版本（不能自己下載更新）：版本紀錄裡 Play 上最新的版本比自己新 → 「設定」分頁與設定列表的「更新」那列亮紅點（#1437）
    const playNewVersion = computed(() => (upd.enabled ? '' : playUpdateVersion(rel, info.version)))
    const tabHasDot = t => tabDot(t, { chats: unreadTotal.value, notice: noticeDot.value, update: playNewVersion.value !== '' })
    // 內頁佔著第四格、人已經離開它（3 分鐘計時中）時有新通知進來：第四格馬上變回「通知」（#1429）。雲端代理的金鑰還在內頁上時不動（金鑰只顯示一次）
    // 開新夥伴第 2 步還沒送出時也不動（照 3 分鐘的規則走，不在打字到一半時把表單收掉）
    // 看通知最新一則的時間（不看未讀數：名單重載時未讀數會 0→N，不是新通知）
    watch(() => noticeLastAt(friends.value), (n, o) => { if (isNewNotice(o, n) && !cloudSt.created && !lchStep2.value) fourthNav.noticeArrived() })
    const emptyText = computed(() => (query.value.trim() ? '找不到符合的聯絡人。' : conn.value === 'off' ? ROSTER_LOAD_FAIL_TEXT : conn.value === 'connecting' ? ROSTER_CONNECTING_TEXT : '名單上還沒有夥伴。'))
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
    // 現代外觀的對話頂端（#1421 B 之三）：置中名牌（頭像、名字、哪台電腦・狀態，和電腦頂部共用 nameplateView）；
    // 點名牌開「⋯」選單；右邊「看終端」直接切對話窗格裡同一顆切換（chatPaneEl 是 <chat-pane> 的元件實例）。復古 Aero 不顯示這兩樣（mobile.css）
    const chatPlate = computed(() => (chatFriend.value ? nameplateView(chatFriend.value) : null))
    const chatPaneEl = ref(null)
    // 群組頂端右邊的「N 人離線」（#1460）：一對一放「看終端」的位置；名單與人數和電腦頂部共用 offlineView，全員在線＝null 不顯示
    const chatOffline = computed(() => (chatFriend.value?.room ? offlineView(chatFriend.value.offline) : null))
    // LINE 外觀：進到對話頁時底部導覽收起來（只在 LINE 才設 data-line-chat，其他外觀的畫面不變）
    const lineChat = computed(() => prefs.skin === 'line' && nav.tab === 'chats' && !!chatFriend.value)
    // 名單是蓋在對話上的一層浮層（nav.sheet === 'offline'，同「⋯」選單）：開＝推一筆記錄，系統返回鍵／點外面／Esc／切分頁／人數變了＝退掉那一筆（#1466）
    let offlineClosing = false
    const offlineOpen = computed(() => nav.sheet === 'offline')
    function closeOffline() { if (nav.sheet !== 'offline' || offlineClosing || fourthNav.busy()) return; offlineClosing = true; history.back() }
    function toggleOffline() { if (offlineOpen.value) closeOffline(); else if (!nav.sheet && !fourthNav.busy()) go(offlineNav()) }
    let afterOffline = null   // 名單裡點了人：等名單那一筆記錄退掉（popstate 回來）再跳，不留多餘的記錄（#1515）
    watch(() => nav.sheet, s => { if (s !== 'offline') { offlineClosing = false; if (afterOffline) { const f = afterOffline; afterOffline = null; f() } } })
    watch([() => !!chatOffline.value, () => chatFriend.value?.id], () => closeOffline())
    // 看大圖（#1537）：跟名單同一套浮層（nav.sheet === 'photo'）。開＝推一筆記錄；系統返回鍵退掉那一筆＝關掉看圖、留在同一個對話；
    // 用「關閉」鈕、點背景、Esc 關掉＝把那一筆退掉，不留多的記錄（之後再按返回照原本的行為）。縮放中按返回也是直接關掉
    let photoShown = false
    function onPhotoViewer(open) {
      photoShown = open
      if (open) { if (nav.tab === HOME_TAB && !nav.sheet && !fourthNav.busy()) go(photoNav()) }
      else if (nav.sheet === 'photo' && !fourthNav.busy()) history.back()
    }
    watch(() => nav.sheet, s => { if (s !== 'photo' && photoShown) chatPaneEl.value?.closeViewer?.() })
    window.addEventListener('keydown', e => { if (e.key === 'Escape') closeOffline() })
    const headTerm = computed(() => { const p = chatPaneEl.value; return p && p.mSwitch ? p.mToggle : null })
    function toggleHeadTerm() { const p = chatPaneEl.value; if (!p || !p.mSwitch) return; if (p.remoteShown) p.showMsgs(); else p.showTerm() }
    const chatLog = computed(() => (isRoomChat(lastChat.value) ? hub.view(roomIdOf(lastChat.value)) : logs[lastChat.value]) ?? [])
    // 群組裡點成員（#1515）：在夥伴名單裡就換成那一位，推一筆對話分頁的記錄（返回鍵回到群組，見 popstate）；
    // 名單開著先退掉名單那一筆再跳。不在名單回 false（呼叫端說明）
    function openMember(key) {
      const id = memberFriendId(key, core?.friends)
      if (!id) return false
      const jump = () => {
        if (fourthNav.busy() || nav.tab !== HOME_TAB) return
        const from = lastChat.value
        if (from === id) return
        history.replaceState({ ...(history.state ?? {}), jumpFrom: from, jumpTo: id }, '')
        memberJump = { from, to: id }
        lastChat.value = id
        banner.value = null
        go(tabNav(HOME_TAB))
      }
      if (nav.sheet === 'offline') {
        if (offlineClosing || fourthNav.busy()) return true   // 名單正在收（或導覽中）：這一下不跳，也不留著等
        afterOffline = jump; closeOffline()
      } else jump()
      return true
    }
    // 「N 人離線」名單的一列（只有帶成員鍵的能點）：不在夥伴名單就收起名單、在對話上方說明
    function pickOffline(it) {
      if (!it?.key) return
      if (openMember(it.key) === false) { closeOffline(); roomNote.value = MEMBER_NOT_FRIEND }
    }
    // 點群組：成為「最後使用」，切到對話分頁並進那一則
    function openRoom(chatId) { lastChat.value = chatId; banner.value = null; roomNote.value = ''; fourthNav.openChat() }

    // 點夥伴（或橫幅）：那位成為「最後使用」，切到對話分頁並進那一則
    function openChat(id) {
      const f = core.friends.get(id); if (!f) return
      lastChat.value = id
      banner.value = null
      fourthNav.openChat()
    }
    const pushLog = id => { logs[id] = core.viewOf(id) }
    // 對話往上捲到頂：載入更舊的信；群組訊息編號點了、那一則還沒載入（opts.toSeq，#1530）：往前補載到那一則
    const loadOlder = (id, opts) => (isRoomChat(id) && Number.isInteger(opts?.toSeq) ? hub.loadBack(roomIdOf(id), opts.toSeq) : core.loadOlder(id))
    // 對話分頁正在顯示某位：標已讀、補往來。切到對話分頁、換了最後使用的那位、名單載入完都會跑
    function showLastChat() {
      const id = lastChat.value
      if (isRoomChat(id)) { if (nav.tab === 'chats') void showRoom(); return }
      if (nav.tab !== 'chats' || !id || !core?.friends.get(id)) return
      core.markRead(id)
      pushLog(id)
      void core.syncHistory(id)   // 向後台補這位夥伴 90 天的往來（以後台為準；失敗就用本機快取）
    }
    watch([() => nav.tab, () => nav.chat, () => nav.sheet, lastChat, () => friends.value.length, () => rooms.value.length], showLastChat, { immediate: true })
    // 通知分頁的「通知」對話（PR-H）：唯讀，沒有輸入列與通話鈕（chat-pane 看 friend.isNotice 自己隱藏）。正在看它（含收到新通知的當下）就標已讀
    const noticeChat = computed(() => friends.value.find(isNoticeFriend) ?? null)
    const noticeLog = computed(() => logs[NOTICE_ID] ?? [])
    const noticeShown = computed(() => nav.tab === 'notice' && !nav.sheet && !!noticeChat.value)
    function showNotice() { if (!noticeShown.value) return; core.markRead(NOTICE_ID); logs[NOTICE_ID] = core.viewOf(NOTICE_ID) }
    watch([noticeShown, () => noticeChat.value?.unread, () => noticeLog.value.length], showNotice, { immediate: true })
    const back = () => history.back()
    // 內頁：目前的內頁與標題（標題在內頁自己的頂端）
    const fourthPage = computed(() => fourthSt.fourth?.page ?? null)
    const fourthTitle = computed(() => (fourthPage.value?.kind === 'launch' ? lchTitle.value : fourthPage.value?.kind === 'acct' ? acctTitle.value : pageTitle(fourthPage.value)))   // 開新夥伴的標題跟著畫面（送出後的進度畫面叫「開新夥伴」）
    const tabIconOf = t => (t === PAGE_TAB ? pageIcon(fourthPage.value, acctCur.value ? 'devices' : acctSw.tab) : tabIcon(t))   // 第四格有內頁時用內頁自己的圖示（設定的某一項＝設定清單那一列的圖）
    const tabLabel = t => tabLabelOf(t, fourthTitle.value)   // 第四格有內頁時寫內頁的標題
    // 內頁的「關閉」：整個收起內頁，回到底下那個分頁（雲端代理的金鑰還在畫面上時先問）
    const closePage = () => askBeforeLeave(null, () => fourthNav.closePage())
    const openBanner = () => { const b = banner.value; banner.value = null; if (b) openChat(b.id) }
    // 橫幅上的「換班接手」：開啟那位的對話，直接帶到「換班接手」的確認框（不能換手時停在「⋯」選單，由選單說明原因）
    async function bannerHandover() {
      const b = banner.value; banner.value = null
      if (!b) return
      openChat(b.id)
      await fourthNav.whenSettled()   // 從別的分頁來要先退回對話分頁再進那一則（等 popstate）；「⋯」選單的記錄要推在那一則上面，不能搶先
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
    // 送一張附件；done（選填）收 { ok, error }：一次選多張時等這張的結果再送下一張（#1497）
    const sendAttachTo = async (id, item, caption, done) => {
      let r
      try {
        if (isRoomChat(id)) { const ok = await hub.postAttachment(roomIdOf(id), item, caption); if (nav.tab === 'chats') void showRoom(); r = ok ? { ok: true } : { ok: false, error: hub.st.note || '沒有傳出去' } }
        else { r = await core.sendAttachment(id, item, caption); if (!r.ok) console.info('[ASN] attachment failed', r.error) }
      } catch (e) { r = { ok: false, error: String(e?.message ?? e) } }
      if (typeof done === 'function') done({ ok: r.ok !== false, error: r.error ?? '' })
      return r
    }
    // ---------- 使用指引：設定分頁的一個項目，點進去是暫佔第四格的內頁（先列篇目，再看內文），內容沿用電腦版的篇目 ----------
    const guides = phoneGuideList()
    const guideOpen = computed(() => (fourthPage.value?.kind === 'guide' ? phoneGuide(fourthPage.value.guide) : null))
    // 設定分頁＝分類列表（每列一行目前值），點一列在設定分頁上打開該項的內頁（左上返回回設定）
    // ---------- 認得的電腦：看電腦畫面時確認指紋（頂端條＋底部浮層）、設備頁（每台的詳情、舊設備紀錄）確認與忘記。確認、忘記前都先過本人確認（生物辨識或螢幕鎖） ----------
    const kp = reactive({ list: [], loaded: false, error: '', busy: false })
    const loadKnown = async () => {
      try { kp.list = await knownPeers.list(); kp.loaded = true; kp.error = '' } catch (e) { console.info('[ASN] 認得的電腦讀不到', String(e?.message ?? e)); kp.error = knownErrorText(e) }
    }
    const forgetKnown = async node => {
      if (kp.busy) return
      kp.busy = true; kp.error = ''
      try { await knownPeers.forget(node); await loadKnown() } catch (e) { console.info('[ASN] 忘記這台沒成功', String(e?.message ?? e)); kp.error = knownErrorText(e) } finally { kp.busy = false }
    }
    // 「重新認這台」（#1860）：只有被擋下的那台出現。按下去先在原位問（寫明會發生什麼），確認才走原本「忘記」的流程（先過本人確認，再清掉記住的指紋）
    const reaccept = ref('')
    const reacceptAsk = node => { if (!kp.busy) reaccept.value = node }
    const reacceptNo = () => { reaccept.value = '' }
    const reacceptYes = async () => { const node = reaccept.value; reaccept.value = ''; if (node) await forgetKnown(node) }
    // 改名（這支手機自己、電腦、別的手機、雲端代理都一樣）：名字存在後台，所有設備都顯示；規則與送出都在 Rust（帳號簽章）。
    // 輸入框的內容只當文字；成功後重讀名單（名字跟著變）與認得的電腦；失敗顯示後台回的中文說明
    const dn = reactive({ node: '', text: '', busy: false, err: '' })
    const dnBad = computed(() => deviceNameError(dn.text))
    const dnHint = computed(() => (dn.text.trim() === '' ? '' : dnBad.value))   // 還沒打字時不先罵人
    const devRenameStart = d => { if (dn.busy || !d?.key) return; Object.assign(dn, { node: d.key, text: d.named ? (d.label ?? '') : '', err: '' }) }
    const devRenameCancel = () => { if (dn.busy) return; Object.assign(dn, { node: '', text: '', err: '' }) }
    const devRenameSave = async () => {
      const node = dn.node
      if (!node || dn.busy || deviceNameError(dn.text)) return
      dn.busy = true; dn.err = ''
      try {
        const r = await knownPeers.rename(node, dn.text)
        if (!r) { dn.err = KNOWN_TEXT.failed; return }   // 沒拿到成功的回覆：編輯框留著、顯示失敗，不讓人以為改好了
        Object.assign(dn, { node: '', text: '', err: '' })
        if (node === info.node) followSelfRename({ info, core, me }, { name: r.name, self_renamed: r.selfRenamed === true, window_name: r.windowName, window_rename_failed: r.windowRenameFailed }, showToast)   // 改的是這支手機：本機視窗名 Rust 也換了，畫面就地跟上
        await Promise.allSettled([core.refreshRoster(), loadKnown()])
      } catch (e) { console.info('[ASN] 改名沒成功', String(e?.message ?? e)); dn.err = renameErrorText(e) } finally { dn.busy = false }
    }
    // 正在看的那台電腦：開始看時 Rust 回它的指紋與有沒有確認；結束或切回訊息就清掉
    const vp = reactive({ cur: null, method: false, sheet: false, busy: false, error: '', ch: null, note: '', sheetName: '', noteOwn: false })
    // 從設定頁開確認畫面時暫存原本正在看的那台（{ cur }）；確認畫面全部收掉後由下面的 watch 統一還原。開始／結束看電腦（vpReset）就作廢
    let vpPrev = null
    // vp.noteOwn＝vp.note 是不是設定頁開的確認留下的：只在設定頁顯示、只在離開／重進設定頁時清；終端提示條那邊不顯示這種提示也不碰
    const vpReset = () => { vpPrev = null; vp.noteOwn = false; vp.cur = null; vp.method = false; vp.sheet = false; vp.busy = false; vp.error = ''; vp.ch = null; vp.note = ''; vp.sheetName = '' }
    const onRemoteStarted = r => { vpReset(); vp.cur = knownPeerOf(r, r?.machine) }
    const onRemoteEnded = () => vpReset()
    const peerStrip = computed(() => knownNeedsConfirm(vp.cur))
    // 按「確認指紋」：向 Rust 要四選一的題目（答案只在 Rust），題目出來才開浮層
    const openPeerSheet = async () => {
      const cur = vp.cur
      if (!cur || vp.busy) return
      vp.busy = true; vp.error = ''; vp.note = ''
      try {
        const ch = await knownPeers.challenge(cur)
        if (!ch) vp.note = KNOWN_TEXT.notReady
        else if (ch.state === 'locked') vp.note = KNOWN_TEXT.locked(ch.minutes)
        else if (ch.state === 'blocked') vp.note = KNOWN_TEXT.blocked
        else { vp.ch = ch; vp.sheetName = ch.localName === null ? cur.name : (ch.localName || unnamedLabelOf(cur.node)); vp.sheet = true }
      } catch (e) { console.info('[ASN] 出指紋題目沒成功', String(e?.message ?? e)); vp.note = knownErrorText(e) } finally { vp.busy = false }
    }
    // 「確認指紋」先選方法：用相機掃電腦上的 QR code（預設），或改用選的（四選一）。掃到的字只在外殼與 Rust 之間，這裡只拿得到結果的狀態字
    const openMethodSheet = () => { if (!vp.cur || vp.busy) return; vp.noteOwn = false; vp.note = ''; vp.error = ''; vp.method = true }
    // 確認成功：目前對象與（設定頁確認時暫存的）原本對象若是同一台，兩邊都標已確認，還原後提示條才不會又跳出來
    const markConfirmed = cur => { if (vp.cur === cur) vp.cur = { ...cur, confirmed: true }; if (vpPrev?.cur?.node === cur.node) vpPrev = { cur: { ...vpPrev.cur, confirmed: true } } }
    const closeMethodSheet = () => { vp.method = false }
    // 設備「詳情」裡的「確認」：把那台當成正在看的電腦，開同一個選方法浮層（之後的掃描、四選一、本人確認全走上面同一條路）
    const confirmKnown = p => { if (!p?.node || p.confirmed || vp.busy) return; const prev = vpPrev ?? { cur: vp.cur }; vpReset(); vpPrev = prev; vp.cur = knownPeerOf({ node: p.node, confirmed: false }, p.label); openMethodSheet(); vp.noteOwn = true }
    // 選方法、四選一、掃描都收掉且沒在忙（成功、取消、失敗、掃描結束都會走到這）→ 把目前對象還原成設定頁開啟前的那台；終端提示條開的沒有暫存，不動
    watch(() => !vp.method && !vp.sheet && !vp.busy, idle => { if (idle && vpPrev) { vp.cur = vpPrev.cur; vpPrev = null } })
    const methodPickInstead = async () => { vp.method = false; await openPeerSheet() }
    const SCAN_NOTES = { mismatch: KNOWN_TEXT.scanMismatch, bad_qr: KNOWN_TEXT.scanBad, blocked: KNOWN_TEXT.blocked, locked: KNOWN_TEXT.lockedNow, not_ready: KNOWN_TEXT.notReady }
    const scanPeer = async () => {
      const cur = vp.cur
      if (!cur || vp.busy) return
      vp.busy = true; vp.error = ''; vp.note = ''
      let r = 'cancel'
      try { r = await knownPeers.scan(cur.node) } catch (e) { console.info('[ASN] 掃 QR code 核對指紋沒成功', String(e?.message ?? e)); vp.method = false; vp.note = knownErrorText(e) } finally { vp.busy = false }
      if (r === 'cancel') return   // 本人取消：留在選方法的畫面，可以再選
      vp.method = false
      if (r === 'done') { markConfirmed(cur); vp.note = ''; void loadKnown(); return }
      if (r === 'no_camera') {
        // 沒有相機或沒給權限：直接改用選的，並在選的畫面上說明
        await openPeerSheet()
        if (vp.sheet) vp.error = KNOWN_TEXT.scanNoCamera
        else if (!vp.note) vp.note = KNOWN_TEXT.scanNoCamera
        return
      }
      vp.note = SCAN_NOTES[r] ?? ''
    }
    // #1863：選「用相機掃電腦上的 QR Code」之後，先請那台電腦自動跳出 QR Code（流程與字在 fp-show.mjs，電腦跳出的視窗共用同一份字）。
    // 那台的 ASN 不在線就不送、直接說沒有回應；跳出來了才換成「出現了」，本人按鈕開相機（接回上面的 scanPeer）。
    // 掃完、取消、離開這個畫面（選方法的浮層收掉、換了一台）一律請電腦收掉視窗（fpShow.finish 會呼叫 fp_show_end，同一筆只送一次）
    const fs = reactive(newFpShowState())
    const fpShow = createFpShowFlow({ state: fs, api: makeFpShowApi(), log: (...a) => console.info(...a) })
    let fsTimer = 0
    const fsStopTimer = () => { clearInterval(fsTimer); fsTimer = 0 }
    const fpShowStart = async () => {
      const cur = vp.cur
      if (!cur || vp.busy) return
      fsStopTimer()
      await fpShow.start(cur.node, core?.asn?.[cur.node])
      if (fs.phase === 'wait') fsTimer = setInterval(() => { void fpShow.tick().then(() => { if (fs.phase !== 'wait') fsStopTimer() }) }, FP_SHOW_POLL_MS)
    }
    // 重試：先重讀名單（那台可能剛打開 ASN），再從頭來
    const fpShowRetry = async () => {
      try { await core?.refreshRoster() } catch (e) { console.info('[ASN] 重讀名單失敗，照舊重試', String(e?.message ?? e)) }
      await fpShowStart()
    }
    const fpShowEnd = () => { fsStopTimer(); void fpShow.finish() }
    const fpShowScan = async () => { await scanPeer(); fpShowEnd() }
    watch(() => (vp.method && vp.cur ? vp.cur.node : ''), (node, old) => { if (old && node !== old && fs.phase !== 'idle') fpShowEnd() })
    window.addEventListener('pagehide', () => { if (fs.phase !== 'idle') fpShowEnd() })
    const closePeerSheet = () => { vp.sheet = false; vp.ch = null; vp.sheetName = '' }
    const PEER_NOTES = { wrong: KNOWN_TEXT.wrong, none: KNOWN_TEXT.noneMatch, locked: KNOWN_TEXT.lockedNow, blocked: KNOWN_TEXT.blocked, expired: KNOWN_TEXT.expired, not_ready: KNOWN_TEXT.notReady }
    // 選一個（-1＝都不一樣）：Rust 判斷；選對才過本人確認再記住。結果都收掉浮層，需要說的話放在條下面
    const choosePeer = async index => {
      const cur = vp.cur, ch = vp.ch
      if (!cur || !ch || vp.busy) return
      vp.busy = true; vp.error = ''
      try {
        const r = await knownPeers.pick(ch.id, index, cur.node)
        closePeerSheet()
        if (r === 'done') { markConfirmed(cur); vp.note = ''; void loadKnown() }
        else vp.note = PEER_NOTES[r] ?? ''
      } catch (e) { console.info('[ASN] 確認指紋沒成功', String(e?.message ?? e)); closePeerSheet(); vp.note = knownErrorText(e) } finally { vp.busy = false }
    }
    const peerSheetTitle = computed(() => (vp.cur ? KNOWN_TEXT.sheetTitle(vp.sheetName || vp.cur.name) : ''))
    const peerSheetBody = KNOWN_TEXT.sheetBody
    void loadKnown()
    // 新設備第一次連上時「是不是取代舊的」卡片（#1860 H；電腦同一份流程 lib/device-replace.mjs）。取代後把後台回寫的「已移除」當成拉到的新版併入，不是本機改完再推
    const replaceSt = reactive(newReplaceState())
    const replaceFlow = createReplaceFlow({
      state: replaceSt, api: deviceReplaceApi, log: (...a) => console.info(...a),
      beforeReplace: () => devSync.flush(),
      afterReplace: () => syncAfterReplace({ getPrefs: authApi.getDevicePrefs, devSync, refreshRoster: () => core.refreshRoster(), log: (...a) => console.info(...a) }),
    })
    const replaceCards = computed(() => replaceFlow.view())
    const replacePick = (node, old) => replaceFlow.choose(node, old)
    const replaceDo = (node, old) => void replaceFlow.replace(node, old)
    const replaceKeep = node => void replaceFlow.dismiss(node)
    void replaceFlow.load()
    // 通知上的「查看設備」（#1860 H；去哪由 notice.mjs 的 noticeGoOf 決定，電腦同一份規則）：
    // 每一則新設備通知各自一列（標題＋按鈕），不看最後一則是什麼，也不會因為後面來了別種通知就消失
    const noticeGos = computed(() => noticeGoRows(noticeLog.value))
    const goNotice = go => { if (go?.page === 'devices') openSetting('devices') }
    const settingRows = computed(() => mobileSettingRows({ skin: prefs.skin, name: myName.value, hasUpload: selfHasUpload.value, vibrateNudge: prefs.vibrateNudge, vibrateMsg: prefs.vibrateMsg, updateEnabled: upd.enabled, playView: playView.value, autoUpdate: prefs.autoUpdate, version: info.version, devices: acctDevs.value, accountCount: (acctMy.value?.vendors ?? []).reduce((n, v) => n + v.accounts.length, 0) }))
    const settingCat = computed(() => (fourthPage.value?.kind === 'setting' ? fourthPage.value.cat : ''))
    const settingTitle = computed(() => mobileSettingTitle(settingCat.value))
    // 設定 → 更新：版本紀錄從後台公開的 asn_site_releases 讀（Rust 端讀成功的留 10 分鐘），讀不到照實說（#462）
    const rel = reactive(initialReleases())
    let relBusy = false
    const loadRel = async (force = false) => {
      if (relBusy || rel.phase === 'loading') return
      relBusy = true
      const prev = { ...rel }
      if (prev.phase !== 'ok') rel.phase = 'loading'   // 已有資料的重讀不閃成「讀取中」（紅點不能跟著閃掉）
      // force 預設 false：Rust 端讀成功的只留 10 分鐘，比我們的 30 分鐘過期短，所以重讀不會拿到比 30 分鐘更舊的快取
      const res = await loadReleases(f => mobileSiteApi.releases(f), { force })
      Object.assign(rel, stampReleases(prev, res, Date.now()))
      relBusy = false
    }
    // 不能自己更新的版本（Play）：啟動讀、資料過期（30 分鐘）時回前景／進設定分頁／進更新頁再讀、讀失敗退避重試（30 秒、2 分、5 分、15 分，之後每 30 分；背景不試）
    const relRefresh = createReleasesRefresher({ getRel: () => rel, load: () => loadRel(), isForeground: () => document.visibilityState === 'visible', enabled: () => upd.enabled === false })
    fgListener = fg => relRefresh.onForeground(fg)
    const relLog = computed(() => buildLogView({ entries: rel.entries, current: info.version, available: null }))
    const relNote = computed(() => releasesNote(rel))
    const playView = computed(() => (upd.enabled ? { kind: 'unknown' } : playUpdateView(rel, info.version)))
    const playNewText = computed(() => (playView.value.kind === 'new' ? playNewTextOf(playView.value.version) : ''))
    const rowHasDot = key => key === 'update' && playNewVersion.value !== ''
    const openPlay = () => { void openPlayStore(url => openLink(url)) }   // 既有的 open_link（手機走系統 Intent；Android 會用 Play App 開這個 https 網址）
    watch(() => upd.enabled, en => { if (en === false) void relRefresh.run() }, { immediate: true })   // 不能自己更新的版本：啟動就讀版本紀錄，紅點才有依據
    watch(settingCat, c => { if (c === 'update' && releasesStale(rel, Date.now())) void loadRel() })   // 更新頁（兩種版本都有）：過期或沒讀過才讀
    watch(() => nav.tab, t => { if (t === 'me') relRefresh.check() })   // 進設定大分頁：過期才讀（只有 Play 版需要；check 內會看 enabled）
    // 雲端代理（#756）：進這一頁才讀清單、每 20 秒更新（看代理是否上線）；離開這一頁金鑰與剪貼簿都清掉
    const cloud = createMobileCloud({
      api: cloudApi, status: authApi.status, reactive,
      clip: { write: t => navigator.clipboard.writeText(t) },
      timer: { set: (f, ms) => setTimeout(f, ms), clear: id => clearTimeout(id) },
    })
    const cloudSt = cloud.state
    let cloudTimer = null
    watch(settingCat, (c, old) => {
      if (c === 'cloud') {
        void cloud.load()
        clearInterval(cloudTimer); cloudTimer = setInterval(() => void cloud.load(), CLOUD_POLL_MS)
      } else if (old === 'cloud') {
        clearInterval(cloudTimer); cloudTimer = null
        void cloud.leave().then(() => { if (cloudSt.msg) showToast(cloudSt.msg) })   // 頁面已關：丟金鑰、清不掉的提示改用一句話提示
      }
    })
    fourthKeepMs = () => (cloudSt.created ? CLOUD_KEY_KEEP_MS : FOURTH_KEEP_MS)   // 金鑰還在畫面上時，內頁切走後最多留 30 分鐘
    checkFourth = () => { if (cloudSt.created && fourthExpired(fourthSt.fourth, Date.now(), CLOUD_KEY_KEEP_MS)) cloud.markExpired(); return fourthNav.check(fourthKeepMs()) }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) cloud.onVisible() })
    // 設備與帳號（#268）開的是名單設備卡「選項」的同一頁（先看設備列表），其他分類開該分類的內頁；浮層開著時不開（lib/mobile-nav.mjs 擋）
    const openSetting = key => { if (ACCT_SETTING_KEYS.includes(key)) void openAcct({ tab: key }); else askBeforeLeave(settingPage(key), () => fourthNav.openPage(settingPage(key))) }
    const about = computed(() => aboutView({ deviceName: info.window_name }))
    const openAboutLink = url => { if (isAboutUrl(url)) openLink(url)?.catch(e => console.info('[ASN] 開啟連結失敗', String(e?.message ?? e))) }   // 交給系統瀏覽器（Rust 端 open_link 只放行 http／https）
    const aboutAct = l => (l.kind === 'link' ? openAboutLink(l.url) : l.kind === 'update' ? openSetting('update') : openGuides())   // 官網、隱私權政策開瀏覽器；版本紀錄＝「更新」頁、使用指引＝指引頁，都在 App 內
    const openGuides = () => askBeforeLeave(guidePage(), () => fourthNav.openPage(guidePage()))
    // 換內頁前先問一句：開新夥伴正在填第 2 步、還沒送出時，要換成別的內頁先問「要離開嗎？」（底部浮層，樣式沿用「⋯」選單；系統返回鍵＝留下）。
    // 選離開：先收起浮層，等浮層的記錄退掉（nav.sheet 變回空）才換；選留下就不動。單純切到前三頁不問（內容會保留 3 分鐘）
    const leaveSt = reactive({ ask: null })
    const leave = createLeaveAsk({ nav, st: leaveSt, go, back: () => history.back(), needs: next => !!cloudSt.created || needsLeaveAsk(fourthSt.fourth, next, { draft: lchStep2.value }) })
    const askBeforeLeave = (next, run) => { leave.ask(next, () => { cloud.confirmLeave(); run() }) }   // 本人按了離開：丟掉金鑰不再另外提示
    const answerLeave = ok => leave.answer(ok)
    const leaveAsk = computed(() => leaveSt.ask)
    const leaveText = computed(() => (cloudSt.created ? CLOUD_LEAVE_TEXT : LEAVE_ASK_TEXT))   // 雲端代理的金鑰還在畫面上時問的是另一句
    // 系統返回鍵：金鑰還在畫面上時先問一次（取消這次返回、開「要離開嗎」；選離開才丟金鑰、再返回一次）
    keyBackGuard = () => {
      if (!cloudSt.created || nav.sheet || fourthNav.busy()) return false
      history.pushState(fourthNav.state(), '')
      leave.ask(null, () => { cloud.confirmLeave(); void cloud.leave(); history.back() })
      return true
    }
    watch(() => nav.sheet, s => leave.onSheet(s))
    const openGuide = key => fourthNav.pushLayer(guidePage(key))   // 篇目列表 → 單篇：多一層，返回鍵回列表
    // ---------- 開新夥伴（遠端開視窗）：手機只下指令，視窗開在那台電腦上。要本人簽章（Rust 端沒憑證就不送） ----------
    const lch = reactive({ ...initialLaunch(), vphase: 'sending' })
    const lchData = reactive({ machines: {}, loaded: false, error: '' })
    watch(() => lchData.machines, m => setNodePlatforms(m, { node: info.node, phone: true }), { immediate: true })   // 手機還是電腦只有 node-platform.mjs 一份判斷（#1829）
    const acctSigned = () => (acct.value.known ? acct.value.signed_in : null)   // 還沒查到登入狀態＝null，不是「沒登入」
    const lchCtx = computed(() => ({ machines: lchData.machines, loaded: lchData.loaded, signedIn: acctSigned(), authError: acct.value.error, friends: friends.value }))
    const lchDevices = computed(() => launchDevices(friends.value, { selfNode: info.node, nodeNames: nodeNames.value, nodeOrder: nodeOrder.value, removed: devPrefs.deviceRemoved, ...lchCtx.value }))
    const lchElig = computed(() => (lch.node ? launchEligibility(lch.node, lchCtx.value) : { ok: false, reason: '' }))
    const lchChoices = computed(() => launchChoices(lchData.machines[lch.node]))
    // 「模型」只列廠牌，「運行」四選一（D1 #421，跟電腦版同一套）：內建通道 ＞ 經 pi ＞ ASN 開的終端 ＞ 原生 CLI（只作說明）。不能選的反灰並寫原因
    const lchLauncher = computed(() => lchData.machines[lch.node]?.launcher ?? null)
    const lchVendors = computed(() => launchVendors(lchLauncher.value))
    const lchRow = computed(() => lchVendors.value.find(v => v.id === lch.vendor) ?? null)
    const lchRun = computed(() => launchRun(lchRow.value, lchLauncher.value))
    const lchRunKey = computed(() => pickedRun(lchRun.value, lch.run))
    // 經 pi（D2 #422）：那台回報的 pi 模型清單（要開放遠端管理）；預設第一個
    const lchPi = computed(() => launchPiChoice(lchRow.value, lchLauncher.value))
    const lchReq = computed(() => buildLaunchRequest(lch, { run: lchRunKey.value, row: lchRow.value, launcher: lchLauncher.value }))
    const lchFormErr = computed(() => (lch.node ? launchFormError(lch, lchElig.value, { run: lchRunKey.value, piOk: !!lchReq.value }) : ''))
    function pickLaunchVendor(v) { Object.assign(lch, { vendor: v.id, profile: v.profileId, run: '', piModel: '' }) }
    async function loadLaunchers() {
      lchData.error = ''
      try { lchData.machines = machinesByNode(await mobileLaunchApi.launchers()); lchData.loaded = true } catch (e) { lchData.loaded = false; lchData.error = launchErrorText(e.message) }
    }
    function pickLaunchDevice(node) {
      if (!launchEligibility(node, lchCtx.value).ok) return
      const c = launchChoices(lchData.machines[node])
      Object.assign(lch, { node, deviceLabel: lchDevices.value.find(d => d.key === node)?.label ?? '', error: '' })
      const vs = launchVendors(lchData.machines[node]?.launcher)
      if (!vs.some(v => v.id === lch.vendor)) { const v = vs[0]; Object.assign(lch, { vendor: v?.id ?? '', profile: v?.profileId ?? '', run: '', piModel: '' }) }
      if (!c.cwds.includes(lch.cwd)) lch.cwd = c.cwds[0] ?? ''
      if (!lch.name.trim()) lch.name = defaultPartnerName(friends.value, lch.profile)
    }
    // 開新夥伴是內頁：第 1 步選電腦、第 2 步（多一層，返回鍵回第 1 步）選模型與資料夾、名字、第一句話。
    // 畫面收起（關閉或 3 分鐘到了）不影響背景的開窗：lch 留在這裡，trackLaunch 照常追蹤，開好時跳橫幅
    const openLaunch = (node, vendor = '') => askBeforeLeave(launchPage(), () => openLaunchNow(node, vendor))   // 金鑰還在畫面上時先問；vendor＝新手引導卡指定的那一家
    function openLaunchNow(node, vendor = '') {
      const isLaunch = fourthPage.value?.kind === 'launch'
      // 還在開：回到進度畫面；內頁的開新夥伴還在填：切過去接著填（都不重來）
      if (launchInProgress(lch) || (isLaunch && lch.phase === 'form')) { if (isLaunch) goTab(PAGE_TAB); else fourthNav.openPage(launchPage()); return }
      if (nav.sheet) return
      Object.assign(lch, initialLaunch(), { vphase: 'sending' })
      if (!fourthNav.openPage(launchPage())) return
      void loadLaunchers().then(() => fourthNav.whenSettled()).then(() => {   // 從設備細部頁進來時，換頁要等導覽做完，才推第 2 步
        if (!node) return
        pickLaunchDevice(node)
        const v = vendor ? launchVendors(lchData.machines[node]?.launcher).find(x => x.id === vendor) : null
        if (v) pickLaunchVendor(v)   // 新手引導卡：選好那一家
        nextLaunch()
      })   // 從某台電腦進來＝第 1 頁已選好，直接到第 2 頁
    }
    // 第 2 頁才顯示該電腦可用的模型與資料夾；沒選電腦或那台不能開就留在第 1 頁
    const lchStep2 = computed(() => fourthPage.value?.kind === 'launch' && fourthPage.value.step === 2 && !!lch.node && lch.phase === 'form')
    const lchTitle = computed(() => pageTitle(launchPage(lchStep2.value ? 2 : 1)))
    const lchCanNext = computed(() => !!lch.node && lchElig.value.ok)
    function nextLaunch() { if (!lchCanNext.value || fourthPage.value?.kind !== 'launch' || fourthPage.value.step === 2) return; lch.error = ''; fourthNav.pushLayer(launchPage(2)) }
    // 開好後或失敗後關閉整個面板（第 1、2 步的記錄一次退掉，回到進來之前的頁籤）
    const closeLaunch = () => fourthNav.closePage()
    // ---------- 設備卡「切換 Claude 帳號」：選帳號 → 確認 → 送出並等對方電腦回報 ----------
    const acctKeys = computed(() => new Set(acctButtonDevices(groups.value, info.node).filter(g => !devPrefs.deviceRemoved.includes(g.node)).map(g => g.key)))
    // 整頁＝電腦版「設備與帳號」：資料用電腦版同一份整理函式；別台電腦的帳號逐台向後台讀（只讀選到的那台）
    const acctSw = reactive({ phase: 'pick', page: 'list', tab: 'devices', node: '', picked: '', reports: {}, view: null })
    // 帳號列表（#374）：進「設備與帳號」讀一次，開著時每 5 分鐘再讀（跟電腦版同一個節奏）；
    // 讀不到沿用上一次讀成功的，從沒成功過才是 null（畫面退回各台自己回報的）
    const acctRoster = ref(null)
    const loadRoster = async () => { acctRoster.value = await fetchRoster(acctTransport.acctRoster, undefined, acctRoster.value) }
    setInterval(() => { if (fourthPage.value?.kind === 'acct' && document.visibilityState === 'visible') void loadRoster() }, ROSTER_POLL_MS)
    const acctMy = computed(() => acctRosterView(acctRoster.value, { friends: friends.value, nodeNames: nodeNames.value, selfNode: info.node }))
    const cloudMem = ref(loadCloudNodes())   // 本機記住「上次判成雲端」的節點，離線時標示才不會消失
    const acctAllDevs = computed(() => acctDeviceTree({ cloudNodes: cloudMem.value, friends: friends.value, nodeNames: nodeNames.value, nodeFacts: nodeFacts.value, nodeOrder: nodeOrder.value, deviceOrder: devPrefs.deviceOrder, shown: devPrefs.deviceShown, removed: devPrefs.deviceRemoved, selfNode: info.node, reports: acctSw.reports, launchers: lchData.machines, machines: lchData.machines, roster: acctRoster.value }))
    // 整台離線、夥伴全封存、沒未讀的設備不列頁籤；收在「已隱藏的設備」，可手動顯示
    watch(acctAllDevs, rows => { const next = nextCloudNodes(cloudMem.value, rows); if (!sameNodes(next, cloudMem.value)) { cloudMem.value = next; saveCloudNodes(next) } })
    const acctDevs = computed(() => visibleRows(acctAllDevs.value))   // 列表＝全部設備（含已隱藏，淡色標「已隱藏」）；永久移除的收在底部
    // 認得的電腦紀錄和設備列對起來（列的 key 就是紀錄的 node，指紋圖示用）；永久移除的、只剩紀錄的收進「已移除的設備」一塊（名單還沒讀到時不列）
    const joined = computed(() => joinKnown(acctAllDevs.value, kp.list))
    const removedBlock = computed(() => removedDevices(acctAllDevs.value, kp.list))
    const acctRowLine = d => deviceRowLine(d)
    const curKnown = computed(() => (acctCur.value ? joined.value.byNode[acctCur.value.key] ?? null : null))
    const showHiddenDevice = key => { devPrefs.deviceShown = showDevice(devPrefs.deviceShown, key) }
    // 細部頁：只有 page 是 detail 且那台還在列表裡才有（被移除或消失就退回列表）
    const acctTitle = computed(() => acctPageTitle(acctCur.value ? 'devices' : acctSw.tab))   // 標題跟著分頁（看某台細部時是「設備」）
    const acctHead = computed(() => acctHeadView(acctSw.tab, acctCur.value, DEVICE_TEXT.hiddenTag))   // 標題列：看某台細部時直接是「設備名＋狀態」，頁內不再重複（#1864）
    const acctCur = computed(() => (acctSw.page === 'detail' ? acctDevs.value.find(d => d.key === acctSw.node) ?? null : null))
    const acctCanRemove = computed(() => canRemoveRow(acctCur.value))
    const acctCanShowBack = computed(() => canShowBackRow(acctCur.value))   // 和電腦版同一個函式（#1829）
    // 設備活過來（又有在線視窗或未讀）就自動從永久移除名單解除
    watch([() => friends.value, () => devPrefs.deviceRemoved], () => { const next = pruneRemoved(devPrefs.deviceRemoved, friends.value, { selfNode: info.node }); if (next.length !== devPrefs.deviceRemoved.length) devPrefs.deviceRemoved = next }, { deep: true })
    const acctLabel = computed(() => acctCur.value?.label ?? '')
    const acctRep = computed(() => acctSw.reports[acctCur.value?.key] ?? null)
    const acctView = computed(() => acctSheetView(acctClaudeRemote(acctRep.value), acctSw.picked, Date.now(), { roster: acctRoster.value, friends: friends.value, nodeNames: nodeNames.value, selfNode: info.node }))
    const acctConfirm = computed(() => acctConfirmText(acctLabel.value, acctView.value.currentEmail, acctView.value.pickEmail))
    let acctToken = 0, acctEpoch = 0, acctRunSeq = 0   // acctToken：畫面還在不在（離開就換）；acctRunSeq：第幾個切換（送出新的才換）
    async function loadAcct(node, force = false) {
      if (!acctNeedsLoad(acctDevs.value.find(d => d.key === node))) return
      const old = acctSw.reports[node]
      if (!force && old && (old.loading || !old.msg)) return   // 讀過或正在讀就不重讀；上次失敗的再點一次會重試
      const epoch = acctEpoch
      acctSw.reports[node] = { loading: true, asnOnline: false, reportedAt: '', msg: '', list: [], failCount: old?.failCount ?? 0, ...(old?.countedAt ? { countedAt: old.countedAt } : {}) }
      try {
        const v = await acctTransport.acctList(node)
        if (epoch === acctEpoch) acctSw.reports[node] = acctReportEntry(old, { value: v })
      } catch (e) { console.info('[ASN] 帳號回報讀取失敗', node, String(e?.message ?? e)); if (epoch === acctEpoch) acctSw.reports[node] = acctReportEntry(old, { error: acctErrorText(e) }) }
    }
    // 進設備頁時預讀各台帳號回報（#930）：為了顯示「雲端」標示，進設備頁時讀一次；一分鐘內再進就用上次讀到的，不重讀
    const acctPrefetch = createReportPrefetch({ read: node => acctTransport.acctList(node) })
    const acctPrefetched = {}
    async function prefetchReports() {
      const epoch = acctEpoch
      const put = (node, r) => { if (epoch === acctEpoch && (!acctSw.reports[node] || isFailedReport(acctSw.reports[node]))) acctSw.reports[node] = r }
      const nodes = acctDevs.value.filter(d => acctNeedsLoad(d)).map(d => d.key)
      await acctPrefetch(nodes, (node, v) => {
        const r = acctReportEntry(null, { value: v })
        acctPrefetched[node] = r
        put(node, r)
      })
      for (const [node, r] of Object.entries(acctPrefetched)) put(node, r)   // 一分鐘內沒重讀的（或只重讀了失敗的）：先前讀到的結果補上
    }
    // 別台帳號回報自動重讀（#2158，不加按鈕）：設備／帳號頁開著時每分鐘檢查一次，讀失敗超過 1 分鐘的、讀成功超過 5 分鐘的再讀；頁面關掉就停。
    // 進頁面那一刻的第一次讀取由上面的 prefetchReports 做（immediate: false）；同一台正在讀就不再發
    const acctReloading = new Set()
    async function reloadReports() {
      const epoch = acctEpoch
      const nodes = acctDevs.value.filter(d => acctNeedsLoad(d)).map(d => d.key)
      const due = reportsDue({ nodes, reports: acctSw.reports, now: Date.now(), failedOf: r => Boolean(r?.msg), isOnline: n => acctDevs.value.find(d => d.key === n)?.online !== false }).filter(n => !acctReloading.has(n))
      await Promise.all(due.map(async node => {
        acctReloading.add(node)
        try {
          const prev = acctSw.reports[node]
          let next
          try { next = acctReportEntry(prev, { value: await acctTransport.acctList(node) }) } catch (e) {
            console.info('[ASN] 帳號回報重讀失敗', node, String(e?.message ?? e))   // 原始錯誤只進 log，畫面用白話
            next = acctReportEntry(prev, { error: acctErrorText(e) })
          }
          if (epoch === acctEpoch) acctSw.reports[node] = next
        } finally { acctReloading.delete(node) }
      }))
      return due.length
    }
    const acctReportScheduler = createReportScheduler({ run: reloadReports, isOpen: () => fourthPage.value?.kind === 'acct' })
    watch(() => fourthPage.value?.kind === 'acct', open => { if (open) acctReportScheduler.start({ immediate: false }); else acctReportScheduler.stop() }, { immediate: true })
    // 從夥伴列表設備旁的「選項」或設定列表進來；開新夥伴第 2 步還沒送出時先問一句
    const openAcct = g => askBeforeLeave(acctPage(), () => void openAcctNow(g))
    async function openAcctNow(g) {
      if (nav.sheet) return
      acctEpoch++; acctToken++   // 重新打開：之前還在跑的讀取與切換不再更新這個畫面（切換的結果改用提示說）
      Object.assign(acctSw, { phase: 'pick', page: 'list', picked: '', view: null, reports: {}, tab: acctTabOf(g?.tab) })
      if (g?.tab === 'devices' || !g?.tab) { void loadKnown(); void replaceFlow.load() }
      // 從夥伴列表某台設備旁的「選項」進來：直接開那一台的細部頁（底下墊一層列表，返回鍵回列表）；從別處進來先看列表
      if (g?.node && acctDevs.value.some(d => d.key === g.node)) { acctSw.node = g.node; acctSw.page = 'detail' } else acctSw.node = ''
      if (!fourthNav.openPage(acctPage(acctSw.node))) return
      if (!lchData.loaded) void loadLaunchers()
      void loadRoster()
      void prefetchReports()
      if (acctSw.page === 'detail') void loadAcct(g.node)
    }
    function openAcctDevice(key) {
      if (acctSw.phase !== 'pick') return
      const stale = !!fourthPage.value?.node   // 細部那台不見了（畫面退回列表）又點另一台：取代那一層，不多留一筆
      acctSw.node = key; acctSw.picked = ''; acctSw.page = 'detail'
      fourthNav.pushLayer(acctPage(key), { replace: stale })
      return loadAcct(key)
    }
    // 設備列的「詳情」：同一層細部頁（名字、指紋、第一次見到、隱藏與移除、被擋下時的「重新認這台」）。帳號不在這裡，只在設定的「帳號」頁（#1860）；
    // 還是讀一次那台的回報：新電腦引導卡要靠它知道四家各裝了沒
    function openAcctInfo(key) {
      if (acctSw.phase !== 'pick') return
      const stale = !!fourthPage.value?.node
      acctSw.node = key; acctSw.picked = ''; acctSw.page = 'detail'; reaccept.value = ''
      fourthNav.pushLayer(acctPage(key), { replace: stale })
      void loadKnown()
      void loadAcct(key)
    }
    // 帳號分頁的「切換到某台」：開那台的細部頁、等它的帳號讀回來，再進確認畫面（現有的選帳號→確認→送出流程，不另做一套）
    const setAcctTab = t => { acctSw.tab = acctTabOf(t); if (acctSw.tab === 'devices') void replaceFlow.load() }
    // 能不能把帳號切到這一台：手機版的本機永遠不行（判斷只在 isSwitchTarget 一處）
    const acctCanSwitchTo = node => isSwitchTarget(acctDevs.value.find(d => d.key === node), info.node)
    const acctSwitchOn = async (node, email) => { if (!acctCanSwitchTo(node)) return; await openAcctDevice(node); startAcctSwitch(email) }
    // 帳號卡片的設備列（#2111 ②）：一台一列，列的狀態由共用的 accountDeviceRows 決定（電腦同一個函式；手機只有 Claude 能切換）；切換進行中的那台顯示「切換中…」
    const acctDevRows = (vendor, a) => accountDeviceRows(acctDevs.value, vendor, a?.account, a?.usedOn, { vendors: ['claude'], switchingNode: acctSw.phase === 'run' ? acctSw.node : switchBusyNode(acctRowSwitch, vendor, a?.account, acctDevs.value.map(d => d.key)) })
    const acctInUseOf = (vendor, a) => accountInUse(acctDevRows(vendor, a), a?.current)
    // 登入失效（#1960）：和電腦同一組函式（account-roster.mjs）；「重新登入」走手機既有的 setupAsk(…, 'relogin')，確認與進度在那一列下方原位顯示
    const acctLoginLostOf = (vendor, a) => accountLoginLost(acctDevRows(vendor, a))
    const acctLoginNotices = computed(() => loginLostNotices(acctMy.value?.vendors ?? [], acctDevRows))
    // 還沒登入 Codex 的別台電腦（那台回報「可以從手機替它登入」）：帳號頁列出，按下去開確認（確認與進度在那台的詳情裡原位顯示）
    const acctLoginTargets = computed(() => acctDevs.value.filter(d => !d.self && !d.phone && d.online && d.cloud !== true)
      .flatMap(d => [...d.vendors, ...d.missing].filter(v => Object.hasOwn(LOGIN_VENDORS, v.key) && v.login?.kind === 'remote').map(v => ({ node: d.key, label: d.label, vendor: v.key }))))
    const acctLoginPress = t => { loginAsk(t.node, t.vendor); openAcctInfo(t.node) }
    const acctReloginPress = b => { if (b.state === 'relogin' && !acctReloginHere(b.node)) setupAsk(b.node, 'relogin') }
    const acctReloginHere = node => setupSt.mode === 'relogin' && setupSt.node === node && setupSt.stage !== 'idle'
    // 按帳號卡設備列的「切換」（#2111 ③）：不跳框、不進確認頁，那一列顯示「切換中…」，結果在那一列下方原位顯示；成功後重讀帳號列表，卡片頂端與設備列一起變。
    // 流程與文字和電腦同一份（switch-result.mjs）；對方電腦預設仍會要使用者按「同意」才換
    const acctRowSwitch = reactive({})
    const acctRowTracker = createSwitchTracker({ state: acctRowSwitch, log: (...a) => console.info(...a) })
    const acctRowCurrent = (vendor, email, node) => {
      const acc = (acctMy.value?.vendors ?? []).find(x => x.key === vendor)?.accounts.find(x => String(x.account).trim().toLowerCase() === String(email).trim().toLowerCase())
      return accountDeviceRows(acctDevs.value, vendor, email, acc?.usedOn, { vendors: ['claude'] }).find(r => r.node === node)?.current === true
    }
    const acctDevPress = (b, a, vendor = 'claude') => {
      if (b.state !== 'switch' || !acctCanSwitchTo(b.node)) return
      const email = a.account
      void acctRowTracker.press({
        key: switchRowKey(vendor, email, b.node), label: b.label,
        run: async () => { const v = await runAcctSwitch(acctTransport, b.node, email); return v.phase === 'done' ? { ok: true } : { ok: false, fail: v.fail } },
        reload: async () => { await loadRoster(); await loadAcct(b.node, true) },
        synced: () => acctRowCurrent(vendor, email, b.node),
      })
    }
    const acctRowResult = (vendor, a, node) => switchResultOf(acctRowSwitch, switchRowKey(vendor, a?.account, node))
    // 從手機替電腦安裝並登入 Claude Code（#650 F）：按鈕 → 確認 → 送出 → 每 5 秒查狀態 → 結果。真正的安裝在電腦上做，這裡只下指令與看狀態
    // mode：'install'＝安裝並登入、'relogin'＝重新登入（#1512 C；送的是同一個要求，只差按鈕與確認字）
    const setupSt = reactive({ node: '', mode: 'install', stage: 'idle', since: 0, saw: false, reached: false, fails: 0, lead: '', text: '', note: '', ok: false, msg: '' })
    let setupTimer = null
    const setupStop = () => { clearInterval(setupTimer); setupTimer = null }
    const setupReset = () => { setupStop(); Object.assign(setupSt, { node: '', mode: 'install', stage: 'idle', since: 0, saw: false, reached: false, fails: 0, lead: '', text: '', note: '', ok: false, msg: '' }) }
    // 失敗的結果一定要看得到：用 role="alert" 顯示，並把設備卡捲到看得見的地方（結果在畫面外，本人會以為沒事）
    const setupShowFailure = () => { void Vue.nextTick(() => document.querySelector('.m-dv-setup .m-dv-prog, .m-dv-devconfirm.m-dv-prog')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })) }
    const setupFinish = (text, ok, note = '') => {
      setupStop(); Object.assign(setupSt, { stage: 'done', ok, text, note }); if (!ok) setupShowFailure()
      if (ok && setupSt.mode === 'relogin') { void loadRoster(); void loadAcct(setupSt.node, true) }   // 登入好了：重讀帳號列表與那台的回報，帳號頁的「登入已失效」提示與標籤一起消失（#1960）
    }
    const setupAsk = (node, mode = 'install') => { setupReset(); Object.assign(setupSt, { node, mode: mode === 'relogin' ? 'relogin' : 'install', stage: 'confirm' }) }
    const setupNo = () => { if (setupSt.stage === 'confirm') setupReset() }
    const setupPoll = async () => {
      const node = setupSt.node
      if (!node || setupSt.stage !== 'waiting') return
      let res = { ok: true, st: null }
      try { res = { ok: true, st: setupStateOf((await mobileSetupApi.remoteStatus())?.nodes, node) } } catch { res = { ok: false } }   // 查不到先下一輪再查；連續 3 次就告訴本人
      if (setupSt.node !== node || setupSt.stage !== 'waiting') return
      const { next, view: v } = setupStep({ since: setupSt.since, saw: setupSt.saw, reached: setupSt.reached, fails: setupSt.fails }, res, Date.now())
      Object.assign(setupSt, { saw: next.saw, reached: next.reached, fails: next.fails })
      if (!v) return
      if (v.done) return setupFinish(v.text, v.ok, v.note)
      Object.assign(setupSt, { text: v.text, note: v.note, ok: v.ok })
    }
    const setupYes = async () => {
      if (setupSt.stage !== 'confirm') return
      const node = setupSt.node
      setupSt.stage = 'sending'; setupSt.msg = ''; setupSt.text = SETUP_TEXT.sending
      let sent = null
      try {
        sent = await mobileSetupApi.remoteRequest(node, setupSt.mode === 'relogin')
      } catch (e) {
        if (setupSt.node !== node) return
        return setupFinish(setupErrorText(e), false)
      }
      if (setupSt.node !== node) return
      Object.assign(setupSt, { stage: 'waiting', since: Date.now(), text: SETUP_TEXT.pending, lead: setupLeadOf(sent) })
      setupTimer = setInterval(() => void setupPoll(), SETUP_POLL_MS)
      void setupPoll()
    }
    const setupClose = () => setupReset()
    // ---------- 新手引導卡（#1605）：看某台自己的電腦（設備細部頁），它一個視窗也沒有時，列出四家各一個動作 ----------
    // 狀態用設備卡已經算好的（vendors／missing 的 state、action、login、relogin），規則與電腦版同一份（lib/new-computer-guide.mjs）；手機沒辦法叫那台電腦重新偵測，所以沒有「重新檢查」
    const guideHidden = ref(loadGuideHidden())
    const guideHint = ref({ key: '', text: '' })
    const guideNode = computed(() => {
      const d = acctCur.value
      return d && !d.self && !d.phone && d.cloud !== true && d.online ? d : null
    })
    const guideCtx = () => ({ conn: conn.value, rosterLoaded: true, query: '', localWindows: guideNode.value ? activeFriends(friends.value).filter(f => f.node === guideNode.value.key && !isNoticeFriend(f) && !isMergedAway(f)).length : 1, hidden: guideHidden.value })
    const guideStates = computed(() => {
      const d = guideNode.value
      if (!d) return {}
      const all = [...d.vendors, ...d.missing]
      const st = k => all.find(v => v.key === k)?.state ?? null
      const known = s => s && s !== STATE.NO_REPORT && s !== STATE.UNKNOWN_INSTALL
      // Gemini 不在「主要幾家」裡：有它的設備項目就是裝了；沒有就看另外三家的狀態查到了沒，查到了才說沒裝
      const gemini = d.vendors.find(v => v.key === 'gemini') ? STATE.INSTALLED_LOGGED_OUT : (['claude', 'codex', 'grok'].every(k => known(st(k))) ? STATE.NOT_INSTALLED : null)
      return { claude: st('claude'), codex: st('codex'), gemini, grok: st('grok') }
    })
    const guideRowList = computed(() => {
      const d = guideNode.value
      if (!d) return []
      const all = [...d.vendors, ...d.missing]
      const by = k => all.find(v => v.key === k)
      const remote = { install: {}, login: {} }
      for (const k of ['claude', 'codex', 'grok']) { remote.install[k] = by(k)?.action?.kind === 'remote'; remote.login[k] = by(k)?.login?.kind === 'remote' || by(k)?.relogin?.kind === 'remote' }
      return guideRows({ states: guideStates.value, isSelf: false, remote })
    })
    const guideOn = computed(() => guideNode.value !== null && guideVisible(guideCtx()))
    const guideReshow = computed(() => guideNode.value !== null && guideReshowVisible(guideCtx()))
    const guideHintView = computed(() => {
      if (guideHint.value.text) return guideHint.value
      // 要求安裝被拒、過期、沒人接手：說到那台電腦的哪裡打開開關
      if (setupSt.node === guideNode.value?.key && setupSt.mode === 'install' && setupSt.stage === 'done' && !setupSt.ok) return { key: 'claude', text: GUIDE_TEXT.installSwitch }
      return null
    })
    const setGuideHidden = v => { guideHidden.value = v === true; saveGuideHidden(guideHidden.value) }
    // 官網：交給系統瀏覽器（open_link 只放行 http／https）；只開引導卡列出的四個網址
    const guideSite = site => { if (GUIDE_VENDORS.some(v => v.url === site?.url)) openLink(site.url)?.catch(e => console.info('[ASN] 開啟官網失敗', String(e?.message ?? e))) }
    async function guideAct(row) {
      const d = guideNode.value
      if (!d || !row) return
      guideHint.value = { key: '', text: '' }
      if (row.action === 'open') {
        // 先看那台能不能開；不能就說原因（沒開放時，原因裡就有「允許我的其他設備替這台開新視窗」要去哪裡勾）
        if (!lchData.loaded) await loadLaunchers()
        const elig = launchEligibility(d.key, lchCtx.value)
        if (!elig.ok) { guideHint.value = { key: row.key, text: elig.reason }; return }
        openLaunch(d.key, row.key)
        return
      }
      if (row.action === 'login') {
        if (row.key === 'claude') setupAsk(d.key, 'relogin')
        else if (row.key === 'codex') loginAsk(d.key, 'codex')
        return
      }
      if (row.action === 'install') setupAsk(d.key)
    }
    // 從手機替電腦登入裝置碼型 CLI（#933 PR-5b，先做 Codex）：按鈕 → 確認 → 送出（這支手機的設備金鑰簽）→ 每 3 秒取一次 →
    // 拿到就顯示「給哪台、哪一家」、開啟登入頁、代碼與倒數（不給複製）→ 之後照狀態顯示結果。網址與代碼只在顯示階段放在這裡，離開、進背景、到期就清
    const loginSt = reactive({ node: '', vendor: '', stage: 'idle', rid: '', text: '', ok: false, url: '', code: '', exp: 0, name: '', left: 0 })
    let loginTimer = null
    // 停止這一輪：連 Rust 那邊記著的一次性私鑰也丟掉（離開、進背景、到期、出錯、按關閉都走這裡）
    const loginStop = () => { clearInterval(loginTimer); loginTimer = null; if (loginSt.rid) void mobileSetupApi.deviceCancel(loginSt.rid).catch(() => { /* 出口已留警告記錄；這輪已停，私鑰最後由 Rust 端過期清掉 */ }) }
    const loginWipe = () => { Object.assign(loginSt, { url: '', code: '', exp: 0, left: 0 }) }
    const loginReset = () => { loginStop(); loginWipe(); Object.assign(loginSt, { node: '', vendor: '', stage: 'idle', rid: '', text: '', ok: false, name: '' }) }
    const loginEnd = (text, good = false) => { loginStop(); loginWipe(); Object.assign(loginSt, { stage: 'done', text, ok: good }) }
    const loginAsk = (node, vendor) => { if (!Object.hasOwn(LOGIN_VENDORS, vendor)) return; loginReset(); Object.assign(loginSt, { node, vendor, stage: 'confirm' }) }
    const loginNo = () => { if (loginSt.stage === 'confirm') loginReset() }
    const loginTick = async () => {
      const { node, rid } = loginSt
      if (loginSt.stage === 'show') {
        loginSt.left = secondsLeft(loginSt.exp)
        if (!loginSt.left) return loginEnd(LOGIN_TEXT.expired)
        // 代碼顯示中：看那台電腦回報的結果（不再取代碼）
        let st = null
        try { st = setupStateOf((await mobileSetupApi.remoteStatus())?.nodes, node) } catch { return /* 出口已留警告記錄，這一輪先略過 */ }
        if (loginSt.node !== node || loginSt.stage !== 'show') return
        if (st && (st.state === 'done' || st.state === 'failed')) loginEnd(st.detail || (st.state === 'done' ? LOGIN_TEXT.doneOk : LOGIN_TEXT.failed), st.state === 'done')
        return
      }
      if (loginSt.stage !== 'waiting' || !rid) return
      let r = null
      try { r = await mobileSetupApi.deviceFetch(rid) } catch { return }   // 查不到這一輪就下一輪再查
      if (loginSt.rid !== rid || loginSt.stage !== 'waiting') return
      const v = fetchView(r, loginSt.vendor)
      if (v.stage === 'show') { Object.assign(loginSt, { stage: 'show', url: v.url, code: v.code, exp: v.exp, name: v.name, left: secondsLeft(v.exp) }); return }
      if (v.stage === 'done') return loginEnd(v.text, v.ok)
      loginSt.text = v.text
    }
    const loginYes = async () => {
      if (loginSt.stage !== 'confirm') return
      const { node, vendor } = loginSt
      Object.assign(loginSt, { stage: 'sending', text: LOGIN_TEXT.sending })
      let r = null
      try { r = await mobileSetupApi.deviceRequest(node, vendor) } catch (e) { if (loginSt.node === node) loginEnd(loginErrorText(e)); return }
      if (loginSt.node !== node) return
      const v = requestView(r)
      if (v.stage === 'done') return loginEnd(v.text)
      Object.assign(loginSt, { stage: 'waiting', rid: v.rid, text: v.text })
      loginTimer = setInterval(() => void loginTick(), LOGIN_POLL_MS)
      void loginTick()
    }
    const loginClose = () => loginReset()
    // App 進背景：顯示中的代碼清掉，結束這一輪
    document.addEventListener('visibilitychange', () => { if (document.hidden && loginSt.stage === 'show') loginEnd(LOGIN_TEXT.expired) })
    // 返回：細部頁回列表＝退一筆記錄（細部是內頁的一層；退回列表時 acctSw 由下面的監看整理）。細部頁頂端的「‹ 返回」、標題列返回鍵、系統返回鍵都一樣
    const acctBackToList = () => back()
    // 內頁換了：設備與帳號的列表／細部跟著記錄走；離開設備與帳號就讓還在跑的讀取與切換不再更新畫面
    watch(fourthPage, (p, old) => {
      if (p?.kind !== 'acct') { if (old?.kind === 'acct') { acctToken++; acctEpoch++; setupReset(); loginReset() } return }
      if (p.node) { acctSw.node = p.node; acctSw.page = 'detail'; return }
      if (old?.kind === 'acct' && old.node) acctToken++   // 細部退回列表：進行中的切換不再更新畫面
      Object.assign(acctSw, { phase: 'pick', page: 'list', node: '', picked: '' })
    })
    // 離開或重進詳情：清掉詳情裡開確認留下的失敗提示（成功時 scanPeer／choosePeer 已清）、收掉沒送出的改名
    watch(() => acctSw.page === 'detail', (now, was) => { if (now !== was) { if (vp.noteOwn) { vp.note = ''; vp.noteOwn = false }; kp.error = ''; if (!dn.busy) Object.assign(dn, { node: '', text: '', err: '' }) } })
    // 被隱藏的設備：顯示回名單／永久移除（要先看過二次確認）／恢復
    const acctShowBack = () => { if (acctCur.value) showHiddenDevice(acctCur.value.key) }
    const acctAskRemove = () => { if (acctSw.phase === 'pick' && acctCanRemove.value) acctSw.phase = 'rm' }
    const acctRemoveText = computed(() => DEVICE_TEXT.confirmRemove(acctCur.value?.identity?.title))
    function acctRemoveNow() {
      if (acctSw.phase !== 'rm' || !acctCanRemove.value) return
      devPrefs.deviceRemoved = removeDevice(devPrefs.deviceRemoved, acctCur.value.key, { selfNode: info.node })
      acctBackToList()
    }
    const acctRestore = key => { devPrefs.deviceRemoved = restoreDevice(devPrefs.deviceRemoved, key) }
    // 排序：每列左邊有「排序把手」，只有按住把手才會拖（把手 touch-action:none），其餘地方照常捲動、點一下進細部頁；把手聚焦後也能用上下鍵移動
    const acctDrag = reactive({ key: '', over: '', after: false })
    // 每列右邊直接一顆「詳情」，不再點一列才展開按鈕（#1860）
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
      if (acctSw.phase !== 'pick' || !acctCanSwitchTo(acctCur.value?.key)) return
      acctSw.picked = email
      if (acctView.value.canPick && acctView.value.pickEmail) acctSw.phase = 'confirm'
      else acctSw.picked = ''
    }
    const acctBackToPick = () => { acctSw.phase = 'pick'; acctSw.picked = '' }
    async function submitAcct() {
      if (acctSw.phase !== 'confirm' || !acctView.value.pickEmail || !acctCanSwitchTo(acctCur.value?.key)) return   // 一定要先看過確認畫面才送；不能切到這支手機自己
      const token = ++acctToken, run = ++acctRunSeq, email = acctView.value.pickEmail, node = acctCur.value.key, label = acctCur.value.label
      acctSw.phase = 'run'
      // 離開進行中的畫面（退回列表、離開設備與帳號）後：指令照樣送出、照樣等結果，只是不再更新畫面；送出另一個切換才停止等這一個
      const v = await runAcctSwitch(acctTransport, node, email, { onUpdate: v => { if (token === acctToken) acctSw.view = v }, cancelled: () => run !== acctRunSeq })
      // 結果出來時使用者已經不在那個畫面（離開了，或切到別的分頁）：跳一句提示；還在畫面上就照原本在畫面上顯示
      if (run === acctRunSeq && (token !== acctToken || nav.tab !== PAGE_TAB)) showToast(acctResultToast(v, { label, email }))
    }
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    async function trackLaunch(t) {
      const stop = Date.now() + LAUNCH_GIVE_UP_MS
      while (lch.id === t.id && Date.now() < stop) {
        await sleep(LAUNCH_POLL_MS)
        let row = null
        try { row = ((await mobileLaunchApi.launchers([t.id]))?.launches ?? []).find(l => l.id === t.id) } catch { /* 下一輪再問 */ }
        if (row?.status === 'ok' || row?.status === 'unconfirmed') await core.refreshRoster()
        const appeared = appearedIn(friends.value, t.node, t.name)
        const v = progressView(row, appeared, t.name, appeared ? appearedModel(friends.value, t.node, t.name) : '')
        if (lch.id !== t.id) return
        Object.assign(lch, { vphase: v.phase, text: v.text })
        if (appeared) {
          lch.friendId = friendId(t.node, t.name)
          if (!(nav.tab === PAGE_TAB && fourthPage.value?.kind === 'launch')) banner.value = { id: lch.friendId, nick: t.name, line: '已經開好了，點一下開始對話', status: 'online', hue: 200 }
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
        const body = lchReq.value
        if (!body) throw new Error('請選一個 pi 的模型')
        const r = await mobileLaunchApi.launch(body)
        if (!r?.id) throw new Error('送出失敗')
        Object.assign(lch, { phase: 'progress', id: r.id, since: Date.now(), friendId: '', detail: '', ...(({ phase, text }) => ({ vphase: phase, text }))(progressView(null, false)) })
        void trackLaunch({ id: r.id, node: lch.node, name })
      } catch (e) { lch.error = launchErrorText(e.message) } finally { lch.busy = false }
    }
    // 開好了「開始對話」：收起內頁並直接切到對話分頁（對話分頁就是那一位，#1438）；不再多推「進那一則」的記錄，返回鍵不會多按一次（#1442）
    function openLaunched() {
      const id = lch.friendId
      if (!id) return
      if (!core.friends.get(id)) { closeLaunch(); return }
      lastChat.value = id; banner.value = null
      fourthNav.closePage(HOME_TAB)
    }
    // ---------- 「⋯」選單：管理這位夥伴的視窗（詳情、改名、切換模型、關閉視窗、換班接手；離線的只有喚醒） ----------
    // 判斷全部用 lib/partner-ops.mjs 的 menuItems／opFormError／progressView，手機不另寫一套。手機只下指令，視窗在那台電腦上
    const opsCtx = computed(() => ({ machines: lchData.machines, loaded: lchData.loaded, signedIn: acctSigned(), authError: acct.value.error, friends: friends.value, nonWindowNodes: [info.node] }))
    // 選單對象：預設是對話頁上那一位；從名單長按叫出來時是被按的那一列（opsTargetId，選單收起就清掉）
    const opsTargetId = ref('')
    const rowFriendOf = id => {
      if (isRoomChat(id)) { const row = roomRowOf(roomIdOf(id)); return row ? roomPseudoFriend(row) : null }
      return friends.value.find(x => x.id === id) ?? null
    }
    const opsFriend = computed(() => (opsTargetId.value ? rowFriendOf(opsTargetId.value) : chatFriend.value))
    const headWake = computed(() => headCallView(chatFriend.value, opsCtx.value).kind === 'wake')   // 對話頁右上角：離線可喚醒時換成紅色喚醒圖示（#1866）
    const opsItems = computed(() => (opsFriend.value ? manageItems(opsFriend.value, opsCtx.value) : []))
    // 選單畫面上的列：手機對話頁上方沒有按鈕列，管理項目都在這裡；喚醒、切換模型排最前面，其餘順序和電腦版一致。
    // 這位夥伴永遠用不到的不列（在線的喚醒、一般視窗的重開／移除…），暫時不能用的反灰寫原因（規則在 mobile-ops.mjs phoneOpApplies）
    const opsRows = computed(() => buildPartnerMenu(opsFriend.value, opsCtx.value, 'phone'))   // 四個入口共用的組選單函式（#1559，lib/partner-menu.mjs）
    const opsView = computed(() => sharedWhy(opsRows.value))   // 同一個原因只在選單最上方寫一次
    const ops = reactive({ phase: 'menu', newName: '', note: '', ack: false, model: '', error: '', view: null })
    const opsAcp = computed(() => acpSwitchChoices(opsFriend.value))   // 內建通道工作者的型號清單（Gemini 有、Grok 沒有＝手動輸入），跟電腦版同一份
    const opsText = computed(() => opDialogText(ops.phase, opsFriend.value?.agent || opsFriend.value?.nick || '', opsFriend.value?.device || '', dialogEngine(opsFriend.value), { hasList: opsAcp.value.models.length > 0 }))
    const opsTitle = computed(() => (ops.phase === 'menu' ? (opsFriend.value?.nick ?? '') : opsText.value.title || OP_LABEL[ops.phase] || ''))
    const opsModels = phoneModels(), opsModelNote = MODEL_NOTE
    const opsIsPi = computed(() => ['pi', 'acp'].includes(partnerEngine(opsFriend.value)))   // pi 與內建通道的工作者沒有固定的模型清單：改成輸入框（Claude 的常用清單對它們不適用）
    // pi 的模型下拉選單（#443／#444）：那台開放遠端管理時，啟動設定摘要會帶它的 pi 能用的模型；沒有就退回輸入框並說明
    const opsPiChoices = computed(() => {
      const f = opsFriend.value
      if (partnerEngine(f) !== 'pi') return { groups: [], selected: '' }
      return piModelChoices(cleanPiModels(lchData.machines?.[f.node]?.launcher?.pi_models), f.model)
    })
    const opsPiNote = computed(() => (partnerEngine(opsFriend.value) === 'pi' && !opsPiChoices.value.groups.length ? PI_MODEL_REMOTE_NOTE : ''))
    const opsRuns = ref({})   // 對話頁頂端的進度，依夥伴位址分開存（#928）：{ [friend.id]: { op, view } }
    const opsBanner = computed(() => opLineNote(runFor(opsRuns.value, chatFriend.value?.id)))
    let opsToken = 0
    // 名單列長按／右鍵叫出選單：蓋在目前的分頁上（不切到對話頁），對象是被按的那一列
    // 長按放開手指時，有些環境會補一個 click，落在剛長出來的選單上（可能正好是某一項或背景）：選單剛開、手指剛放開的零點四秒內，選單裡的 click 不算數（#1479）
    let rowMenuAt = 0
    const ROW_MENU_GUARD_MS = 400
    const opsClickGuard = e => { if (opsTargetId.value && Date.now() - Math.max(rowMenuAt, rowPress.lastAt()) < ROW_MENU_GUARD_MS) { e.stopPropagation(); e.preventDefault() } }
    function openRowMenu(id) {
      if (nav.sheet || fourthNav.busy() || !rowFriendOf(id)) return
      opsTargetId.value = id
      rowMenuAt = Date.now()
      Object.assign(ops, { phase: 'menu', newName: rowFriendOf(id)?.agent ?? '', note: '', ack: false, model: '', error: '', view: null })
      opsToken++
      go({ tab: nav.tab, sheet: 'ops', chat: nav.chat })
      void loadLaunchers()
    }
    watch(() => nav.sheet, s => { if (s !== 'ops') opsTargetId.value = '' })
    const opsPinLabel = computed(() => (opsTargetId.value ? pinMenuLabel(prefs.chatPins, opsTargetId.value) : ''))
    function pickPin() {
      const id = opsTargetId.value
      if (!id) return
      history.back()
      togglePinChat(id)
    }
    function openOps() {
      if ((!opsItems.value.length && !groupItems.value.length) || nav.sheet) return
      opsTargetId.value = ''
      Object.assign(ops, { phase: 'menu', newName: chatFriend.value?.agent ?? '', note: '', ack: false, model: '', error: '', view: null })
      opsToken++
      go(opsNav())
      void loadLaunchers()   // 各台電腦的在線與開放狀態（選單的可按條件）
    }
    function pickOp(op) {
      const item = opsItems.value.find(i => i.key === op)
      if (!item || !item.ok) return
      ops.error = ''
      if (op === 'archive' || op === 'unarchive') { history.back(); void setArchived(opsFriend.value, op === 'archive'); return }
      if (opStep(op) === 'run') void submitOp(op)
      else {
        if (op === 'model' && opsPiChoices.value.groups.length) ops.model = opsPiChoices.value.selected
        if (op === 'model' && opsAcp.value.models.length) ops.model = opsAcp.value.selected
        ops.phase = op
      }
    }
    async function submitOp(op) {
      const f = opsFriend.value
      if (!f) return
      const item = opsItems.value.find(i => i.key === op)
      const input = { newName: ops.newName, model: ops.model, note: ops.note, ack: ops.ack }
      const piGroups = op === 'model' ? opsPiChoices.value.groups : []
      if (piGroups.length && !piGroups.some(g => g.options.some(o => o.value === input.model))) { ops.error = PI_MODEL_PICK_ERR; return }
      const acpList = op === 'model' ? opsAcp.value.models : []
      if (acpList.length && !acpList.some(m => m.id === input.model)) { ops.error = '請從清單選一個模型'; return }
      const err = opFormError(f, op, input, item)
      if (err) { ops.error = err; return }
      const inSheet = showsInSheet(op)
      if (inSheet) ops.phase = 'info'
      else history.back()
      await execOp(f, op, input)
    }
    // 送出並顯示進度（#1800）：詳情的進度留在選單裡；其他動作就地顯示在對話頁頂端，成功幾秒後自己消失、失敗附「重試」。
    // 非詳情的操作（含封存）與電腦版共用同一份 createOpRunner：連按只認最後一次、重試、自動消失都在那裡
    const opsRunState = { get runs() { return opsRuns.value }, set runs(v) { opsRuns.value = v } }
    let archiveNoteTimer = null
    // 封存／取消封存：記在帳號層（後台），立刻重新拉名單；結果也用名單上方的一行字說明
    const onArchived = async r => {
      if (r.ok) await core.refreshRoster()
      archiveNote.value = r.text
      clearTimeout(archiveNoteTimer)
      archiveNoteTimer = setTimeout(() => { archiveNote.value = '' }, 6000)
    }
    const opRunner = createOpRunner({ api: opsTransport, state: opsRunState, run: makeOpRun({ onArchived }), onDone: d => { void afterOpDone(d) } })
    async function afterOpDone({ op, view, friend: f, input }) {
      if (op === 'archive' || op === 'unarchive') return
      await core.refreshRoster()   // 狀態與名字變了：重新拉名單；改名後對話分頁跳到新名字
      const next = renamedChatId(f, op, input, view)
      if (!next) return
      opRunner.move(f.id, next)   // 進度與自動消失的倒數都跟著新名字走，舊名字那格清掉
      prefs.chatPins = renamedPinId(prefs.chatPins, f.id, next)   // 釘選跟著換成新的對話位址（#1479）
      if (lastChat.value === f.id && core.friends.get(next)) lastChat.value = next   // 只有正在看的那一位才跟著跳；從名單改別人的名字不動對話頁
    }
    async function execOp(f, op, input) {
      if (!showsInSheet(op)) { await opRunner.start(f, op, input); return }
      const token = ++opsToken
      await runPartnerOp(opsTransport, f, op, input, {
        onUpdate: v => { if (token === opsToken) ops.view = v },
        cancelled: () => token !== opsToken,
      })
    }
    const setArchived = (f, archived) => (f ? opRunner.start(f, archived ? 'archive' : 'unarchive', {}) : Promise.resolve(null))
    const retryInfo = () => { const f = opsFriend.value; if (f) void execOp(f, 'info', {}) }
    // 狀態列（#1907）：手指按著時暫停自動消失的倒數，放開再繼續
    const holdRun = () => { const f = chatFriend.value; if (f) opRunner.hold(f.id) }
    const releaseRun = () => { const f = chatFriend.value; if (f) opRunner.release(f.id) }
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
      try { list = secretList(await mobileAskApi.secretPending()) } catch { return /* 出口已留警告記錄，下一輪再查 */ }
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
      try { await mobileAskApi.secretReply(cur.id, value); history.back() }
      catch (e) { sec.error = secretError(e); sec.busy = false }
    }
    const laterSecret = () => { if (sec.cur) secDismissed.add(sec.cur.id); history.back() }
    watch(() => nav.sheet, s => { if (s !== 'secret' && sec.cur) secClose() })
    document.addEventListener('visibilitychange', () => { void checkSecrets() })
    setInterval(() => { void checkSecrets() }, SECRET_POLL_MS)
    void listen('relay-bell', () => { void checkSecrets() })
    // ---------- 手機回答權限框（#853）：電腦上的夥伴在問權限，跳出全文和選項，按一個就送那個數字
    // 全文只給本人看（不寫儲存、不進紀錄、不放系統通知）；沒登入或後台還沒部署就靜默略過；門鈴沒有內容
    const pq = reactive({ cur: null, armed: false, busy: false, error: '', waiting: false, result: null })
    const pqDismissed = new Set()
    let pqArmTimer = 0, pqResultTimer = 0, pqWatchTimer = 0, pqAutoTimer = 0
    const pqWatchStop = () => { clearInterval(pqWatchTimer); pqWatchTimer = 0 }
    const pqClose = () => { pqWatchStop(); clearTimeout(pqAutoTimer); clearTimeout(pqArmTimer); clearInterval(pqResultTimer); Object.assign(pq, { cur: null, armed: false, busy: false, error: '', waiting: false, result: null }) }
    // 外來訊息確認框：請求不帶種類，靠兩顆按鈕的字認；標題與提醒字改成外來訊息的版本
    const permHeld = computed(() => isHeldOptions(pq.cur?.options))
    const permReqTitle = computed(() => pqAskTitle(pq.cur?.deviceName, pq.cur?.window))
    const permShownTitle = computed(() => permHeld.value ? heldTitle(pq.cur?.window) : permReqTitle.value)
    const pqDeviceName = node => deviceNameOf(node, { nodeNames: nodeNames.value, friends: friends.value })
    async function checkPermReqs() {
      if (pq.busy || pq.cur || sec.cur || nav.sheet || !acct.value.signed_in || document.visibilityState !== 'visible') return
      let list
      try { list = pqList(await mobileAskApi.permReqList(), pqDeviceName) } catch { return /* 出口已留警告記錄，下一輪再查 */ }
      const next = pqNext(list, pqDismissed)
      if (!next || nav.sheet) return
      Object.assign(pq, { cur: next, armed: false, busy: false, error: '', waiting: false, result: null })
      clearTimeout(pqArmTimer)
      pqArmTimer = setTimeout(() => { pq.armed = true }, PQ_ARM_MS)
      go(permReqNav())
      pqWatchStart()
    }
    // 框開著時每 5 秒看一次這筆還在不在：電腦撤回不會通知手機，不查的話按鈕會一直留著（#921）。
    // 只在框開著而且畫面在前景時查；關框或切到背景就停；查不到（失敗）不當成結束
    async function pqWatchTick() {
      const cur = pq.cur
      if (!cur || pq.busy || pq.waiting || pq.result || document.visibilityState !== 'visible') return
      let alive = null
      try { alive = pqStill(await mobileAskApi.permReqList(), cur.id) } catch { return /* 出口已留警告記錄，下一輪再查 */ }
      const out = pqWatchOutcome(alive)
      if (out && pq.cur === cur && !pq.busy && !pq.waiting && !pq.result) { pqWatchStop(); pq.result = out; pqAutoArm() }
    }
    // 電腦那邊已經處理掉、本人沒按過：顯示一行字，約 2 秒後自己收框（只有輪詢這條會走到；按了選項之後的 cancelled 不自動收）。
    // 計時器到了要確認還是同一筆；切到背景會清掉，回前景再重排
    function pqAutoArm() {
      clearTimeout(pqAutoTimer); pqAutoTimer = 0
      const cur = pq.cur
      if (!cur || !pq.result?.auto || document.visibilityState !== 'visible') return
      pqAutoTimer = setTimeout(() => { pqAutoTimer = 0; if (pq.cur === cur && pq.result?.auto) laterPermReq() }, PQ_AUTOCLOSE_MS)
    }
    function pqWatchStart() {
      pqWatchStop()
      if (pq.cur && !pq.result && document.visibilityState === 'visible') pqWatchTimer = setInterval(() => { void pqWatchTick() }, PQ_WATCH_MS)
    }
    function pqWaitResult(id) {
      let tries = 0
      pq.waiting = true
      clearInterval(pqResultTimer)
      pqResultTimer = setInterval(async () => {
        tries += 1
        let r = null
        try { r = pqResult(await mobileAskApi.permReqList(), id) } catch { /* 出口已留警告記錄，下一輪再查 */ }
        if (!r && tries < PQ_RESULT_TRIES) return
        clearInterval(pqResultTimer)
        Object.assign(pq, { waiting: false, result: r ?? { ok: false, text: PERMREQ_TEXT.unknown } })
      }, PQ_RESULT_MS)
    }
    async function decidePermReq(n) {
      const cur = pq.cur
      if (!cur || pq.busy || !pq.armed) return
      const args = pqDecideArgs(cur, n)
      if (!args) return
      pq.busy = true; pq.error = ''
      try { await mobileAskApi.permReqDecide(args); pqDismissed.add(cur.id); pqWaitResult(cur.id) }
      catch (e) { pq.error = pqError(e); pq.busy = false }
    }
    const laterPermReq = () => { if (pq.cur) pqDismissed.add(pq.cur.id); history.back() }
    // #1445：照原本的選項顯示、危險提示（只從電腦端的代碼查表，不從本文推斷）、要小心的放行類按住一秒才算
    const permOpts = computed(() => pqOptionsView(pq.cur))
    const permRisk = computed(() => pqRiskView(pq.cur))
    const permTrunc = computed(() => pqTruncNote(pq.cur))
    const permHold = createHold({ onDone: n => { void decidePermReq(n) }, vibrate: ms => { if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(ms) }, state: reactive({ key: null }) })   // 沒真的點過畫面時瀏覽器不准震，也不要叫
    watch(() => [pq.cur?.id, pq.busy, pq.waiting], () => permHold.cancel())
    // 按住到一半 App 被切走、失去焦點：取消（不能在背景按滿送出；asn真 審查）
    window.addEventListener('blur', () => permHold.cancel())
    document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') permHold.cancel() })
    const permPress = o => { if (!o.hold) void decidePermReq(o.n) }   // 點一下只算不用按住的；要按住的放開時的 click 不算
    function permHoldStart(o) { if (o.hold && !pq.busy && pq.armed) permHold.start(o.n) }
    function permHoldKey(o, e) { if (o.hold && !pq.busy && pq.armed && permHold.keyDown(o.n, e)) e.preventDefault() }
    watch(() => nav.sheet, s => { if (s !== 'permreq' && pq.cur) pqClose() })
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { pqWatchStart(); pqAutoArm() } else { pqWatchStop(); clearTimeout(pqAutoTimer); pqAutoTimer = 0 } void checkPermReqs() })
    setInterval(() => { void checkPermReqs() }, PQ_POLL_MS)
    void listen('relay-bell', () => { void checkPermReqs() })
    // ---------- 電腦要往終端送字／代答提問（#285、#296）：跳出確認面板，本人按確認或拒絕；桌面才能建立請求，手機只能決定 ----------
    // 預覽文字只給本人看（不寫儲存、不進 console）；沒登入或後台還沒部署就靜默略過；通知只敲門鈴，不帶內容
    const tq = reactive({ cur: null, choice: null, error: '', busy: false, left: 0 })
    const tqDismissed = new Set()
    let tqTimer = 0
    const tqCountdown = computed(() => tqCountdownText(tq.left))
    const tqClose = () => { clearInterval(tqTimer); tq.cur = null; tq.choice = null; tq.busy = false }
    const tqDeviceName = node => deviceNameOf(node, { nodeNames: nodeNames.value, friends: friends.value })
    async function checkTermReqs() {
      if (tq.busy || tq.cur || sec.cur || nav.sheet || !acct.value.signed_in || document.visibilityState !== 'visible') return
      let list
      try { list = tqList(await mobileAskApi.termReqList(), tqDeviceName) } catch { return /* 出口已留警告記錄，下一輪再查 */ }
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
      try { await mobileAskApi.termReqDecide(args); history.back() }
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
    // 下拉重整：頁面捲到最上面時往下拉，頂端長出機器人；拉過門檻放開才更新，完成後收回。只在夥伴頁（對話清單、通知、設定頁沒有）
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

    // 左右滑動切換大分頁。夥伴／對話／設定／通知四頁並排，手指拖動時整排跟著動，放開吸附到最近的一頁。
    // 邊緣 24px 留給系統的返回手勢；輸入框、工具列、放大照片上不接手；水平位移要明顯大於垂直（2 倍）才算，所以上下捲動與文字選取不會被誤判。
    // 頁數固定四頁；內頁暫時佔第四格（tabs 的最後一格換成 PAGE_TAB），跟其他頁一樣滑
    const tabs = computed(() => tabList(fourthSt.fourth))
    const pages = computed(() => tabs.value.length)
    const curTab = computed(() => nav.tab)   // 分頁列標著哪一格（在內頁上＝第四格）
    const pageSlot = computed(() => tabs.value.indexOf(PAGE_TAB))   // 內頁在第幾格（沒有內頁是 -1）
    const idx = computed(() => tabIndex(curTab.value, tabs.value))
    const pagerStyle = computed(() => ({ transform: `translate3d(calc(${-idx.value * 100 / pages.value}% + ${sw.shift}px), 0, 0)` }))
    const indicator = computed(() => indicatorPos(idx.value, sw.mode === 'pager' ? sw.shift : 0, sw.width, pages.value))
    // will-change 只在手指拖動（dragging）和程式控制的滑頁轉場期間加（#1565）：一直開著的話，Chrome 會沿用轉場途中某一格的小數 x 位移畫內頁，
    // 滑完也不重畫，字和直線偏半像素、變糊。轉場結束（transitionend，或保險逾時）拿掉，內頁就重畫到整像素
    let settleTimer = 0
    const pagerSettled = () => { clearTimeout(settleTimer); settleTimer = 0; sw.moving = false }
    watch(() => pagerStyle.value.transform, () => {
      if (sw.dragging) return
      sw.moving = true
      clearTimeout(settleTimer)
      settleTimer = setTimeout(pagerSettled, PAGER_SETTLE_MS)
    })
    function pagerMoved(e) { if (e.target === e.currentTarget && e.propertyName === 'transform' && !sw.dragging) pagerSettled() }
    function swipeStart(e, mode) {
      sw.mode = ''; sw.locked = ''
      if (e.touches.length !== 1 || nav.sheet) return
      const t = e.touches[0]
      if (!swipeStartOk(t.clientX, window.innerWidth)) return
      if (e.target?.closest?.(SWIPE_BLOCK_SELECTOR)) return
      if (e.target?.closest?.(SCROLL_TERM_SELECTOR)) return   // 在終端畫面上滑：交給終端自己捲，不換頁
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
      sw.shift = pagerShift(idx.value, dx, pages.value)
    }
    function swipeEnd() {
      const { mode, locked, dx, t0, width } = sw
      if (!mode || locked !== 'h') { sw.mode = ''; sw.locked = ''; sw.dragging = false; return }
      sw.dragging = false; sw.locked = ''
      const target = swipeTarget({ index: idx.value, dx, dt: Date.now() - t0, width, count: pages.value })
      sw.shift = 0; sw.mode = ''
      if (target !== idx.value) goTab(tabs.value[target])
    }

    // 「我」：大頭貼（裁成正方形縮成 96×96 上傳）。設備名稱不在這裡改（#1803）：只有設備頁一個改名入口，這裡一行連結帶過去
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
      catch (e) { nameDraft.value = myName.value; nameErr.value = plainMessage(e); setTimeout(() => { nameErr.value = '' }, 5000) }
    }
    // 群組裡 AI 之間互相叫醒的上限（帳號層設定，預設 20）：改了存後台；不合格或失敗就還原並提示
    const wakeDraft = ref('20'), wakeErr = ref('')
    const commitWake = async () => {
      const c = checkAiWakeLimit(wakeDraft.value)
      if (!c.ok) { wakeErr.value = c.error; setTimeout(() => { wakeErr.value = '' }, 5000); void loadWake(); return }
      try { wakeDraft.value = String(await authApi.setAiWakeLimit(c.value)); wakeErr.value = '' }
      catch (e) { wakeErr.value = plainMessage(e); setTimeout(() => { wakeErr.value = '' }, 5000); void loadWake() }
    }
    const loadWake = () => authApi.getAiWakeLimit().then(n => { wakeDraft.value = String(n) }).catch(() => {})
    void loadWake()
    const acct = ref({ signed_in: false, email: '', known: false, error: '' })
    // 要放在 acct 定義之後：watch 的來源函式會立刻執行一次，放前面會踩到「初始化之前就取用」而整個監看失效
    watch([() => friends.value.length, () => acct.value.signed_in], () => { void backfillLast() })
    void authApi.status().then(s => { acct.value = s ? { ...s, known: true, error: '' } : { ...acct.value, error: '沒有收到回應' } }).catch(e => { acct.value = { ...acct.value, error: String(e?.message ?? e).slice(0, 80) } })
    // 我的名字（帳號層）：先用上次存的，登入帳號的資料取到後更新並存起來（離線也有名字可顯示）
    void authApi.accountInfo().then(i => { if (typeof i?.owner_name === 'string') ownerName.value = i.owner_name }).catch(() => {})
    // 登入資料暫時沒有加密保存時的一句提醒（只有文字；平常是空字串）
    const sealNote = ref('')
    void loginUnsealedNote(invoke).then(t => { sealNote.value = t })
    const myName = computed(() => accountDisplayName(ownerName.value, acct.value.email))
    watch(myName, v => { nameDraft.value = v }, { immediate: true })
    const meForChat = computed(() => ({ ...me, nick: myName.value }))   // 對話裡自己的名字用帳號名；設備名只在「從 …」小標
    const accountText = computed(() => (acct.value.signed_in ? `已登入：${acct.value.email || '（沒有 email）'}` : '尚未登入'))
    const loggingOut = ref(false)
    async function doLogout() {
      if (loggingOut.value) return
      loggingOut.value = true
      try { await push?.logout(); await authApi.logout(); location.reload() } catch (e) { loggingOut.value = false; say(plainMessage(e)) }
    }

    return {
      itemIcon, isDangerItem, tabIcon, tabIconOf,
      mobileRemoteViewApi, mobileRemoteInputApi, selfNode: computed(() => info.node),   // 看別台電腦夥伴的終端（案 A：對話頁「訊息／終端」切換）、在下方輸入框打字（#1378）；發起先過生物辨識，不能用電腦版的 remoteViewApi／remoteInputApi
      onboard, onboardApi, finishOnboard, ONBOARD_TEXT, acct, sealNote, nameDraft, nameErr, commitName, wakeDraft, wakeErr, commitWake, AI_WAKE_LIMIT_LABEL, AI_WAKE_LIMIT_NOTE,
      screen, fatal, login, loginNote, PROVIDERS, canStart, startLogin, cancelLogin, reloginBar, dismissReloginBar, goLogin, backFromLogin,
      upd, updText: computed(() => bannerText(upd)), updButton: computed(() => buttonLabel(upd)), startUpdate, checkUpdate, sideloadLast: sideloadLastText(bridge),
      pf, sw, pagerStyle, pagerMoved, indicator, swipeStart, swipeMove, swipeEnd, goTab, tabs, curTab, pages, TAB_LABEL, tabLabel, fourthPage, pageSlot, fourthTitle, closePage, myName, meForChat, lastOf,
      pushView: computed(() => pushSettingView(pushSt.state, prefs.push)), PUSH_TEXT, setPush: on => { prefs.push = on === true; if (on === true) push?.enable(); else void push?.disable() },
      listTimeText, nav, me, prefs, conn, query, collapsed, groups, unreadTotal, emptyText, STATUS, friendStatusText, headTone, CONN_LABEL, info, banner, shake, refreshing,
      sec, SECRET_TEXT, secCountdown, answerSecret, laterSecret,
      pq, PERMREQ_TEXT, permSegs, permOpts, permRisk, permTrunc, permHold, permPress, permHoldStart, permHoldKey, permReqTitle, permShownTitle, permHeld, HELD_HINT, decidePermReq, laterPermReq,
      tq, TERMREQ_TEXT, tqCountdown, decideTermReq, laterTermReq,
      KNOWN_TEXT, IDENTITY_TEXT, ACTION_TEXT, phoneFpMark, NAME_MAX, kp, forgetKnown, reaccept, reacceptAsk, reacceptNo, reacceptYes, dn, dnBad, dnHint, devRenameStart, devRenameCancel, devRenameSave, removedBlock, acctRowLine, joined, curKnown, openAcctInfo, vp, peerStrip, onRemoteStarted, onRemoteEnded, openPeerSheet, closePeerSheet, choosePeer, openMethodSheet, closeMethodSheet, confirmKnown, methodPickInstead, scanPeer, peerSheetTitle, peerSheetBody, fs, FP_SHOW_TEXT, fpShowStart, fpShowRetry, fpShowEnd, fpShowScan,
      avOf, avById, meAv, chatFriend, chatEmptyText, chatPlate, chatPaneEl, onPhotoViewer, headTerm, toggleHeadTerm, headWake, chatOffline, lineChat, offlineOpen, toggleOffline, closeOffline, chatLog, opsItems, opsRows, opsView, opsAcp, ops, opsText, opsTitle, opsModels, opsModelNote, opsIsPi, opsPiNote, opsPiChoices, opsBanner, openOps, pickOp, submitOp, retryInfo, OP_PROGRESS_TEXT, holdRun, releaseRun, setArchived, archiveNote, photoApi, emo, groupHeading, statusNote,
      GUIDE_TEXT, guideNode, guideOn, guideReshow, guideRowList, guideHintView, setGuideHidden, guideAct, guideSite,
      SUB_LAPSED_TEXT, setupSt, setupAsk, setupNo, setupYes, setupClose, SETUP_TEXT, RELOGIN_TEXT, loginSt, loginAsk, loginNo, loginYes, loginClose, LOGIN_TEXT, LOGIN_VENDORS, acctSw, setAcctTab, acctSwitchOn, acctCanSwitchTo, ACCT_TABS, acctSwitchTargets: (vendor, a) => acctSwitchTargetsOf(acctDevs.value, vendor, a, info.node), acctDevRows, acctLoginTargets, acctLoginPress, accountCardKey, accountStatusOf, acctInUseOf, acctLoginLostOf, acctLoginNotices, acctReloginHere, acctReloginPress, LOGIN_LOST_TEXT, acctDevPress, acctRowResult, DEVICE_BUTTON_TEXT, DEVICE_ROW_TEXT, usedOnText, ROSTER_TEXT, acctMy, acctDevs, acctCanRemove, acctCanShowBack, acctDrag, acctShowBack, acctAskRemove, acctRemoveText, acctRemoveNow, acctRestore, acctBackToList, openAcctDevice, gripDown, gripMove, gripUp, gripKey, acctMove, DEVICE_TEXT, acctCur, acctRep, acctView, acctConfirm, ACCT_TEXT, acctTitle, acctHead, vendorIconSvg, acctKeys, openAcct, startAcctSwitch, acctBackToPick, submitAcct, planLabel, PLAN_UNKNOWN, INCOMPLETE_LABEL, INCOMPLETE_REASON, LOGIN_FAILED_LABEL, CURRENT_LABEL, CURRENT_FAILED_ARIA,
      lch, lchData, lchDevices, lchElig, lchFormErr, lchChoices, lchVendors, lchRow, lchRun, lchRunKey, lchPi, pickLaunchVendor, PI_REMOTE_VERSION_NOTE, LAUNCH_DISPLAY_NOTE, showDisplayNote, lchStep2, lchTitle, lchCanNext, nextLaunch, closeLaunch, openLaunch, pickLaunchDevice, submitLaunch, openLaunched,
      openMember, pickOffline, topGroups, rowPressOf, opsClickGuard, isChatPinned, opsTargetId, opsPinLabel, pickPin, unreadRows, unreadShown, UNREAD_GROUP_KEY, UNREAD_GROUP_LABEL, plusOpen, pickPlus, rooms, roomRows, roomsNote, roomsErr, roomsLoaded, refreshRooms, roomNote, openRoom, ROOM_GROUP_KEY, ROOM_GROUP_LABEL, roomEmptyText, groupFlow, groupItems, pickGroup, chatCards, decideCard, guides, guideOpen, openGuides, openGuide, about, openAboutLink, aboutAct, GUIDE_ENTRY_LABEL, GUIDE_ENTRY_SUB,
      toast, leaveAsk, answerLeave, LEAVE_ASK_TEXT, leaveText,
      friends, callApi, dictApi, onCallState, openChat, back, openBanner, bannerHandover, contextLabel, elevatedBadge, sendTo, nudgeTo, sendAttachTo, loadOlder, refreshAll,
      cloud, cloudSt, CLOUD_TEXT, CLOUD_COPY_NOTE, CLOUD_INVITE_NOTE,
      SKINS, SKIN_LABEL, settingRows, settingCat, settingTitle, openSetting, replaceSt, replaceCards, replacePick, replaceDo, replaceKeep, REPLACE_TEXT, noticeGos, goNotice, noticeChat, noticeLog, tabHasDot, rel, relLog, relNote, loadRel, RETRY_LABEL, playView, playNewText, rowHasDot, openPlay, PLAY_BUTTON_LABEL, PLAY_LATEST_TEXT, PLAY_NOTICE_NOT_AUTO, avBusy, avMsg, avFile, selfHasUpload, pickAvatar, removeAvatar, accountText, loggingOut, doLogout,
    }
  },
})
app.component('chat-pane', ChatPane)
app.component('asn-avatar', AsnAvatar)
app.component('pin-dot', PinDot)
app.component('new-guide-card', NewGuideCard)
app.component('group-sheet', GroupSheet)
app.component('onboard-card', OnboardCard)
app.component('guide-doc', GuideDoc)
app.component('line-icon', LineIcon)
app.component('fp-mark', FpMark)
app.component('device-identity', DeviceIdentity)
app.component('ptr-zone', PtrZone)
app.component('relogin-bar', ReloginBar)
for (const [name, comp] of Object.entries(UI_KIT)) app.component(name, comp)
app.mount('#app')
// 根元素（#app）自己的屬性不在 Vue 編譯的樣板裡，:class 綁不上去；登入畫面的背景類別在這裡手動切
watch(screen, s => document.getElementById('app').classList.toggle('is-login', s === 'login' || s === 'onboard'), { immediate: true })
document.getElementById('splash')?.remove()
void startCore?.()
