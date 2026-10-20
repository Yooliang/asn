// 傳照片的純邏輯（瀏覽器與 node 測試都能跑）：尺寸、替代文字、來信附件整理、錯誤白話。
// 畫布處理在 photo-canvas.mjs；檢查格式與大小、上傳、寄信在 Rust（src-tauri/src/attach.rs，金鑰也只在那裡）。
// 規則與 supabase/functions/_shared/attachments.ts 一致；設計見 docs/ATTACHMENTS.md。

export const PHOTO_MAX_EDGE = 2048          // 長邊上限（像素）
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024   // 壓縮後上限
export const PHOTO_PICK_MAX = 30 * 1024 * 1024   // 選進來的原圖上限（太大的圖連解碼都不做）
export const THUMB_EDGE = 256
export const THUMB_MAX_CHARS = 12000
export const PHOTO_KEEP_DAYS = 30
export const PHOTO_LABEL = '〔照片〕'
export const FILE_LABEL = '〔檔案〕'
export const MAX_PHOTOS = 4
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const THUMB_RE = /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/

// 一般檔案（不壓縮、不轉檔）：副檔名白名單 → 型別（同後端 FILE_TYPES 與 Rust）。可執行檔、腳本、安裝檔一律不在裡面。
export const FILE_MAX_BYTES = 25 * 1024 * 1024
export const FILE_TYPES = {
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv', zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
export const FILE_ACCEPT = Object.keys(FILE_TYPES).map(e => '.' + e).join(',')   // <input accept>
export const FILE_EXT_TEXT = Object.keys(FILE_TYPES).join('、')
export function fileExt(name) { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name ?? '').trim()); return m ? m[1].toLowerCase() : '' }
export const fileMimeOf = name => (Object.hasOwn(FILE_TYPES, fileExt(name)) ? FILE_TYPES[fileExt(name)] : null)

// 縮到長邊不超過 max（只縮不放大），回整數寬高
export function fitSize(w, h, max = PHOTO_MAX_EDGE) {
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0 }
  const s = Math.min(1, max / Math.max(w, h))
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) }
}

// 檔名清理（同後端與 Rust）：控制字元、括號、引號、路徑與 shell 符號換成空白，至多 80 字
const BAD = new RegExp('[\\x00-\\x1f\\x7f-\\x9f' + [0x2028, 0x2029, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map(c => String.fromCharCode(c)).join('') + '〔〕［］【】「」『』()（）\\[\\]{}<>《》`\'"“”‘’\\\\/|:*?;&$%!#^~=,]', 'g')
export function cleanPhotoName(s, fallback = 'photo.webp') {
  const out = String(s ?? '').replace(BAD, ' ').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '').slice(0, 80).trim()
  return out || fallback
}

// 上傳用的檔名：原檔名換成 .webp 副檔名
export function webpName(original) {
  const base = String(original ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '')
  return cleanPhotoName(`${base || 'photo'}.webp`)
}

// 內文：第一行是替代文字「〔照片〕檔名」／「〔檔案〕檔名」（舊版用戶端看得到），說明文字接在後面
export function photoText(name, caption = '', kind = 'image') {
  const cap = String(caption ?? '').replace(/\s+$/, '')
  const label = kind === 'file' ? FILE_LABEL : PHOTO_LABEL
  return cap ? `${label}${name}\n${cap}` : `${label}${name}`
}

// 收到的信：開頭最多 n 行（n＝附件數）以〔照片〕／〔檔案〕開頭的替代文字行拿掉，因為已經有結構化的附件可以顯示。沒有附件時一個字不動
export function stripPhotoLines(text, n) {
  if (!(n > 0)) return String(text ?? '')
  const lines = String(text ?? '').split('\n')
  let cut = 0
  while (cut < n && cut < lines.length && (lines[cut].startsWith(PHOTO_LABEL) || lines[cut].startsWith(FILE_LABEL))) cut++
  return lines.slice(cut).join('\n')
}

export const isThumb = v => typeof v === 'string' && v.length <= THUMB_MAX_CHARS && THUMB_RE.test(v)

// 信件的 attachments → 乾淨的清單：只留白名單欄位；編號不是 uuid 的丟掉；縮圖不是 webp data URL 就不用；最多 4 筆
export function normalizePhotos(v) {
  if (!Array.isArray(v)) return []
  const num = x => (Number.isInteger(x) && x > 0 && x < 1e9 ? x : null)
  const out = []
  for (const a of v) {
    if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !UUID.test(a.id)) continue
    out.push({
      id: a.id.toLowerCase(),
      kind: a.kind === 'image' ? 'image' : 'file',
      name: cleanPhotoName(a.name, a.kind === 'image' ? 'photo.webp' : 'file'),
      mime: typeof a.mime === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(a.mime) ? a.mime.toLowerCase() : 'application/octet-stream',
      bytes: num(a.bytes), width: num(a.width), height: num(a.height),
      thumb: isThumb(a.thumb) ? a.thumb : null,
      expires_at: typeof a.expires_at === 'string' ? a.expires_at.slice(0, 40) : null,
      expired: a.expired === true,
    })
    if (out.length >= MAX_PHOTOS) break
  }
  return out
}

// 過期：後端說過期，或到期時間已過（本機存檔裡舊的紀錄也會自己變成「已過期」）
export function photoExpired(p, now = Date.now()) {
  if (p?.expired) return true
  const t = Date.parse(p?.expires_at ?? '')
  return Number.isFinite(t) && t <= now
}

export function expiresAt(now = Date.now()) { return new Date(now + PHOTO_KEEP_DAYS * 86400_000).toISOString() }

export function formatBytes(n) {
  if (!n) return ''
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

// 縮圖上顯示的說明（無障礙文字／提示）
export function photoTitle(p) {
  const dim = p.width && p.height ? `${p.width}×${p.height}` : ''
  return [p.name, dim, formatBytes(p.bytes)].filter(Boolean).join('　')
}

// 通知與對話裡沒有文字時顯示的一句
export const PHOTO_NOTICE = '傳來了一張照片'
export const FILE_NOTICE = '傳來了一個檔案'
export const noticeOf = list => (list.length && list.every(a => a.kind === 'file') ? FILE_NOTICE : PHOTO_NOTICE)

// 後端／Rust 的錯誤 → 給人看的白話（Rust 端多半已經轉好，這裡補沒轉到的）
export function friendlyPhotoError(msg) {
  const e = String(msg ?? '')
  if (/quota_exceeded/.test(e)) return '這台設備的照片空間滿了（照片保存 30 天後自動清掉），晚點再傳。'
  if (/file_too_large/.test(e)) return '檔案太大了（照片上限 5 MB、檔案上限 25 MB）。'
  if (/unsupported_type/.test(e)) return '收發室不收這種檔案。'
  if (/rate_limited/.test(e)) return '傳得太頻繁了，請稍後再試。'
  return e || '照片沒有傳出去。'
}
