// 對話裡的圖片直接顯示（#1911）：狀態判斷、自動下載門檻、同時最多 2 張的排隊、方格排法、剩 N 天提示、動作列守門、大圖記憶體上限
// 執行：node --test relay/asn/test/photo-inline.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUTO_BYTES_DESK, AUTO_BYTES_PHONE, MAX_PARALLEL, MB, actionItems, actsMode, autoFetchOk, bigButtonText, createFetchQueue, daysLeft, gridCell, inlineBox, inlineState, remainText, sharePhoto, useGrid,
} from '../ui/lib/photo-inline.mjs'
import { formatBytes, recentPhotos } from '../ui/lib/photo.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = rel => fs.readFileSync(path.join(here, '..', rel), 'utf8')
const NOW = Date.parse('2026-11-25T00:00:00Z')
const FAR = '2099-01-01T00:00:00Z'
const pic = (extra = {}) => ({ id: 'p1', kind: 'image', name: 'a.webp', bytes: 200_000, width: 800, height: 600, thumb: null, expires_at: FAR, expired: false, ...extra })

test('狀態：沒縮圖、有縮圖、太大、過期、失敗、下載中、大圖已到', () => {
  const ctx = (o = {}) => ({ now: NOW, ...o })
  assert.equal(inlineState(pic({ thumb: null }), ctx()), 'wait', '沒縮圖（命令列寄的）：沒捲進畫面前先灰框等著')
  assert.equal(inlineState(pic({ thumb: 'data:image/webp;base64,AAAA' }), ctx()), 'wait', '有縮圖：先放縮圖等')
  assert.equal(inlineState(pic(), ctx({ visible: true })), 'loading', '捲進畫面要自動下載')
  assert.equal(inlineState(pic(), ctx({ job: 'queued' })), 'loading', '排隊中也顯示下載中')
  assert.equal(inlineState(pic(), ctx({ job: 'loading' })), 'loading')
  assert.equal(inlineState(pic(), ctx({ job: 'failed' })), 'failed')
  assert.equal(inlineState(pic(), ctx({ shown: true })), 'ready')
  assert.equal(inlineState(pic({ bytes: 4 * MB }), ctx({ visible: true })), 'big', '超過門檻不自動下載')
  assert.equal(inlineState(pic({ bytes: 4 * MB }), ctx({ forced: true, visible: true })), 'loading', '按了「下載照片」就下載')
  assert.equal(inlineState(pic({ expired: true }), ctx({ shown: true })), 'expired', '過期優先於一切')
  assert.equal(inlineState(pic({ expires_at: '2026-11-24T00:00:00Z' }), ctx({ job: 'failed' })), 'expired', '到期時間已過也算過期')
})

test('門檻：電腦 3 MB、手機 1.5 MB；剛好等於不算太大；大小不明照常下載', () => {
  assert.equal(AUTO_BYTES_DESK, 3 * MB)
  assert.equal(AUTO_BYTES_PHONE, 1.5 * MB)
  assert.equal(autoFetchOk(pic({ bytes: 3 * MB }), false), true)
  assert.equal(autoFetchOk(pic({ bytes: 3 * MB + 1 }), false), false)
  assert.equal(autoFetchOk(pic({ bytes: 2 * MB }), false), true, '電腦 2 MB 自動')
  assert.equal(autoFetchOk(pic({ bytes: 2 * MB }), true), false, '手機 2 MB 要人按')
  assert.equal(autoFetchOk(pic({ bytes: 1.5 * MB }), true), true)
  assert.equal(autoFetchOk(pic({ bytes: null }), true), true)
  assert.equal(inlineState(pic({ bytes: 2 * MB }), { now: NOW, phone: true, visible: true }), 'big')
  assert.equal(inlineState(pic({ bytes: 2 * MB }), { now: NOW, phone: false, visible: true }), 'loading')
  assert.equal(bigButtonText(pic({ bytes: 3.4 * MB }), formatBytes), '下載照片　3.4 MB')
  assert.equal(bigButtonText(pic({ bytes: null }), formatBytes), '下載照片')
})

test('動作列：只有大圖到了才能按；下載中反灰；失敗、太大、過期不放', () => {
  assert.equal(actsMode('ready'), 'on')
  for (const s of ['loading', 'wait', 'failed', 'big', 'expired']) assert.equal(actsMode(s), 'none', s + '：載入完成前不畫動作列')
})

test('動作列項目：電腦「儲存｜另存新檔」沒有分享；手機多「分享」', () => {
  // 同一種存法不放兩顆鈕：電腦只有另存新檔，手機儲存＋分享（#1912 做出直接存才把「儲存」加回電腦）
  assert.deepEqual(actionItems({ phone: false }).map(i => i.label), ['另存新檔'])
  assert.deepEqual(actionItems({ phone: true }).map(i => i.label), ['儲存', '分享'])
  assert.deepEqual(actionItems().map(i => i.key), ['saveas'])
})

test('框大小：電腦最大 280×320、手機 250×300，保持比例、不放大；不知道長寬用固定比例', () => {
  assert.deepEqual(inlineBox(pic({ width: 1600, height: 1000 })), { w: 280, h: 175, known: true }, '橫圖')
  assert.deepEqual(inlineBox(pic({ width: 900, height: 1200 })), { w: 240, h: 320, known: true }, '直圖受高限制')
  assert.deepEqual(inlineBox(pic({ width: 1200, height: 1200 })), { w: 280, h: 280, known: true })
  assert.deepEqual(inlineBox(pic({ width: 1600, height: 1000 }), { phone: true }), { w: 250, h: 156, known: true })
  assert.deepEqual(inlineBox(pic({ width: 900, height: 1200 }), { phone: true }), { w: 225, h: 300, known: true })
  assert.deepEqual(inlineBox(pic({ width: 100, height: 50 })), { w: 100, h: 50, known: true }, '小圖不放大')
  assert.deepEqual(inlineBox(pic({ width: null, height: null })), { w: 280, h: 210, known: false })
})

test('方格：兩張以上排兩欄，每格電腦 138、手機 123', () => {
  assert.equal(useGrid(1), false)
  assert.equal(useGrid(2), true)
  assert.equal(useGrid(4), true)
  assert.equal(gridCell({ phone: false }), 138)
  assert.equal(gridCell({ phone: true }), 123)
})

test('剩 N 天：3 天以內才提醒（不滿一天算 1 天）；過期、沒期限不提醒', () => {
  const at = ms => pic({ expires_at: new Date(NOW + ms).toISOString() })
  const D = 86400_000
  assert.equal(remainText(at(2 * D + 3600_000), NOW), '剩 3 天可下載')
  assert.equal(remainText(at(3 * D), NOW), '剩 3 天可下載')
  assert.equal(remainText(at(3 * D + 1), NOW), '', '超過 3 天不提醒')
  assert.equal(remainText(at(3600_000), NOW), '剩 1 天可下載')
  assert.equal(remainText(at(-1), NOW), '', '過期了不寫剩幾天')
  assert.equal(remainText(pic({ expires_at: null }), NOW), '')
  assert.equal(daysLeft(at(10 * D), NOW), 10)
  assert.equal(daysLeft(pic({ expires_at: null }), NOW), null)
})

test('下載排隊：同時最多 2 張、其餘照順序等、做完補上；同一張不重複；排隊中的可取消', async () => {
  const log = []
  const q = createFetchQueue({ max: 2, onChange: (id, st) => log.push(`${id}:${st}`) })
  const gates = {}
  let live = 0, peak = 0
  const job = id => () => new Promise((res, rej) => {
    live++; peak = Math.max(peak, live)
    gates[id] = { ok: () => { live--; res() }, fail: () => { live--; rej(new Error('x')) } }
  })
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(q.add(id, job(id)), true)
  assert.equal(q.add('a', job('a')), false, '正在跑的不重複加')
  assert.equal(q.add('c', job('c')), false, '排隊中的不重複加')
  await Promise.resolve(); await Promise.resolve()
  assert.equal(q.running, 2); assert.equal(q.waiting, 2)
  assert.deepEqual(Object.keys(gates), ['a', 'b'], '只有前兩張開始')
  assert.equal(q.cancel('d'), true, '還在排的可以取消')
  assert.equal(q.cancel('a'), false, '已經在跑的取消不了')
  gates.a.ok()
  await new Promise(r => setTimeout(r, 5))
  assert.deepEqual(Object.keys(gates), ['a', 'b', 'c'], 'a 做完，c 補上')
  gates.b.fail(); gates.c.ok()
  await new Promise(r => setTimeout(r, 5))
  assert.equal(q.running, 0); assert.equal(q.waiting, 0)
  assert.equal(peak, 2, '任何時候同時不超過 2 張')
  assert.equal(MAX_PARALLEL, 2, '預設同時最多 2 張')
  const dq = createFetchQueue(); let dlive = 0, dpeak = 0
  for (let i = 0; i < 6; i++) dq.add(`z${i}`, () => new Promise(r => { dlive++; dpeak = Math.max(dpeak, dlive); setTimeout(() => { dlive--; r() }, 3) }))
  await new Promise(r => setTimeout(r, 60))
  assert.equal(dpeak, 2, '不指定時也是同時最多 2 張，六張全部做完'); assert.equal(dq.running + dq.waiting, 0)
  assert.ok(log.includes('b:failed') && log.includes('a:done') && log.includes('d:idle'), log.join(' '))
})

test('大圖記憶體：一串多張不會互相擠掉；畫面上看得到的釘住不丟；總量超過上限丟最久沒看的；最新那張一定留著', () => {
  const r = recentPhotos(50, { maxChars: 100 })
  const big = n => 'x'.repeat(n)
  r.set('a', big(40)); r.set('b', big(40))
  r.pin('a')
  r.set('c', big(40))   // 120 > 100：a 最舊但釘住，丟 b
  assert.equal(r.has('a'), true); assert.equal(r.has('b'), false); assert.equal(r.has('c'), true)
  assert.equal(r.chars, 80)
  r.unpin('a'); r.set('d', big(40))
  assert.equal(r.has('a'), false, '放開後 a 才會被丟')
  const one = recentPhotos(50, { maxChars: 10 })
  one.set('huge', big(500))
  assert.equal(one.has('huge'), true, '單張超過上限也要留著（正在顯示）')
  const many = recentPhotos(80)
  for (let i = 0; i < 12; i++) many.set(`i${i}`, 'u')
  assert.equal(many.size, 12, '連續十幾張都還在（舊的只留 5 張會互相擠掉）')
  // peek 不算最近看過；有變就通知
  const s = recentPhotos(2); let n = 0
  const off = s.subscribe(() => n++)
  s.set('1', 'a'); s.set('2', 'b'); assert.equal(s.peek('1'), 'a'); s.set('3', 'c')
  assert.equal(s.has('1'), false, 'peek 沒有把 1 變成最近看的')
  s.clear(); assert.equal(n, 4); off(); s.set('x', 'y'); assert.equal(n, 4, '取消訂閱後不再通知')
})

test('分享：這支手機沒有分享功能丟白話；交給系統分享面板；人自己關掉面板不算錯', async () => {
  const fetchFull = async () => ({ data_url: 'data:image/webp;base64,AA', mime: 'image/webp' })
  const toBlob = async () => new Blob(['x'], { type: 'image/webp' })
  await assert.rejects(sharePhoto({ fetchFull, id: 'i', name: 'a.webp', nav: {} }), /不能直接分享/)
  let got = null
  await sharePhoto({ fetchFull, toBlob, id: 'i', name: 'a.webp', nav: { share: async d => { got = d }, canShare: () => true } })
  assert.equal(got.files[0].name, 'a.webp')
  await sharePhoto({ fetchFull, toBlob, id: 'i', name: 'a.webp', nav: { share: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }) } } })
  await assert.rejects(sharePhoto({ fetchFull, toBlob, id: 'i', name: 'a.webp', nav: { share: async () => {}, canShare: () => false } }), /不能直接分享/)
})

test('守門：圖片下方有動作列；過期沒有任何動作；電腦沒有「分享」；手機才傳 phone', () => {
  const pane = read('ui/lib/chatpane.mjs')
  const tpl = pane.slice(pane.indexOf('<div class="photos"'), pane.indexOf('<div class="compose-row"'))
  // 單張圖：att-photo 後面緊接 att-actions，且動作列只在狀態不是 none 時畫（過期、失敗、太大都是 none）
  assert.match(tpl, /<att-photo [^>]*><\/att-photo>\s*<att-actions v-if="photoApi && picActs\(p\) !== 'none'"/)
  assert.equal(actsMode('expired'), 'none')
  // 分享只在手機且外殼給了 share 才出現
  assert.match(pane, /const canShare = computed\(\(\) => !!\(props\.phone && props\.photoApi && typeof props\.photoApi\.share === 'function'\)\)/)
  assert.match(pane, /actionItems\(\{ phone: canShare\.value \}\)/)
  assert.match(read('ui/m.html'), /:camera="true" :phone="true"/)
  assert.doesNotMatch(read('ui/list.js') + read('ui/chat.js') + read('ui/list.html') + read('ui/chat.html'), /:phone=|photoApi[^\n]*share/, '電腦版不傳 phone、也沒有 share')
  assert.match(read('ui/m.js'), /share: \(id, name\) => sharePhoto\(/)
  // 動作列元件只發事件、反灰時不發
  const comp = read('ui/lib/att-actions.mjs')
  assert.match(comp, /!off && \$emit\('act', it\.key\)/)
  // 沒有新增 Rust 命令：下載走原本的 photoApi.fetch
  assert.match(pane, /props\.photoApi\.fetch\(p\.id, expiryMs\(p\)\)/)
})
