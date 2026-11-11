// 電腦版設定頁的指紋 QR code：資料驗證、畫圖計畫、畫到 canvas（用假的 2d 內容）、只用 canvas 不用 v-html
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { QR_TEXT, QUIET, MODULE_PX, drawPlan, normalizeQr, paint } from '../ui/lib/fp-qr.mjs'
import { SETTING_OPS } from '../ui/lib/settings-panel.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// 21x21 的假格子：左上、右上、左下各一個 7x7 定位方塊的外框，其餘淺色
function rows21() {
  const g = Array.from({ length: 21 }, () => Array(21).fill('0'))
  for (const [ox, oy] of [[0, 0], [14, 0], [0, 14]]) for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) if (i === 0 || j === 0 || i === 6 || j === 6) g[oy + i][ox + j] = '1'
  return g.map(r => r.join(''))
}

test('文字：照規格、繁體中文', () => {
  assert.equal(QR_TEXT.show, '顯示 QR code')
  assert.equal(QR_TEXT.note, '用手機的「確認指紋 → 掃 QR code」掃這個')
  for (const t of Object.values(QR_TEXT)) assert.doesNotMatch(t.replace(/QR code/g, ''), /[A-Za-z]{3,}/, t)
  assert.equal(MODULE_PX, 4)
  assert.ok(QUIET >= 4, '留白至少 4 格')
})

test('normalizeQr：邊長要是 21＋4n、列數與字元都要對；壞的一律 null', () => {
  const ok = { size: 21, rows: rows21() }
  assert.deepEqual(normalizeQr(ok), ok)
  assert.equal(normalizeQr(null), null)
  assert.equal(normalizeQr({ size: 22, rows: rows21() }), null)
  assert.equal(normalizeQr({ size: 21, rows: rows21().slice(1) }), null)
  assert.equal(normalizeQr({ size: 21, rows: rows21().map((r, i) => (i === 3 ? r.slice(1) : r)) }), null)
  assert.equal(normalizeQr({ size: 21, rows: rows21().map((r, i) => (i === 3 ? 'x'.repeat(21) : r)) }), null)
  assert.equal(normalizeQr({ size: 181, rows: [] }), null)
  assert.equal(normalizeQr({ size: '21', rows: rows21() }), null)
})

test('畫圖計畫：四周留白、每格 4 像素；深色格的座標對；壞資料不畫', () => {
  const p = drawPlan({ size: 21, rows: rows21() })
  assert.equal(p.side, (21 + QUIET * 2) * MODULE_PX)
  const g = rows21()
  assert.equal(p.dark.length, g.join('').split('1').length - 1)
  assert.deepEqual(p.dark[0], [QUIET * MODULE_PX, QUIET * MODULE_PX], '左上角第一格緊貼留白')
  assert.ok(p.dark.every(([x, y]) => x >= QUIET * MODULE_PX && y >= QUIET * MODULE_PX && x < p.side - QUIET * MODULE_PX && y < p.side - QUIET * MODULE_PX), '深色格都在留白裡面')
  assert.equal(drawPlan({ size: 20, rows: [] }), null)
})

test('paint：先白底、再畫深色格；用的是 2d 內容的矩形，不產生圖片網址', () => {
  const ops = []
  const ctx = { set fillStyle(v) { ops.push(['style', v]) }, fillRect: (...a) => ops.push(['rect', ...a]) }
  const p = drawPlan({ size: 21, rows: rows21() })
  paint(ctx, p)
  assert.deepEqual(ops[0], ['style', '#ffffff'])
  assert.deepEqual(ops[1], ['rect', 0, 0, p.side, p.side])
  assert.deepEqual(ops[2], ['style', '#000000'])
  assert.equal(ops.length, 3 + p.dark.length)
  assert.deepEqual(ops[3], ['rect', QUIET * MODULE_PX, QUIET * MODULE_PX, MODULE_PX, MODULE_PX])
})

test('設定頁與樞紐：顯示 QR code 的按鈕在指紋旁、只用 canvas（沒有 v-html）、操作登記、Rust 命令只叫唯讀的那個', () => {
  assert.ok(SETTING_OPS.includes('known-qr'))
  const panel = read('../ui/lib/settings-panel.mjs')
  const card = panel.slice(panel.indexOf('aria-label="認得的電腦"'), panel.indexOf('aria-label="收發信功能"'))
  assert.match(card, /KNOWN\.ownFp\(st\.known\.ownFp\)[^\n]*@click="act\('known-qr', !st\.known\.qr\)">\{\{ st\.known\.qr \? QR_TEXT\.hide : QR_TEXT\.show \}\}/)
  assert.match(card, /<fp-qr-canvas :qr="st\.known\.qr"><\/fp-qr-canvas>/)
  assert.match(card, /\{\{ QR_TEXT\.note \}\}/)
  assert.doesNotMatch(card + read('../ui/lib/fp-qr.mjs').replace(/^\s*\/\/.*$/gm, ''), /v-html|innerHTML|toDataURL|insertAdjacentHTML/)
  assert.match(read('../ui/lib/fp-qr.mjs'), /<canvas /)
  const list = read('../ui/list.js')
  assert.match(list, /case 'known-qr': await toggleOwnQr\(value === true\); break/)
  assert.match(list, /invoke\('device_own_fingerprint_qr'\)/)
  assert.match(list, /ownFp: known\.ownFp, qr: known\.qr \}/)
  const lib = read('../src-tauri/src/lib.rs')
  const own = lib.slice(lib.indexOf('async fn device_own_fingerprint_qr('), lib.indexOf('async fn device_own_fingerprint_qr(') + 500).split('\n}\n')[0]
  assert.match(own, /fp_scan::qr_rows\(&app\.node, &device_id::fingerprint\(&k\.public_b64\(\)\)\)/, '內容是這台的節點與完整指紋')
})
