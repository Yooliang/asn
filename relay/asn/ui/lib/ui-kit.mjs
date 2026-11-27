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
export const UI_KIT = Object.freeze({ AsnButton, AsnActions, AsnConfirm, AsnStatus, AsnNote, AsnMoreMenu })
