// 存檔鍵名（#1853 第 2 張）：前端要用到的「存檔欄位名」集中在這一份，只放名字，不放行為，也沒有任何程式 import 它去做事；
// 它的用途是讓測試把「程式實際存的欄位」跟「Rust 設定層宣告的欄位」逐一對齊（見 test/storage-keys.test.mjs、test/prefs-keys.test.mjs）。
//
// 鍵名以 Rust 設定層（src-tauri/src/settings/docs.rs 的各個 Doc 型別）為準：DOC_FIELDS 是從那裡照抄的，不在前端另外自己定義；
// 抄錯、Rust 改名、Rust 多了或少了欄位，對齊測試都會變紅（改 Rust 的人要同時改這裡與 docs/設定值清單.md）。
// asn-me.json、asn-onboard.json、launch-prefs.json 在 Rust 端是「整個檔案都是 extra」（不宣告欄位），欄位真相在前端的存檔那一行，
// 所以下面這幾組是反過來由測試去對前端原始碼（list.js 的 saveMe、m.js 的存檔那一行…）。
// 瀏覽器本機儲存的鍵不在這裡：它的唯一來源是 lib/local-prefs.mjs 的 LOCAL_KEYS。

// 設備排序同步用的 5 欄（lib/device-order.mjs 的 deviceFieldsToSave）
export const ME_DEVICE_FIELDS = Object.freeze(['deviceOrder', 'deviceShown', 'deviceRemoved', 'deviceRev', 'deviceSynced'])

// asn-me.json 頂層欄位：電腦（list.js 的 saveMe）與手機（m.js 的存檔那一行）各自送出的
export const ME_FIELDS_DESKTOP = Object.freeze(['autoAddClaude', 'autoUpdate', 'bubble', 'chatPins', 'closeTo', 'dpCollapsed', 'dpMode', 'frame', 'groupDim', 'guideSize', 'me', 'mergedSize', 'notify', 'pinnedChat', 'session', 'settingSize', 'showNowPlaying', 'skin', 'splitSize', 'tabDim', 'toolbar', 'winMode', ...ME_DEVICE_FIELDS].sort())
export const ME_FIELDS_MOBILE = Object.freeze(['lastChat', 'me', 'mobilePrefs', 'navChat', 'navTab', 'ownerName', ...ME_DEVICE_FIELDS].sort())
// 改名時暫存的待送名字（lib/device-rename.mjs 的 PENDING_KEY、PENDING_BASE_KEY），也寫在 asn-me.json
export const ME_FIELDS_PENDING = Object.freeze(['pendingDeviceName', 'pendingDeviceNameBase'])

// asn-onboard.json（lib/onboard.mjs）
export const ONBOARD_FIELDS = Object.freeze(['done'])

// launch-prefs.json 存檔時會有的欄位（lib/launch-prefs.mjs 的 launchPrefsToSave；maxPerHourSet 只有設定頁改過才有）
export const LAUNCH_PREFS_FIELDS = Object.freeze(['cwdAllow', 'launchDisplay', 'maxPerHourSet', 'recentCwd', 'showAdvanced'])

// 各設定檔的欄位（不含 `extra`），檔名＝Doc 的 NAME。照抄 src-tauri/src/settings/docs.rs，由 test/storage-keys.test.mjs 逐一比對
export const DOC_FIELDS = Object.freeze({
  'acct-prefs': ['remote_trust_own', 'remote_trust_signed', 'remote_allow_switch'],
  'agent-setup-prefs': ['remote_allow_install'],
  bridge: ['enabled', 'allow_takeover', 'allow_remote_launch', 'unaddressed_to', 'auto_resume_off', 'term_server_off', 'term_server_on', 'screen_watch_off', 'perm_phone_off', 'mobile_view_off', 'remote_input_off', 'compact_handoff_off', 'compact_handoff_n', 'gemini_full_access'],
  'launch-prefs': [],
  'pi-auto': ['auto', 'done'],
  'quota-readers': ['grok', 'agy', 'minimax', 'extra_claude', 'extra_claude_refresh'],
  settings: ['window_name', 'old_names'],
  voice: ['tts_voice', 'tts_auto', 'stt_lang', 'stt_model'],
})
