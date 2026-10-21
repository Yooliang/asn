import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { assertShotNotBlank, decodePngRgb, pngUniqueColors } from './shot-png.mjs'
import { makePng } from './png.mjs'

test('shot-png：漸層圖不是空白', () => {
  const f = path.join(os.tmpdir(), `asn-png-${process.pid}.png`)
  fs.writeFileSync(f, makePng(64, 64, (x, y) => [x * 3, y * 3, (x + y) % 256]))
  assert.ok(pngUniqueColors(f) >= 12)
  assertShotNotBlank(f, { minBytes: 200 })
  fs.unlinkSync(f)
})

test('shot-png：單色圖判為空白', () => {
  const f = path.join(os.tmpdir(), `asn-flat-${process.pid}.png`)
  fs.writeFileSync(f, makePng(32, 32, () => [245, 245, 245]))
  assert.equal(pngUniqueColors(f), 1)
  assert.throws(() => assertShotNotBlank(f, { minBytes: 100, minUnique: 12 }))
  fs.unlinkSync(f)
})

test('shot-png：解碼尺寸正確', () => {
  const f = path.join(os.tmpdir(), `asn-dec-${process.pid}.png`)
  fs.writeFileSync(f, makePng(10, 20))
  const d = decodePngRgb(f)
  assert.equal(d.w, 10)
  assert.equal(d.h, 20)
  fs.unlinkSync(f)
})
