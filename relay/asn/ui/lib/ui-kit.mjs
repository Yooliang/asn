// 共用畫面元件（#2105，規範見 docs/畫面規範.md；樣式在 ui/kit.css）。電腦與手機共用同一份。
// 這個檔在 node 也要能載入（測試），所以 Vue 只在元件 setup 裡才取用。

// ---------- 按鈕 ----------
export const BTN_LEVELS = Object.freeze(['primary', 'secondary', 'text'])
// 狀態只給規範裡的用途：danger（不可復原）、current（使用中，不能按）、busy（切換中，不能按）、blocked（不能做，不能按，原因寫在旁邊）、
// relogin（黃色，只給「重新登入」）
export const BTN_STATES = Object.freeze(['', 'danger', 'current', 'busy', 'blocked', 'relogin'])
const NOT_CLICKABLE = new Set(['current', 'busy', 'blocked'])

/** 按鈕的畫法：級別與狀態不合法一律退回 secondary／一般，不會畫出規範外的樣子。純函式，測試直接用 */
export function btnView({ level = 'secondary', state = '', disabled = false } = {}) {
  const lv = BTN_LEVELS.includes(level) ? level : 'secondary'
  const st = BTN_STATES.includes(state) ? state : ''
  const off = disabled === true || NOT_CLICKABLE.has(st)
  return { classes: ['asn-btn', `lv-${lv}`, ...(st ? [`st-${st}`] : [])], disabled: off, level: lv, state: st }
}

export const AsnButton = {
  name: 'AsnButton',
  props: {
    level: { type: String, default: 'secondary' },
    state: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
    fixed: { type: Boolean, default: false },   // 設備列上的固定尺寸（電腦 92、手機 100 寬）
    type: { type: String, default: 'button' },
  },
  emits: ['click'],
  setup(props, { emit }) {
    const { computed } = globalThis.Vue
    const view = computed(() => btnView(props))
    const classes = computed(() => (props.fixed ? [...view.value.classes, 'fixed'] : view.value.classes))
    const onClick = e => { if (!view.value.disabled) emit('click', e) }
    return { view, classes, onClick }
  },
  template: `<button :type="type" :class="classes" :disabled="view.disabled" :aria-busy="view.state === 'busy' ? 'true' : null" @click="onClick"><slot></slot></button>`,
}

// ---------- 動作列 ----------
export const AsnActions = {
  name: 'AsnActions',
  template: `<div class="asn-actions"><slot></slot></div>`,
}

// ---------- 原位確認 ----------
// 只說「會發生什麼」；取消在左、同意並做這件事在右（主要鈕）。取消不呼叫任何後端，由呼叫端決定 no 要做什麼
export const CONFIRM_NO_DEFAULT = '取消'
export const AsnConfirm = {
  name: 'AsnConfirm',
  components: { AsnButton, AsnActions },
  props: {
    text: { type: String, required: true },
    yes: { type: String, required: true },
    no: { type: String, default: CONFIRM_NO_DEFAULT },
    busy: { type: Boolean, default: false },
    danger: { type: Boolean, default: false },   // 不可復原的動作（移除、刪除、結束）：同意鈕畫成危險（紅）
  },
  emits: ['yes', 'no'],
  template: `<div class="asn-confirm" :role="danger ? 'alert' : 'group'">
    <p class="asn-confirm-text">{{ text }}</p>
    <asn-actions>
      <asn-button level="secondary" :disabled="busy" @click="$emit('no')">{{ no }}</asn-button>
      <asn-button :level="danger ? 'secondary' : 'primary'" :state="danger ? 'danger' : ''" :disabled="busy" @click="$emit('yes')">{{ yes }}</asn-button>
    </asn-actions>
  </div>`,
}

// ---------- 狀態行 ----------
export const STATUS_KINDS = Object.freeze(['busy', 'ok', 'fail', 'empty', 'unreadable'])
export const STATUS_TEXT = Object.freeze({ loading: '正在讀取…', retry: '重試' })
/** 狀態行的畫法：種類不合法就當「空」；讀不到才有「重試」 */
export function statusView({ kind = 'empty', retry = false } = {}) {
  const k = STATUS_KINDS.includes(kind) ? kind : 'empty'
  return { kind: k, classes: ['asn-status', `k-${k}`], spin: k === 'busy', retry: k === 'unreadable' && retry === true }
}

export const AsnStatus = {
  name: 'AsnStatus',
  components: { AsnButton },
  props: {
    kind: { type: String, default: 'empty' },
    text: { type: String, default: '' },
    retry: { type: Boolean, default: false },   // 讀不到時是否附「重試」文字鈕
  },
  emits: ['retry'],
  setup(props) {
    const { computed } = globalThis.Vue
    const view = computed(() => statusView(props))
    return { view, STATUS_TEXT }
  },
  template: `<p :class="view.classes" role="status"><span v-if="view.spin" class="asn-spin" aria-hidden="true"></span><span>{{ text || (view.kind === 'busy' ? STATUS_TEXT.loading : '') }}</span><asn-button v-if="view.retry" level="text" @click="$emit('retry')">{{ STATUS_TEXT.retry }}</asn-button></p>`,
}

// ---------- 提示（#2425，規範見 docs/畫面規範.md〈四之一、訊息與提示的位置〉） ----------
// 說的是「目前的狀況」：只有 info（一般說明）和 warn（要使用者處理）。warn 一定要附一個動作，沒有動作就不能用 warn。
// 動作的結果與這一區的資料狀態（空、讀不到）用 AsnStatus，不用這個。
export const NOTE_KINDS = Object.freeze(['info', 'warn'])
/** 提示的畫法：種類不合法退回 info；warn 沒有動作時 valid 是 false（元件會 console.warn，守門測試會擋）。純函式，測試直接用 */
export function noteView(kind = 'info', hasAction = false, banner = false) {
  const kindOk = NOTE_KINDS.includes(kind)
  const k = kindOk ? kind : 'info'
  const action = hasAction === true
  return {
    kind: k, kindOk, banner: banner === true, action,
    classes: ['asn-note', `asn-note-${k}`, ...(banner === true ? ['asn-note-banner'] : [])],
    role: k === 'warn' ? 'status' : 'note',
    valid: kindOk && (k !== 'warn' || action),
  }
}

export const AsnNote = {
  name: 'AsnNote',
  components: { AsnButton },
  props: {
    kind: { type: String, default: 'info' },
    banner: { type: Boolean, default: false },    // 橫幅版（位置 C：視窗頂端、整列寬）
    actionLabel: { type: String, default: '' },   // 動作文字鈕；要別的動作內容就用 action 插槽
  },
  emits: ['action'],
  setup(props, { slots }) {
    const { onMounted, onUpdated } = globalThis.Vue
    // slots 不是響應式的，不能用 computed 包：每次畫面重畫都重新判斷有沒有動作（有條件的 #action 插槽才會跟著出現／消失）
    const view = () => noteView(props.kind, !!slots.action || props.actionLabel !== '', props.banner)
    // 掛載與更新後檢查；同一句話不重複吵（狀況沒變就不再警告）
    let last = ''
    const check = () => {
      const v = view()
      const msg = !v.kindOk ? `AsnNote：不認得的種類「${props.kind}」，改用 info`
        : !v.valid ? 'AsnNote：warn 一定要附一個動作（actionLabel 或 action 插槽）' : ''
      if (msg && msg !== last) console.warn(msg)
      last = msg
    }
    onMounted(check)
    onUpdated(check)
    return { view }
  },
  template: `<p :class="view().classes" :role="view().role"><span class="asn-note-text"><slot></slot></span><span class="asn-note-action" v-if="view().action"><slot name="action"><asn-button level="text" @click="$emit('action', $event)">{{ actionLabel }}</asn-button></slot></span></p>`,
}

// ---------- 結果提示（#2425 位置 D；規範見 docs/畫面規範.md〈四之一〉） ----------
// 剛做完的動作結果（封存、釘選滿、切換帳號…）：成功 4 秒、失敗 6 秒後自己消失，同一時間只有一則（新的取代舊的），也可以按「×」關掉。
// 種類沿用 AsnStatus 的 ok／fail；純資訊不用這個。電腦與手機都呼叫 showResult(kind, text, { at })，頁面根部各掛一個 <asn-toast>（單一元件）。
// 位置（asn真 二審原則：不准蓋到任何按得到的東西，只准蓋純文字）：
//   手機：底部置中，浮在分頁列上方（沒給 at）。
//   電腦：呼叫端用 at 說這個動作發生在哪一區——'chat'＝對話視窗，放在訊息區下緣、輸入區正上方（錨點是 data-toast-anchor="chat"）；
//   'list'＝名單頁，放在名單區下緣（錨點是 data-toast-anchor="list"，離搜尋框與分頁列最遠）。指定的那區看不到就改用另一區；都沒有就退回底部置中。
// 失敗的原文由呼叫端先進 log，這裡只放白話一句。
export const TOAST_KINDS = Object.freeze(['ok', 'fail'])
export const TOAST_MS = Object.freeze({ ok: 4000, fail: 6000 })
export const TOAST_CLOSE = '關閉'
/** 結果提示的畫法：種類不認得當失敗（不把問題畫成成功）。純函式，測試直接用 */
export function toastView(kind = 'ok') {
  const kindOk = TOAST_KINDS.includes(kind)
  const k = kindOk ? kind : 'fail'
  return { kind: k, kindOk, ms: TOAST_MS[k], classes: ['asn-toast', `k-${k}`], role: 'status' }
}

export const TOAST_AT = Object.freeze(['chat', 'list'])
const TOAST_GAP = 8   // 貼著錨點下緣往上留的距離（像素）
/**
 * 電腦版的位置：給錨點的方框與視窗高度，回 { left, bottom, maxWidth }（都是 px 字串）；方框看不到（寬高 0）回 null。
 * 提示的下緣貼在錨點下緣往上 TOAST_GAP，水平置中在錨點內，寬度不超出錨點。純函式，測試直接用
 */
export function toastPlace(rect, viewH, edge = 'bottom') {
  if (!rect || !(rect.width >= 1) || !(rect.height >= 1) || !(viewH > 0)) return null
  const left = `${Math.round(rect.left + rect.width / 2)}px`, maxWidth = `${Math.max(120, Math.round(rect.width - 2 * TOAST_GAP))}px`
  // 貼上緣（終端或對方畫面：上緣是較舊的輸出，不擋正在打字的那一行）：提示的上緣貼在錨點上緣往下 TOAST_GAP，往下長
  if (edge === 'top') return { left, top: `${Math.round(rect.top + TOAST_GAP)}px`, bottom: 'auto', maxWidth }
  return { left, bottom: `${Math.max(0, Math.round(viewH - rect.bottom + TOAST_GAP))}px`, maxWidth }
}
/**
 * 依 at 在目前畫面找錨點（指定的那區看不到就改找另一區）；找不到回 null。
 * 同一個名稱可能有好幾個（整合模式每個對話分頁各一個，沒作用中的藏起來），所以逐一看、取第一個看得到的（方框有寬高）。
 * 錨點上的 data-toast-edge="top" 表示貼上緣（終端與對方畫面），沒有就貼下緣（訊息區、名單區）
 */
export function toastAnchorStyle(at, doc = globalThis.document, viewH = globalThis.innerHeight) {
  if (!TOAST_AT.includes(at) || !doc?.querySelectorAll) return null
  for (const name of [at, ...TOAST_AT.filter(a => a !== at)]) {
    for (const el of doc.querySelectorAll(`[data-toast-anchor="${name}"]`)) {
      const p = toastPlace(el.getBoundingClientRect(), viewH, el.getAttribute?.('data-toast-edge') === 'top' ? 'top' : 'bottom')
      if (p) return p
    }
  }
  return null
}

let toastCur = { kind: 'ok', text: '', seq: 0, at: '' }
let toastTimer = null
const toastSubs = new Set()
const toastEmit = () => { for (const f of toastSubs) f({ ...toastCur }) }
/** 目前顯示的那一則（沒有就是 text 空字串） */
export const currentResult = () => ({ ...toastCur })
/** 手動關掉 */
export function dismissResult() {
  globalThis.clearTimeout(toastTimer); toastTimer = null
  if (!toastCur.text) return
  toastCur = { ...toastCur, text: '' }
  toastEmit()
}
/** 顯示一則結果；新的直接取代舊的並重新計時。沒有文字就什麼都不做 */
export function showResult(kind, text, { at = '' } = {}) {
  const t = typeof text === 'string' ? text.trim() : ''
  if (!t) return
  const v = toastView(kind)
  globalThis.clearTimeout(toastTimer)
  toastCur = { kind: v.kind, text: t, seq: toastCur.seq + 1, at: TOAST_AT.includes(at) ? at : '' }
  toastTimer = globalThis.setTimeout(dismissResult, v.ms)
  toastEmit()
}
const watchResult = fn => { toastSubs.add(fn); return () => toastSubs.delete(fn) }

export const AsnToast = {
  name: 'AsnToast',
  setup() {
    const { ref, computed, onMounted, onBeforeUnmount } = globalThis.Vue
    const cur = ref(currentResult())
    let off = null
    onMounted(() => { cur.value = currentResult(); off = watchResult(v => { cur.value = v }) })
    onBeforeUnmount(() => { if (off) off() })
    const view = computed(() => toastView(cur.value.kind))
    // 電腦版：出現時（與視窗大小改變時）依 at 量錨點的位置；手機沒給 at，沒有行內位置，走 kit.css 的底部置中
    const place = ref(null)
    const replace = () => { place.value = cur.value.text ? toastAnchorStyle(cur.value.at) : null }
    const { watch, nextTick } = globalThis.Vue
    watch(() => cur.value.seq, () => { replace(); void nextTick(replace) }, { immediate: true })
    onMounted(() => globalThis.addEventListener?.('resize', replace))
    onBeforeUnmount(() => globalThis.removeEventListener?.('resize', replace))
    return { cur, view, place, dismissResult, TOAST_CLOSE }
  },
  template: `<div v-if="cur.text" :key="cur.seq" :class="view.classes" :role="view.role" :style="place"><span class="asn-toast-text">{{ cur.text }}</span><button type="button" class="asn-toast-close" :aria-label="TOAST_CLOSE" @click="dismissResult()">×</button></div>`,
}

// ---------- 「⋯」選單（#2111 ⑥） ----------
// 卡片右上角的更多動作：項目是動作說法（danger＝危險色，要走原位確認）；沒有項目就不畫「⋯」。點外面、按 Esc、選了項目都會收起
export const MORE_MENU_LABEL = '更多動作'
export function moreMenuItems(items) {
  return (Array.isArray(items) ? items : []).filter(i => i && typeof i.key === 'string' && i.key && typeof i.label === 'string' && i.label)
    .map(i => ({ key: i.key, label: i.label, danger: i.danger === true }))
}
export const AsnMoreMenu = {
  name: 'AsnMoreMenu',
  props: { items: { type: Array, default: () => [] }, label: { type: String, default: MORE_MENU_LABEL }, disabled: { type: Boolean, default: false } },
  emits: ['pick'],
  setup(props, { emit }) {
    const { ref, computed } = globalThis.Vue
    const open = ref(false)
    const list = computed(() => moreMenuItems(props.items))
    const toggle = () => { if (!props.disabled) open.value = !open.value }
    const close = () => { open.value = false }
    const pick = it => { open.value = false; emit('pick', it.key) }
    return { open, list, toggle, close, pick }
  },
  template: `<span class="asn-more" v-if="list.length" @keydown.esc="close">
    <button type="button" class="asn-more-btn" aria-haspopup="menu" :aria-expanded="open ? 'true' : 'false'" :aria-label="label" :disabled="disabled" @click="toggle">⋯</button>
    <span class="asn-more-back" v-if="open" @click="close"></span>
    <ul class="asn-more-list" role="menu" v-if="open"><li v-for="it in list" :key="it.key" role="none"><button type="button" role="menuitem" :class="['asn-more-item', { danger: it.danger }]" @click="pick(it)">{{ it.label }}</button></li></ul>
  </span>`,
}

/** 要註冊進 app 的共用元件（電腦 list.js、手機 m.js 都用這一份） */
export const UI_KIT = Object.freeze({ AsnButton, AsnActions, AsnConfirm, AsnStatus, AsnNote, AsnToast, AsnMoreMenu })
