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

// ---- #2033：發版機上提示視窗截圖疑似空白只警告（checkShot）----
import { checkShot, recordShotWarning } from './shot-png.mjs'

function flatShot(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-lenient-'))
  const f = path.join(dir, name)
  fs.writeFileSync(f, makePng(32, 32, () => [245, 245, 245]))
  return { dir, f }
}

test('checkShot：放寬時提示視窗空白只警告不擋', () => {
  const { dir, f } = flatShot('toast-2-2.png')
  const warns = []
  assert.equal(checkShot(f, { minBytes: 100, minUnique: 12 }, { lenientToast: true, warn: m => warns.push(m) }), null)
  assert.equal(warns.length, 1)
  assert.match(warns[0], /toast-2-2\.png/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('checkShot：放寬只影響提示視窗，對話視窗空白照樣失敗', () => {
  const { dir, f } = flatShot('chat.png')
  assert.throws(() => checkShot(f, { minBytes: 100, minUnique: 12 }, { lenientToast: true, warn: () => assert.fail('不該警告') }), /截圖(太小|幾乎單色)/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('checkShot：沒開放寬時提示視窗空白照樣失敗', () => {
  const { dir, f } = flatShot('toast-0-0.png')
  assert.throws(() => checkShot(f, { minBytes: 100, minUnique: 12 }, { lenientToast: false }), /截圖(太小|幾乎單色)/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('checkShot：放寬時提示視窗的其他錯誤（不是 PNG）照樣失敗', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-lenient-'))
  const f = path.join(dir, 'toast-1-1.png')
  fs.writeFileSync(f, Buffer.alloc(20000, 1))
  assert.throws(() => checkShot(f, {}, { lenientToast: true, warn: () => assert.fail('不該警告') }), /不是 PNG/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('recordShotWarning：警告寫進 keep 資料夾的 shot-warning.txt（workflow 讀它寫摘要）', () => {
  const keep = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-keep-'))
  recordShotWarning('提示視窗截圖疑似空白（toast-2-2.png）', keep)
  assert.match(fs.readFileSync(path.join(keep, 'shot-warning.txt'), 'utf8'), /toast-2-2\.png/)
  fs.rmSync(keep, { recursive: true, force: true })
})

test('發版 workflow：只在發版 e2e 步驟開放寬，有警告時寫摘要並上傳截圖，整步沒有 continue-on-error', () => {
  const y = fs.readFileSync(new URL('../../../.github/workflows/asn-release.yml', import.meta.url), 'utf8')
  assert.match(y, /ASN_SHOT_TOAST_LENIENT: '1'/)
  assert.match(y, /Windows 截圖疑似空白，請看產物/)
  assert.match(y, /GITHUB_STEP_SUMMARY/)
  assert.match(y, /failure\(\) \|\| steps\.shotwarn\.outputs\.warn == 'true'/)
  assert.doesNotMatch(y, /continue-on-error/)
})
