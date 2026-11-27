// 「關於」頁共用元件 AsnAboutPanel（#1763 C1，規格 U3）：電腦設定（lib/settings-panel.mjs）與手機設定（m.html）都用這一個。
// 文字與連結只在 lib/about-info.mjs 寫一次（about 就是 aboutView() 算出來的）；這個元件只負責畫，不碰 Tauri、不存任何東西，按了什麼用事件交給殼。
// 版面照殼的 data-layout（shells/platform-attrs.mjs）：split＝電腦（連結一排按鈕、有「記錄」卡）、stack＝手機（連結一列一列、帶箭頭、沒有「記錄」卡）。
// 這一張只搬不改：兩種版面的標籤、順序、字都跟搬家前逐字相同；樣式在 ui/parts/about-panel.css（原本散在 style.css／mobile.css 的 about 規則搬進來）。
// 「檢視記錄」不是平台能力（不放 caps），有沒有由設定值清單 open-ui-log 那一列的平台欄決定，殼用 about-info.mjs 的 ABOUT_LOG_VIEWER 傳進 showLogViewer。
import { AsnButton } from '../lib/ui-kit.mjs'

export const ABOUT_LAYOUTS = Object.freeze(['split', 'stack'])

export const AsnAboutPanel = {
  name: 'AsnAboutPanel',
  components: { AsnButton },
  props: {
    about: { type: Object, required: true },                                  // aboutView() 的結果：intro、deviceLine、items、maker
    version: { type: String, default: '' },                                   // 版本號：電腦、手機各自取（st.version／info.version），照原樣顯示
    layout: { type: String, default: 'split' },                               // split＝電腦、stack＝手機（填別的值一律當 split）
    showLogViewer: { type: Boolean, default: false },                         // 要不要顯示「記錄」卡（檢視記錄）；預設不顯示，忘了傳時「什麼都不多給」
    logMsg: { type: String, default: '' },                                    // 檢視記錄之後的結果提示（只有顯示「記錄」卡時才看得到）
  },
  emits: ['open-link', 'open-update', 'open-guide', 'open-log'],
  setup(props, { emit }) {
    const { computed } = globalThis.Vue
    const stack = computed(() => props.layout === 'stack')
    const lay = computed(() => (stack.value ? 'is-stack' : 'is-split'))
    // 連結列：外部連結交出網址，版本紀錄與使用指引只交出「要去哪」
    const pick = l => { if (l.kind === 'link') emit('open-link', l.url); else if (l.kind === 'update') emit('open-update'); else emit('open-guide') }
    const caret = l => (l.kind === 'link' ? '↗' : '▸')
    return { stack, lay, pick, caret }
  },
  template: `<template v-if="!stack">
    <p class="asn-about-intro" :class="lay">{{ about.intro }}</p>
    <small class="asn-about-ver" :class="lay">版本 {{ version }}</small>
    <small class="asn-about-device" :class="lay" v-if="about.deviceLine">{{ about.deviceLine }}</small>
    <section class="set-card asn-about-links" :class="lay" aria-label="連結">
      <div class="upd-row">
        <asn-button v-for="l in about.items" :key="l.key" :class="'asn-about-' + l.key" @click="pick(l)">{{ l.label }}</asn-button>
      </div>
    </section>
    <section class="set-card" aria-label="記錄" v-if="showLogViewer">
      <b>記錄</b>
      <small>出問題時可以看這份記錄</small>
      <div class="upd-row">
        <asn-button @click="$emit('open-log')">檢視記錄</asn-button>
      </div>
      <small v-if="logMsg" role="status">{{ logMsg }}</small>
    </section>
    <small class="asn-about-maker" :class="lay">{{ about.maker }}</small>
  </template>
  <template v-else>
    <div class="m-card m-form asn-about-card">
      <p class="asn-about-intro" :class="lay">{{ about.intro }}</p>
      <p class="m-ver">版本 {{ version }}</p>
      <p class="m-ver asn-about-device" :class="lay" v-if="about.deviceLine">{{ about.deviceLine }}</p>
    </div>
    <div class="m-card m-form m-set-list asn-about-links" :class="lay">
      <ul class="m-guide-list">
        <li v-for="l in about.items" :key="l.key">
          <button class="m-row-btn" :class="'asn-about-' + l.key" type="button" @click="pick(l)"><span class="m-row-tx"><b>{{ l.label }}</b></span><span class="m-caret" aria-hidden="true">{{ caret(l) }}</span></button>
        </li>
      </ul>
    </div>
    <p class="m-ver asn-about-maker" :class="lay">{{ about.maker }}</p>
  </template>`,
}
