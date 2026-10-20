// 下載附件的共用核心（machine/attach.mjs 與 cloud-agent/attach.mjs 共用）：換短效網址、檢查、存檔。
// 不依賴本機身分判定（identity.mjs），雲端代理也能直接用。
import fs from 'node:fs'
import path from 'node:path'
import { UUID_RE, safeText } from './attach-format.mjs'

export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024   // 一般檔案上限；照片另外限 5 MB
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export class AttachFail extends Error { constructor(code, msg) { super(msg); this.code = code } }

// 型別白名單（同 supabase/functions/_shared/attachments.ts 的 FILE_TYPES）：型別 → 副檔名
export const EXT_OF = {
  'image/webp': '.webp', 'application/pdf': '.pdf', 'text/plain': '.txt', 'text/markdown': '.md', 'application/json': '.json', 'text/csv': '.csv',
  'application/zip': '.zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
}
const ZIP_LIKE = new Set(['application/zip', ...Object.keys(EXT_OF).filter(m => m.includes('openxmlformats'))])
const TEXT_LIKE = new Set(['text/plain', 'text/markdown', 'application/json', 'text/csv'])

// 內容檢查（跟型別對得上才存）：webp 要有 RIFF….WEBP 檔頭；pdf 要 %PDF；zip／docx／xlsx／pptx 要 PK 檔頭；文字檔前 8 KB 不能有 NUL
export function contentOk(mime, buf) {
  if (mime === 'image/webp') return buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP'
  if (mime === 'application/pdf') return buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-'
  if (ZIP_LIKE.has(mime)) return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5)
  if (TEXT_LIKE.has(mime)) return !buf.subarray(0, 8192).includes(0)
  return false
}

// 本機檔名：<編號前 8 碼>-<清過的檔名>，副檔名依型別補上
export function localName(id, name, mime) {
  const ext = EXT_OF[mime] ?? ''
  let base = safeText(name, 60).replace(/\s+/g, '_') || 'file'
  if (ext && !base.toLowerCase().endsWith(ext)) base += ext
  return `${id.slice(0, 8)}-${base}`
}

// api：relay-core 的 api；baseUrl：收發室網址（下載網址必須與它同一主機）；回 { path, bytes, name, mime, existed }
export async function downloadAttachment({ api, baseUrl, id, outDir, out, fetchFn = fetch }) {
  if (!UUID_RE.test(id ?? '')) throw new AttachFail(1, '--id 要是附件編號（uuid）')
  let info
  try { info = await api(`attach_url&id=${id}`) } catch (e) {
    const why = e.status === 404 ? '找不到這個附件，或你沒有權限下載' : e.status === 410 ? '這個附件已過期（超過保存期限，檔案已刪除）' : e.message
    throw new AttachFail(4, `取不到下載網址：${why}`)
  }
  let u, base
  try { u = new URL(info?.url); base = new URL(baseUrl) } catch { throw new AttachFail(4, '收發室回的下載網址格式不對') }
  if (!['http:', 'https:'].includes(u.protocol) || u.host !== base.host) throw new AttachFail(4, '下載網址不在收發室的主機上，拒絕下載')
  const mime = String(info.mime ?? '')
  const target = out ? path.resolve(out) : path.join(outDir, localName(id, info.name, mime))
  if (fs.existsSync(target)) {
    if (out) throw new AttachFail(1, `目的地已有檔案，不覆蓋：${target}`)
    return { path: target, bytes: fs.statSync(target).size, name: info.name, mime, existed: true }
  }
  let res
  try { res = await fetchFn(u, { signal: AbortSignal.timeout(60_000) }) } catch (e) { throw new AttachFail(4, `下載失敗：${e.message}`) }
  if (!res.ok) throw new AttachFail(4, `下載失敗：HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!EXT_OF[mime]) throw new AttachFail(4, '不認得的檔案型別，拒絕存檔')
  const limit = mime === 'image/webp' ? MAX_IMAGE_BYTES : MAX_DOWNLOAD_BYTES
  if (buf.length > limit) throw new AttachFail(4, `檔案超過 ${limit / 1024 / 1024} MB 上限，拒絕存檔`)
  if (Number.isInteger(info.bytes) && buf.length !== info.bytes) throw new AttachFail(4, `檔案大小不符（應為 ${info.bytes}，收到 ${buf.length}），拒絕存檔`)
  if (!contentOk(mime, buf)) throw new AttachFail(4, '檔案內容跟型別對不上，拒絕存檔')
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  try { fs.writeFileSync(target, buf, { flag: 'wx', mode: 0o600 }) } catch (e) { throw new AttachFail(e.code === 'EEXIST' ? 1 : 4, `寫檔失敗：${e.message}`) }
  return { path: target, bytes: buf.length, name: info.name, mime, existed: false }
}
