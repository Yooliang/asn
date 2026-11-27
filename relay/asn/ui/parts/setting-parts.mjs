// 設定項目基本件 U1（#1763 F2）：卡片、一列、開關、下拉、輸入框、按鈕、說明。樣式在 ui/parts/parts.css（只用 --asn-* 變數）。
// 寫法同 lib/ui-kit.mjs：物件式元件、template 是字串、Vue 只在 setup 裡取用（node 也能載入）；按鈕直接用 #2105 的 AsnButton，不另做一套。
// 目前沒有任何頁面使用，只有測試在用；之後搬頁面時，確認才送出（change 事件），畫面暫存留在元件內。
import { AsnButton, AsnNote } from '../lib/ui-kit.mjs'

// ---------- 卡片 ----------
export const AsnSettingCard = {
  name: 'AsnSettingCard',
  props: { title: { type: String, default: '' } },
  template: `<section class="asn-card"><h3 class="asn-card-title" v-if="title">{{ title }}</h3><slot></slot></section>`,
}

// ---------- 一列：label 在左、控制項（預設插槽）在右 ----------
export const AsnSettingRow = {
  name: 'AsnSettingRow',
  props: { label: { type: String, default: '' }, hint: { type: String, default: '' } },
  template: `<div class="asn-row"><div class="asn-row-label"><span>{{ label }}</span><small class="asn-row-hint" v-if="hint">{{ hint }}</small></div><div class="asn-row-ctl"><slot></slot></div></div>`,
}

// ---------- 開關（勾選） ----------
export const AsnToggle = {
  name: 'AsnToggle',
  props: { modelValue: { type: Boolean, default: false }, label: { type: String, default: '' }, disabled: { type: Boolean, default: false } },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit }) {
    const onChange = e => { const v = e.target.checked === true; emit('update:modelValue', v); emit('change', v) }
    return { onChange }
  },
  template: `<label :class="['asn-toggle', { 'is-disabled': disabled }]"><input type="checkbox" :checked="modelValue" :disabled="disabled" @change="onChange"><span v-if="label">{{ label }}</span><slot></slot></label>`,
}

// ---------- 下拉 ----------
/** 選項整理：只收有 value 與 label 的；value 一律轉成字串（原生下拉的值都是字串） */
export function selectOptions(options) {
  return (Array.isArray(options) ? options : []).filter(o => o && o.value !== undefined && o.value !== null && typeof o.label === 'string')
    .map(o => ({ value: String(o.value), label: o.label }))
}
export const AsnSelect = {
  name: 'AsnSelect',
  props: { modelValue: { type: [String, Number], default: '' }, options: { type: Array, default: () => [] }, disabled: { type: Boolean, default: false }, label: { type: String, default: '' } },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit }) {
    const { computed } = globalThis.Vue
    const list = computed(() => selectOptions(props.options))
    const onChange = e => { const v = e.target.value; emit('update:modelValue', v); emit('change', v) }
    return { list, onChange }
  },
  template: `<select class="asn-select" :disabled="disabled" :aria-label="label || null" @change="onChange"><option v-for="o in list" :key="o.value" :value="o.value" :selected="o.value === String(modelValue)">{{ o.label }}</option></select>`,
}

// ---------- 輸入框 ----------
// 手機要保留 enterkeyhint 與 inputmode；按 Enter 會失焦（失焦時瀏覽器才送 change，等於「確認才送出」）
export const AsnText = {
  name: 'AsnText',
  props: {
    modelValue: { type: String, default: '' },
    type: { type: String, default: 'text' },
    placeholder: { type: String, default: '' },
    inputmode: { type: String, default: '' },
    enterkeyhint: { type: String, default: 'done' },
    maxlength: { type: Number, default: 0 },
    disabled: { type: Boolean, default: false },
    label: { type: String, default: '' },
  },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit }) {
    const onInput = e => emit('update:modelValue', e.target.value)
    const onChange = e => emit('change', e.target.value)
    const onEnter = e => { if (e.isComposing) return; e.target.blur() }
    return { onInput, onChange, onEnter }
  },
  template: `<input class="asn-text" :type="type" :value="modelValue" :placeholder="placeholder || null" :inputmode="inputmode || null" :enterkeyhint="enterkeyhint || null" :maxlength="maxlength > 0 ? maxlength : null" :disabled="disabled" :aria-label="label || null" @input="onInput" @change="onChange" @keydown.enter="onEnter">`,
}

// ---------- 按鈕：包 #2105 的 AsnButton（級別、狀態不變），只多一個 class 讓最小高度跟著點擊尺寸 ----------
export const AsnPartButton = {
  name: 'AsnPartButton',
  components: { AsnButton },
  props: { level: { type: String, default: 'secondary' }, state: { type: String, default: '' }, disabled: { type: Boolean, default: false } },
  emits: ['click'],
  template: `<asn-button class="asn-part-btn" :level="level" :state="state" :disabled="disabled" @click="$emit('click', $event)"><slot></slot></asn-button>`,
}

// ---------- 說明文字：併入共用元件（#2425），這裡只轉出同名元件，不另留一份 ----------

/** U1 基本件（目前沒有頁面註冊它們；搬頁面時再 app.component） */
export const PARTS_U1 = Object.freeze({ AsnSettingCard, AsnSettingRow, AsnToggle, AsnSelect, AsnText, AsnPartButton, AsnNote })
