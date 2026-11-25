// 這台指紋的 QR Code：資料驗證、畫圖計畫、畫到 canvas（用假的 2d 內容）、只用 canvas 不用 v-html。
// #1863 起只在「手機要核對時自動跳出的視窗」（panel.js 的 fpshow）顯示，設定頁的「QR Code」分頁拿掉了
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

test('文字：繁體中文，產品名寫 QR Code', () => {
  assert.deepEqual(Object.keys(QR_TEXT).sort(), ['alt', 'failed'], '設定頁的顯示／收起／說明字已經不用')
  assert.equal(QR_TEXT.alt, '這台電腦的指紋 QR Code')
  for (const t of Object.values(QR_TEXT)) assert.doesNotMatch(t.replace(/QR Code/g, ''), /[A-Za-z]{3,}/, t)
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
  assert.equal(drawPlan({ size: 21, rows: rows21() }, 6).side, (21 + QUIET * 2) * 6, '跳出的視窗畫大一點')
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

test('守門（#1863）：設定頁不再有 QR Code 分頁，樞紐也沒有 known-qr', () => {
  assert.ok(!SETTING_OPS.includes('known-qr'), '設定操作清單不再有 known-qr')
  const panel = read('../ui/lib/settings-panel.mjs')
  assert.doesNotMatch(panel, /setView\('qr'\)|view === 'qr'|known-qr|fp-qr-canvas|FpQrCanvas|QR_TEXT/, '設定頁不再有 QR Code 分頁與畫布')
  assert.doesNotMatch(panel, />QR Code</, '設備頁上方那排沒有「QR Code」鈕')
  const list = read('../ui/list.js')
  assert.doesNotMatch(list, /toggleOwnQr|known-qr|known\.qr|ownFingerprintQr/, '名單視窗不再產生 QR')
})

test('跳出的視窗：只用 canvas（沒有 v-html）、QR 向本機要、Rust 命令內容是這台的節點與完整指紋', () => {
  const html = read('../ui/panel.html')
  const sec = html.slice(html.indexOf('<section class="fps"'), html.indexOf('</section>', html.indexOf('<section class="fps"')))
  assert.ok(sec.length > 0, '找得到 fpshow 區塊（找不到時 slice 是空字串，測試會變成永遠綠）')
  assert.match(sec, /<fp-qr-canvas v-if="fps\.qr" :qr="fps\.qr"/)
  assert.doesNotMatch(sec + read('../ui/lib/fp-qr.mjs').replace(/^\s*\/\/.*$/gm, ''), /v-html|innerHTML|toDataURL|insertAdjacentHTML/)
  assert.match(read('../ui/lib/fp-qr.mjs'), /<canvas /)
  assert.match(read('../ui/panel.js'), /knownDeviceApi\.ownFingerprintQr\(\)/)
  const lib = read('../src-tauri/src/lib.rs')
  const own = lib.slice(lib.indexOf('async fn device_own_fingerprint_qr('), lib.indexOf('async fn device_own_fingerprint_qr(') + 500).split('\n}\n')[0]
  assert.match(own, /fp_scan::qr_rows\(&app\.node, &device_id::fingerprint\(&k\.public_b64\(\)\)\)/, '內容是這台的節點與完整指紋')
})
