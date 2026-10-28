// 守門：安卓版（#158 第一期）只含手機該有的東西，電腦版一個字不變。
// 這些是靜態檢查（讀原始碼與設定檔）：手機建置不編譯電腦端模組、手機的 Rust 指令清單沒有電腦端指令、手機畫面不叫電腦端指令、
// 套件名固定、備份關閉、沒有正式簽章金鑰。每一條都做過「拿掉被守的東西確認會紅」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n')
const lib = read('src-tauri', 'src', 'lib.rs')
const cargo = read('src-tauri', 'Cargo.toml')

// 電腦端才有的 Rust 模組：手機建置一個都不能編進去
const DESKTOP_MODS = ['acct_remote', 'statusline_hook', 'term_remote', 'ads', 'agent_tools', 'askpass', 'bridge', 'cli', 'claude_accounts', 'claude_json', 'claude_mod', 'claude_quota', 'cloud_invite', 'codex_accounts', 'launch', 'shot', 'stt', 'tray', 'tts', 'updater', 'usage', 'voicecfg', 'wins']
// 電腦端才有的指令（手機的指令清單、手機畫面都不能出現）
const DESKTOP_CMDS = ['bridge_status', 'bridge_set_enabled', 'bridge_set_remote_launch', 'bridge_set_unaddressed_to', 'bridge_takeover', 'cli_info', 'askpass_info', 'askpass_answer', 'askpass_helper_info', 'relay_launch', 'relay_launchers', 'partner_launch_local', 'term_start', 'term_send', 'term_read', 'term_list', 'term_stop', 'term_status', 'term_rename', 'term_answer', 'launch_cwd_candidates', 'launch_cwd_browse', 'partner_console_query', 'partner_console_set', 'subagents_query', 'model_switch_query', 'model_switch_run', 'launch_prefs_get', 'launch_prefs_set', 'usage_summary', 'claude_accounts_list', 'claude_account_current', 'claude_account_save', 'claude_account_switch', 'claude_account_delete', 'claude_mod_status', 'claude_quota_all', 'codex_account_current', 'acct_remote_report', 'acct_remote_list', 'acct_remote_request', 'acct_remote_apply', 'ai_cli_detect', 'ai_cli_install', 'ai_cli_login', 'set_now_playing', 'open_machine_log_dir', 'relay_log_paths', 'open_url', 'ads_fetch', 'tray_available', 'set_close_to_tray', 'set_tray_unread', 'autostart_get', 'autostart_set', 'update_check', 'update_install', 'open_chat', 'open_panel', 'win_ctl', 'frame_native', 'set_frame', 'show_toast', 'shake', 'shot_begin', 'shot_supported', 'stt_transcribe', 'stt_install', 'tts_speak', 'tts_voices', 'voice_cfg_get', 'voice_cfg_set', 'cloud_agent_create', 'cloud_agent_list', 'cloud_agent_revoke', 'cloud_agent_approve', 'relay_attachment_reveal', 'auth_skip_login', 'update_remote_request', 'update_remote_status']

test('電腦端模組：每一個都掛 cfg(desktop)，手機建置不編譯', () => {
  for (const m of DESKTOP_MODS) {
    const re = new RegExp(`#\\[cfg\\(desktop\\)\\]\\n(?:pub )?mod ${m};`)
    assert.match(lib, re, `lib.rs 的 mod ${m} 前面要有 #[cfg(desktop)]`)
  }
  // 沒有掛 cfg 的 mod 宣告不可以是電腦端模組
  for (const m of lib.matchAll(/^(?<attr>#\[[^\n]*\]\n)?(?:pub )?mod (?<name>\w+);/gm)) {
    if (DESKTOP_MODS.includes(m.groups.name)) assert.match(m.groups.attr ?? '', /cfg\(desktop\)/, m.groups.name)
  }
  assert.match(lib, /#\[cfg\(target_os = "android"\)\]\nmod android;/, '安卓專屬模組只在安卓編進去')
})

test('安卓的指令清單：只有名單與對話需要的，沒有任何電腦端指令', () => {
  const m = /#\[cfg\(not\(desktop\)\)\]\n\s*let builder = builder\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\);/.exec(lib)
  assert.ok(m, '找不到手機的 invoke_handler 區塊')
  const entries = m[1].split(',').map(s => s.trim()).filter(Boolean)
  const names = entries.map(s => s.replace(/^\w+::/, ''))
  for (const must of ['startup_info', 'relay_list', 'relay_inbox', 'relay_ack', 'relay_send', 'relay_chat_history', 'relay_send_attachment', 'relay_attachment_fetch', 'relay_attachment_save', 'auth_login', 'auth_bind', 'auth_logout', 'set_presence', 'store_load', 'store_save']) {
    assert.ok(names.includes(must), `手機要有 ${must}`)
  }
  assert.deepEqual(names.filter(n => DESKTOP_CMDS.includes(n)), [], '手機的指令清單不能有電腦端指令')
  // 清單裡 lib.rs 自己定義的指令，不可以是掛 cfg(desktop) 的（否則手機編不過或悄悄少了指令）
  for (const e of entries.filter(x => !x.includes('::'))) {   // 有「模組::」前綴的不是 lib.rs 自己定義的
    const n = e
    const d = new RegExp(`((?:#\\[[^\\n]*\\]\\n)*)(?:pub(?:\\([a-z]+\\))? )?(?:async )?fn ${n}\\b`).exec(lib)
    if (d) assert.doesNotMatch(d[1], /cfg\(desktop\)/, `${n} 掛了 cfg(desktop) 卻在手機清單裡`)
  }
})

test('電腦端的指令定義都掛 cfg(desktop)（lib.rs 裡的）', () => {
  for (const c of ['relay_launch', 'relay_launchers', 'partner_launch_local', 'term_start', 'term_send', 'term_read', 'term_list', 'term_stop', 'term_status', 'term_rename', 'term_answer', 'model_switch_run', 'subagents_query', 'bridge_status', 'bridge_takeover', 'cli_info', 'open_url', 'set_now_playing', 'relay_log_paths', 'open_machine_log_dir', 'relay_attachment_reveal', 'voice_cfg_get', 'acct_remote_apply']) {
    const d = new RegExp(`((?:(?:#\\[[^\\n]*\\]|///[^\\n]*)\\n)*)(?:async )?fn ${c}\\b`).exec(lib)
    assert.ok(d, `找不到 ${c}`)
    assert.match(d[1], /cfg\(desktop\)/, `${c} 要掛 cfg(desktop)`)
  }
})

test('Cargo：系統匣、自動更新、系統加密連線只在非安卓；安卓用純 Rust 加密連線與開網址外掛', () => {
  const section = name => {
    const i = cargo.indexOf(`[${name}]`)
    assert.ok(i >= 0, `找不到 [${name}]`)
    const rest = cargo.slice(i + name.length + 2)
    const j = rest.search(/\n\[/)
    return j < 0 ? rest : rest.slice(0, j)
  }
  const common = section('dependencies')
  const desktop = section(`target.'cfg(not(any(target_os = "android", target_os = "linux")))'.dependencies`)
  const linux = section(`target.'cfg(target_os = "linux")'.dependencies`)
  const android = section(`target.'cfg(target_os = "android")'.dependencies`)
  assert.doesNotMatch(common, /tray-icon|tauri-plugin-updater|native-tls|rustls|opener/, '共用區不放平台專屬的東西')
  assert.match(desktop, /tray-icon/); assert.match(desktop, /tauri-plugin-updater/); assert.match(desktop, /reqwest[^\n]*native-tls/); assert.match(desktop, /tokio-tungstenite[^\n]*native-tls/)
  assert.match(linux, /reqwest[^\n]*rustls/); assert.doesNotMatch(linux, /native-tls/, 'Linux 一律純 Rust 加密連線（無視窗橋不裝 OpenSSL）')
  assert.match(android, /reqwest[^\n]*rustls/); assert.match(android, /tokio-tungstenite[^\n]*rustls/); assert.match(android, /tauri-plugin-opener/)
  assert.doesNotMatch(android, /native-tls|tray-icon|updater/, '安卓不用 OpenSSL（交叉編譯很痛）、沒有系統匣與自動更新')
})

test('設定：電腦版識別與視窗不變；安卓套件名固定 tw.yooliang.asn、首頁是 m.html、不帶電腦端的打包資源與更新器', () => {
  const desk = JSON.parse(read('src-tauri', 'tauri.conf.json'))
  assert.equal(desk.identifier, 'tw.yooliang.asn', '電腦版識別（資料夾靠它；安裝位置靠 publisher 釘住，見 identifier-migration.test.mjs）')
  assert.equal(desk.app.windows[0].url, 'list.html')
  const and = JSON.parse(read('src-tauri', 'tauri.android.conf.json'))
  assert.equal(and.identifier, 'tw.yooliang.asn', '上架後不能改的套件名')
  assert.equal(and.app.windows.length, 1)
  assert.equal(and.app.windows[0].url, 'm.html')
  assert.equal(and.bundle.resources, null, '電腦端的收發室外掛資源不進手機')
  assert.equal(and.bundle.createUpdaterArtifacts, false)
  assert.equal(and.plugins.updater, null, '手機走應用程式商店，不用自動更新器')
  const appdir = read('src-tauri', 'src', 'appdir.rs')
  assert.match(appdir, /pub const PACKAGE: &str = "tw\.yooliang\.asn";/)
})

test('安卓專案：套件名、權限、關閉備份、登入回來的網址協定；沒有正式簽章金鑰', () => {
  const g = (...p) => read('src-tauri', 'gen', 'android', ...p)
  const manifest = g('app', 'src', 'main', 'AndroidManifest.xml')
  assert.match(manifest, /android\.permission\.INTERNET/); assert.match(manifest, /android\.permission\.VIBRATE/)
  assert.match(manifest, /android:allowBackup="false"/, '節點金鑰與登入存檔不能被系統備份帶到別支手機')
  assert.match(manifest, /android:scheme="tw\.yooliang\.asn"/, '瀏覽器登入完成後帶回 App 的網址協定')
  assert.doesNotMatch(manifest, /READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|CAMERA|READ_CONTACTS/, '不多要權限')
  // 麥克風只為「通話」（#99）要：必須有，而且只有這一個多出來的危險權限
  assert.match(manifest, /<uses-permission android:name="android\.permission\.RECORD_AUDIO" \/>/, '通話需要麥克風權限（Play 版與自行安裝版共用這份清單）')
  assert.match(manifest, /android\.hardware\.microphone"\s+android:required="false"/, '沒有麥克風的裝置也要能裝')
  assert.match(manifest, /android\.speech\.RecognitionService/); assert.match(manifest, /android\.intent\.action\.TTS_SERVICE/)   // Android 11 以上看得到系統語音服務
  assert.deepEqual([...manifest.matchAll(/uses-permission android:name="android\.permission\.(\w+)"/g)].map(m => m[1]).sort(), ['INTERNET', 'RECORD_AUDIO', 'VIBRATE'], '權限只有網路、震動、麥克風（另有安裝權限的置換字串）')
  const gradle = g('app', 'build.gradle.kts')
  assert.match(gradle, /applicationId = "tw\.yooliang\.asn"/); assert.match(gradle, /namespace = "tw\.yooliang\.asn"/)
  assert.doesNotMatch(gradle, /storeFile|signingConfigs|keystore/i, '第一期只用除錯簽章，不帶正式簽章金鑰')
  assert.match(g('.gitignore'), /keystore\.properties/)
  const kt = fs.readdirSync(path.join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'java', 'tw', 'yooliang', 'asn'))
  assert.ok(kt.includes('MainActivity.kt') && kt.includes('AsnBridge.kt'))
  // 整個專案沒有 tw.irori（電腦版的識別）混進來
  for (const f of ['app/build.gradle.kts', 'app/src/main/AndroidManifest.xml', 'app/src/main/java/tw/yooliang/asn/MainActivity.kt', 'app/src/main/java/tw/yooliang/asn/AsnBridge.kt']) assert.doesNotMatch(g(...f.split('/')), /tw\.irori/, f)
  // 沒有任何金鑰檔進專案
  const stack = [path.join(root, 'src-tauri', 'gen', 'android')]
  const bad = []
  while (stack.length) {
    const d = stack.pop()
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (!['build', '.gradle', '.tauri'].includes(e.name)) stack.push(p) } else if (/\.(jks|keystore|p12|pem)$/i.test(e.name) || e.name === 'keystore.properties') bad.push(p)
    }
  }
  assert.deepEqual(bad, [])
})

test('外殼橋：只動 App 私有資料夾裡的檔案，匯出到「下載/ASN」，不碰其他位置', () => {
  const kt = read('src-tauri', 'gen', 'android', 'app', 'src', 'main', 'java', 'tw', 'yooliang', 'asn', 'AsnBridge.kt')
  assert.match(kt, /filesRoot/); assert.match(kt, /canonicalFile/); assert.match(kt, /startsWith\(filesRoot\.path/)
  assert.match(kt, /Download\/ASN/)
  assert.match(kt, /@JavascriptInterface\s+fun vibrate/); assert.match(kt, /fun relaunch/)
  const act = read('src-tauri', 'gen', 'android', 'app', 'src', 'main', 'java', 'tw', 'yooliang', 'asn', 'MainActivity.kt')
  assert.match(act, /addJavascriptInterface\(AsnBridge\(this\), "AsnAndroid"\)/)
})

test('手機畫面（m.html／m.js／mobile.mjs）：不叫任何電腦端指令、不出現電腦端的設定與視窗外框', () => {
  const files = { 'm.html': read('ui', 'm.html'), 'm.js': read('ui', 'm.js'), 'lib/mobile.mjs': read('ui', 'lib', 'mobile.mjs') }
  const code = t => t.replace(/<!--[\s\S]*?-->/g, '').replace(/(^|\s)\/\/.*$/gm, '$1')   // 註解可以提到電腦端功能（說明「沒有它」），程式本身不行
  for (const [f, raw] of Object.entries(files)) {
    const text = code(raw)
    for (const c of DESKTOP_CMDS) assert.doesNotMatch(text, new RegExp(`['"\`]${c}['"\`]`), `${f} 不能叫電腦端指令 ${c}`)
    assert.doesNotMatch(text, /data-tauri-drag-region|class="titlebar"|ctl\('min'\)|settings-panel|SettingsPanel|ActionBar|action-bar|createVoiceUi|Annotator|shotApi/, `${f} 不放電腦端的標題列、設定面板、功能列、語音、截圖`)
    assert.doesNotMatch(text, /內建收發室|密碼小幫手|用量|Claude 帳號|系統匣|開機自動/, `${f} 不顯示電腦端設定的字樣`)
  }
  // m.js 用到的每個指令（直接 invoke 或經 authApi）都必須在手機的指令清單裡
  const m = /#\[cfg\(not\(desktop\)\)\]\n\s*let builder = builder\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\);/.exec(lib)
  const allowed = new Set(m[1].split(',').map(s => s.trim().replace(/^\w+::/, '')).filter(Boolean))
  const used = new Set([...files['m.js'].matchAll(/invoke\('(\w+)'/g)].map(x => x[1]))
  const api = read('ui', 'lib', 'tauri.mjs')
  const authBlock = /export const authApi = \{([\s\S]*?)\n\}/.exec(api)[1]
  for (const x of files['m.js'].matchAll(/authApi\.(\w+)/g)) {
    const mm = new RegExp(`\\b${x[1]}: [^\\n]*?invoke\\('(\\w+)'`).exec(authBlock)
    assert.ok(mm, `authApi.${x[1]} 不存在`)
    used.add(mm[1])
  }
  assert.ok(used.size >= 10, '應該抓得到 m.js 的指令')
  assert.deepEqual([...used].filter(c => !allowed.has(c)), [], 'm.js 叫的指令都要在手機的指令清單裡')
})

test('手機頁面：不載電腦端的樣式與腳本；觸控目標有放大；電腦版頁面沒被改成手機版', () => {
  const html = read('ui', 'm.html')
  assert.match(html, /viewport-fit=cover/); assert.match(html, /mobile\.css/); assert.match(html, /src="m\.js"/)
  assert.doesNotMatch(html, /list\.js|chat\.js|login\.js|panel\.js|toast\.js|shot\.js|askpass\.js/)
  const css = read('ui', 'mobile.css')
  assert.match(css, /min-height:\s*44px/, '觸控目標至少 44px')
  assert.match(css, /\.m button,\.m input,\.m select,\.m textarea\{font-size:16px\}/, '16px 以上，輸入時不會被放大')
  // 標題列的大頭貼固定小圓形：不用電腦版的 .dp 相框（曾被撐滿半個螢幕），且 CSS 明訂尺寸上限
  assert.doesNotMatch(html, /class="m-(me|av-big)"[^>]*>\s*<span class="dp/, '按鈕裡的大頭貼不用 .dp 相框（手機上會被撐滿或縮成一條綠線）')
  assert.doesNotMatch(html, /class="dp (xl|lg)/, '手機頁面不放電腦版的大尺寸相框')
  assert.match(html, /<img class="m-pic"[^>]*width="44" height="44"/)
  assert.match(html, /<img class="m-pic m-pic-lg"[^>]*width="112" height="112"/)
  assert.doesNotMatch(css, /^\.m-av[\s,{:.]/m, '.m-av 是 ChatPane 訊息頭像的類別，不能拿來改')
  const lg = /\.m-pic-lg\{[^}]*\}/.exec(css)[0]
  assert.ok(Number(/max-width:(\d+)px/.exec(lg)[1]) <= 120, '「我」的大頭貼上限 120px')
  const av = /\.m-pic\{[^}]*\}/.exec(css)[0]
  const px = k => Number(new RegExp(`${k}:(\\d+)px`).exec(av)?.[1])
  assert.ok(px('width') <= 48 && px('height') <= 48 && px('max-width') <= 48 && px('max-height') <= 48, '標題列大頭貼尺寸上限 48px')
  assert.match(css, /\.m-head\{[^}]*height:\d+px;/, '標題列固定高度')   // overflow 改 visible：右上「＋」選單要往下展開
  for (const f of ['list.html', 'chat.html', 'login.html']) assert.doesNotMatch(read('ui', f), /mobile\.css|m\.js/, f)
})

test('縮放鎖定：viewport 與 WebView 都關掉縮放；輸入框 16px 以上；#app 掛上前整個藏起來', () => {
  const html = read('ui', 'm.html'), css = read('ui', 'mobile.css')
  assert.match(html, /name="viewport" content="[^"]*maximum-scale=1[^"]*user-scalable=no/)
  const act = read('src-tauri', 'gen', 'android', 'app', 'src', 'main', 'java', 'tw', 'yooliang', 'asn', 'MainActivity.kt')
  assert.match(act, /setSupportZoom\(false\)/); assert.match(act, /builtInZoomControls = false/); assert.match(act, /displayZoomControls = false/)
  assert.doesNotMatch(act.replace(/\/\/.*$/gm, ''), /textZoom/, '不鎖文字大小，尊重系統字型設定')
  assert.match(css, /\.m button,\.m input,\.m select,\.m textarea\{font-size:16px\}/)
  assert.doesNotMatch(css, /\.(composer textarea|m-search input)[^}]*font-size:(1[0-5]|[0-9])px/, '輸入框不小於 16px')
  assert.match(css, /\.m\[v-cloak\]\{display:none!important\}/, '.m 的 display:flex 會蓋掉 [v-cloak]，必須明確壓過')
  assert.match(html, /<div id="splash"/); assert.match(read('ui', 'm.js'), /getElementById\('splash'\)\?\.remove\(\)/)
  assert.ok(read('ui', 'm.js').indexOf("app.mount('#app')") < read('ui', 'm.js').indexOf('startCore?.()'), '先掛畫面，再開始收信')
})

test('滿版：名單、我、對話三頁左右不留外距與外框', () => {
  const css = read('ui', 'mobile.css')
  for (const sel of ['.m-scroll', '.m-tabs', '.m-chat > .pane']) {
    const rule = css.split('\n').find(l => l.startsWith(`${sel}{`))
    assert.ok(rule, sel)
    assert.match(rule, /margin:0[;}]/, `${sel} 不留外距`)
    assert.match(rule, /border-radius:0/, `${sel} 不留圓角外框`)
  }
  assert.doesNotMatch(css, /\.m-(scroll|tabs)\{[^}]*margin:0 8px/)
})

test('自動更新只在自行安裝版：Rust 旗標、Gradle 管道、安裝權限、空殼分開；Play 版不含更新程式與安裝權限', () => {
  assert.match(cargo, /\[features\][\s\S]*?\nsideload = \[\]/)
  const rs = read('src-tauri', 'src', 'android.rs')
  assert.match(rs, /#\[cfg\(feature = "sideload"\)\]\nmod sideload/, '下載與驗證程式只在 sideload 編進去')
  assert.match(rs, /#\[cfg\(not\(feature = "sideload"\)\)\][\s\S]*?"enabled": false/, 'Play 版：檢查指令只回 enabled:false')
  assert.match(rs, /Err\("這個版本不提供自動更新"\.into\(\)\)/)
  assert.match(rs, /verify_sha256\(&hasher\.hex\(\), &m\.sha256\)/, '下載完一定驗 sha256')
  assert.match(rs, /return fail\(&part, e\)/, 'sha256 不符就刪檔、回錯誤，不會走到改名與安裝')
  assert.doesNotMatch(rs.split('mod sideload')[0], /reqwest::Client::new\(\)\.get\(&m\.url/, '下載網址只在 sideload 模組裡用')
  const g = read('src-tauri', 'gen', 'android', 'app', 'build.gradle.kts')
  assert.match(g, /val asnDist = \(findProperty\("asnDist"\) as String\?\) \?: "play"/, '預設是 Play 版')
  assert.match(g, /src\/\$asnDist\/java/)
  assert.match(g, /if \(asnDist == "sideload"\) "android\.permission\.REQUEST_INSTALL_PACKAGES" else "android\.permission\.INTERNET"/)
  const manifest = read('src-tauri', 'gen', 'android', 'app', 'src', 'main', 'AndroidManifest.xml')
  assert.doesNotMatch(manifest, /REQUEST_INSTALL_PACKAGES/, '主 manifest 不直接寫安裝權限，由管道決定')
  assert.match(manifest, /\$\{installPermission\}/)
  const d = ['gen', 'android', 'app', 'src']
  const play = read('src-tauri', ...d, 'play', 'java', 'tw', 'yooliang', 'asn', 'SelfUpdate.kt')
  const side = read('src-tauri', ...d, 'sideload', 'java', 'tw', 'yooliang', 'asn', 'SelfUpdate.kt')
  assert.match(play, /ENABLED = false/); assert.doesNotMatch(play.replace(/\/\/.*$/gm, ''), /Intent|FileProvider|canRequestPackageInstalls|INSTALL/, 'Play 版空殼不含安裝程式碼')
  assert.match(side, /ENABLED = true/); assert.match(side, /canRequestPackageInstalls/); assert.match(side, /application\/vnd\.android\.package-archive/)
  assert.match(side, /startsWith\(updates\.path/, '只安裝更新資料夾裡的 APK')
  assert.match(read('src-tauri', ...d, 'main', 'res', 'xml', 'file_paths.xml'), /asn_updates/)
  const main = fs.readdirSync(path.join(root, 'src-tauri', ...d, 'main', 'java', 'tw', 'yooliang', 'asn'))
  assert.ok(!main.includes('SelfUpdate.kt'), '安裝程式不能放進共用的 main')
  // 發版腳本：自行安裝版帶 sideload 旗標與管道變數；只用 debug 金鑰，不產生金鑰
  const rel = read('scripts', 'release-android.mjs')
  assert.match(rel, /ORG_GRADLE_PROJECT_asnDist: 'sideload'/); assert.match(rel, /'--features', 'sideload'/)
  assert.match(rel, /debug\.keystore/); assert.doesNotMatch(rel, /keytool|genkey|-genkeypair/, '不產生金鑰')
})

test('手機開新夥伴：只走要本人簽章的指令；不用電腦版不簽章的 relay_launch；不在線／未開放／沒登入不送出', () => {
  const m = /#\[cfg\(not\(desktop\)\)\]\n\s*let builder = builder\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\);/.exec(lib)
  const names = m[1].split(',').map(s => s.trim().replace(/^\w+::/, '')).filter(Boolean)
  assert.ok(names.includes('android_launch') && names.includes('android_launchers'), '手機要有遠端開視窗的兩個指令')
  assert.ok(names.includes('relay_partner_list') && names.includes('relay_partner_succeed'), '接班設定（#153）也走簽章指令')
  assert.ok(!names.includes('relay_launch') && !names.includes('relay_launchers') && !names.includes('partner_launch_local'), '手機不用電腦版的（不簽章／本機開視窗）指令')
  const rs = read('src-tauri', 'src', 'android.rs')
  assert.match(rs, /signing_token\(&auth\)\.await[\s\S]*?launch_signed\(&body, token\.as_deref\(\)\)/, 'android_launch 取本人憑證交給 launch_signed')
  assert.match(rs, /signing_token\(&auth\)\.await[\s\S]*?launchers_signed\(ids\.as_deref\(\), token\.as_deref\(\)\)/)
  const relay = read('src-tauri', 'src', 'relay.rs')
  assert.match(relay, /pub async fn launch_signed[\s\S]*?ok_or\("尚未登入，無法替電腦開新夥伴"\)\?;[\s\S]*?api_signed\("launch"/, '沒憑證在打後台之前就回錯')
  assert.match(relay, /pub async fn launchers_signed[\s\S]*?ok_or\("尚未登入，無法查詢電腦的啟動設定"\)\?;[\s\S]*?api_signed\("launchers"/)
  // 畫面：送出前一定先過 lchFormErr（不在線、沒開放、沒登入、欄位不對都在這裡擋下）
  const js = read('ui', 'm.js')
  const sub = /async function submitLaunch\(\) \{([\s\S]*?)\n    \}\n/.exec(js)[1]
  assert.ok(sub.indexOf('lchFormErr.value') >= 0 && sub.indexOf('lchFormErr.value') < sub.indexOf("invoke('android_launch'"), '先檢查再送出')
  assert.match(sub, /if \(lch\.error \|\| lch\.busy\) return/)
  assert.match(js, /pickLaunchDevice\(node\) \{\s*if \(!launchEligibility\(node, lchCtx\.value\)\.ok\) return/, '不能開的電腦選不起來')
  assert.match(read('ui', 'm.html'), /:disabled="!d\.ok"/, '不能開的電腦按鈕反灰')
  // 後台：簽章證明本人才多認一條（migration 與 Edge Function）
  assert.match(read('..', '..', 'supabase', 'functions', 'relay', 'index.ts'), /action === "launch" \|\| action === "launchers"\) \? await signedUserId/)
})

test('名單每列：廠商小徽章疊在頭像右下角（約 40%、白底圓角）；第三行最後一句話單行省略、色淡；補往來有節制', () => {
  const html = read('ui', 'm.html'), css = read('ui', 'mobile.css'), js = read('ui', 'm.js')
  assert.match(css, /\.m-av-wrap \.dp\{display:block;width:38px;height:38px\}/, '包在 wrapper 裡的 .dp 要明確 display:block（inline 會忽略寬高）')
  // 小徽章改用統一頭像 <asn-avatar size="sm">（#336），樣式是 style.css 的 .avb 那一套
  const base = read('ui', 'style.css')
  assert.match(html, /<span class="m-av-wrap">\s*<asn-avatar size="sm" :src="avOf\(c\)" :friend="c"/)
  const v = /\.avb-v\{([^}]*)\}/.exec(base)[1]
  assert.match(v, /position:absolute/); assert.match(v, /right:-?\d+px/); assert.match(v, /bottom:-?\d+px/); assert.match(v, /background:#fff/); assert.match(v, /border-radius:\d+px/)
  const w = Number(/\.avb\.sm \.avb-v\{width:(\d+)px/.exec(base)[1]), a = Number(/\.m-av-wrap\{[^}]*width:(\d+)px/.exec(css)[1])
  assert.ok(w / a >= 0.35 && w / a <= 0.45, `徽章約頭像寬的 40%（${w}/${a}）`)
  assert.match(html, /<span class="b-last" v-if="lastOf\(c\.id\)">\{\{ lastOf\(c\.id\) \}\}<\/span>/)
  const last = /\.m-buddy \.b-last\{([^}]*)\}/.exec(css)[1]
  assert.match(last, /white-space:nowrap/); assert.match(last, /overflow:hidden/); assert.match(last, /text-overflow:ellipsis/); assert.match(last, /color:#9[0-9a-f]{5}/, '字色較淡')
  // 補往來：登入才補、每位最多一次、有佇列上限，且 syncHistory 本身有最短間隔與快取
  assert.match(js, /backfillQueue\(order, \{ lastOf, tried: backfillTried \}\)/); assert.match(js, /backfillTried\.add\(id\)[\s\S]*?await core\.syncHistory\(id\)/)
  assert.match(js, /if \(backfilling \|\| !acct\.value\.signed_in\) return/)
  assert.match(js, /BACKFILL_GAP_MS/)
})

test('三個大分頁：夥伴／對話／設置，橫向翻頁、頂部分頁列＋底線指示條；邊緣留給系統、輸入與工具列不接手', () => {
  const html = read('ui', 'm.html'), css = read('ui', 'mobile.css'), js = read('ui', 'm.js')
  assert.deepEqual([...html.matchAll(/<section class="m-pg" aria-label="([^"]+)">/g)].map(m => m[1]).concat([...html.matchAll(/<section class="m-pg m-chat" [^>]*aria-label="([^"]+)">/g)].map(m => m[1])).sort(), ['夥伴', '設置', '對話'].sort())   // 對話分頁的標籤固定（#461：設備與帳號改在第四頁籤）
  assert.match(html, /<button v-for="t in tabs"[^>]*@click="goTab\(t\)"><span>\{\{ tabLabel\(t\) \}\}<\/span>/, '上方分頁三個（有第四頁籤時四個），可點')
  assert.match(html, /class="m-ind" :style="\{ transform: 'translateX\(' \+ indicator \* 100 \+ '%\)' \}"/, '指示條跟著滑動')
  // 分頁列在最上方（pager 之前），不留底部列；視覺高 32px、可點範圍 36px；輸入區貼底並讓出安全區
  assert.ok(html.indexOf('<nav class="m-tabs"') > html.indexOf('<section class="m-page"') && html.indexOf('<nav class="m-tabs"') < html.indexOf('class="m-pager-wrap"'), '分頁列在 pager 之上')
  assert.equal((html.match(/<nav class="m-tabs"/g) || []).length, 1, '只有一個分頁列')
  assert.match(css, /\.m-tabs\{[^}]*height:32px[^}]*border-bottom:1px solid/, '分頁列矮（32px），底邊分隔')
  assert.doesNotMatch(css, /\.m-tabs\{[^}]*border-top/, '不再是底部列')
  assert.match(css, /\.m-ind\{[^}]*bottom:0/, '底線指示')
  assert.match(css, /\.m-tabs button::after\{[^}]*top:-2px;bottom:-2px/, '可點範圍 32+4＝36px')
  assert.match(css, /\.m-page\{[^}]*padding-bottom:env\(safe-area-inset-bottom/, '輸入區貼底並讓出手勢列')
  assert.doesNotMatch(html, />\s*名單\s*<|>\s*我\s*<\/span>/, '舊的「名單／我」分頁拿掉')
  // 手勢：頁面並排區接觸控（對話分頁在裡面，所以對話上也能左右滑；輸入框與工具列不接手）
  assert.match(html, /class="m-pager-wrap" @touchstart\.passive="swipeStart\(\$event, 'pager'\)" @touchmove="swipeMove" @touchend="swipeEnd" @touchcancel="swipeEnd"/)
  assert.match(css, /\.m-pager-wrap\{[^}]*touch-action:pan-y/)
  assert.match(css, /\.m-pager\{[^}]*width:calc\(var\(--pages,3\) \* 100%\)[^}]*transition:transform/); assert.match(css, /\.m-pager\.dragging\{transition:none\}/, '拖動時沒有動畫（跟手）')
  assert.doesNotMatch(css, /\.m-chat\{[^}]*position:fixed/, '對話是第二個分頁本身，不再是蓋在分頁上的一層')
  // 邏輯接線：邊緣、輸入、選取、水平鎖定、吸附
  const start = /function swipeStart\(e, mode\) \{([\s\S]*?)\n    \}\n/.exec(js)[1]
  assert.match(start, /swipeStartOk\(t\.clientX, window\.innerWidth\)/, '邊緣不接手'); assert.match(start, /closest\?\.\(SWIPE_BLOCK_SELECTOR\)/); assert.match(start, /getSelection/, '正在選文字不接手')
  const move = /function swipeMove\(e\) \{([\s\S]*?)\n    \}\n/.exec(js)[1]
  assert.match(move, /swipeLock\(dx, dy\)/); assert.match(move, /if \(l === 'v'\) \{ sw\.mode = ''; return \}/, '垂直就放手給系統捲動')
  assert.match(js, /swipeTarget\(\{ index: idx\.value, dx, dt: Date\.now\(\) - t0, width, count: pages\.value \}\)/)
  assert.match(css, /\.m-ind\{[^}]*z-index:2/, '指示條要在分頁按鈕上面（不然被選中的底色蓋住）')
  assert.match(js, /if \(sw\.locked === 'h'\) \{ y0 = null/, '左右滑動時不觸發下拉重整')
  // 返回：對話 → 回到分頁；非夥伴的分頁 → 回夥伴
  assert.match(js, /const goTab = t => fourthNav\.goTab\(t\)/)
  assert.match(read('ui', 'lib', 'mobile-nav.mjs'), /function switchTab\(t\) \{[\s\S]*?if \(nav\.tab === 'list'\) go\(tabNav\(t\)\)[\s\S]*?else if \(t === 'list'\) history\.back\(\)/)
  // 設置頁沒有下拉重整；舊的 goMe／goList 都不見了
  assert.doesNotMatch(js, /goMe|goList/)
})

test('名字兩層、頭像圓角方形：我的名字（帳號層、唯讀）與這台設備的名稱分開；對話與「我」頂端用帳號名；.m-pic 不是圓形', () => {
  const html = read('ui', 'm.html'), css = read('ui', 'mobile.css'), js = read('ui', 'm.js')
  assert.match(html, /<label>我的名字<input[^>]*v-model="nameDraft"[^>]*@change="commitName"/, '「我的名字」可改（#166：走後台 account_name）')
  assert.doesNotMatch(html, /readonly/, '不再唯讀')
  assert.match(js, /authApi\.setAccountName\(c\.name\)/, '改名字走帳號名稱指令')
  assert.match(html, /<label>這台設備的名稱<input[^>]*v-model="me\.nick"[^>]*@change="commitNick"/, '設備名稱照舊可改（就是視窗名）')
  assert.doesNotMatch(html, /暱稱（也是對外的名字）/)
  assert.match(html, /<chat-pane v-if="chatFriend" :friend="chatFriend" :me="meForChat"/, '對話裡自己的名字用帳號名')
  assert.match(js, /meForChat = computed\(\(\) => \(\{ \.\.\.me, nick: myName\.value \}\)\)/)
  assert.match(html, /<p class="m-who">\{\{ myName \}\}<\/p>/, '「我」分頁頂端顯示帳號名')
  assert.match(html, /<div class="m-title">\{\{ myName \}\}<\/div>/, '夥伴頁頂端用帳號名')
  const rs = read('src-tauri', 'src', 'account.rs')
  assert.match(rs, /owner_name: owner_name_of\(&v\)/, '帳號名字來自 account_bootstrap 的 tenant.owner_name')
  // 頭像：MSN 風圓角方形加狀態色外框，不是圓形；也不回頭用電腦版的 .dp 相框
  const pic = /\.m-pic\{([^}]*)\}/.exec(css)[1], lg = /\.m-pic-lg\{([^}]*)\}/.exec(css)[1]
  assert.doesNotMatch(pic, /border-radius:\s*50%/); assert.doesNotMatch(lg, /border-radius:\s*50%/)
  assert.match(pic, /border-radius:\d+px/); assert.match(lg, /border-radius:\d+px/)
  assert.match(pic, /border:3px solid var\(--frame\)/, '外圈有狀態色邊框')
  assert.doesNotMatch(css, /\.m-pic[^{]*\{[^}]*border-radius:\s*50%/)
})

test('名單頁：群組標題沒有開新夥伴按鈕、標題列沒有重新整理鈕、圖示按鈕同尺寸；下拉重整有接上', () => {
  const html = read('ui', 'm.html'), css = read('ui', 'mobile.css'), js = read('ui', 'm.js')
  // 群組標題只有收合鈕；開新夥伴只剩右上角那一個「＋」
  const group = /<div v-for="g in groups"[\s\S]*?<ul v-show/.exec(html)[0]
  assert.doesNotMatch(group, /開新夥伴|openLaunch|m-gplus/, '群組標題旁不放開新夥伴')
  assert.doesNotMatch(css, /m-gplus/)
  assert.equal(html.split("pickPlus('launch')").length - 1, 1, '只有標題列右上角「＋」選單一個入口')
  assert.equal(html.split("openLaunch('')").length - 1, 0, '開新夥伴不再直接散在名單上')
  assert.doesNotMatch(html, /openLaunch\((?!'')/, '不再有預選電腦的入口')
  // 標題列沒有重新整理鈕（改下拉重整）
  const head = /<header class="m-head">[\s\S]*?<\/header>/.exec(html)[0]
  assert.doesNotMatch(head, /重新整理|refreshAll|⟳/)
  assert.doesNotMatch(html, /aria-label="重新整理"/)
  // 所有圖示按鈕（返回、＋）同一個類別與同尺寸：觸控區 48px、圖示 28px，且都用 SVG（不用字元，大小才會一致）
  for (const m of html.matchAll(/<button class="m-icon-btn"[^>]*>([\s\S]*?)<\/button>/g)) assert.match(m[1], /<svg class="m-ic" viewBox="0 0 24 24" width="28" height="28"/, m[0].slice(0, 80))
  assert.ok(html.match(/<button class="m-icon-btn"/g).length >= 3, '返回（開新夥伴）、＋與「⋯」')
  const rule = /\.m-icon-btn\{([^}]*)\}/.exec(css)[1]
  assert.match(rule, /width:48px/); assert.match(rule, /height:48px/)
  assert.match(css, /\.m-icon-btn \.m-ic\{width:28px;height:28px/)
  assert.doesNotMatch(css, /\.m-chathead \.m-icon-btn/, '返回鍵不另外放大，與「＋」同尺寸')
  // 下拉重整：觸控事件接在名單捲動區；動畫只用 transform／opacity；用我們自己的機器人（與 logo.svg 同一份圖形）
  assert.match(html, /<ptr-zone :ptr="pf\.ptr"><\/ptr-zone>\s*<div class="m-scroll" :ref="el => \(pf\.ptr\.el = el\)" @touchstart\.passive="pf\.start" @touchmove="pf\.move" @touchend="pf\.end" @touchcancel="pf\.end"/, 'pf 下拉重整接在夥伴頁的捲動區')
  assert.equal(html.split('<ptr-zone').length - 1, 1, '只有夥伴頁有下拉重整（對話頁是單一對話、設置頁沒有）')
  assert.match(js, /class="m-ptr"/); assert.match(js, /ptr\.phase/)
  assert.match(js, /shouldRefreshOnRelease\(ptr\.h, refreshing\.value\)/); assert.match(js, /refreshAll\(\)/)
  assert.match(js, /if \(e\.cancelable\) e\.preventDefault\(\)/)
  const logo = read('ui', 'img', 'logo.svg')
  for (const d of ['M 180 270 C 180 270, 160 360, 250 360', 'rx="75"', 'M 205 200 L 215 190 L 225 200']) assert.ok(logo.includes(d) && js.includes(d), `機器人圖形與 logo.svg 一致：${d}`)
  const anim = css.split('\n').filter(l => /^@keyframes m-ptr-/.test(l)).join('\n')
  assert.ok(anim.length > 0); assert.doesNotMatch(anim, /(width|height|top|left|margin)\s*:/, '動畫只動 transform，不觸發排版')
  assert.match(css, /prefers-reduced-motion[\s\S]*?m-ptr/)
})

test('檢查更新失敗的文字：404＝目前已是最新版；連不上或其他錯誤＝暫時無法檢查更新；原始錯誤不外洩', () => {
  const rs = read('src-tauri', 'src', 'android.rs')
  const f = /async fn fetch_manifest[\s\S]*?\n    \}\n/.exec(rs)[0]
  assert.match(f, /CheckStatus::NotFound => return Ok\(None\)/); assert.match(f, /CheckStatus::Unavailable => return Err\(MSG_UNAVAILABLE/)
  assert.doesNotMatch(f, /format!\(|連不上更新伺服器|回應異常/, '不再把狀態碼或內部說明帶給畫面')
  assert.match(rs, /else \{\s*return Ok\(json!\(\{ "enabled": true, "available": false \}\)\);/, '404＝沒有新版')
  const js = read('ui', 'm.js')
  assert.match(js, /updateCheckErrorText\(e\.message\)/); assert.match(js, /目前已是最新版/)
  assert.doesNotMatch(js, /upd\.manual = e\.message/)
})

test('登入畫面 logo 只有一層框；App 圖示是機器人（自適應圖示＋各密度）', () => {
  const css = read('ui', 'mobile.css')
  const img = /\.m-login-card \.login-avatar img\{([^}]*)\}/.exec(css)[1]
  assert.match(img, /background:none/); assert.match(img, /box-shadow:none/); assert.match(img, /border-radius:0/, '內層不再有自己的底色、陰影、圓角框')
  assert.match(css, /\.m-login-card \.login-avatar::after\{display:none\}/)
  const res = ['src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res']
  for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    for (const f of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
      const b = fs.readFileSync(path.join(root, ...res, `mipmap-${d}`, f))
      assert.equal(b.subarray(1, 4).toString(), 'PNG', `${d}/${f}`)
    }
  }
  const px = (d, f) => fs.readFileSync(path.join(root, ...res, `mipmap-${d}`, f)).readUInt32BE(16)
  assert.deepEqual([px('mdpi', 'ic_launcher_foreground.png'), px('xxxhdpi', 'ic_launcher_foreground.png')], [108, 432], '自適應前景 108dp 畫布')
  assert.deepEqual([px('mdpi', 'ic_launcher.png'), px('xxxhdpi', 'ic_launcher.png')], [48, 192])
  for (const f of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    const x = read(...res, 'mipmap-anydpi-v26', f)
    assert.match(x, /<adaptive-icon/); assert.match(x, /@mipmap\/ic_launcher_foreground/); assert.match(x, /@drawable\/ic_launcher_background/)
  }
  assert.match(read(...res, 'drawable', 'ic_launcher_background.xml'), /#DCEBFA/)
  assert.ok(!fs.existsSync(path.join(root, ...res, 'drawable-v24', 'ic_launcher_foreground.xml')), 'Tauri 預設圖示的前景不能留著')
  assert.match(read('scripts', 'gen-android-icons.mjs'), /ui', 'img', 'logo\.svg/, '圖示由機器人 logo 產生')
  // 電腦版圖示檔沒被動到
  assert.ok(fs.existsSync(path.join(root, 'src-tauri', 'icons', 'icon.ico')))
})

test('登入畫面背景：電腦版與手機版各用一張 MSN 風背景，cover＋草地對齊底部；表單區有半透明白底保持可讀', () => {
  for (const [f, w, h] of [['login-bg-desktop.webp', 1600, 1000], ['login-bg-mobile.webp', 1080, 2340]]) {
    const b = fs.readFileSync(path.join(root, 'ui', 'img', f))
    assert.equal(b.subarray(0, 4).toString(), 'RIFF'); assert.equal(b.subarray(8, 12).toString(), 'WEBP')
    assert.ok(b.length < 100 * 1024, `${f} 不要太大`)
  }
  const style = read('ui', 'style.css'), mcss = read('ui', 'mobile.css')
  assert.match(style, /\.login-pane\{[^}]*url\(img\/login-bg-desktop\.webp\) center bottom\/cover no-repeat/)
  assert.match(mcss, /\.m\.is-login\{[^}]*url\(img\/login-bg-mobile\.webp\) center bottom\/cover no-repeat/)
  assert.doesNotMatch(mcss, /login-bg-desktop/); assert.doesNotMatch(style, /login-bg-mobile/)
  assert.match(style, /\.login-card\{[^}]*background:rgba\(255,255,255,\.\d+\)/)
  assert.match(mcss, /\.m-login-card\{[^}]*background:rgba\(255,255,255,\.\d+\)/)
  assert.doesNotMatch(read('ui', 'm.html'), /<div id="app"[^>]*:class/, '#app 自己的屬性不會被 Vue 處理，:class 綁了也沒用')
  assert.match(read('ui', 'm.js'), /classList\.toggle\('is-login', s === 'login' \|\| s === 'onboard'\)/)
})

test('文件與資源：設計文件存在，說明套件名、登入方式、限制', () => {
  const doc = fs.readFileSync(path.join(root, '..', '..', 'docs', 'design', 'ANDROID.md'), 'utf8')
  for (const k of ['tw.yooliang.asn', '登入', '本機回送位址', '限制', '第二期', '真機']) assert.ok(doc.includes(k), `ANDROID.md 要提到「${k}」`)
})

test('登入完成頁（安卓）：把使用者帶回 App 的按鈕，不帶權杖或授權碼', () => {
  const auth = read('src-tauri', 'src', 'auth.rs')
  const m = /pub const PAGE_OK_ANDROID: &str = "((?:[^"\\]|\\.)*)";/.exec(auth)
  assert.ok(m, '找不到 PAGE_OK_ANDROID')
  assert.match(m[1], /intent:\/\/login-done#Intent;scheme=tw\.yooliang\.asn;package=tw\.yooliang\.asn;end/)
  assert.doesNotMatch(m[1], /code|token|state|verifier/i)
  assert.match(auth, /fn page_ok\(\)[\s\S]*cfg!\(target_os = "android"\)/)
})

test('通話（#99）：麥克風執行期才問、語音走系統內建，手機不編進電腦端的語音模組與指令', () => {
  const dir = ['src-tauri', 'gen', 'android', 'app', 'src', 'main', 'java', 'tw', 'yooliang', 'asn']
  const voice = read(...dir, 'CallVoice.kt'), bridgeKt = read(...dir, 'AsnBridge.kt'), act = read(...dir, 'MainActivity.kt')
  assert.match(voice, /requestPermissions\([^)]*RECORD_AUDIO/, '第一次通話才詢問麥克風權限')
  assert.match(voice, /"zh-TW"/); assert.match(voice, /SpeechRecognizer/); assert.match(voice, /TextToSpeech/)
  assert.match(act, /onRequestPermissionsResult/); assert.match(act, /override fun onStop\(\)[\s\S]*callVoice\.onBackground\(\)/, '螢幕關閉或切到背景要結束通話')
  for (const m of ['callAvailable', 'callMicState', 'callRequestMic', 'callListen', 'callStopListen', 'callSpeak', 'callStopSpeak', 'callEnd', 'keepAwake']) assert.match(bridgeKt, new RegExp(`@JavascriptInterface\\s+fun ${m}\\b`), `外殼橋有 ${m}`)
  // 手機的通話邏輯是純邏輯：不碰電腦端的收音、辨識、念出（stt／tts 是電腦端模組，指令手機不存在）
  const logic = read('ui', 'lib', 'mobile-call.mjs').replace(/(^|\s)\/\/.*$/gm, '$1')
  assert.doesNotMatch(logic, /from '\.\/(mic|voice-ui|voice-input|tauri|wav)\.mjs'/, '不編進電腦端的收音與 Tauri')
  assert.doesNotMatch(logic, /invoke\(|stt_|tts_|voice_cfg/, '不叫電腦端的語音指令')
  const mjs = read('ui', 'm.js').replace(/(^|\s)\/\/.*$/gm, '$1')
  assert.doesNotMatch(mjs, /['"`](stt_\w+|tts_\w+|voice_\w+)['"`]/)
  for (const c of ['stt', 'tts', 'voicecfg']) assert.match(lib, new RegExp(`#\\[cfg\\(desktop\\)\\]\\s*mod ${c};`), `${c} 仍然只有電腦版`)
})

test('通話鈕只在對話頁工具列、只給 AI 夥伴；手機對話頁把通話接上', () => {
  const pane = read('ui', 'lib', 'chatpane.mjs')
  assert.match(pane, /v-if="showCallBtn( && !displayOnly)?"[^>]*@click="startCall"/, '工具列的通話鈕（僅顯示條目沒有）')
  assert.match(pane, /const showCallBtn = computed\(\(\) => !!props\.callApi && !!call && canCallPartner\(props\.friend\)\)/, '顯示條件：手機傳了通話、對方是 AI 夥伴')
  assert.match(pane, /:callable="!!call && !callApi"/, '手機沒有上方功能列，不會多出第二顆通話鈕')
  assert.match(read('ui', 'm.html'), /<chat-pane[^>]*:call-api="callApi"[^>]*@call-state="onCallState"/)
  assert.match(read('ui', 'm.js'), /startCallPoll\(\{ anyCall: \(\) => callOn\.value/, '通話中每 2 秒收信')
  for (const f of ['list.html', 'chat.html']) assert.doesNotMatch(read('ui', f), /call-api/, `${f} 是電腦版頁面，沒有手機的通話`)
})

test('手機群組對話：讀走節點金鑰、發言走要本人簽章的專用指令；手機清單沒有電腦端模組；畫面不叫沒簽章的發言路徑', () => {
  const m = /#\[cfg\(not\(desktop\)\)\]\n\s*let builder = builder\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\);/.exec(lib)
  const names = m[1].split(',').map(s => s.trim().replace(/^\w+::/, '')).filter(Boolean)
  for (const c of ['relay_rooms', 'android_room_read', 'android_room_post']) assert.ok(names.includes(c), `手機要有 ${c}`)
  const droid = read('src-tauri', 'src', 'android.rs')
  const post = /pub async fn android_room_post[\s\S]*?\n\}/.exec(droid)[0]
  assert.match(post, /signing_token/, '發言要取登入憑證')
  assert.match(post, /room_post_signed/, '發言走簽章版')
  assert.doesNotMatch(post, /\.api\(/, '發言不能繞過簽章直接打後台')
  const relay = read('src-tauri', 'src', 'relay.rs')
  assert.match(/pub async fn room_post_signed[\s\S]*?\n    \}/.exec(relay)[0], /ok_or\("尚未登入/, '沒憑證在打後台之前就回錯')
  // 群組的讀寫經 lib/room-hub.mjs（電腦版共用）；手機在建立時指定自己的兩個指令名
  const js = read('ui', 'm.js'), hub = read('ui', 'lib', 'room-hub.mjs')
  assert.match(js, /readCmd: 'android_room_read'/); assert.match(js, /postCmd: 'android_room_post'/)
  assert.match(hub, /invoke\(postCmd/); assert.match(hub, /invoke\(readCmd/); assert.match(hub, /invoke\('relay_rooms'/)
  assert.doesNotMatch(js, /invoke\('relay_send'[^\n]*room/i, '群組發言不經一般寄信')
  const html = read('ui', 'm.html'), css = read('ui', 'mobile.css')
  assert.match(html, /ROOM_GROUP_KEY/, '夥伴分頁有群組對話分組'); assert.match(html, /is-room/)
  assert.match(css, /\.m-chat\.is-room \.toolbar>\.tool\{display:none\}/, '群組沒有震動、傳照片、傳檔案：工具列的鈕藏起來')
})
