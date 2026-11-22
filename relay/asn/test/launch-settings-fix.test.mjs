// 啟動設定現況修正（#1548 第 1 張）：版本有值、外掛狀態帶到設定頁、空白名單不誤存建議資料夾、存檔失敗看得到、上限說明與範圍
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { LAUNCH_MAX_NOTE, clampMaxPerHour, launchPrefsToSave, normalizeLaunchPrefs } from '../ui/lib/launch-prefs.mjs'
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
  assert.match(fn, /launchPrefsToSave\(launchPrefs\)/)
  assert.deepEqual(launchPrefsToSave(normalizeLaunchPrefs({ cwdAllow: [], recentCwd: ['D:\demo'] })).cwdAllow, [], '白名單空的就存空的，不把建議資料夾放進去')
  assert.doesNotMatch(js, /launchCwdText/, '文字框已經拿掉（#1548 ③）')
  assert.match(fn, /launchMsg\.value = `啟動設定沒有存成功：/)
  assert.match(js, /launch: \{ tools: launchToolRows\.value, maxPerHour: launchPrefs\.maxPerHour, cwdList: launchPrefs\.cwdAllow, cwdSuggest: suggestCwds\(launchPrefs\.cwdAllow, launchPrefs\.recentCwd\), cwdMsg: launchCwdMsg\.value, msg: launchMsg\.value \}/)
  assert.match(rd('ui/lib/settings-panel.mjs'), /<small class="acct-warn" v-if="st\.launch\.msg" role="alert">\{\{ st\.launch\.msg \}\}<\/small>/)
})

test('上限：只有設定頁改過才寫 maxPerHourSet（夾在 1～20）；舊存檔的 maxPerHour 不算；顯示用的生效值另外傳、不寫回存檔', () => {
  assert.deepEqual([50, 0, -2, 7, 2.6, NaN, '9'].map(clampMaxPerHour), [20, 1, 1, 7, 3, 6, 9])
  // 讀：舊存檔的 maxPerHour:6 不算，畫面顯示後端算好的生效值；設定頁改過的優先
  assert.deepEqual([normalizeLaunchPrefs({ maxPerHour: 6, maxPerHourEffective: 10 }).maxPerHour, normalizeLaunchPrefs({ maxPerHour: 6, maxPerHourEffective: 10 }).maxPerHourSet], [10, null])
  assert.equal(normalizeLaunchPrefs({ maxPerHourSet: 3, maxPerHourEffective: 3 }).maxPerHour, 3)
  assert.equal(normalizeLaunchPrefs({ maxPerHour: 9 }).maxPerHour, 6, '只有舊欄位：當作沒設過')
  assert.equal(normalizeLaunchPrefs({ maxPerHourSet: 99, maxPerHourEffective: 4 }).maxPerHourSet, null)
  // 寫：開新夥伴、記最近的資料夾（沒改過上限）一律不寫上限；設定頁改過才帶 maxPerHourSet；顯示用的值不寫
  const plain = normalizeLaunchPrefs({ maxPerHour: 6, maxPerHourEffective: 10, recentCwd: ['D:\a'] })
  const saved = launchPrefsToSave(plain)
  assert.ok(!('maxPerHour' in saved) && !('maxPerHourSet' in saved) && !('maxPerHourEffective' in saved), JSON.stringify(saved))
  assert.deepEqual(saved.recentCwd, ['D:\a'])
  assert.equal(launchPrefsToSave({ ...plain, maxPerHourSet: 3, maxPerHour: 3 }).maxPerHourSet, 3)
  const js = rd('ui/list.js')
  assert.match(js, /case 'launch-max': launchPrefs\.maxPerHourSet = launchPrefs\.maxPerHour = clampMaxPerHour\(value\);/)
  assert.equal((js.match(/maxPerHourSet =/g) || []).length, 1, '只有設定頁那一處寫 maxPerHourSet')
  assert.match(js, /const prefs = launchPrefsToSave\(launchPrefs\)/)
  assert.match(LAUNCH_MAX_NOTE, /自己在這台電腦上開不受限制/)   // #1548 ①：兩個關鍵意思都要在：別的設備才受限（欄位文字）、自己不受限（說明）
  assert.match(LAUNCH_MAX_NOTE, /超過時對方會看到提示/)
  assert.match(rd('ui/lib/settings-panel.mjs'), /別的設備一小時最多替這台開/)
  assert.match(rd('ui/lib/settings-panel.mjs'), /<small class="set-note" id="set-note-launch-max">\{\{ LAUNCH_MAX_NOTE \}\}<\/small>/)
  // Rust：遠端開窗與設定頁讀的是同一個來源；讀的是 maxPerHourSet，生效值另放 maxPerHourEffective
  assert.match(rd('src-tauri/src/bridge/launcher.rs'), /cfg\.max_per_hour = crate::launch::config::effective_max_per_hour\(&prefs, Some\(cfg\.max_per_hour\)\);/)
  assert.match(rd('src-tauri/src/launch/config.rs'), /prefs\.get\("maxPerHourSet"\)/)
  assert.match(rd('src-tauri/src/launch/mod.rs'), /p\["maxPerHourEffective"\] = /)
})
