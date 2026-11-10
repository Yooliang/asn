// #1281：手機進前景／進背景要立刻告知 Rust（在線回報帶 foreground，後台推播只看前景）。
// 靜態守門：外殼（Kotlin）在 onStart／onStop 呼叫網頁；網頁呼叫 set_foreground；Rust 兩份指令清單都有 set_foreground，電腦版不帶旗標。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = (...p) => fs.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const act = rd('src-tauri', 'gen', 'android', 'app', 'src', 'main', 'java', 'tw', 'yooliang', 'asn', 'MainActivity.kt')
const m = rd('ui', 'm.js')
const lib = rd('src-tauri', 'src', 'lib.rs')
const relay = rd('src-tauri', 'src', 'relay.rs')

test('外殼：onStop 先送 false 再交給系統（原有的結束通話不變）、onStart 送 true', () => {
  assert.match(act, /override fun onStop\(\) \{\n    callVoice\.onBackground\(\)\n    fgEvent\(false\)[^\n]*\n    super\.onStop\(\)/)
  assert.match(act, /override fun onStart\(\) \{\n    super\.onStart\(\)\n    fgEvent\(true\)/)
  assert.match(act, /window\.__asnFgEvent && window\.__asnFgEvent\(\$fg\)/)
})

test('網頁：外殼事件與 visibilitychange 都呼叫 set_foreground，啟動時也告知一次', () => {
  assert.match(m, /window\.__asnFgEvent = tellFg/)
  assert.match(m, /invoke\('set_foreground', \{ foreground: fg === true \}\)/)
  assert.match(m, /addEventListener\('visibilitychange', \(\) => tellFg\(document\.visibilityState === 'visible'\)\)/)
  assert.match(m, /\n  tellFg\(document\.visibilityState === 'visible'\)\n/)
})

test('Rust：set_foreground 指令在電腦與手機兩份清單都有；只有手機版帶 foreground；預設在背景', () => {
  assert.match(lib, /fn set_foreground\(app: State<'_, App>, foreground: bool\)/)
  assert.equal((lib.match(/set_presence, set_foreground,/g) || []).length, 2)
  assert.match(relay, /reports_foreground: cfg!\(target_os = "android"\)/)
  assert.match(relay, /foreground: AtomicBool::new\(false\)/)
  assert.match(relay, /if self\.foreground\.swap\(fg, Ordering::SeqCst\) != fg \{\n\s+self\.presence_wake\.notify_one\(\);/)
  assert.match(relay, /build_presence_body_fg\(&self\.window_name\(\), version, &status, &psm, self\.presence_foreground\(\)\)/)
  assert.match(relay, /build_presence_body\(&self\.window_name\(\), version, "offline", ""\)/, '離線回報不帶 foreground')
})
