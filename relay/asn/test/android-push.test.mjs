// 守門：手機推播（#797 PR③）。靜態檢查原始碼與設定檔；每條都做過「拿掉被守的東西確認會紅」。
// 重點：APK 不帶服務帳戶金鑰、沒有 google-services.json 也建得過、通知文字是常數且和後台一致、不解析 FCM 訊息內容、權限只問一次、備份全排除。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n')
const A = ['src-tauri', 'gen', 'android']
const kt = f => read(...A, 'app', 'src', 'main', 'java', 'tw', 'yooliang', 'asn', f)
const noComments = s => s.replace(/\/\/[^\n]*/g, '')

test('google-services 外掛只在 google-services.json 存在時才套用；那個檔不進 repo', () => {
  const app = read(...A, 'app', 'build.gradle.kts')
  assert.match(app, /if \(file\("google-services\.json"\)\.exists\(\)\) \{\s*apply\(plugin = "com\.google\.gms\.google-services"\)\s*\}/)
  assert.doesNotMatch(app.replace(/if \(file\("google-services\.json"\)[\s\S]*?\n\}/, ''), /google\.gms|google-services"\)/, '沒有別的地方無條件套用')
  assert.doesNotMatch(app.split('plugins {')[1].split('}')[0], /google/, 'plugins 區塊不能無條件套用')
  assert.match(read(...A, 'app', '.gitignore'), /^google-services\.json$/m)
  assert.ok(!fs.existsSync(path.join(root, ...A, 'app', 'google-services.json')), 'repo 裡不能有這個檔')
  assert.match(read(...A, 'build.gradle.kts'), /classpath\("com\.google\.gms:google-services:/)
  assert.match(app, /firebase-messaging/)
})

test('APK 不帶任何服務帳戶金鑰：專案裡找不到私鑰、服務帳戶欄位、FCM 秘密名', () => {
  const stack = [path.join(root, ...A)]
  const hits = []
  while (stack.length) {
    const d = stack.pop()
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (!['build', '.gradle', '.tauri', '.kotlin'].includes(e.name)) stack.push(p); continue }
      if (!/\.(kt|kts|xml|json|properties|pro|gradle|txt|md)$/i.test(e.name)) continue
      const s = fs.readFileSync(p, 'utf8')
      if (/BEGIN (RSA )?PRIVATE KEY|"private_key"|"client_email"|FCM_SERVICE_ACCOUNT|service_account/i.test(s)) hits.push(path.relative(root, p))
    }
  }
  assert.deepEqual(hits, [])
})

test('通知文字是常數，和後台送的固定文字一致；Kotlin 不讀 FCM 訊息的任何欄位', () => {
  const push = kt('AsnPush.kt'), svc = kt('AsnMessagingService.kt')
  const server = read('..', '..', 'supabase', 'functions', '_shared', 'push_fcm.ts')
  const k = n => new RegExp(`const val ${n} = "([^"]*)"`).exec(push)[1]
  const s = n => new RegExp(`export const ${n} = "([^"]*)"`).exec(server)[1]
  assert.equal(k('TITLE'), s('PUSH_TITLE')); assert.equal(k('BODY'), s('PUSH_BODY')); assert.equal(k('TAG'), s('PUSH_TAG')); assert.equal(k('CHANNEL_ID'), s('PUSH_CHANNEL'))
  assert.match(svc, /override fun onMessageReceived\(message: RemoteMessage\)/)
  assert.doesNotMatch(noComments(svc), /message\.(data|notification|messageId|from|to|collapseKey)|\.getData|\.getNotification|RemoteMessage\.Notification/, '不解析訊息內容')
  assert.doesNotMatch(noComments(push), /putExtra|setData|Uri\.parse/, '點通知只打開主畫面：沒有額外資料、沒有深層連結、沒有外部連結')
  assert.match(push, /FLAG_IMMUTABLE/)
  assert.match(svc, /AsnPush\.appInForeground\(\)\) return/, '前景不顯示')
})

test('權杖不寫 log、不存檔：外殼與前端都沒有把權杖丟進 Log／console／SharedPreferences', () => {
  const push = kt('AsnPush.kt'), svc = kt('AsnMessagingService.kt'), bridge = kt('AsnBridge.kt')
  for (const src of [push, svc]) assert.doesNotMatch(noComments(src), /android\.util\.Log|Log\.[dviwe]\(|println|Timber/)
  assert.doesNotMatch(svc, /putString|SharedPreferences/, '服務不存權杖')
  assert.doesNotMatch(push, /putString/, '只記「問過權限」的布林')
  assert.match(push, /TOKEN_RE\.matches\(tok\)/, '放進事件前先檢查格式')
  assert.doesNotMatch(bridge, /pushToken|getToken/, '橋不直接回傳權杖，只經事件')
  const js = read('ui', 'lib', 'mobile-push.mjs')
  assert.doesNotMatch(noComments(js), /log\([^)]*token/i, 'log 不帶權杖')
  assert.doesNotMatch(js, /localStorage|sessionStorage|store\./, '前端不存權杖')
})

test('通知權限只問一次：問之前先記下，被拒就不再問；Android 13 以上才問', () => {
  const push = kt('AsnPush.kt'), act = kt('MainActivity.kt')
  const ask = /fun askPermission[\s\S]*?\n  \}/.exec(push)[0]
  assert.ok(ask.indexOf('putBoolean(KEY_ASKED, true)') > 0 && ask.indexOf('putBoolean(KEY_ASKED, true)') < ask.indexOf('requestPermissions'), '先記下再問')
  assert.match(ask, /TIRAMISU/); assert.match(ask, /state\(activity\) != "ask"\) return/)
  assert.match(push, /getBoolean\(KEY_ASKED, false\) -> "denied"/)
  assert.match(act, /requestCode == AsnPush\.REQ_NOTIF\) pushEvent/)
  assert.match(read(...A, 'app', 'src', 'main', 'AndroidManifest.xml'), /android\.permission\.POST_NOTIFICATIONS/)
})

test('沒有 Firebase 就當不能用：所有 Firebase 呼叫都在 firebaseReady 之後，且包在 try', () => {
  const push = kt('AsnPush.kt')
  assert.match(push, /FirebaseApp\.getApps\(ctx\)\.isNotEmpty\(\)\n  \} catch \(e: Throwable\) \{\n    false/)
  assert.match(/fun requestToken[\s\S]*?\n  \}/.exec(push)[0], /if \(!firebaseReady\(activity\)\) return/)
  assert.match(/fun deleteToken[\s\S]*?\n  \}/.exec(push)[0], /if \(!firebaseReady\(ctx\)\) return/)
  assert.match(push, /!firebaseReady\(ctx\) -> "unavailable"/)
})

test('清單：服務不對外、頻道與小圖示預設值、備份全排除（含 Firebase 安裝資料）', () => {
  const m = read(...A, 'app', 'src', 'main', 'AndroidManifest.xml')
  assert.match(m, /<service\s+android:name="\.AsnMessagingService"\s+android:exported="false">\s*<intent-filter>\s*<action android:name="com\.google\.firebase\.MESSAGING_EVENT" \/>/)
  assert.match(m, /default_notification_channel_id" android:value="asn_messages"/)
  assert.match(m, /android:allowBackup="false"/)
  assert.match(m, /android:fullBackupContent="@xml\/backup_rules"/); assert.match(m, /android:dataExtractionRules="@xml\/data_extraction_rules"/)
  const res = (...p) => read(...A, 'app', 'src', 'main', 'res', ...p)
  for (const dom of ['root', 'file', 'database', 'sharedpref', 'external']) {
    assert.match(res('xml', 'backup_rules.xml'), new RegExp(`<exclude domain="${dom}" path="\\." />`), dom)
    const x = res('xml', 'data_extraction_rules.xml')
    assert.equal([...x.matchAll(new RegExp(`<exclude domain="${dom}" path="\\." />`, 'g'))].length, 2, `${dom}：雲端備份與換機傳輸各一條`)
  }
  assert.doesNotMatch(res('xml', 'backup_rules.xml') + res('xml', 'data_extraction_rules.xml'), /<include/, '沒有任何「包含」')
  assert.match(res('values', 'strings.xml'), /push_channel_name/)
  assert.ok(fs.existsSync(path.join(root, ...A, 'app', 'src', 'main', 'res', 'drawable', 'ic_stat_asn.xml')))
})

test('Rust：註冊要先有在線回報；手機指令清單有、電腦清單沒有；後台動作名一致', () => {
  const rs = read('src-tauri', 'src', 'android.rs'), lib = read('src-tauri', 'src', 'lib.rs'), rl = read('src-tauri', 'src', 'relay.rs')
  assert.match(rs, /pub async fn android_push_register[\s\S]*?push_register\(&token\)/)
  assert.match(rs, /pub async fn android_push_unregister[\s\S]*?push_unregister\(\)/)
  const cut = lib.indexOf('手機只開放單欄名單與對話需要的指令')
  assert.ok(cut > 0)
  const [desktop, mobile] = [lib.slice(0, cut), lib.slice(cut)]
  assert.match(mobile, /android::android_push_register, android::android_push_unregister/)
  assert.doesNotMatch(desktop, /android_push_/, '電腦清單沒有')
  const reg = /pub async fn push_register[\s\S]*?\n    \}/.exec(rl)[0]
  assert.ok(reg.indexOf('presence_reported()') > 0 && reg.indexOf('presence_reported()') < reg.indexOf('self.api('), '先確認回報過在線才打後台')
  assert.match(reg, /"push_register"/); assert.match(rl, /"push_unregister"/)
  assert.match(rl, /self\.presence_ok\.store\(true, Ordering::Relaxed\);/, '回報成功才記下')
})

test('前端接線：第一次收信之後與回到前景才同步；登出先取消再登出', () => {
  const js = read('ui', 'm.js')
  assert.match(js, /await core\.start\(\); sync\(\); push\?\.sync\(\)/)
  assert.match(js, /void roomsHook\.refresh\?\.\(\); push\?\.sync\(\)/)
  assert.match(js, /await push\?\.logout\(\); await authApi\.logout\(\)/)
  assert.match(js, /invoke\('android_push_register', \{ token \}\)/)
})
