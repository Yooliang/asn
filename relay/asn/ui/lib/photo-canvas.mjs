// 傳照片／檔案前的處理（只能在瀏覽器／WebView 裡跑）。
// 可重用的入口（截圖標註等功能直接呼叫，再交給 core.sendAttachment）：
//   imageFromBlob(blob, name)  任何圖片 Blob → 長邊縮到 2048（短邊不足 1280 的長圖不縮，總像素 ≤ 8 MP）、轉 webp（逐步降品質到 ≤ 5 MB）、附 256 長邊縮圖
//   fileFromBlob(blob, name)   一般檔案 Blob → 原樣（不壓縮、不轉檔），只檢查副檔名白名單與 25 MB
//   attachmentFromFile(file)   選到的 File：圖片走 imageFromBlob，其餘走 fileFromBlob
// 都回 { kind, name, data（base64）, width?, height?, thumb? }；格式與大小在送出前還會由 Rust 再檢查一次，這裡只是盡量做對。
// 尺寸與規則在 photo.mjs（純函式，有單元測試）。
import { FILE_EXT_TEXT, FILE_MAX_BYTES, PHOTO_MAX_BYTES, PHOTO_PICK_MAX, THUMB_EDGE, cleanPhotoName, fileMimeOf, fitSize, isThumb, photoPlan, webpName } from './photo.mjs'

const blobOf = (cv, q) => new Promise(res => cv.toBlob(b => res(b), 'image/webp', q))

function drawTo(bmp, w, h) {
  const cv = document.createElement('canvas')
  cv.width = w; cv.height = h
  const g = cv.getContext('2d')
  g.imageSmoothingQuality = 'high'
  g.drawImage(bmp, 0, 0, w, h)
  return cv
}

async function toBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
  return btoa(s)
}

export async function imageFromBlob(blob, name = 'photo') {
  if (!blob || !/^image\//.test(blob.type)) throw new Error('請選一個圖片檔。')
  if (blob.size > PHOTO_PICK_MAX) throw new Error('圖片檔太大了（上限 30 MB），請換一張。')
  let bmp
  try { bmp = await createImageBitmap(blob) } catch { throw new Error('讀不了這個圖片檔，請換一張。') }
  try {
    // 先照新規則（長邊 2048、短邊保底 1280，長圖不縮糊）；壓不進 5 MB 就逐步降品質，再不行就逐輪縮小，最後退回只看長邊的舊規則（尺寸清單見 photoPlan：越後面越小、不重複）
    // 低階手機配不出大畫布（getContext 回 null、drawImage／toBlob 丟例外、toBlob 回 null）時，這一輪算失敗、退到下一輪較小的尺寸（#2331）；
    // 只有真的產出了、但不是 webp，才直接說這個環境不能轉 webp
    let allocFailed = false
    for (const { w, h } of photoPlan(bmp.width, bmp.height)) {
      try {
        const cv = drawTo(bmp, w, h)
        for (const q of [0.88, 0.78, 0.68, 0.55, 0.42]) {
          const out = await blobOf(cv, q)
          if (!out) throw new Error('toBlob 回 null')
          if (out.type !== 'image/webp') { const e = new Error('這個環境不能轉成 webp，無法傳照片。'); e.fatal = true; throw e }
          if (out.size <= PHOTO_MAX_BYTES) {
            return { kind: 'image', name: webpName(name), data: await toBase64(out), width: w, height: h, thumb: await makeThumb(bmp) }
          }
        }
      } catch (e) {
        if (e && e.fatal) throw e
        allocFailed = true
        console.warn('[photo] 這一輪畫布配不出來，改試下一輪較小的尺寸', w, h, e)
      }
    }
    if (allocFailed) throw new Error('這台裝置處理不了這麼大的圖，請換一張或先縮小。')
    throw new Error('照片壓縮後還是超過 5 MB，請換一張或先縮小。')
  } finally { bmp.close?.() }
}

export async function fileFromBlob(blob, name = 'file') {
  const clean = cleanPhotoName(name, 'file')
  if (!blob || !blob.size) throw new Error('這個檔案是空的。')
  if (!fileMimeOf(clean)) throw new Error(`這種檔案不能傳（可傳：${FILE_EXT_TEXT}；圖片請用「傳照片」）。`)
  if (blob.size > FILE_MAX_BYTES) throw new Error('檔案太大了（上限 25 MB）。')
  return { kind: 'file', name: clean, data: await toBase64(blob) }
}

export const attachmentFromFile = file => (file && /^image\//.test(file.type) ? imageFromBlob(file, file.name) : fileFromBlob(file, file?.name))

// 舊名（對話區選圖用）
export const photoFromFile = file => imageFromBlob(file, file?.name)

// 縮圖：長邊 256 的 webp data URL，超過 12000 字就降品質、再縮小
async function makeThumb(bmp) {
  for (const edge of [THUMB_EDGE, 192, 128]) {
    try {
      const { w, h } = fitSize(bmp.width, bmp.height, edge)
      const cv = drawTo(bmp, w, h)
      for (const q of [0.7, 0.5, 0.35]) {
        const u = cv.toDataURL('image/webp', q)
        if (isThumb(u)) return u
      }
    } catch (e) { console.warn('[photo] 縮圖畫布失敗，改試更小的', edge, e) }   // 縮圖失敗不該害主圖寄不出去
  }
  return null   // 做不出夠小的縮圖就不附（對方仍可點開看原圖）
}
