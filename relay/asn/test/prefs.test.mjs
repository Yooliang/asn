// 視窗外框、通知、點自己的大頭貼換照片的純邏輯，以及對應的版面守門（整合分頁無縫、全部視窗都有外框切換）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { FRAMES, FRAME_LABEL, NOTIFY_ITEMS, NOTIFY_KEYS, isNativeFrame, normalizeFrame, notifyFromSaved, notifyPlan, notifySummary, notifyWith } from '../ui/lib/prefs.mjs'
import { removeAvatarUpload, uploadAvatarFile } from '../ui/lib/avatar.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

test('視窗外框：預設自訂；沒有這個欄位的舊存檔與壞值都是自訂，只有 native 才是原生', () => {
  assert.deepEqual(FRAMES, ['custom', 'native'])
  assert.equal(normalizeFrame(undefined), 'custom')
  assert.equal(normalizeFrame(JSON.parse('{"sound":true,"winMode":"merged"}').frame), 'custom')
  for (const v of [null, '', 'Native', true, 1, 'windows']) assert.equal(normalizeFrame(v), 'custom', String(v))
  assert.equal(normalizeFrame('native'), 'native')
  assert.equal(isNativeFrame('native'), true)
  assert.equal(isNativeFrame(undefined), false)
  assert.ok(FRAMES.every(f => FRAME_LABEL[f]))
})

test('通知：四個開關，名稱與順序固定；預設全開', () => {
  assert.deepEqual(NOTIFY_ITEMS.map(i => i.label), ['右下角通知', '通知聲音', '震動聲音', '收到檔案聲音'])
  assert.deepEqual(notifyFromSaved(undefined), { toast: true, msg: true, nudge: true, file: true })
  assert.deepEqual(notifyFromSaved({}), { toast: true, msg: true, nudge: true, file: true })
})

test('通知：舊存檔的布林 sound 轉過來不遺失（關＝三個聲音關、右下角通知維持開）', () => {
  assert.deepEqual(notifyFromSaved({ sound: true }), { toast: true, msg: true, nudge: true, file: true })
  assert.deepEqual(notifyFromSaved({ sound: false }), { toast: true, msg: false, nudge: false, file: false })
  // 新欄位優先；缺的項目與壞值退回舊欄位／預設
  assert.deepEqual(notifyFromSaved({ sound: false, notify: { toast: false, msg: true } }), { toast: false, msg: true, nudge: false, file: false })
  assert.deepEqual(notifyFromSaved({ notify: { toast: 'no', msg: 1, nudge: null } }), { toast: true, msg: true, nudge: true, file: true })
  for (const bad of [null, 'x', 5, []]) assert.deepEqual(notifyFromSaved({ notify: bad }), notifyFromSaved({}))
  assert.deepEqual(notifyFromSaved(null), notifyFromSaved({}))
})

test('通知：改單一開關不動其他；認不得的鍵忽略；摘要用中文', () => {
  const all = notifyFromSaved({})
  const p = notifyWith(all, 'nudge', false)
  assert.deepEqual(p, { toast: true, msg: true, nudge: false, file: true })
  assert.deepEqual(all, notifyFromSaved({}), '不改原物件')
  assert.equal(notifyWith(all, 'bogus', false), all)
  assert.equal(notifyWith(all, 'msg', 'yes').msg, false, '非布林 true 一律當關')
  assert.equal(notifySummary(all), '右下角通知、通知聲音、震動聲音、收到檔案聲音')
  assert.equal(notifySummary(Object.fromEntries(NOTIFY_KEYS.map(k => [k, false]))), '全部關閉')
})

test('通知：每個開關各自管一件事（右下角通知／一般訊息／震動／檔案），忙碌中不出聲', () => {
  const msg = { kind: 'msg', sound: 'msg', toast: true }
  const nudge = { kind: 'nudge', sound: 'nudge', toast: true, shake: true }
  const file = { kind: 'msg', sound: 'msg', toast: true, hasFile: true }
  const login = { kind: 'login', sound: 'login', toast: true }
  const all = notifyFromSaved({})
  assert.deepEqual(notifyPlan(msg, all, 'online'), { sound: 'msg', toast: true })
  assert.deepEqual(notifyPlan(nudge, all, 'online'), { sound: 'nudge', toast: true })
  assert.deepEqual(notifyPlan(file, all, 'online'), { sound: 'file', toast: true }, '帶檔案用收到檔案的聲音')
  assert.deepEqual(notifyPlan(login, all, 'online'), { sound: 'login', toast: true })
  assert.deepEqual(notifyPlan(msg, all, 'busy'), { sound: null, toast: true })
  assert.deepEqual(notifyPlan({ kind: 'login', toast: true }, all, 'online'), { sound: null, toast: true })
  // 單獨關右下角通知：聲音照出
  const noToast = notifyWith(all, 'toast', false)
  assert.deepEqual(notifyPlan(msg, noToast, 'online'), { sound: 'msg', toast: false })
  assert.equal(notifyPlan(login, noToast, 'online').toast, false)
  // 單獨關通知聲音：震動與檔案聲音不受影響，訊息與登入提示音關
  const noMsg = notifyWith(all, 'msg', false)
  assert.equal(notifyPlan(msg, noMsg, 'online').sound, null)
  assert.equal(notifyPlan(login, noMsg, 'online').sound, null)
  assert.equal(notifyPlan(nudge, noMsg, 'online').sound, 'nudge')
  assert.equal(notifyPlan(file, noMsg, 'online').sound, 'file')
  // 單獨關震動聲音／檔案聲音
  assert.equal(notifyPlan(nudge, notifyWith(all, 'nudge', false), 'online').sound, null)
  assert.equal(notifyPlan(msg, notifyWith(all, 'nudge', false), 'online').sound, 'msg')
  assert.equal(notifyPlan(file, notifyWith(all, 'file', false), 'online').sound, null)
  assert.equal(notifyPlan(msg, notifyWith(all, 'file', false), 'online').sound, 'msg')
})

test('守門：樞紐用 notifyPlan 決定聲音與右下角通知，存檔寫 notify，不再有「音效」', () => {
  const js = read('ui/list.js')
  assert.match(js, /const plan = notifyPlan\(n, notifyPrefs\.value, me\.status\)/)
  assert.match(js, /if \(plan\.sound\) SOUNDS\[plan\.sound\]/)
  assert.match(js, /if \(plan\.toast\) void invoke\('show_toast'/)
  assert.match(js, /notify: notifyPrefs\.value, frame:/)
  assert.match(js, /notifyFromSaved\(savedMe\)/)
  assert.match(js, /\bfile: \(\) =>/, '收到檔案有自己的聲音')
  assert.doesNotMatch(js, /soundOn/)
  assert.doesNotMatch(read('ui/lib/settings-panel.mjs'), /音效/)
})

test('點自己的大頭貼：選到圖 → 縮圖 → 上傳，成功與失敗都回中文訊息', async () => {
  const calls = []
  const api = (reply = { ok: true }) => ({ toDataUrl: async f => { calls.push(['toDataUrl', f.name]); return 'data:image/png;base64,AAAA' }, setAvatar: async v => { calls.push(['setAvatar', v]); return reply } })
  const ok = await uploadAvatarFile({ name: 'me.jpg' }, api())
  assert.deepEqual(calls, [['toDataUrl', 'me.jpg'], ['setAvatar', 'data:image/png;base64,AAAA']])
  assert.deepEqual(ok, { ok: true, message: '大頭貼已更新。' })
  calls.length = 0
  const bad = await uploadAvatarFile({ name: 'x' }, api({ ok: false, error: 'avatar_too_large' }))
  assert.equal(bad.ok, false)
  assert.match(bad.message, /太大/)
  // 縮圖階段就失敗：不會上傳
  calls.length = 0
  const r = await uploadAvatarFile({ name: 'x' }, { toDataUrl: async () => { throw new Error('讀不了這個圖片檔，請換一張。') }, setAvatar: async v => { calls.push(v); return { ok: true } } })
  assert.deepEqual(r, { ok: false, message: '讀不了這個圖片檔，請換一張。' })
  assert.deepEqual(calls, [])
  // 取消選圖（沒有檔案）：什麼都不做
  assert.deepEqual(await uploadAvatarFile(undefined, api()), { ok: false, message: '' })
  assert.deepEqual(calls, [])
})

test('改回自動產生：送 null', async () => {
  const sent = []
  assert.deepEqual(await removeAvatarUpload({ setAvatar: async v => { sent.push(v); return { ok: true } } }), { ok: true, message: '已移除，改回自動產生。' })
  assert.deepEqual(sent, [null])
  assert.equal((await removeAvatarUpload({ setAvatar: async () => ({ ok: false, error: 'HTTP 401' }) })).ok, false)
})

test('守門：名單頁點大頭貼走上傳流程、設定頁兩處共用同一個檔案輸入與流程', () => {
  const html = read('ui/list.html'), js = read('ui/list.js'), panel = read('ui/lib/settings-panel.mjs')
  assert.match(html, /class="dp me-dp"[^>]*@click="avMenu = false; avFile\.click\(\)"/)   // 名單最上面自己的大頭貼
  assert.match(html, /點一下換大頭貼/)
  assert.match(html, /@contextmenu\.prevent/)   // 右鍵小選單
  assert.equal(html.match(/ref="avFile"/g).length, 1, '只有一個檔案輸入')
  assert.match(panel, /選擇圖片…/)   // 設定聊天窗的大頭貼區保留（它有自己的檔案輸入，把選到的檔案交給樞紐）
  assert.match(js, /uploadAvatarFile\(file, avApi\)/)
  assert.match(js, /removeAvatarUpload\(avApi\)/)
})

test('守門：設定頁的通知是四個勾選、視窗外框是下拉，不再是按鈕', () => {
  const html = read('ui/lib/settings-panel.mjs') + read('ui/list.html')
  assert.match(html, /act\('notify', \{ key: i\.key, on: \$event\.target\.checked \}\)/)
  assert.match(html, /aria-label="視窗外框"/)
  assert.doesNotMatch(html, /aria-label="音效"/)
})

test('守門：名單與對話視窗都有調整大小把手與外框切換；原生外框時藏起自畫的標題列', () => {
  for (const f of ['ui/list.html', 'ui/chat.html']) assert.match(read(f), /class="rz"/, f)
  assert.match(read('ui/chat.js'), /initFrame\(\)/)
  assert.match(read('ui/list.js'), /initFrame\(\)/)
  const css = read('ui/style.css')
  assert.match(css, /html\.frame-native \.titlebar,html\.frame-native \.rz\{display:none\}/)
})

test('守門：整合模式分頁列和對話區之間沒有間隙，選中的分頁蓋住對話區上緣', () => {
  const css = read('ui/style.css')
  assert.match(css, /\.chat-area\{[^}]*\}/)
  assert.doesNotMatch(css.match(/\.chat-area\{[^}]*\}/)[0], /gap/, '分頁列與對話區不能有 gap')
  assert.match(css, /\.tabbar\{[^}]*margin-bottom:-1px/)
  assert.match(css, /\.ctab\.on\{[^}]*margin-bottom:-1px[^}]*background:var\(--panel-head\)/)
})

test('守門：拖邊緣調整大小需要的權限有開', () => {
  assert.match(read('src-tauri/capabilities/default.json'), /core:window:allow-start-resize-dragging/)
  assert.match(read('ui/lib/tauri.mjs'), /startResizeDragging/)
})
