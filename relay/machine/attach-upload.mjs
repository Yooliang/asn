// 上傳附件的共用核心（machine/send.mjs 用；對應下載端 attach-download.mjs，規則同 supabase/functions/_shared/attachments.ts）。
// 不依賴本機身分判定，api 與 fetch 由呼叫端傳入，所以也能在假後端上測試、之後雲端代理要用也能直接拿。
// 流程：本機全部檢查完（不碰網路）→ 逐個 attach_init 要一次性上傳網址 → PUT 位元組 → attach_commit →（呼叫端）send 帶 attachment_ids。
// 任何一個失敗就丟錯，呼叫端不寄信（已上傳的孤兒檔 30 天後由後端清掉）。
//
// 照片的處理：Node 沒有影像函式庫、也不加原生依賴，所以【只收已經是 webp 的照片】（檔頭 RIFF….WEBP、≤ 5 MB，位元組原樣上傳，不縮放、不帶縮圖）。
// png／jpg／gif 等照片不會被當一般檔案寄（它們本來就不在白名單），而是明確拒絕並說明先轉成 webp。
// 一般檔案：副檔名在白名單（pdf、txt、md、json、csv、zip、docx、xlsx、pptx）、內容檔頭對得上、≤ 25 MB；可執行檔、腳本一律擋。
import fs from 'node:fs'
import path from 'node:path'
import { AttachFail, EXT_OF, MAX_DOWNLOAD_BYTES, MAX_IMAGE_BYTES, contentOk } from './attach-download.mjs'
import { KIND_LABEL, UUID_RE, safeText } from './attach-format.mjs'

// 後端一封信至多 4 個附件（MAX_PER_MESSAGE）
export const MAX_FILES = 4
export const FILE_EXTS = Object.fromEntries(Object.entries(EXT_OF).filter(([m]) => m !== 'image/webp').map(([m, e]) => [e.slice(1), m]))
const WHITELIST_TEXT = 'webp 照片，或 pdf、txt、md、json、csv、zip、docx、xlsx、pptx'
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'heic', 'heif', 'tif', 'tiff', 'svg', 'avif'])

// 檔名：清掉控制字元／括號／路徑符號，≤ 80 字且保留副檔名（後端用清過的檔名比對副檔名）
export function cleanUploadName(p, ext) {
  const raw = path.basename(String(p))
  const dot = raw.lastIndexOf('.')
  const stem = safeText(dot > 0 ? raw.slice(0, dot) : raw, 80 - ext.length - 1) || 'file'
  return `${stem}.${ext}`
}

// 讀一個本機檔並檢查；回 { kind, mime, name, bytes(Buffer) }；不合格丟 AttachFail(1)（給人看的中文原因），不碰網路
export function prepareFile(file) {
  const shown = path.basename(String(file))
  let st
  try { st = fs.statSync(file) } catch { throw new AttachFail(1, `找不到檔案：${file}`) }
  if (!st.isFile()) throw new AttachFail(1, `不是檔案：${file}`)
  const dot = shown.lastIndexOf('.')
  const ext = dot > 0 ? shown.slice(dot + 1).toLowerCase() : ''
  const isImage = ext === 'webp'
  const mime = isImage ? 'image/webp' : FILE_EXTS[ext]
  if (!mime) {
    if (IMAGE_EXTS.has(ext)) throw new AttachFail(1, `${shown}：這支程式不轉檔，照片只收 webp；請先轉成 webp 再寄（或用 ASN 電腦版寄，會自動轉）`)
    throw new AttachFail(1, `${shown}：這種檔案不能寄（可寄：${WHITELIST_TEXT}；可執行檔、腳本一律擋）`)
  }
  const limit = isImage ? MAX_IMAGE_BYTES : MAX_DOWNLOAD_BYTES
  if (st.size < 1) throw new AttachFail(1, `${shown}：檔案是空的`)
  if (st.size > limit) throw new AttachFail(1, `${shown}：${(st.size / 1024 / 1024).toFixed(1)} MB，超過上限（${isImage ? '照片' : '檔案'}至多 ${limit / 1024 / 1024} MB）`)
  const bytes = fs.readFileSync(file)
  if (bytes.length > limit) throw new AttachFail(1, `${shown}：超過上限（至多 ${limit / 1024 / 1024} MB）`)
  if (!contentOk(mime, bytes)) throw new AttachFail(1, `${shown}：檔案內容跟副檔名 .${ext} 對不上，已取消`)
  return { kind: isImage ? 'image' : 'file', mime, name: cleanUploadName(file, ext), bytes }
}

export function prepareFiles(files) {
  if (files.length > MAX_FILES) throw new AttachFail(1, `一封信最多 ${MAX_FILES} 個附件（給了 ${files.length} 個）`)
  return files.map(prepareFile)
}

// 信的內文：每個附件一行「〔照片〕檔名／〔檔案〕檔名」（舊版用戶端看得到），說明文字接在後面；沒說明文字就只有這幾行
export function attachmentText(items, caption) {
  const head = items.map(i => `${KIND_LABEL[i.kind]}${i.name}`).join('\n')
  const cap = String(caption ?? '').replace(/\s+$/, '')
  return cap ? `${head}\n${cap}` : head
}

// 後端錯誤 → 白話（api 丟的錯形如「attach_init HTTP 413 quota_exceeded」）
export function explainUploadError(msg) {
  const pick = (code, text) => msg.includes(code) ? text : null
  return pick('quota_exceeded', '這台設備的附件空間滿了（保存 30 天後自動清掉），晚點再寄')
    ?? pick('file_too_large', '檔案太大了（照片上限 5 MB、檔案上限 25 MB）')
    ?? pick('unsupported_type', '收發室不收這種檔案')
    ?? pick('rate_limited', '傳得太頻繁了，請稍後再試')
    ?? pick('not_uploaded', '檔案還沒傳完，請再試一次')
    ?? (/^attach_\w+ HTTP 404/.test(msg) ? '這個收發室還不支援傳附件' : msg)
}

// api(action, body) → 後端回的 JSON，失敗丟 Error（訊息含 action 與狀態碼）；baseUrl：上傳網址必須與它同一主機
// 回附件編號陣列（順序同 items）。已上傳的不回收；任何一步失敗整個丟 AttachFail(4)，呼叫端不寄信。
export async function uploadItems({ api, baseUrl, items, fetchFn = fetch }) {
  const ids = []
  let base
  try { base = new URL(baseUrl) } catch { throw new AttachFail(4, '收發室網址格式不對') }
  for (const it of items) {
    let init
    try {
      init = await api('attach_init', { kind: it.kind, mime: it.mime, name: it.name, bytes: it.bytes.length })
    } catch (e) { throw new AttachFail(4, `${it.name}：${explainUploadError(e.message)}`) }
    const id = init?.id
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw new AttachFail(4, `${it.name}：收發室沒有給附件編號`)
    let u
    try { u = new URL(init.upload_url) } catch { throw new AttachFail(4, `${it.name}：收發室沒有給上傳網址`) }
    if (!['http:', 'https:'].includes(u.protocol) || u.host !== base.host) throw new AttachFail(4, `${it.name}：上傳網址不在收發室的主機上，已取消`)
    let res
    try {
      res = await fetchFn(u, { method: 'PUT', headers: { 'content-type': it.mime }, body: it.bytes, signal: AbortSignal.timeout(120_000) })
    } catch (e) { throw new AttachFail(4, `${it.name}：上傳失敗（${e.message}）`) }   // 網址是一次性簽名，不放進訊息
    if (!res.ok) throw new AttachFail(4, `${it.name}：上傳失敗（HTTP ${res.status}）`)
    try { await api('attach_commit', { id }) } catch (e) { throw new AttachFail(4, `${it.name}：${explainUploadError(e.message)}`) }
    ids.push(id)
  }
  return ids
}
