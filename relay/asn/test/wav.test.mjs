import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeWav, resample, takeToWavBase64, toBase64 } from '../ui/lib/wav.mjs'

test('WAV 檔頭：RIFF／PCM／單聲道／16 kHz／16 位元，長度欄位對得上（Rust 端 check_wav 的規格）', () => {
  const w = encodeWav(Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]))
  const v = new DataView(w.buffer)
  assert.equal(String.fromCharCode(...w.subarray(0, 4)), 'RIFF')
  assert.equal(String.fromCharCode(...w.subarray(8, 16)), 'WAVEfmt ')
  assert.deepEqual([v.getUint32(16, true), v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint32(28, true), v.getUint16(32, true), v.getUint16(34, true)], [16, 1, 1, 16000, 32000, 2, 16])
  assert.equal(String.fromCharCode(...w.subarray(36, 40)), 'data')
  assert.equal(v.getUint32(40, true), 14)
  assert.equal(v.getUint32(4, true), w.length - 8)
  assert.equal(w.length, 44 + 14)
  // 取樣值：超出範圍的夾住，不溢位
  const s = i => v.getInt16(44 + i * 2, true)
  assert.deepEqual([s(0), s(3), s(4), s(5), s(6)], [0, 32767, -32768, 32767, -32768])
})

test('降到 16 kHz：長度比例對、值是區間平均；相同取樣率原樣交回', () => {
  const src = new Float32Array(48000).fill(0.25)
  const out = resample(src, 48000)
  assert.equal(out.length, 16000)
  assert.ok(out.every(x => Math.abs(x - 0.25) < 1e-6))
  assert.equal(resample(src, 16000), src)
  assert.equal(resample(Float32Array.from([1, 3, 5, 7, 9, 11]), 48000).join(), '3,9')
  assert.equal(resample(new Float32Array(44100), 44100, 16000).length, 16000)
})

test('一段錄音 → base64 的 WAV；base64 能還原', () => {
  const b64 = takeToWavBase64({ samples: new Float32Array(48000).fill(0.1), rate: 48000 })
  const buf = Buffer.from(b64, 'base64')
  assert.equal(buf.length, 44 + 16000 * 2)
  assert.equal(toBase64(Uint8Array.from([104, 105])), 'aGk=')
  // 很長的資料不會爆 call stack
  assert.equal(Buffer.from(toBase64(new Uint8Array(2_000_000)), 'base64').length, 2_000_000)
})
