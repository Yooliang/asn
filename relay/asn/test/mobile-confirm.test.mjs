import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { confirmViewer, NO_LOCK_TEXT } from '../ui/lib/mobile-confirm.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// 假外殼：被叫到時用 reply 的結果回呼網頁
const fakeWin = reply => {
  const win = {}
  win.AsnAndroid = { confirmViewer: id => { if (reply instanceof Error) throw reply; if (reply !== null) queueMicrotask(() => win.__asnConfirmViewer(id, reply)) } }
  return win
}

test('通過、取消、沒設螢幕鎖：原樣回傳', async () => {
  assert.equal(await confirmViewer(fakeWin('ok')), 'ok')
  assert.equal(await confirmViewer(fakeWin('cancel')), 'cancel')
  assert.equal(await confirmViewer(fakeWin('no_lock')), 'no_lock')
})

test('外殼不存在、沒有這個方法、丟例外、逾時、亂回：一律 cancel，絕不是 ok', async () => {
  assert.equal(await confirmViewer({}), 'cancel')
  assert.equal(await confirmViewer({ AsnAndroid: {} }), 'cancel')
  assert.equal(await confirmViewer(fakeWin(new Error('壞了'))), 'cancel')
  assert.equal(await confirmViewer(fakeWin('OK'), 50), 'cancel', '大小寫不對不算')
  assert.equal(await confirmViewer(fakeWin('yes')), 'cancel')
  assert.equal(await confirmViewer(fakeWin(null), 20), 'cancel')
})

test('每次都真的問一次，不記住上一次的 ok；別人的回呼不會被當成自己的', async () => {
  const win = fakeWin('ok')
  let asked = 0
  const inner = win.AsnAndroid.confirmViewer
  win.AsnAndroid.confirmViewer = id => { asked++; inner(id) }
  await confirmViewer(win); await confirmViewer(win)
  assert.equal(asked, 2)
  const w2 = {}
  w2.AsnAndroid = { confirmViewer: () => { w2.__asnConfirmViewer('別人的編號', 'ok') } }
  assert.equal(await confirmViewer(w2, 20), 'cancel')
})

test('文案與原始碼守門', () => {
  assert.equal(NO_LOCK_TEXT, '這支手機沒有設定螢幕鎖，請先設定再查看終端')
  const src = fs.readFileSync(path.join(root, 'ui', 'lib', 'mobile-confirm.mjs'), 'utf8')
  const noBridge = src.split('if (!bridge')[1].split('\n')[0]
  assert.match(noBridge, /return 'cancel'/, '橋不存在要回 cancel')
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /resolve\('ok'\)|return 'ok'/, '只有外殼回的 ok 才算')
})
