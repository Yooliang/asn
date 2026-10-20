// 上傳前的圖片處理（只能在瀏覽器／WebView 裡跑）：選到的圖 → 置中裁成正方形 → 縮成 96×96 → webp（不行就 png），並檢查 ≤ 32 KB。
// 幾何與檢查規則在 avatar.mjs（純函式，有單元測試）；這裡只有畫布。
import { AVATAR_MAX_BYTES, AVATAR_PX, checkAvatarDataUrl, squareCrop } from './avatar.mjs'

const MAX_FILE = 12 * 1024 * 1024

export async function avatarFromFile(file) {
  if (!file || !/^image\//.test(file.type)) throw new Error('請選一個圖片檔。')
  if (file.size > MAX_FILE) throw new Error('圖片檔太大了（上限 12 MB），請換一張。')
  let bmp
  try { bmp = await createImageBitmap(file) } catch { throw new Error('讀不了這個圖片檔，請換一張。') }
  const { sx, sy, s } = squareCrop(bmp.width, bmp.height)
  const cv = document.createElement('canvas')
  cv.width = cv.height = AVATAR_PX
  const g = cv.getContext('2d')
  g.imageSmoothingQuality = 'high'
  g.drawImage(bmp, sx, sy, s, s, 0, 0, AVATAR_PX, AVATAR_PX)
  bmp.close?.()
  for (const q of [0.92, 0.82, 0.7, 0.58, 0.45]) {
    const u = cv.toDataURL('image/webp', q)
    if (u.startsWith('data:image/webp') && checkAvatarDataUrl(u).ok) return u
  }
  const p = cv.toDataURL('image/png')
  if (checkAvatarDataUrl(p).ok) return p
  throw new Error(`圖片太複雜，處理後超過 ${AVATAR_MAX_BYTES / 1024} KB，請換一張簡單一點的。`)
}
