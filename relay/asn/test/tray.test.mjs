// 關閉視窗時縮到系統匣／結束程式、系統匣未讀數、登入自動啟動：前端純邏輯，以及設定頁與 Rust 端的接線守門。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CLOSE_CHOICES, CLOSE_LABEL, normalizeClose, totalUnread } from '../ui/lib/prefs.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

test('關閉視窗時：預設縮到系統匣；沒這欄位的舊存檔與壞值都縮到系統匣，只有 quit 才結束', () => {
  assert.deepEqual(CLOSE_CHOICES, ['tray', 'quit'])
  assert.ok(CLOSE_CHOICES.every(c => CLOSE_LABEL[c]))
  assert.equal(normalizeClose(JSON.parse('{"sound":true}').closeTo), 'tray')
  for (const v of [null, '', 'Quit', true, 1, 'exit']) assert.equal(normalizeClose(v), 'tray', String(v))
  assert.equal(normalizeClose('quit'), 'quit')
  assert.equal(normalizeClose('tray'), 'tray')
})

test('系統匣未讀數：只加正整數', () => {
  assert.equal(totalUnread([]), 0)
  assert.equal(totalUnread(undefined), 0)
  assert.equal(totalUnread([{ unread: 2 }, { unread: 0 }, { unread: 3 }, {}]), 5)
  assert.equal(totalUnread([{ unread: -1 }, { unread: 1.5 }, { unread: '4' }, null]), 0)
})

test('接線：設定頁有兩個控制項，存檔欄位 closeTo，Rust 端註冊了對應指令', () => {
  const js = read('ui/list.js'), html = read('ui/list.html'), lib = read('src-tauri/src/lib.rs'), tray = read('src-tauri/src/tray.rs')
  assert.match(html, /關閉視窗時/)
  assert.match(html, /登入時自動啟動 ASN/)
  assert.match(html, /v-if="autostart\.supported"/, '不支援的系統隱藏自動啟動開關')
  assert.match(js, /closeTo: closeTo\.value/, '關閉行為存進 asn-me.json')
  for (const cmd of ['set_close_to_tray', 'set_tray_unread', 'autostart_get', 'autostart_set', 'autostart_supported', 'tray_available']) {
    assert.ok(js.includes(`'${cmd}'`), `前端呼叫 ${cmd}`)
    assert.ok(lib.includes(`tray::${cmd}`), `Rust 註冊 ${cmd}`)
    assert.ok(tray.includes(`pub fn ${cmd}`), `Rust 實作 ${cmd}`)
  }
  assert.match(lib, /prevent_close\(\)/, '縮到系統匣時攔下關閉')
})
