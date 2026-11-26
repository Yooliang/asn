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
  'cat.voice': ['voice'],
  'cat.window': ['tray', 'windowFrame'],
  'cat.launch': ['launch'],
  'cat.usage': ['usage'],
  'cat.update': [],
  'cat.about': [],
})

// 項目層：這張只放「有明顯平台差異」的項目，其他項目回 []。
// 完整的項目層（每個設定項目的需求，以及跟設定值清單「平台／未做」的雙向比對）由 #1853 第 3 張補齊。
export const ITEM_NEEDS = Object.freeze({
  frame: ['windowFrame'],
  mode: ['windowMode'],
  dpMode: ['windowMode'],
  toolbar: ['windowMode'],
  bubble: ['windowMode'],
  tabDim: ['windowMode'],
  groupDim: ['windowMode'],
  notify: ['toast'],
  'prefs.vibrateNudge': ['vibrate'],
  'prefs.vibrateMsg': ['vibrate'],
  'prefs.push': ['push'],
  'voice-save': ['voice'],
  'voice-install': ['voice'],
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
  'launch-max': ['launch'],
  'launch-cwd-add': ['launch'],
  'launch-install-ask': ['launch'],
  'launch-recheck': ['launch'],
  'pi-setup-ask': ['launch'],
  'askpass-copy': ['launch'],
  'tm-open': ['taskManager'],
  'quota-source': ['quotaReader'],
  'quota-refresh': ['quotaReader'],
  'quota-share': ['quotaReader'],
  'usage-refresh': ['usage'],
})

// token＝'cat.xxx' 或指令名；回傳 needs 陣列（沒登記的回 []）。回傳的是複本，呼叫端改它不會動到表。
export const settingNeeds = token => [...(CAT_NEEDS[token] ?? ITEM_NEEDS[token] ?? [])]

// 這張能力表下有哪些類別：保留 catKeys 原本的順序，只留下需要的能力全部為 true 的類別。
export const catsFor = (caps, catKeys) => catKeys.filter(k => settingNeeds(`cat.${k}`).every(n => caps[n] === true))
