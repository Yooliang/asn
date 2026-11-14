// 沒登入時說清楚（todo-next-188）：登入畫面講收發信照常、名單上方提醒一次、主動登出時本人選要不要一併停止
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { LOGOUT_CANCEL_LABEL, LOGOUT_DONE_TEXT, LOGOUT_NOTE, LOGOUT_ONLY_LABEL, LOGOUT_STOP_AUTOSTART_NOTE, LOGOUT_STOP_DONE_TEXT, LOGOUT_STOP_LABEL, LOGOUT_STOP_NOTE, RELOGIN_BAR_ACTION, RELOGIN_BAR_DISMISS, RELOGIN_BAR_HINT, RELOGIN_BAR_TEXT, STILL_RUNNING_NOTE, showReloginBar } from '../ui/lib/login.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const TEXTS = { STILL_RUNNING_NOTE, RELOGIN_BAR_TEXT, RELOGIN_BAR_HINT, RELOGIN_BAR_ACTION, RELOGIN_BAR_DISMISS, LOGOUT_NOTE, LOGOUT_ONLY_LABEL, LOGOUT_STOP_LABEL, LOGOUT_STOP_NOTE, LOGOUT_STOP_AUTOSTART_NOTE, LOGOUT_CANCEL_LABEL, LOGOUT_DONE_TEXT, LOGOUT_STOP_DONE_TEXT }

test('文字：說發生什麼、怎麼辦；沒有內部名稱', () => {
  for (const [k, t] of Object.entries(TEXTS)) assert.doesNotMatch(t, /bridge|agent|token|refresh|auth|api|node|bin|https?:|[A-Za-z]{4,}/i, `${k}：${t}`)
  assert.match(STILL_RUNNING_NOTE, /還在收發信/)
  assert.match(STILL_RUNNING_NOTE, /登入後/)
  assert.match(RELOGIN_BAR_TEXT, /收發信照常/)
  assert.ok([...RELOGIN_BAR_TEXT].length <= 20, '提醒條只有一行，名單視窗很窄，字不能太長')
  assert.match(RELOGIN_BAR_HINT, /切換帳號暫停/)
  assert.doesNotMatch(RELOGIN_BAR_HINT, /回報/)
  assert.match(LOGOUT_NOTE, /繼續收發信、回報帳號/)
  assert.match(LOGOUT_NOTE, /繼續收發信/)
  // 照實說：關閉只是暫停，下次開啟會恢復；不說「結束」「不再」這種絕對的話
  for (const s of [LOGOUT_STOP_LABEL, LOGOUT_STOP_NOTE, LOGOUT_STOP_DONE_TEXT]) assert.doesNotMatch(s, /不再收發|永久|結束 ASN/, s)
  assert.match(LOGOUT_STOP_NOTE, /下次開啟 ASN 才會恢復/)
  assert.match(LOGOUT_STOP_DONE_TEXT, /下次開啟 ASN 會恢復/)
  assert.match(LOGOUT_STOP_AUTOSTART_NOTE, /開機自動啟動/)
})

test('提醒條：這台有金鑰、沒登入、還沒按「知道了」才出現；取不到狀態不吵人', () => {
  assert.equal(showReloginBar(true, false, false), true)
  assert.equal(showReloginBar(true, false, true), false, '按了「知道了」就先不顯示')
  assert.equal(showReloginBar(true, true, false), false, '已登入')
  assert.equal(showReloginBar(true, null, false), false, '取不到狀態不顯示')
  assert.equal(showReloginBar(false, false, false), false, '新電腦直接走登入畫面，不用提醒條')
  assert.equal(showReloginBar(undefined, false, false), false)
})

test('接線守門：登入畫面只在這台有金鑰時講收發信照常；提醒條與按鈕接上；登出預設不停收發', () => {
  const html = read('ui/login.html'), js = read('ui/login.js')
  assert.match(html, /v-if="canSkip"[^>]*>\{\{ STILL_RUNNING_NOTE \}\}/, '新電腦（沒金鑰）不能說「還在收發信」')
  assert.match(js, /STILL_RUNNING_NOTE/)
  const list = read('ui/list.html'), lj = read('ui/list.js')
  assert.match(list, /class="upd-bar relogin-bar" v-if="reloginBar\.show"/)
  assert.match(list, /:title="RELOGIN_BAR_HINT"/)
  assert.match(list, /@click\.stop="goLogin"/)
  assert.match(list, /@click\.stop="dismissReloginBar"/)
  assert.match(lj, /showReloginBar\(info\.can_skip_login === true/)
  assert.match(lj, /setInterval\(\(\) => void refreshReloginBar\(\), 60_000\)/)
  assert.match(lj, /if \(st\?\.signed_in === true\) reloginDismissed = false/, '登入後又掉才會再提醒')
  const panel = read('ui/lib/login-panel.mjs')
  assert.match(panel, /@click="logout\(false\)"[^>]*>\{\{ LOGOUT_ONLY_LABEL \}\}/, '預設的「只登出」不停收發')
  assert.match(panel, /@click="logout\(true\)"[^>]*>\{\{ LOGOUT_STOP_LABEL \}\}/)
  assert.match(panel, /await authApi\.logout\(stop === true\)/)
  assert.match(panel, /<template v-if="autostartOn"> \{\{ LOGOUT_STOP_AUTOSTART_NOTE \}\}/, '有設開機自動啟動要提')
  assert.match(panel, /invoke\('autostart_get'\)/)
  assert.match(panel, /@click="ask"/, '按「登出」先說明，不直接登出')
  assert.match(read('ui/lib/tauri.mjs'), /logout: \(stop = false\) => \{ shownPhotos\.clear\(\); return invoke\('auth_logout', \{ stop: stop === true \}\) \}/)
  const rs = read('src-tauri/src/account.rs')
  assert.match(rs, /handle: AppHandle, stop: Option<bool>\) -> Result<\(\), String> \{/)
  assert.match(rs, /if stop == Some\(true\) \{\s*stop_soon\(&app, handle\);\s*\} else \{\s*restart_soon\(&app, handle\);/, '沒選就照舊重新啟動、收發信照常')
})
