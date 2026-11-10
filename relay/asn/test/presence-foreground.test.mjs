// #1281：手機進前景／進背景要立刻告知 Rust（在線回報帶 foreground，後台推播只看前景）。
// 靜態守門：外殼（Kotlin）在 onStart／onStop 呼叫網頁；網頁呼叫 set_foreground 並在前景時續命；Rust 兩份指令清單都有 set_foreground，
// 前景告知有期限（沒續命就過期），電腦版不帶旗標。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = (...p) => fs.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const act = rd('src-tauri', 'gen', 'android', 'app', 'src', 'main', 'java', 'tw', 'yooliang', 'asn', 'MainActivity.kt')
const m = rd('ui', 'm.js')
const lib = rd('src-tauri', 'src', 'lib.rs')
const relay = rd('src-tauri', 'src', 'relay.rs')

test('外殼：onStop 先送 false、結束通話丟例外也一定送出且會呼叫 super；onStart 送 true', () => {
  assert.match(act, /override fun onStop\(\) \{\n(    \/\/[^\n]*\n)+    try \{\n      fgEvent\(false\)\n      callVoice\.onBackground\(\)\n    \} finally \{\n      super\.onStop\(\)\n    \}/)
  assert.match(act, /override fun onStart\(\) \{\n    super\.onStart\(\)\n    fgEvent\(true\)/)
  assert.match(act, /window\.__asnFgEvent && window\.__asnFgEvent\(\$fg\)/)
  assert.doesNotMatch(act, /super\.onStop\(\) 之前送出/, '註解不說「之前送出」（只是排進佇列）')
})

test('網頁：外殼事件與 visibilitychange 都呼叫 set_foreground，啟動時也告知一次', () => {
  assert.match(m, /window\.__asnFgEvent = tellFg/)
  assert.match(m, /invoke\('set_foreground', \{ foreground: fg === true \}\)/)
  assert.match(m, /addEventListener\('visibilitychange', \(\) => tellFg\(document\.visibilityState === 'visible'\)\)/)
  assert.match(m, /\n  tellFg\(document\.visibilityState === 'visible'\)\n/)
})

test('網頁：前景時每 30 秒續命（背景不送）；間隔要能容許漏掉至少兩次（Rust 的期限 90 秒）', () => {
  const renew = Number(/const FG_RENEW_MS = ([\d_]+)/.exec(m)[1].replace(/_/g, ''))
  const ttl = Number(/pub const FG_TTL_MS: u64 = ([\d_]+);/.exec(relay)[1].replace(/_/g, ''))
  assert.equal(renew, 30000); assert.equal(ttl, 90000)
  assert.ok(ttl >= renew * 3, '期限要容許漏掉至少兩次續命')
  assert.match(m, /setInterval\(\(\) => \{ if \(document\.visibilityState === 'visible'\) tellFg\(true\) \}, FG_RENEW_MS\)/)
})

test('Rust：set_foreground 指令在電腦與手機兩份清單都有；只有手機版帶 foreground；前景有期限、預設在背景', () => {
  assert.match(lib, /fn set_foreground\(app: State<'_, App>, foreground: bool\)/)
  assert.equal((lib.match(/set_presence, set_foreground,/g) || []).length, 2)
  assert.match(relay, /reports_foreground: cfg!\(target_os = "android"\)/)
  assert.match(relay, /foreground_ms: AtomicU64::new\(0\)/)
  assert.match(relay, /t != 0 && now_ms\.saturating_sub\(t\) <= FG_TTL_MS/, '前景有期限')
  assert.match(relay, /if was != fg \{\n\s+self\.presence_wake\.notify_one\(\);/)
  assert.match(relay, /build_presence_body_fg\(&self\.window_name\(\), version, &status, &psm, self\.presence_foreground\(\)\)/)
  assert.match(relay, /build_presence_body\(&self\.window_name\(\), version, "offline", ""\)/, '離線回報不帶 foreground')
})
