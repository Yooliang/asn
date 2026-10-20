// 截圖標註畫面（對話區裡的全區浮層）：畫筆、螢光筆、矩形、箭頭、文字、馬賽克、復原／重做、清除；確定後輸出 PNG 與說明文字。
// 只顯示與發事件（done／cancel），不碰網路與 Tauri；規則與畫法在 markup.mjs（有單元測試）。
// 兩層畫布：底層＝底圖＋已確定的標註（變動時才重畫），上層＝正在拖曳的那一筆（每次移動重畫，很輕）。
import { COLORS, COLOR_LABEL, SIZES, SIZE_LABEL, TOOLS, TOOL_LABEL, createMarkup, drawOp, exportSize, fitView, mosaicCell, rectOf, renderAll, strokeWidth, textSize, toImagePoint } from './markup.mjs'

const { ref, computed, reactive, onMounted, onBeforeUnmount, nextTick } = Vue
const ICON = {   // 每個圖示一條路徑；fill＝實心
  pen: { d: 'M4 20l1-4L16.5 4.5a2 2 0 0 1 3 3L8 19z' },
  marker: { d: 'M5 19h6M9 15l7-9 3 2.4-7 9L8 17z M3 21.5h18' },
  rect: { d: 'M4 6h16v12H4z' },
  arrow: { d: 'M5 19L18 6M18 6h-7M18 6v7' },
  text: { d: 'M5 6h14M12 6v13M9 19h6' },
  mosaic: { d: 'M4 4h5v5H4zM14 4h5v5h-5zM9 9h5v5H9zM4 14h5v5H4zM14 14h5v5h-5z', fill: true },
}

export const Annotator = {
  name: 'Annotator',
  props: {
    blob: { type: Object, required: true },        // 要標註的圖片（截圖的 PNG，或貼上的圖片）
    caption: { type: String, default: '' },         // 說明文字的初始值（輸入框裡原本打的字）
    busy: { type: Boolean, default: false },        // 送出處理中（鎖住按鈕）
    message: { type: String, default: '' },         // 處理失敗等提示
  },
  emits: ['done', 'cancel'],
  setup(props, { emit }) {
    const baseEl = ref(null), topEl = ref(null), boxEl = ref(null), textEl = ref(null), capEl = ref(null)
    const tool = ref('pen'), color = ref(COLORS[0]), size = ref(2)
    const text = reactive({ open: false, x: 0, y: 0, left: 0, top: 0, value: '' })
    const cap = ref(props.caption)
    const note = ref('')
    const marks = createMarkup(), tick = ref(0)   // tick：清單變動時讓按鈕狀態重算
    const state = reactive({ w: 0, h: 0, view: { w: 0, h: 0 } })
    let bmp = null, draft = null, drawing = false

    const canUndo = computed(() => (tick.value, marks.canUndo))
    const canRedo = computed(() => (tick.value, marks.canRedo))
    const hasMarks = computed(() => (tick.value, marks.hasMarks))
    const makeCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c }

    function repaint() {
      const cv = baseEl.value; if (!cv || !bmp) return
      const g = cv.getContext('2d')
      g.clearRect(0, 0, cv.width, cv.height)
      renderAll(g, bmp, marks.visible(), makeCanvas)
      tick.value++
    }
    function repaintTop() {
      const cv = topEl.value; if (!cv) return
      const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height)
      if (!draft) return
      if (draft.type === 'mosaic') {   // 拖曳中只畫虛線框，放開才真的打馬賽克
        g.save(); g.setLineDash([8, 6]); g.lineWidth = Math.max(2, state.w / 600); g.strokeStyle = '#1e88e5'; g.strokeRect(draft.x, draft.y, draft.w, draft.h); g.restore()
      } else drawOp(g, draft, bmp, makeCanvas)
    }
    function fit() {
      const box = boxEl.value; if (!box || !bmp) return
      state.view = fitView(state.w, state.h, box.clientWidth - 8, box.clientHeight - 8)
    }
    async function load() {
      try { bmp = await createImageBitmap(props.blob) } catch { note.value = '讀不了這張圖片。'; return }
      state.w = bmp.width; state.h = bmp.height
      await nextTick()
      for (const el of [baseEl.value, topEl.value]) { el.width = bmp.width; el.height = bmp.height }
      fit(); repaint()
    }

    const pointOf = e => {
      const r = topEl.value.getBoundingClientRect()
      return toImagePoint(e.clientX - r.left, e.clientY - r.top, { w: r.width, h: r.height }, state.w, state.h)
    }
    const baseOp = () => ({ color: color.value })
    function down(e) {
      if (e.button !== 0 || props.busy) return
      if (text.open) commitText()
      const p = pointOf(e)
      if (tool.value === 'text') { openText(e, p); return }
      topEl.value.setPointerCapture(e.pointerId)
      drawing = true
      const t = tool.value
      if (t === 'pen' || t === 'marker') draft = { ...baseOp(), type: t, width: strokeWidth(size.value, state.w, t), pts: [[p.x, p.y]], x0: p.x, y0: p.y }
      else if (t === 'rect') draft = { ...baseOp(), type: 'rect', width: strokeWidth(size.value, state.w), x: p.x, y: p.y, w: 0, h: 0, x0: p.x, y0: p.y }
      else if (t === 'arrow') draft = { ...baseOp(), type: 'arrow', width: strokeWidth(size.value, state.w), x1: p.x, y1: p.y, x2: p.x, y2: p.y }
      else draft = { type: 'mosaic', cell: mosaicCell(state.w), x: p.x, y: p.y, w: 0, h: 0, x0: p.x, y0: p.y }
      repaintTop()
    }
    function move(e) {
      if (!drawing || !draft) return
      const p = pointOf(e)
      if (draft.pts) draft.pts.push([p.x, p.y])
      else if (draft.type === 'arrow') { draft.x2 = p.x; draft.y2 = p.y }
      else Object.assign(draft, rectOf(draft.x0, draft.y0, p.x, p.y))
      repaintTop()
    }
    function up() {
      if (!drawing) return
      drawing = false
      const d = draft; draft = null
      if (d && marks.commit(d)) repaint()
      repaintTop()
    }

    // 文字：在點的位置放一個輸入框，Enter 確定（Shift+Enter 換行）、Esc 取消這一段字
    function openText(e, p) {
      const r = topEl.value.getBoundingClientRect(), b = boxEl.value.getBoundingClientRect()
      Object.assign(text, { open: true, x: p.x, y: p.y, left: e.clientX - b.left, top: e.clientY - b.top, value: '' })
      void r
      nextTick(() => textEl.value && textEl.value.focus())
    }
    function commitText() {
      if (!text.open) return
      const v = text.value; text.open = false
      if (marks.commit({ type: 'text', color: color.value, size: textSize(size.value, state.w), x: text.x, y: text.y, text: v })) repaint()
    }
    const cancelText = () => { text.open = false }

    const undo = () => { if (text.open) return cancelText(); if (marks.undo()) repaint() }
    const redo = () => { if (marks.redo()) repaint() }
    const clearAll = () => { if (marks.clear()) repaint() }

    // 輸出：標註後的整張圖（長邊超過上限先縮小）→ PNG
    async function finish() {
      if (props.busy || !bmp) return
      commitText()
      const { w, h } = exportSize(state.w, state.h)
      let out = baseEl.value
      if (w !== state.w || h !== state.h) {
        out = makeCanvas(w, h)
        const g = out.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(baseEl.value, 0, 0, w, h)
      }
      const png = await new Promise(res => out.toBlob(res, 'image/png'))
      if (!png) { note.value = '這個環境不能輸出圖片。'; return }
      emit('done', { blob: png, caption: cap.value.trim() })
    }
    const cancel = () => { if (!props.busy) emit('cancel') }

    function onKey(e) {
      const typing = text.open || e.target === capEl.value
      if (e.key === 'Escape') { e.preventDefault(); if (text.open) cancelText(); else cancel(); return }
      if (typing) return
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo() }
      else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo() }
    }
    let ro = null
    onMounted(() => {
      window.addEventListener('keydown', onKey, true)
      ro = new ResizeObserver(fit); ro.observe(boxEl.value)
      void load()
    })
    onBeforeUnmount(() => { window.removeEventListener('keydown', onKey, true); ro && ro.disconnect(); bmp && bmp.close && bmp.close() })

    return { baseEl, topEl, boxEl, textEl, capEl, tool, color, size, text, cap, note, state, canUndo, canRedo, hasMarks, TOOLS, TOOL_LABEL, COLORS, COLOR_LABEL, SIZES, SIZE_LABEL, ICON, down, move, up, commitText, cancelText, undo, redo, clearAll, finish, cancel }
  },
  template: `
<div class="annot" role="dialog" aria-modal="true" aria-label="標註圖片">
  <div class="an-bar">
    <span class="an-group" role="group" aria-label="工具">
      <button v-for="t in TOOLS" :key="t" type="button" class="an-btn" :class="{ on: tool === t }" :aria-pressed="tool === t" :aria-label="TOOL_LABEL[t]" :title="TOOL_LABEL[t]" @click="tool = t">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path :d="ICON[t].d" :fill="ICON[t].fill ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </span>
    <span class="an-group" role="group" aria-label="顏色">
      <button v-for="c in COLORS" :key="c" type="button" class="an-color" :class="{ on: color === c }" :style="{ background: c }" :aria-pressed="color === c" :aria-label="'顏色：' + COLOR_LABEL[c]" :title="COLOR_LABEL[c]" @click="color = c"></button>
    </span>
    <span class="an-group" role="group" aria-label="粗細">
      <button v-for="s in SIZES" :key="s" type="button" class="an-size" :class="{ on: size === s }" :aria-pressed="size === s" :aria-label="'粗細：' + SIZE_LABEL[s]" :title="SIZE_LABEL[s]" @click="size = s"><i :style="{ height: (s * 2 + 1) + 'px' }"></i></button>
    </span>
    <span class="an-group">
      <button type="button" class="an-btn" :disabled="!canUndo" aria-label="復原" title="復原（Ctrl+Z）" @click="undo"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M9 7L4 12l5 5M4.5 12H15a5 5 0 0 1 0 10h-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 -5)"/></svg></button>
      <button type="button" class="an-btn" :disabled="!canRedo" aria-label="重做" title="重做（Ctrl+Y）" @click="redo"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M15 7l5 5-5 5M19.5 12H9a5 5 0 0 0 0 10h3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 -5)"/></svg></button>
      <button type="button" class="an-btn" :disabled="!hasMarks" aria-label="清除全部標註" title="清除全部標註" @click="clearAll"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    </span>
  </div>
  <div class="an-box" ref="boxEl">
    <div class="an-stage" :style="{ width: state.view.w + 'px', height: state.view.h + 'px' }">
      <canvas ref="baseEl" class="an-cv" aria-label="要標註的圖片"></canvas>
      <canvas ref="topEl" class="an-cv an-top" :class="'tool-' + tool" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up"></canvas>
    </div>
    <textarea v-if="text.open" ref="textEl" class="an-text" rows="1" v-model="text.value" :style="{ left: text.left + 'px', top: text.top + 'px', color: color }" aria-label="輸入要放在圖上的文字" @keydown.enter.exact.prevent="commitText" @keydown.esc.stop.prevent="cancelText" @blur="commitText"></textarea>
    <div class="an-msg" v-if="note || message" role="status">{{ note || message }}</div>
  </div>
  <div class="an-foot">
    <input ref="capEl" class="an-cap" type="text" v-model="cap" maxlength="500" placeholder="說明文字（選填）" aria-label="說明文字" @keydown.enter.prevent="finish">
    <button class="aero-btn" type="button" :disabled="busy" @click="finish">{{ busy ? '傳送中…' : '傳送' }}</button>
    <button class="aero-btn" type="button" :disabled="busy" @click="cancel">取消</button>
  </div>
</div>`,
}
