// 把這台的指紋畫成 QR Code，讓手機用「確認指紋 → 用相機掃」掃來核對。手機要核對時這台會自動跳出視窗顯示它（#1863，panel.js 的 fpshow）。
// 格子由 Rust 排好（device_own_fingerprint_qr 回 { size, rows }，rows 每列一個字串、'1' 是深色）；這裡只負責驗資料、畫在 canvas 上。
// 只用 canvas 畫（不用 v-html、不用 innerHTML、不產生圖片網址）。四周留 4 格空白，每格預設 4 個像素（跳出的視窗畫大一點）。
export const QR_TEXT = {
  alt: '這台電腦的指紋 QR Code',
  failed: '暫時做不出 QR Code，請稍後再試。',
}

/** 每格幾個像素 */
export const MODULE_PX = 4
/** 四周留白幾格（QR code 規格要求至少 4） */
export const QUIET = 4
const SIZE_MIN = 21
const SIZE_MAX = 177

/** Rust 回的資料 → { size, rows }；邊長不合 QR code 規格、列數或字元不對一律回 null（畫面就不畫） */
export function normalizeQr(raw) {
  const size = raw?.size
  const rows = raw?.rows
  if (!Number.isInteger(size) || size < SIZE_MIN || size > SIZE_MAX || (size - 21) % 4 !== 0) return null
  if (!Array.isArray(rows) || rows.length !== size) return null
  if (!rows.every(r => typeof r === 'string' && r.length === size && /^[01]+$/.test(r))) return null
  return { size, rows: rows.map(String) }
}

/** 畫圖計畫：整張圖的邊長（像素）與每個深色格的左上角座標。純函式，方便測 */
export function drawPlan(qr, modulePx = MODULE_PX, quiet = QUIET) {
  const n = normalizeQr(qr)
  if (!n) return null
  const side = (n.size + quiet * 2) * modulePx
  const dark = []
  n.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '1') dark.push([(x + quiet) * modulePx, (y + quiet) * modulePx])
  })
  return { side, modulePx, dark }
}

/** 畫到 canvas 的 2d 內容（白底黑格）。ctx 由呼叫端給（測試用假的） */
export function paint(ctx, plan) {
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, plan.side, plan.side)
  ctx.fillStyle = '#000000'
  for (const [x, y] of plan.dark) ctx.fillRect(x, y, plan.modulePx, plan.modulePx)
}

export const FpQrCanvas = {
  props: { qr: { type: Object, default: null }, modulePx: { type: Number, default: MODULE_PX } },
  setup(props) {
    const { ref, computed, onMounted, watch, nextTick } = globalThis.Vue
    const el = ref(null)
    const plan = computed(() => drawPlan(props.qr, Math.min(12, Math.max(MODULE_PX, Math.round(props.modulePx) || MODULE_PX))))
    const px = computed(() => plan.value?.side ?? 0)
    const draw = () => {
      const c = el.value
      const p = plan.value
      if (!c || !p) return
      const ctx = c.getContext('2d')
      if (ctx) paint(ctx, p)
    }
    onMounted(draw)
    watch(plan, () => { void nextTick(draw) })
    return { el, px, alt: QR_TEXT.alt }
  },
  template: '<canvas v-if="px" ref="el" class="fp-qr" role="img" :aria-label="alt" :width="px" :height="px" :style="{ width: px + \'px\', height: px + \'px\' }"></canvas>',
}
