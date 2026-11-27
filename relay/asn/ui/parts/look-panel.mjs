// 「外觀」頁共用元件 AsnLookPanel（加外觀三選一 AsnSkinPicker）（#1763 C3，規格 U5）：電腦設定（lib/settings-panel.mjs）與手機設定（m.html）都用這一個。
// 項目清單由 lookItems(caps, custom) 產生：外觀三選一每個平台都有；視窗外框…分組依這一組「自訂選項」只在 custom 為 true 時才有，
// custom 看設定值清單的平台欄（lib/look-info.mjs 的 LOOK_CUSTOM），不是能力，所以不放 caps；視窗外框另外還要能力 desktopWindow（settingNeeds('frame')）。
// 依所選外觀用不到的選項整個藏起來（不是變灰，#1547，規則在 lib/settings-cats.mjs 的 lookShows）；存檔的值不動。
// 這個元件只負責畫與發事件：不碰 Tauri、不存任何東西。選外觀發 skin（外觀代號）、其他選單發 pick（{ key, value }），由殼接到原本的函式
// （電腦 act('skin', k)、act(key, value)；手機 prefs.skin = k）。
// 版面照殼的 data-layout（shells/platform-attrs.mjs）：split＝電腦（外觀縮圖橫排在欄位組裡、選單一個一個）、stack＝手機（外觀放在一張卡裡直排）。
// 這一張只搬不改：標籤、選項、順序、字都跟搬家前逐字相同；沿用原本的 class（skin-pick、skin-opt、skin-mini、chk、set-sel、m-card、m-form、m-check），
// 另外加 asn-look-* 與 is-split／is-stack 當記號（沒有任何樣式選擇器用到），所以沒有 CSS 要搬。縮圖 skin-mini 本來就是兩邊共用。
import { BUBBLES, BUBBLE_LABEL, DP_LABEL, DP_MODES, MODES, MODE_LABEL, TOOLBARS, TOOLBAR_LABEL } from '../lib/merge.mjs'
import { SKINS, SKIN_LABEL } from '../lib/skin.mjs'
import { FRAMES, FRAME_LABEL } from '../lib/prefs.mjs'
import { DIMS, groupOptions } from '../lib/dims.mjs'
import { lookShows } from '../lib/settings-cats.mjs'
import { settingNeeds } from '../lib/setting-needs.mjs'

export const LOOK_LAYOUTS = Object.freeze(['split', 'stack'])

// 畫面上的順序與標籤（照搬家前）。key 同時是設定值清單與 setting-needs 裡的標記（token）、也是 act 的 op 名
const LOOK_ALL = [
  { key: 'skin', label: '外觀' },
  { key: 'frame', label: '視窗外框' },
  { key: 'mode', label: '視窗模式' },
  { key: 'dpMode', label: '頭像模式' },
  { key: 'toolbar', label: '工具列位置' },
  { key: 'bubble', label: '文字底色' },
  { key: 'tabDim', label: '分頁依' },
  { key: 'groupDim', label: '分組依' },
]

/** 這張能力表、這個平台的「有沒有自訂選項」下有哪些項目（順序固定）。custom 必須明確是 true 才放行（沒傳＝只有外觀）。 */
export function lookItems(caps, custom) {
  return LOOK_ALL
    .filter(i => i.key === 'skin' || (custom === true && settingNeeds(i.key).every(n => caps?.[n] === true)))
    .map(i => ({ key: i.key, label: i.label, token: i.key }))
}

// 每個選單的選項（值、字）
const OPTIONS = {
  frame: () => FRAMES.map(v => ({ value: v, label: FRAME_LABEL[v] })),
  mode: () => MODES.map(v => ({ value: v, label: MODE_LABEL[v] })),
  dpMode: () => DP_MODES.map(v => ({ value: v, label: DP_LABEL[v] })),
  toolbar: () => TOOLBARS.map(v => ({ value: v, label: TOOLBAR_LABEL[v] })),
  bubble: () => BUBBLES.map(v => ({ value: v, label: BUBBLE_LABEL[v] })),
  tabDim: () => DIMS.map(d => ({ value: d.key, label: d.label })),
}

export const AsnSkinPicker = {
  name: 'AsnSkinPicker',
  props: {
    skin: { type: String, default: '' },                       // 目前的外觀（空的當 aero）
    layout: { type: String, default: 'split' },                // split＝電腦、stack＝手機（填別的值一律當 split）
  },
  emits: ['pick'],
  setup(props, { emit }) {
    const { computed } = globalThis.Vue
    const stack = computed(() => props.layout === 'stack')
    const cur = computed(() => props.skin || 'aero')
    // 手機版面的單選維持原本 v-model 的寫法（只改元素的勾選狀態、不寫 checked 屬性，畫面零差異）；選了送 pick，由殼寫 prefs.skin
    const model = computed({ get: () => cur.value, set: k => emit('pick', k) })
    return { stack, cur, model, SKINS, SKIN_LABEL }
  },
  template: `<fieldset v-if="!stack" class="skin-pick asn-look-skin is-split" aria-label="外觀">
    <legend>外觀</legend>
    <label v-for="k in SKINS" :key="k" class="skin-opt asn-look-skin-opt" :class="{ on: cur === k }">
      <span class="skin-mini" :class="'skin-mini-' + k" aria-hidden="true"><i></i><b></b></span>
      <span class="chk"><input type="radio" name="skin" :value="k" :checked="cur === k" @change="$emit('pick', k)" /><span>{{ SKIN_LABEL[k] }}</span></span>
    </label>
  </fieldset>
  <div v-else class="m-card m-form skin-pick asn-look-skin is-stack" role="radiogroup" aria-label="外觀">
    <label v-for="k in SKINS" :key="k" class="m-check skin-opt asn-look-skin-opt" :class="{ on: cur === k }">
      <span class="skin-mini" :class="'skin-mini-' + k" aria-hidden="true"><i></i><b></b></span>
      <input type="radio" name="skin" :value="k" v-model="model"> {{ SKIN_LABEL[k] }}
    </label>
  </div>`,
}

export const AsnLookPanel = {
  name: 'AsnLookPanel',
  components: { AsnSkinPicker },
  props: {
    items: { type: Array, default: () => [] },                 // lookItems(caps, custom) 的結果
    skin: { type: String, default: '' },                       // 目前的外觀：電腦是 st.skin，手機是 prefs.skin
    values: { type: Object, default: () => ({}) },             // 各選單的現值：電腦是 st（frame、mode、dpMode、toolbar、bubble、tabDim、groupDim），手機是 prefs（沒有自訂選項時用不到）
    layout: { type: String, default: 'split' },                // split＝電腦、stack＝手機
  },
  emits: ['skin', 'pick'],
  setup(props) {
    const { computed } = globalThis.Vue
    const hasSkin = computed(() => props.items.some(i => i.key === 'skin'))
    // 自訂選項：依所選外觀藏起來用不到的（lookShows 傳原本的值，空的視同 aero，aero 什麼都不藏）
    const shown = computed(() => props.items.filter(i => i.key !== 'skin' && lookShows(props.skin, i.key)))
    const optionsOf = key => (key === 'groupDim' ? groupOptions(props.values.tabDim).map(d => ({ value: d.key, label: d.label })) : OPTIONS[key]())
    return { hasSkin, shown, optionsOf }
  },
  template: `<asn-skin-picker v-if="hasSkin" :skin="skin" :layout="layout" @pick="k => $emit('skin', k)"></asn-skin-picker>
  <label v-for="o in shown" :key="o.key" class="asn-look-opt is-split">{{ o.label }}
    <select class="set-sel" :value="values[o.key]" @change="$emit('pick', { key: o.key, value: $event.target.value })" :aria-label="o.label"><option v-for="x in optionsOf(o.key)" :key="x.value" :value="x.value">{{ x.label }}</option></select>
  </label>`,
}
