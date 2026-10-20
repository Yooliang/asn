// 測試與截圖用：用 node 內建 zlib 產生一張合法的小 PNG（漸層＋圓點），當作「設備上傳的大頭貼」。
import zlib from 'node:zlib'

function crc32(buf) {
  let c, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
// px(x,y) → [r,g,b]
export function makePng(w = 96, h = 96, px = (x, y) => [x * 2, y * 2, 160]) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
export const pngDataUrl = (...a) => 'data:image/png;base64,' + makePng(...a).toString('base64')
// 示範用：橘色底、白色圓臉（跟自動產生的色塊明顯不同）
export const demoUploadUrl = () => pngDataUrl(96, 96, (x, y) => { const d = Math.hypot(x - 48, y - 52); return d < 26 ? [255, 244, 230] : (d < 34 ? [230, 120, 40] : [244, 164, 70]) })
