// 附件（傳照片）在收信端的格式（純函式，橋、recv、room、雲端代理共用）。設計見 docs/ATTACHMENTS.md。
// 信件的 attachments 欄位來自寄件人，視為外部資料：欄位只留白名單、檔名清掉控制字元與括號，
// 附件編號必須是 uuid 才會組進下載指令。收到的是一行「〔照片〕檔名（型別，大小，尺寸）下載：<指令> --id <編號>」，
// 接在內文後面，和內文一起放進既有的外部資料區塊（橋的 <<<MAIL … MAIL>>>、recv 的 JSON body）。
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const MAX_ATTACHMENTS = 4
export const KIND_LABEL = { image: '〔照片〕', file: '〔檔案〕' }
const LABELS = Object.values(KIND_LABEL)

// 預設的下載指令（本機機器橋這一套）；雲端代理傳自己的
export const ATTACH_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'attach.mjs')
export const defaultCmd = () => `node "${ATTACH_CLI}"`

// 檔名／型別這類文字：控制字元、換行、括號、引號、路徑與 shell 符號都換成空白，至多 max 字
// 控制字元、行分隔、零寬與雙向控制字元（用字碼組，避免原始碼裡出現看不見的字元）
const CTRL = new RegExp("[\x00-\x1f\x7f-\x9f" + [0x2028, 0x2029, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map(c => String.fromCharCode(c)).join("") + "]", "g")

export function safeText(v, max = 80) {
  return String(v ?? '')
    .replace(CTRL, " ")
    .replace(/[〔〕［］【】「」『』()（）[\]{}<>《》`'"“”‘’\\/|:*?;&$%!#^~=,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .slice(0, max)
    .trim()
}

const posInt = v => (Number.isInteger(v) && v > 0 && v < 1e9 ? v : null)

// 信件的 attachments → 乾淨的清單（沒有或壞掉＝[]）；丟掉縮圖與不認得的欄位，編號不是 uuid 的整筆丟掉
export function normalizeAttachments(v) {
  if (!Array.isArray(v)) return []
  const out = []
  for (const a of v) {
    if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !UUID_RE.test(a.id)) continue
    out.push({
      id: a.id.toLowerCase(),
      kind: Object.hasOwn(KIND_LABEL, a.kind) ? a.kind : 'file',
      name: safeText(a.name) || 'file',
      mime: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(a.mime ?? '') ? String(a.mime).toLowerCase() : 'application/octet-stream',
      bytes: posInt(a.bytes),
      width: posInt(a.width),
      height: posInt(a.height),
      expired: a.expired === true,
    })
    if (out.length >= MAX_ATTACHMENTS) break
  }
  return out
}

export function sizeText(bytes) {
  if (!bytes) return ''
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

// 一個附件一行
export function noteLine(a, cmd = defaultCmd()) {
  const label = KIND_LABEL[a.kind] ?? KIND_LABEL.file
  if (a.expired) return `${label}${a.name}（已過期，檔案已刪除，不能下載）`
  // 照片：型別、大小、尺寸；一般檔案：只有大小（檔名的副檔名已經說明型別）
  const info = (a.kind === 'image' ? [a.mime, sizeText(a.bytes), a.width && a.height ? `${a.width}×${a.height}` : ''] : [sizeText(a.bytes)]).filter(Boolean).join('，')
  return `${label}${a.name}（${info}）下載：${cmd} --id ${a.id}`
}

// 寄件端為了舊版用戶端，會在內文最前面放「〔照片〕檔名」當替代文字；新版有結構化的附件就不重複顯示，
// 把開頭最多 N 行（N＝附件數）以標籤開頭的行拿掉。沒有附件時一個字都不動。
export function stripFallback(body, attachments) {
  const n = attachments.length
  if (!n) return String(body ?? '')
  const lines = String(body ?? '').split('\n')
  let cut = 0
  while (cut < n && cut < lines.length && LABELS.some(l => lines[cut].startsWith(l))) cut++
  return lines.slice(cut).join('\n')
}

// 內文 + 附件提示行（沒有附件原樣回傳）
export function bodyWithNotes(body, attachments, cmd = defaultCmd()) {
  const list = normalizeAttachments(attachments)
  if (!list.length) return String(body ?? '')
  const text = stripFallback(body, list).replace(/\s+$/, '')
  return `${text ? text + '\n' : ''}${list.map(a => noteLine(a, cmd)).join('\n')}`
}
