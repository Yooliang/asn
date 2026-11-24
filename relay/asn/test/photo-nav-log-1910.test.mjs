// #1910：看圖切換與抓圖結果寫進 ui.log（[ASN] 開頭的 console.info 會進 ui.log）。
// 只記入口、方向、第幾張、成功失敗、毫秒、失敗類別；不准帶檔名、照片編號或內容。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fetchErrClass, fetchLogLine, stepLogLine } from '../ui/lib/photo-nav.mjs'

test('切換那一行：入口、方向、第幾張到第幾張，[ASN] 開頭才會進 ui.log', () => {
  assert.equal(stepLogLine('箭頭', 1, 0, 1, 3), '[ASN] 看圖切換 箭頭 下一張：第 1 → 2 張／共 3 張')
  assert.equal(stepLogLine('鍵盤', -1, 2, 1, 3), '[ASN] 看圖切換 鍵盤 上一張：第 3 → 2 張／共 3 張')
  assert.equal(stepLogLine('箭頭', 1, 2, 2, 3), '[ASN] 看圖切換 箭頭 下一張：停在第 3 張（已到頭或到尾）／共 3 張')
  assert.equal(stepLogLine('滑動', -1, 0, -1, 3), '[ASN] 看圖切換 滑動 上一張：停在第 1 張（已到頭或到尾）／共 3 張')
})

test('抓圖那一行：成功、失敗、毫秒取整，失敗類別只收固定代號', () => {
  assert.equal(fetchLogLine(true, 812.6), '[ASN] 看圖抓圖 成功 813ms')
  const coded = Object.assign(new Error('照片已經過期'), { code: 'attach:expired' })
  assert.equal(fetchLogLine(false, 40, coded), '[ASN] 看圖抓圖 失敗 40ms 類別=attach:expired')
  assert.equal(fetchLogLine(false, 40, new Error('C:\\Users\\x\\秘密.png 讀不到')), '[ASN] 看圖抓圖 失敗 40ms 類別=other', '沒有代號的錯誤不能把訊息原文（可能含檔名）寫進去')
  assert.equal(fetchErrClass({ code: '../../etc 很長很長' }), 'other', '代號格式不對也一律 other')
  assert.equal(fetchErrClass(null), 'ok')
  assert.equal(fetchLogLine(false, -5, null), '[ASN] 看圖抓圖 失敗 0ms 類別=ok')
})

test('chatpane：三個入口都帶自己的名字呼叫 stepViewer，抓圖成功與失敗都寫一行', () => {
  const src = fs.readFileSync(new URL('../ui/lib/chatpane.mjs', import.meta.url), 'utf8')
  assert.match(src, /console\.info\(stepLogLine\(via, dir, i, j, seq\.length\)\)/, 'stepViewer 要先記切換結果（包含到頭沒切的情況）')
  assert.match(src, /stepViewer\(dir, '鍵盤'\)/)
  assert.match(src, /stepViewer\(dir, '滑動'\)/)
  assert.match(src, /async function stepViewer\(dir, via = '箭頭'\)/, '箭頭按鈕走預設值')
  assert.match(src, /console\.info\(fetchLogLine\(true, Date\.now\(\) - t0\)\)/)
  assert.match(src, /console\.info\(fetchLogLine\(false, Date\.now\(\) - t0, e\)\)/)
  assert.doesNotMatch(src, /fetchLogLine\([^)]*\bp\.(id|name)\b/, '不准把照片編號或檔名寫進 log')
})
