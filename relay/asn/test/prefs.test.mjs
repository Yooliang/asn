// 視窗外框、音效、點自己的大頭貼換照片的純邏輯，以及對應的版面守門（整合分頁無縫、全部視窗都有外框切換）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { FRAMES, FRAME_LABEL, SOUND_CHOICES, SOUND_LABEL, isNativeFrame, normalizeFrame, soundChoice, soundFromChoice, soundFromSaved } from '../ui/lib/prefs.mjs'
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

test('音效：舊存檔的布林照舊讀，下拉選單只有開／關', () => {
  assert.deepEqual(SOUND_CHOICES, ['on', 'off'])
  assert.deepEqual(SOUND_CHOICES.map(c => SOUND_LABEL[c]), ['開', '關'])
  assert.equal(soundFromSaved(undefined), true)   // 舊存檔沒這欄＝開
  assert.equal(soundFromSaved(true), true)
  assert.equal(soundFromSaved(false), false)
  assert.equal(soundChoice(true), 'on')
  assert.equal(soundChoice(false), 'off')
  assert.equal(soundFromChoice('off'), false)
  assert.equal(soundFromChoice('on'), true)
  for (const on of [true, false]) assert.equal(soundFromChoice(soundChoice(on)), on)
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
  const html = read('ui/list.html'), js = read('ui/list.js')
  assert.match(html, /class="dp me-dp"[^>]*@click="avMenu = false; avFile\.click\(\)"/)   // 名單最上面自己的大頭貼
  assert.match(html, /點一下換大頭貼/)
  assert.match(html, /@contextmenu\.prevent/)   // 右鍵小選單
  assert.equal(html.match(/ref="avFile"/g).length, 1, '只有一個檔案輸入')
  assert.match(html, /選擇圖片…/)   // 設定頁的大頭貼區保留
  assert.match(js, /uploadAvatarFile\(file, avApi\)/)
  assert.match(js, /removeAvatarUpload\(avApi\)/)
})

test('守門：設定頁的音效與視窗外框都是下拉，不再是按鈕', () => {
  const html = read('ui/list.html')
  assert.match(html, /aria-label="音效"/)
  assert.match(html, /aria-label="視窗外框"/)
  assert.doesNotMatch(html, /音效：/)
  assert.doesNotMatch(html, /soundOn = !soundOn/)
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
