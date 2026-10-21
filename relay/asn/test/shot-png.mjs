// --shot 截圖品質：解 8-bit RGB/RGBA PNG，拒絕幾乎單色的空白圖。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import zlib from 'node:zlib'

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function unfilterRow(filter, row, prev, bpp) {
  const out = Buffer.from(row)
  const n = out.length
  if (filter === 0) return out
  for (let i = 0; i < n; i++) {
    const left = i >= bpp ? out[i - bpp] : 0
    const up = prev ? prev[i] : 0
    const upLeft = prev && i >= bpp ? prev[i - bpp] : 0
    if (filter === 1) out[i] = (out[i] + left) & 0xff
    else if (filter === 2) out[i] = (out[i] + up) & 0xff
    else if (filter === 3) out[i] = (out[i] + Math.floor((left + up) / 2)) & 0xff
    else if (filter === 4) out[i] = (out[i] + paeth(left, up, upLeft)) & 0xff
  }
  return out
}

/** @returns {{ w: number, h: number, bpp: number, rows: Buffer[] }} */
export function decodePngRgb(file) {
  const buf = fs.readFileSync(file)
  assert.ok(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), '不是 PNG')
  let pos = 8
  let w = 0
  let h = 0
  let depth = 0
  let ctype = 0
  const idats = []
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    pos += 4
    const type = buf.toString('ascii', pos, pos + 4)
    pos += 4
    const data = buf.subarray(pos, pos + len)
    pos += len + 4
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      depth = data[8]
      ctype = data[9]
    } else if (type === 'IDAT') idats.push(data)
    else if (type === 'IEND') break
  }
  assert.equal(depth, 8, '只支援 8-bit PNG')
  const bpp = ctype === 2 ? 3 : ctype === 6 ? 4 : 0
  assert.ok(bpp, `不支援的 PNG 色彩類型 ${ctype}`)
  const raw = zlib.inflateSync(Buffer.concat(idats))
  const stride = w * bpp
  const rows = []
  let rp = 0
  let prev = null
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++]
    const row = raw.subarray(rp, rp + stride)
    rp += stride
    const decoded = unfilterRow(filter, row, prev, bpp)
    rows.push(decoded)
    prev = decoded
  }
  return { w, h, bpp, rows }
}

/** 取樣估計不同 RGB 色數；blank 通常 unique ≤ 2 */
export function pngUniqueColors(file, { step = 8 } = {}) {
  const { w, h, bpp, rows } = decodePngRgb(file)
  const seen = new Set()
  for (let y = 0; y < h; y += step) {
    const row = rows[y]
    for (let x = 0; x < w; x += step) {
      const o = x * bpp
      const key = `${row[o]},${row[o + 1]},${row[o + 2]}`
      seen.add(key)
      if (seen.size > 64) return seen.size
    }
  }
  return seen.size
}

export function assertShotNotBlank(file, { minUnique = 12, minBytes = 10_000 } = {}) {
  const st = fs.statSync(file)
  assert.ok(st.size >= minBytes, `截圖太小（${st.size} bytes），可能尚未繪製：${file}`)
  const unique = pngUniqueColors(file)
  assert.ok(unique >= minUnique, `截圖幾乎單色（unique≈${unique}），可能空白：${file}`)
  return unique
}
