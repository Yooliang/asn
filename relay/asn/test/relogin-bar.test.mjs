// 登入失效要看得見（#1764）：共用提醒條的觸發條件、電腦與手機引用同一份元件、群組讀不到的說明、正常狀態什麼都不多出來
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { AUTH_LOST_EVENT, ROOMS_NEED_LOGIN_TEXT, ReloginBar, createReloginWatch, looksLikeLoginLost, reloginBarText, roomsLoginLost, roomsNoteText } from '../ui/lib/relogin-bar.mjs'
import { createEventHub } from '../ui/lib/event-hub.mjs'
import { RELOGIN_BAR_TEXT } from '../ui/lib/login.mjs'
import { createRoomHub } from '../ui/lib/room-hub.mjs'
import { ROOM_LOAD_FAIL_TEXT } from '../ui/lib/mobile-rooms.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const mk = ({ signedIn = true, hasNode = true } = {}) => {
  const cur = { signedIn }, listeners = {}
  const hub = createEventHub({ listen: async (e, fn) => { (listeners[e] ||= []).push(fn); return () => { listeners[e] = (listeners[e] || []).filter(f => f !== fn) } } })
  const w = createReloginWatch({ status: async () => ({ signed_in: cur.signedIn }), hub, canSkipLogin: () => hasNode })
  return { w, cur, hub, listeners, fire: e => (listeners[e] || []).forEach(f => f()) }
}

test('正常狀態：已登入時提醒條不出現，群組說明是空的', async () => {
  const { w } = mk()
  await w.start()
  assert.equal(w.st.show, false)
  assert.equal(roomsNoteText({ err: false, signed: true }), '')
  assert.equal(roomsNoteText({}), '', '舊版 Rust 沒有 signed 欄位也不多出東西')
})

test('觸發一：登入掉了，查狀態就出現；按知道了先不再提，登入後又掉才再出現', async () => {
  const { w, cur } = mk({ signedIn: false })
  assert.equal(await w.refresh(), true)
  w.dismiss()
  assert.equal(await w.refresh(), false, '按過知道了就不再提')
  cur.signedIn = true; await w.refresh()
  cur.signedIn = false
  assert.equal(await w.refresh(), true, '登入後又掉要再提醒')
})

test('觸發二：收到清掉登入的事件就立刻出現（按過知道了也再提醒）', async () => {
  const { w, cur, fire } = mk({ signedIn: true })
  await w.start()
  cur.signedIn = false
  w.dismiss()
  fire(AUTH_LOST_EVENT)
  await new Promise(r => setTimeout(r, 5))
  assert.equal(w.st.show, true)
  assert.equal(AUTH_LOST_EVENT, 'auth-signed-out')
  assert.match(read('src-tauri/src/auth_notice.rs'), /pub const AUTH_LOST_EVENT: &str = "auth-signed-out"/, '前後端事件名要一樣')
})

test('觸發三：群組列表回報登入已失效、或後台回 401 就立刻出現；暫時連不上不算', async () => {
  const a = mk({ signedIn: true })
  assert.equal(await a.w.noteRooms({ rooms: [], signed: false, reason: 'login_expired' }), true)
  const b = mk({ signedIn: true })
  assert.equal(await b.w.noteRooms({ rooms: [], signed: false, reason: 'refresh_failed' }), false, '暫時失敗不叫人重新登入')
  assert.equal(await b.w.noteRooms({ rooms: [] }), false)
  const c = mk({ signedIn: true })
  assert.equal(await c.w.noteError(new Error('後台回 401')), true)
  assert.equal(await mk({ signedIn: true }).w.noteError(new Error('連線逾時')), false)
  assert.equal(roomsLoginLost({ signed: false, reason: 'not_signed_in' }), true)
  assert.equal(looksLikeLoginLost('HTTP 401'), true)
})

test('登入有問題但登入檔還在：例行檢查不能收起提示，成功換到憑證才解除（不閃）', async () => {
  const { w } = mk({ signedIn: true })   // 狀態一直說已登入（連續不確定的錯誤，不清登入檔）
  await w.start()
  assert.equal(w.st.show, false)
  await w.noteRooms({ rooms: [], signed: false, reason: 'login_expired' })
  assert.equal(w.st.show, true)
  for (let i = 0; i < 3; i++) assert.equal(await w.refresh(), true, '每分鐘的例行檢查不能把提示收起來')
  w.dismiss()
  assert.equal(await w.refresh(), false, '按了知道了就先不再提')
  assert.equal(await w.refresh(), false, '例行檢查也不能把按過的又叫出來')
  await w.noteRooms({ rooms: [], signed: true })   // 成功換到憑證
  assert.equal(await w.refresh(), false)
  await w.noteRooms({ rooms: [], signed: false, reason: 'login_expired' })
  assert.equal(w.st.show, true, '之後再出問題要能再提醒')
})

test('回到前景要再查一次（手機不能只在開 App 時查）', async () => {
  const { w, cur } = mk({ signedIn: true })
  await w.start()
  assert.equal(w.st.show, false)
  cur.signedIn = false
  assert.equal(await w.onForeground(), true)
})

test('沒有節點金鑰（新電腦）或查不到狀態：不顯示', async () => {
  assert.equal(await mk({ signedIn: false, hasNode: false }).w.refresh(), false)
  const w = createReloginWatch({ status: async () => { throw new Error('x') }, hub: createEventHub({ listen: async () => () => {} }), canSkipLogin: () => true })
  assert.equal(await w.refresh(), false)
})

test('文字：電腦與手機同一份，只差「這台電腦／這支手機」', () => {
  assert.equal(reloginBarText('desk'), RELOGIN_BAR_TEXT)
  assert.equal(reloginBarText('phone'), RELOGIN_BAR_TEXT.replace('這台電腦', '這支手機'))
  assert.match(ROOMS_NEED_LOGIN_TEXT, /重新登入/)
  assert.equal(roomsNoteText({ err: true, signed: true }), ROOM_LOAD_FAIL_TEXT)
  assert.equal(roomsNoteText({ err: false, signed: false }), ROOMS_NEED_LOGIN_TEXT)
  assert.doesNotMatch(ROOMS_NEED_LOGIN_TEXT, /[A-Za-z]{3,}|signed|token/i)
})

test('守門：電腦與手機都引用同一份元件，沒有各寫一份', () => {
  const dh = read('ui/list.html'), mh = read('ui/m.html'), dj = read('ui/list.js'), mj = read('ui/m.js')
  assert.match(dh, /<relogin-bar variant="desk"/)
  assert.match(mh, /<relogin-bar variant="phone"/)
  for (const j of [dj, mj]) {
    assert.match(j, /import \{[^}]*ReloginBar[^}]*\} from '\.\/lib\/relogin-bar\.mjs'/)
    assert.match(j, /app\.component\('relogin-bar', ReloginBar\)/)
    assert.match(j, /createReloginWatch\(/)
  }
  assert.doesNotMatch(dh + mh, /RELOGIN_BAR_TEXT|RELOGIN_BAR_ACTION/, '文字只在共用元件裡')
  assert.doesNotMatch(dj, /showReloginBar|refreshReloginBar/, '電腦版不再自己寫一份判斷')
  assert.match(mj, /tellFg = fg => \{[^\n]*reloginWatch\.onForeground\(\)/, '手機回到前景要查')
  assert.match(mh, /v-if="roomsNote"/)
  assert.match(dh, /v-if="roomsNote"/)
})

test('電腦版紅條的外觀 class 維持原樣（元件樣板）', () => {
  assert.match(ReloginBar.template, /:class="variant === 'phone' \? 'm-upd' : 'upd-bar'"/)
  assert.match(ReloginBar.template, /'aero-btn upd-btn'/)
  assert.match(ReloginBar.template, /'upd-text'/)
  assert.match(ReloginBar.template, /class="relogin-bar"/)
})

test('群組讀不到：中樞記下失敗，原位有說明；登入失效時標 signed:false 並通知提醒條', async () => {
  let failed = null, got = null
  const bad = createRoomHub({ invoke: async () => { throw new Error('relay_rooms 連線失敗') }, groupApi: {}, selfNode: 'T', windowName: 'w', onFail: e => { failed = e } })
  await bad.refresh()
  assert.equal(bad.st.err, true)
  assert.ok(failed)
  assert.equal(roomsNoteText(bad.st), ROOM_LOAD_FAIL_TEXT)
  const unsigned = createRoomHub({ invoke: async () => ({ rooms: [], signed: false, reason: 'login_expired' }), groupApi: {}, selfNode: 'T', windowName: 'w', onRooms: r => { got = r } })
  await unsigned.refresh()
  assert.equal(unsigned.st.signed, false)
  assert.equal(got.reason, 'login_expired')
  assert.equal(roomsNoteText(unsigned.st), ROOMS_NEED_LOGIN_TEXT)
  const ok = createRoomHub({ invoke: async () => ({ rooms: [], signed: true }), groupApi: {}, selfNode: 'T', windowName: 'w' })
  await ok.refresh()
  assert.equal(roomsNoteText(ok.st), '', '正常時不多出任何說明')
})

test('名單讀不到的說明本來就在原位（電腦與手機）', () => {
  assert.match(read('ui/list.js'), /conn\.value === 'off' \? ROSTER_LOAD_FAIL_TEXT : conn\.value !== 'on' \? ROSTER_CONNECTING_TEXT/)
  assert.match(read('ui/m.js'), /conn\.value === 'off' \? ROSTER_LOAD_FAIL_TEXT/)
})

test('Rust 守門：手機也設清掉登入的記錄與事件；群組列表回 signed；簽章失敗有原因', () => {
  const lib = read('src-tauri/src/lib.rs'), acct = read('src-tauri/src/account.rs')
  const i = lib.indexOf('auth_state.on_signout')
  assert.ok(i > 0)
  const before = lib.slice(Math.max(0, i - 700), i)
  assert.doesNotMatch(before.slice(before.lastIndexOf('let mut auth_state')), /#\[cfg\(desktop\)\]\s*\{\s*auth_state/, 'on_signout 不能只在桌面設')
  assert.match(lib, /auth_notice::file_signout_logger/, '手機的記錄器')
  assert.match(lib, /h\.emit\(auth_notice::AUTH_LOST_EVENT/)
  assert.match(lib, /auth_notice::mark_signed\(v, why\)/)
  assert.match(acct, /pub async fn signing_token_checked/)
  assert.doesNotMatch(acct.slice(acct.indexOf('pub async fn signing_token('), acct.indexOf('// ---------- 指令')), /_ => None/, '不再把所有失敗吞成 None')
})
