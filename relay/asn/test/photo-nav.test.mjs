// 看大圖左右切換（#1728）：照片串的攤平與排序、上一張下一張與到頭、同對話限定、放大時不切換、鍵盤與接線守門
// 執行：node --test relay/asn/test/photo-nav.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NEXT, PREV, SWIPE_MIN_PX, keyDir, locate, navState, photoSeq, stepIndex, swipeDir } from '../ui/lib/photo-nav.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = rel => fs.readFileSync(path.join(here, '..', rel), 'utf8')
const img = (n, extra = {}) => ({ id: `p${n}`, kind: 'image', name: `${n}.webp`, expires_at: '2099-01-01T00:00:00Z', expired: false, ...extra })
const msg = (t, who, photos) => ({ t, who, photos })
const NOW = Date.parse('2026-11-18T00:00:00Z')
const ids = seq => seq.map(e => e.id)

test('照片串：跨信件攤平、依時間排序（log 順序亂也一樣）、同時間維持原先後', () => {
  const log = [msg(300, 'B', [img(4)]), msg(100, 'A', [img(1), img(2)]), msg(100, 'A', [img(3)]), msg(200, 'B', [])]
  assert.deepEqual(ids(photoSeq(log, { now: NOW })), ['p1', 'p2', 'p3', 'p4'])
  const seq = photoSeq(log, { who: m => `〔${m.who}〕`, now: NOW })
  assert.equal(seq[3].who, '〔B〕')
  assert.equal(seq[0].t, 100)
})

test('照片串：只收圖片；一般檔案、已過期的、沒有附件的訊息都不算', () => {
  const log = [
    msg(1, 'A', [img(1), img(2, { kind: 'file' }), img(3, { expired: true }), img(4, { expires_at: '2020-01-01T00:00:00Z' })]),
    { t: 2, who: 'A' }, null, msg(3, 'A', 'oops'), msg(4, 'A', [img(5)]),
  ]
  assert.deepEqual(ids(photoSeq(log, { now: NOW })), ['p1', 'p5'])
  assert.deepEqual(photoSeq(undefined), [])
})

test('同對話限定：照片串只看傳進來的那一份 log，別的對話的照片不會出現', () => {
  const chatA = [msg(1, 'A', [img(1)]), msg(3, 'A', [img(3)])]
  const chatB = [msg(2, 'B', [img(2)])]
  assert.deepEqual(ids(photoSeq(chatA, { now: NOW })), ['p1', 'p3'])
  assert.deepEqual(ids(photoSeq(chatB, { now: NOW })), ['p2'])
  assert.equal(locate(photoSeq(chatA, { now: NOW }), 'p2'), -1)
  // 接線：看大圖的串只由這個畫面的 log 算，沒有第二個來源
  assert.match(read('ui/lib/chatpane.mjs'), /photoSeq\(props\.log/)
})

test('上一張、下一張、到頭到尾停住不繞回', () => {
  assert.equal(stepIndex(2, NEXT, 5), 3)
  assert.equal(stepIndex(2, PREV, 5), 1)
  assert.equal(stepIndex(0, PREV, 5), 0)
  assert.equal(stepIndex(4, NEXT, 5), 4)
  assert.equal(stepIndex(0, NEXT, 1), 0)
  assert.equal(stepIndex(0, NEXT, 0), -1)
  assert.equal(stepIndex(-1, NEXT, 3), -1)
})

test('第 N／M 張與前後還有沒有（端點箭頭靠這個停用或隱藏）', () => {
  assert.deepEqual(navState(0, 5), { n: 1, total: 5, hasPrev: false, hasNext: true })
  assert.deepEqual(navState(2, 5), { n: 3, total: 5, hasPrev: true, hasNext: true })
  assert.deepEqual(navState(4, 5), { n: 5, total: 5, hasPrev: true, hasNext: false })
  assert.deepEqual(navState(0, 1), { n: 1, total: 1, hasPrev: false, hasNext: false })
})

test('手機滑動：左滑＝下一張（較新）、右滑＝上一張（較舊）', () => {
  assert.equal(swipeDir(-120, 5, 1), NEXT)
  assert.equal(swipeDir(120, -5, 1), PREV)
})

test('手機滑動：位移不夠、斜著滑、放大中都不切換', () => {
  assert.equal(swipeDir(-SWIPE_MIN_PX, 0, 1), 0)
  assert.equal(swipeDir(-30, 0, 1), 0)
  assert.equal(swipeDir(-100, 100, 1), 0)
  assert.equal(swipeDir(-100, 140, 1), 0)
  assert.equal(swipeDir(-200, 0, 2), 0)
  assert.equal(swipeDir(200, 0, 1.5), 0)
  assert.equal(swipeDir(-200, 0, 1.005), NEXT)   // 幾乎沒放大算沒放大
})

test('鍵盤：← 上一張、→ 下一張；輸入框裡、有組合鍵、別的按鍵都不攔', () => {
  const k = (key, extra = {}) => ({ key, target: { tagName: 'DIV' }, ...extra })
  assert.equal(keyDir(k('ArrowLeft')), PREV)
  assert.equal(keyDir(k('ArrowRight')), NEXT)
  assert.equal(keyDir(k('ArrowUp')), 0)
  assert.equal(keyDir(k('a')), 0)
  assert.equal(keyDir(k('ArrowLeft', { target: { tagName: 'TEXTAREA' } })), 0)
  assert.equal(keyDir(k('ArrowRight', { target: { tagName: 'input' } })), 0)
  assert.equal(keyDir(k('ArrowRight', { target: { tagName: 'DIV', isContentEditable: true } })), 0)
  assert.equal(keyDir(k('ArrowRight', { altKey: true })), 0)
  assert.equal(keyDir(k('ArrowRight', { ctrlKey: true })), 0)
  assert.equal(keyDir(null), 0)
})

test('接線守門：切換用到純函式；方向鍵只在大圖開著時攔；關閉的圖示鈕有名字', () => {
  const pane = read('ui/lib/chatpane.mjs')
  assert.match(pane, /from '\.\/photo-nav\.mjs'/)
  assert.match(pane, /if \(viewer\.value\) \{\s*const dir = keyDir\(e\)/)
  assert.match(pane, /swipeDir\(/)
  assert.match(pane, /class="aero-btn pv-btn pv-close"[\s\S]{0,120}aria-label="關閉"/)
  assert.match(pane, /class="pv-nav pv-prev"[\s\S]{0,160}stepViewer\(-1\)" aria-label="上一張"/)
  assert.match(pane, /class="pv-nav pv-next"[\s\S]{0,160}stepViewer\(1\)" aria-label="下一張"/)
})
