// 設定的「需要哪些平台能力」（#1763 F1、#1853 第 3 張）：類別（cat.xxx）與每個設定標記各自要的能力名稱，能力名稱見 shells/caps-*.mjs。
// 手機、電腦各自有哪些設定類別，由「這一類需要的能力全部都在該平台的能力表裡」算出來，不再手寫一份清單。
// 設定值清單（docs/設定值清單.md）的平台欄也照這裡的 needs 與能力表填，由 test/settings-list.test.mjs 雙向比對。
// 純邏輯，node 與瀏覽器都能跑。

// 類別層：每一類都要有（沒有特殊需求寫 []）。沒登記的類別一律不放行（catsFor）、測試也會紅（missingCatNeeds）。
export const CAT_NEEDS = Object.freeze({
  'cat.me': [],
  'cat.devices': [],
  'cat.accounts': [],
  'cat.cloud': [],
  'cat.look': [],
  'cat.notify': [],
  'cat.voice': ['localSpeech'],
  'cat.window': ['tray', 'desktopWindow'],
  'cat.launch': ['hostAgents'],
  'cat.usage': ['claudeLocalLogs'],
  'cat.update': [],
  'cat.about': [],
})

// 項目層：設定值清單裡每一個標記（指令、prefs.、app.、flag.、file.）都要在這裡明確登記，需求為空也要寫 []。
// 沒登記、或這裡登記了清單沒有的，守門測試都會紅。
// 寫法：group(需求, 同一列的所有標記…)。同一列的標記做的是同一件事，需求一定相同，所以放在同一組；寫錯（同一個標記登記兩次）會當場丟錯。
// 「平台本來就做不到」才寫能力名稱；「平台做得到、只是沒做」或「設計上固定值」寫 []，清單平台欄標「無（未做）」。
const group = (needs, ...tokens) => tokens.map(t => [t, Object.freeze([...needs])])
const build = (...groups) => {
  const table = new Map()
  for (const [token, needs] of groups.flat()) {
    if (table.has(token)) throw new Error(`ITEM_NEEDS 重複登記 ${token}`)
    table.set(token, needs)
  }
  return Object.freeze(Object.fromEntries(table))
}

export const ITEM_NEEDS = build(
  // 一、個人
  group([], 'avatar-remove'),
  group([], 'now-playing', 'file.me.showNowPlaying'),
  group([], 'app.account-name'),
  group([], 'app.ai-wake-limit'),
  group([], 'app.me-status', 'file.me.me'),
  group([], 'app.me-psm'),
  group([], 'app.login-logout'),
  // 二、設備
  group([], 'device-move', 'device-reorder', 'file.me.deviceOrder'),
  group([], 'device-show', 'file.me.deviceShown'),
  group([], 'device-remove', 'file.me.deviceRemoved'),
  group([], 'device-restore'),
  group([], 'device-rename', 'device-rename-clear', 'file.settings.window_name'),
  group([], 'replace-pick', 'replace-do', 'replace-keep'),
  group([], 'known-forget'),
  // 「允許別台設備對這台做事」這一類（信任手機直接登入、替這台切換帳號）跟收發信的橋同一個角色：接受遠端的要求
  group(['bridge'], 'known-login-ok'),
  group(['taskManager'], 'tm-open', 'tm-close', 'tm-ask', 'tm-cancel', 'tm-confirm', 'tm-wake', 'tm-adopt', 'tm-view', 'tm-handover', 'tm-restart-ask', 'tm-restart-cancel', 'tm-restart-confirm'),
  group([], 'row-switch'),
  group(['bridge'], 'acct-allow-switch', 'file.acct-prefs.remote_allow_switch', 'file.acct-prefs.remote_trust_own', 'file.acct-prefs.remote_trust_signed'),
  group([], 'flag.AGENT_INSTALL_UI'),
  group([], 'relogin-ask', 'relogin-yes', 'relogin-no', 'relogin-close'),
  // 三、帳號
  group(['quotaReader'], 'quota-source', 'file.quota-readers.grok', 'file.quota-readers.agy', 'file.quota-readers.extra_claude'),
  group(['quotaReader'], 'quota-refresh', 'file.quota-readers.extra_claude_refresh'),
  group(['quotaReader'], 'quota-mm-add', 'quota-mm-remove', 'file.quota-readers.minimax'),
  group(['quotaReader'], 'quota-share', 'quota-unshare', 'quota-copy', 'quota-close', 'quota-cancel'),
  // 四、雲端代理
  group([], 'app.cloud-agent'),
  // 五、外觀
  group([], 'skin', 'prefs.skin', 'file.me.skin', 'file.local.asnSkin'),
  group(['desktopWindow'], 'frame', 'file.me.frame'),
  // 視窗模式、頭像模式、工具列位置、文字底色、分頁依、分組依：手機固定單欄、固定值，是設計選擇，不放進能力表，清單標「無（未做）」
  group([], 'mode', 'file.me.winMode'),
  group([], 'dpMode', 'file.me.dpMode'),
  group([], 'toolbar', 'file.me.toolbar'),
  group([], 'bubble', 'file.me.bubble'),
  group([], 'tabDim', 'file.me.tabDim'),
  group([], 'groupDim', 'file.me.groupDim'),
  // 六、提醒與聲音
  group(['desktopToast'], 'notify', 'file.me.notify'),
  group(['vibrate'], 'prefs.vibrateNudge', 'file.me.mobilePrefs'),
  group(['vibrate'], 'prefs.vibrateMsg'),
  group(['push'], 'prefs.push'),
  group([], 'prefs.voice'),
  // 七、語音
  group(['localSpeech'], 'voice-save', 'file.voice.tts_voice', 'file.voice.tts_auto', 'file.voice.stt_lang', 'file.voice.stt_model'),
  group(['localSpeech'], 'voice-install'),
  // 八、視窗與系統匣
  group(['tray'], 'closeTo', 'file.me.closeTo'),
  group(['autostart'], 'autostart'),
  group(['guard'], 'guard', 'guard-resume'),
  group(['bridge'], 'bridge-launch', 'file.bridge.allow_remote_launch'),
  group(['bridge'], 'bridge-auto-resume', 'file.bridge.auto_resume_off'),
  group(['bridge'], 'bridge-compact', 'bridge-compact-n', 'file.bridge.compact_handoff_off', 'file.bridge.compact_handoff_n'),
  group(['bridge'], 'bridge-term-server', 'bridge-term-fetch-retry', 'file.bridge.term_server_off', 'file.bridge.term_server_on'),
  group(['bridge'], 'bridge-screen-watch', 'file.bridge.screen_watch_off'),
  group(['bridge'], 'bridge-perm-phone', 'file.bridge.perm_phone_off'),
  group(['bridge'], 'bridge-mobile-view', 'file.bridge.mobile_view_off'),
  group(['bridge'], 'bridge-remote-input', 'file.bridge.remote_input_off'),
  group(['bridge'], 'bridge-unaddressed', 'file.bridge.unaddressed_to'),
  group(['bridge'], 'bridge-takeover', 'bridge-takeover-yes', 'bridge-takeover-no', 'file.bridge.allow_takeover'),
  // 九、啟動設定：本機開 AI 視窗、安裝與偵測 AI 工具
  group(['hostAgents'], 'launch-max', 'file.launch-prefs.maxPerHourSet'),
  group(['hostAgents'], 'launch-cwd-add', 'launch-cwd-remove', 'launch-cwd-suggest', 'file.launch-prefs.cwdAllow'),
  group(['hostAgents'], 'launch-install-ask', 'launch-install-yes', 'launch-install-no'),
  group(['hostAgents'], 'launch-recheck'),
  group(['hostAgents'], 'pi-setup-ask', 'pi-setup-install', 'pi-setup-cancel', 'pi-setup-remove', 'pi-login'),
  group(['hostAgents'], 'askpass-copy'),
  // 十、用量
  group(['claudeLocalLogs'], 'usage-refresh'),
  // 十一、更新
  group([], 'autoCheck', 'prefs.autoUpdate', 'file.me.autoUpdate'),
  group([], 'check-update'),
  group([], 'releases-retry'),
  // 十二、關於
  group([], 'open-link', 'open-update', 'open-guide'),
  group([], 'open-ui-log'),
  // 其他存在檔裡、但設定頁沒有的偏好
  group([], 'prefs.chatPins', 'file.me.chatPins'),
  group([], 'flag.LOG_REPORT_ROOM'),
  group([], 'app.guide-hidden', 'file.local.asnNewComputerGuideHidden'),
  group(['hostAgents'], 'app.launch-display', 'file.launch-prefs.launchDisplay'),
  // 手機沒有視窗：視窗大小、頭像欄收合、釘選的對話分頁
  group(['desktopWindow'], 'app.window-layout', 'file.me.dpCollapsed', 'file.me.pinnedChat', 'file.me.splitSize', 'file.me.mergedSize', 'file.me.guideSize', 'file.me.settingSize'),
  // 十三、內部存檔欄位
  group(['hostAgents'], 'file.me.autoAddClaude'),
  group(['desktopWindow'], 'file.me.session'),
  group([], 'file.me.deviceRev', 'file.me.deviceSynced'),
  group([], 'file.me.ownerName'),
  group([], 'file.me.lastChat', 'file.me.navTab', 'file.me.navChat'),
  group([], 'file.me.pendingDeviceName', 'file.me.pendingDeviceNameBase'),
  group([], 'file.local.asnCloudNodes'),
  group([], 'file.local.asnUpdateTestUrl'),
  group([], 'file.onboard.done'),
  group([], 'file.settings.old_names'),
  group(['hostAgents'], 'file.agent-setup-prefs.remote_allow_install'),
  group(['hostAgents'], 'file.pi-auto.auto', 'file.pi-auto.done'),
  group(['bridge'], 'file.bridge.enabled'),
  group(['hostAgents'], 'file.launch-prefs.recentCwd', 'file.launch-prefs.showAdvanced'),
)

// token＝'cat.xxx' 或項目標記；回傳 needs 陣列（沒登記的回 []，是否登記由 isRegistered／missingCatNeeds 與守門測試負責）。回傳的是複本，呼叫端改它不會動到表。
export const settingNeeds = token => [...(CAT_NEEDS[token] ?? ITEM_NEEDS[token] ?? [])]

// 這個標記有沒有明確登記（[] 也算登記）
export const isRegistered = token => Object.hasOwn(CAT_NEEDS, token) || Object.hasOwn(ITEM_NEEDS, token)

// SETTING_CATS 的類別裡，沒在 needs 登記的（回傳 'cat.xxx' 陣列）；table 讓測試可以餵缺一類的假表
export const missingCatNeeds = (catKeys, table = CAT_NEEDS) => catKeys.map(k => `cat.${k}`).filter(t => !Object.hasOwn(table, t))

// 這張能力表下有哪些類別：保留 catKeys 原本的順序，只留下需要的能力全部為 true 的類別；沒登記的類別不放行。
export const catsFor = (caps, catKeys) => catKeys.filter(k => Object.hasOwn(CAT_NEEDS, `cat.${k}`) && CAT_NEEDS[`cat.${k}`].every(n => caps[n] === true))
