// 大頭貼（純函式，介面與測試共用）：
//   1. 自動產生：依字串雜湊產生左右對稱 8×8 色塊（三種顏色），種子＝好友 id（`節點/視窗名`），每人固定、不同人不同。
//      概念同常見的「錢包 blockies」：種子 → 偽隨機數 → 一組主色／底色／點綴色，再逐列決定半邊格子、鏡射成另一半。
//      雜湊（FNV-1a）與亂數（mulberry32）是自己寫的標準演算法，不含任何第三方程式。
//   2. 設備上傳的大頭貼：96×96、png 或 webp、≤ 32 KB 的 data URL；上傳前與收到時都要檢查格式與大小。
//   3. 顯示規則：AI 視窗（在名單上）→ 一律自動產生；不在名單上的寄件人 → 用他那台設備上傳的圖，沒有就自動產生；
//      自己 → 本機節點有上傳就用上傳的，沒有就自動產生。

export const GRID = 8
export const AVATAR_PX = 96
export const AVATAR_MAX_BYTES = 32 * 1024        // 圖檔本身（解碼後）上限
export const AVATAR_MAX_CHARS = 48000            // data URL 全長上限（與資料庫、後端一致）
const PREFIX_RE = /^data:image\/(png|webp);base64,/
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/

// ---------- 自動產生（blockies 風格） ----------
function fnv1a(s) {
  let h = 0x811c9dc5
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 三種顏色：主色、底色、點綴色；底色與主色的亮度至少差 22，避免整張糊成一色
function palette(rand) {
  const hue = Math.floor(rand() * 360)
  const main = { h: hue, s: 45 + Math.floor(rand() * 45), l: 35 + Math.floor(rand() * 25) }
  const bgL = main.l > 55 ? 14 + Math.floor(rand() * 18) : 76 + Math.floor(rand() * 16)
  const bg = { h: (hue + 150 + Math.floor(rand() * 60)) % 360, s: 25 + Math.floor(rand() * 40), l: bgL }
  const spot = { h: (hue + 40 + Math.floor(rand() * 280)) % 360, s: 55 + Math.floor(rand() * 40), l: 45 + Math.floor(rand() * 20) }
  return [main, bg, spot].map(c => `hsl(${c.h} ${c.s}% ${c.l}%)`)
}

// 回傳 { colors: [主色, 底色, 點綴色], cells: 8 列 × 8 欄，值 0＝底色、1＝主色、2＝點綴色 }；左右對稱
export function blockieGrid(seed) {
  const rand = mulberry32(fnv1a(seed))
  const colors = palette(rand)
  const half = GRID / 2
  const cells = []
  for (let r = 0; r < GRID; r++) {
    const row = new Array(GRID)
    for (let c = 0; c < half; c++) {
      const v = Math.floor(rand() * 2.3)   // 0（底）約 43%、1（主）約 43%、2（點綴）約 13%
      row[c] = v
      row[GRID - 1 - c] = v
    }
    cells.push(row)
  }
  return { colors, cells }
}

// SVG 文字（只含色塊，不含種子本身）：先鋪底色，再畫非底色的格子
export function blockieSvg(seed) {
  const { colors, cells } = blockieGrid(seed)
  let rects = ''
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) if (cells[r][c]) rects += `<rect x="${c}" y="${r}" width="1" height="1" fill="${colors[cells[r][c]]}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" shape-rendering="crispEdges"><rect width="${GRID}" height="${GRID}" fill="${colors[1]}"/>${rects}</svg>`
}
const memo = new Map()
export function blockieDataUrl(seed) {
  const k = String(seed)
  let u = memo.get(k)
  if (!u) {
    u = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(blockieSvg(k))
    if (memo.size > 500) memo.clear()
    memo.set(k, u)
  }
  return u
}

// ---------- 上傳前處理（純幾何與檢查；畫布縮放在 avatar-canvas.mjs） ----------
// 置中裁成正方形：回傳來源的裁切起點與邊長
export function squareCrop(w, h) {
  const s = Math.min(w, h)
  return { sx: Math.floor((w - s) / 2), sy: Math.floor((h - s) / 2), s }
}

// 解 base64 的前幾個位元組（只為了驗檔頭，不需要整段解碼）
function headBytes(b64, n) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const out = []
  let acc = 0, bits = 0
  for (const ch of b64) {
    acc = (acc << 6) | A.indexOf(ch); bits += 6
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); acc &= (1 << bits) - 1 }
    if (out.length >= n) break
  }
  return out
}
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const isWebp = b => b.length >= 12 && [0x52, 0x49, 0x46, 0x46].every((x, i) => b[i] === x) && [0x57, 0x45, 0x42, 0x50].every((x, i) => b[8 + i] === x)

// 檢查一張大頭貼 data URL：{ ok:true, mime, bytes } 或 { ok:false, error }（error 是給人看的中文）
export function checkAvatarDataUrl(v) {
  if (typeof v !== 'string') return { ok: false, error: '大頭貼格式不對' }
  const m = PREFIX_RE.exec(v)
  if (!m) return { ok: false, error: '大頭貼只接受 png 或 webp 圖片' }
  if (v.length > AVATAR_MAX_CHARS) return { ok: false, error: '大頭貼太大了' }
  const b64 = v.slice(m[0].length)
  if (!B64_RE.test(b64) || b64.length % 4 === 1) return { ok: false, error: '大頭貼的內容不是有效的圖片資料' }
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  const bytes = Math.floor((b64.length * 3) / 4) - pad
  if (bytes > AVATAR_MAX_BYTES) return { ok: false, error: `大頭貼不能超過 ${AVATAR_MAX_BYTES / 1024} KB` }
  const head = headBytes(b64, 12)
  const good = m[1] === 'png' ? PNG_SIG.every((x, i) => head[i] === x) : isWebp(head)
  if (!good) return { ok: false, error: '圖片內容跟格式對不上' }
  return { ok: true, mime: m[1], bytes }
}
export const isAvatarDataUrl = v => checkAvatarDataUrl(v).ok

// ---------- 顯示規則 ----------
// friend：{ id, node, onRoster }；avatars：Map 或物件，節點 → { data, at }（或直接是 data URL 字串）
const pick = (avatars, node) => {
  const e = avatars instanceof Map ? avatars.get(node) : avatars?.[node]
  const d = typeof e === 'string' ? e : e?.data
  return typeof d === 'string' && isAvatarDataUrl(d) ? d : null
}
// 回傳 { kind: 'upload', src } 或 { kind: 'auto', seed }
export function avatarFor(friend, { avatars } = {}) {
  if (friend?.onRoster === true) return { kind: 'auto', seed: friend.id }          // AI 視窗：一律自動產生
  const up = friend?.node ? pick(avatars, friend.node) : null                      // 名單外的寄件人：他那台設備上傳的圖
  return up ? { kind: 'upload', src: up } : { kind: 'auto', seed: friend?.id ?? '' }
}
// 自己：本機節點有上傳就用，沒有就自動產生（種子＝別人看到我的 id：節點/視窗名）
export function selfAvatarFor({ selfNode, windowName, avatars }) {
  const up = pick(avatars, selfNode)
  return up ? { kind: 'upload', src: up } : { kind: 'auto', seed: `${selfNode}/${windowName}` }
}
export const avatarSrcOf = a => (a.kind === 'upload' ? a.src : blockieDataUrl(a.seed))
export const avatarSrc = (friend, ctx) => avatarSrcOf(avatarFor(friend, ctx))
export const selfAvatarSrc = ctx => avatarSrcOf(selfAvatarFor(ctx))

// 上傳失敗的訊息（Rust 端與後端的代碼）→ 白話中文
export function friendlyAvatarError(message) {
  const m = String(message ?? '')
  if (/avatar_too_large|太大|超過/.test(m)) return '圖片太大了，請換一張（處理後要在 32 KB 以內）。'
  if (/bad_avatar|avatar_bad|不是有效|對不上|只接受/.test(m)) return '這個圖片格式不能用，請選 png、jpg 或 webp。'
  if (/HTTP 404|not_found/.test(m)) return '收發室還不支援大頭貼，請稍後再試。'
  if (/HTTP 401|unauthorized/.test(m)) return '收發室不認得這台設備的金鑰。'
  if (/連線失敗/.test(m)) return '連不上收發室，請稍後再試。'
  return `上傳沒有成功：${m}`
}
