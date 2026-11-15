// 啟動設定現況修正（#1548 第 1 張）：版本有值、外掛狀態帶到設定頁、空白名單不誤存建議資料夾、存檔失敗看得到、上限說明與範圍
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { LAUNCH_MAX_NOTE, normalizeLaunchPrefs } from '../ui/lib/launch-prefs.mjs'
import { modelUiRow } from '../ui/lib/partner.mjs'

const rd = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('版本：後端偵測帶 version，畫面照原樣顯示；沒有就是空字串（畫面寫「已安裝」）', () => {
  assert.equal(modelUiRow({ id: 'claude' }, { binary_found: true, version: '2.0.31' }).version, '2.0.31')
  assert.equal(modelUiRow({ id: 'codex' }, { binary_found: true, version: '' }).version, '')
  const rs = rd('src-tauri/src/agent_tools/types.rs')
  assert.match(rs, /pub version: String,/, 'Rust 的偵測結果有 version 欄位')
  assert.match(rd('ui/lib/settings-panel.mjs'), /\{\{ t\.version \|\| '已安裝' \}\}/)
})

test('外掛狀態：設定頁拿得到 accounts.mod（以前沒帶，「啟動設定」和「帳號」那一行都不會出現）', () => {
  assert.match(rd('ui/list.js'), /msg: accounts\.state\.msg, mod: accounts\.state\.mod,/)
})

test('白名單：存的是使用者改過的 launchPrefs.cwdAllow，不是顯示建議資料夾的文字框；存不進去顯示原因', () => {
  const js = rd('ui/list.js')
  const fn = js.slice(js.indexOf('async function saveLaunchPrefs()'), js.indexOf('function setLaunchCwdText('))
  assert.match(fn, /cwdAllow: \[\.\.\.launchPrefs\.cwdAllow\]/)
  assert.doesNotMatch(fn, /launchCwdText/, '存檔不讀文字框')
  assert.match(fn, /launchMsg\.value = `啟動設定沒有存成功：/)
  assert.match(js, /launch: \{ tools: launchToolRows\.value, maxPerHour: launchPrefs\.maxPerHour, cwdText: launchCwdText\.value, msg: launchMsg\.value \}/)
  assert.match(rd('ui/lib/settings-panel.mjs'), /<small class="acct-warn" v-if="st\.launch\.msg" role="alert">\{\{ st\.launch\.msg \}\}<\/small>/)
})

test('上限：存的值夾在 1～20（跟 Rust 認的一樣，不然存了不算數）；說明寫清楚只限制從別的設備開', () => {
  const clamp = v => normalizeLaunchPrefs({ maxPerHour: Math.round(Number(v)) }).maxPerHour
  assert.deepEqual([50, 0, -2, 7, 2.6, NaN, '9'].map(clamp), [20, 1, 1, 7, 3, 6, 9])
  assert.match(rd('ui/list.js'), /case 'launch-max': launchPrefs\.maxPerHour = normalizeLaunchPrefs\(\{ maxPerHour: Math\.round\(Number\(value\)\) \}\)\.maxPerHour;/)
  assert.match(LAUNCH_MAX_NOTE, /別的設備/)
  assert.match(LAUNCH_MAX_NOTE, /自己在這台電腦上開不受影響/)
  assert.match(rd('ui/lib/settings-panel.mjs'), /<small class="set-note" id="set-note-launch-max">\{\{ LAUNCH_MAX_NOTE \}\}<\/small>/)
  // Rust：遠端開窗與設定頁讀的是同一個來源
  assert.match(rd('src-tauri/src/bridge/launcher.rs'), /cfg\.max_per_hour = crate::launch::config::effective_max_per_hour\(&prefs, Some\(cfg\.max_per_hour\)\);/)
  assert.match(rd('src-tauri/src/launch/mod.rs'), /with_effective_max\(prefs, config::file_max_per_hour\(&config::launcher_config_path\(\)\)\)/)
})
