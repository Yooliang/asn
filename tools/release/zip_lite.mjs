// 極簡 zip 讀寫（無依賴）。只為了 build_downloads.mjs 產生「內容可重現」的 zip：
//  - 檔名用 UTF-8（旗標 bit 11），Windows 檔案總管與 PowerShell Expand-Archive 都能正確顯示中文檔名
//  - 路徑一律用 /，時間固定（同一份內容 → 同一個 zip → 同一個 sha256）
//  - 壓縮用 deflate（zlib），太小或壓不下去的檔案改用 store
// listZip 是給測試用的讀取器（含 CRC 驗證）。
import zlib from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// DOS 日期時間（zip 用）；year < 1980 會被夾到 1980-01-01
function dosDateTime(date) {
  const d = new Date(date)
  const y = Math.max(1980, d.getUTCFullYear())
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1)
  const day = ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()
  return { time: time & 0xffff, day: day & 0xffff }
}

// entries: [{ name: 'dir/file.txt', data: Buffer }]；mtime: 固定時間（Date 或 ISO 字串）
export function buildZip(entries, mtime = '2026-01-01T00:00:00Z') {
  const { time, day } = dosDateTime(mtime)
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (e.name.startsWith('/') || e.name.includes('\\') || e.name.split('/').includes('..')) throw new Error(`不合法的 zip 路徑：${e.name}`)
    const name = Buffer.from(e.name, 'utf8')
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data)
    const deflated = zlib.deflateRawSync(raw, { level: 9 })
    const useDeflate = raw.length > 0 && deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const crc = crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)               // version needed
    local.writeUInt16LE(0x0800, 6)           // UTF-8 檔名
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)             // version made by
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(useDeflate ? 8 : 0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(day, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(0, 38)             // external attrs
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cdSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

// 讀 zip：回傳 [{ name, size, data }]，並驗證 CRC
export function listZip(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是 zip（找不到結尾記錄）')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = []
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目錄損毀')
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24)
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32)
    const lho = buf.readUInt32LE(p + 42)
    const name = buf.toString(flags & 0x0800 ? 'utf8' : 'latin1', p + 46, p + 46 + nlen)
    const lnlen = buf.readUInt16LE(lho + 26), lxlen = buf.readUInt16LE(lho + 28)
    const start = lho + 30 + lnlen + lxlen
    const body = buf.subarray(start, start + csize)
    const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body)
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`${name} 的 CRC 不符`)
    out.push({ name, size: usize, data })
    p += 46 + nlen + xlen + clen
  }
  return out
}
