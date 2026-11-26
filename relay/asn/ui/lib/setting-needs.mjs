// 設定的「需要哪些平台能力」（#1763 F1）：類別（cat.xxx）與設定指令各自要的能力名稱，能力名稱見 shells/caps-*.mjs。
// 手機、電腦各自有哪些設定類別，由「這一類需要的能力全部都在該平台的能力表裡」算出來，不再手寫一份清單。
// 純邏輯，node 與瀏覽器都能跑。

// 類別層：每一類都要有（沒有特殊需求寫 []）。測試會對照 SETTING_CATS，少一類就紅。
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

// 項目層：這張只放「有明顯平台差異」的項目，其他項目回 []。
// 完整的項目層（每個設定項目的需求，以及跟設定值清單「平台／未做」的雙向比對）由 #1853 第 3 張補齊。
export const ITEM_NEEDS = Object.freeze({
  frame: ['desktopWindow'],
  // 手機沒有視窗：視窗大小、頭像欄收合、釘選的對話分頁
  'app.window-layout': ['desktopWindow'],
  'file.me.dpCollapsed': ['desktopWindow'],
  'file.me.pinnedChat': ['desktopWindow'],
  'file.me.splitSize': ['desktopWindow'],
  'file.me.mergedSize': ['desktopWindow'],
  'file.me.guideSize': ['desktopWindow'],
  'file.me.settingSize': ['desktopWindow'],
  // 視窗模式、頭像模式、工具列位置、文字底色、分頁依、分組依：手機固定單欄、固定值，是設計選擇，不放進能力表，
  // 由 #1853 第 3 張標為「無（未做）」，所以 mode、dpMode、toolbar、bubble、tabDim、groupDim 都回 []。
  notify: ['desktopToast'],
  'prefs.vibrateNudge': ['vibrate'],
  'prefs.vibrateMsg': ['vibrate'],
  'prefs.push': ['push'],
  'voice-save': ['localSpeech'],
  'voice-install': ['localSpeech'],
  closeTo: ['tray'],
  autostart: ['autostart'],
  guard: ['guard'],
  'guard-resume': ['guard'],
  'bridge-launch': ['bridge'],
  'bridge-auto-resume': ['bridge'],
  'bridge-compact': ['bridge'],
  'bridge-term-server': ['bridge'],
  'bridge-screen-watch': ['bridge'],
  'bridge-perm-phone': ['bridge'],
  'bridge-mobile-view': ['bridge'],
  'bridge-remote-input': ['bridge'],
  'bridge-unaddressed': ['bridge'],
  'bridge-takeover': ['bridge'],
  // 本機開 AI 視窗、安裝與偵測 AI 工具
  'launch-max': ['hostAgents'],
  'launch-cwd-add': ['hostAgents'],
  'launch-cwd-remove': ['hostAgents'],
  'launch-cwd-suggest': ['hostAgents'],
  'launch-install-ask': ['hostAgents'],
  'launch-install-yes': ['hostAgents'],
  'launch-install-no': ['hostAgents'],
  'launch-recheck': ['hostAgents'],
  'pi-setup-ask': ['hostAgents'],
  'pi-setup-install': ['hostAgents'],
  'pi-setup-cancel': ['hostAgents'],
  'pi-setup-remove': ['hostAgents'],
  'pi-login': ['hostAgents'],
  'file.pi-auto.auto': ['hostAgents'],
  'file.pi-auto.done': ['hostAgents'],
  'file.agent-setup-prefs.remote_allow_install': ['hostAgents'],
  'askpass-copy': ['hostAgents'],
  'tm-open': ['taskManager'],
  'quota-source': ['quotaReader'],
  'quota-refresh': ['quotaReader'],
  'quota-share': ['quotaReader'],
  'usage-refresh': ['claudeLocalLogs'],
})

// token＝'cat.xxx' 或指令名；回傳 needs 陣列（沒登記的回 []）。回傳的是複本，呼叫端改它不會動到表。
export const settingNeeds = token => [...(CAT_NEEDS[token] ?? ITEM_NEEDS[token] ?? [])]

// 這張能力表下有哪些類別：保留 catKeys 原本的順序，只留下需要的能力全部為 true 的類別。
export const catsFor = (caps, catKeys) => catKeys.filter(k => settingNeeds(`cat.${k}`).every(n => caps[n] === true))
