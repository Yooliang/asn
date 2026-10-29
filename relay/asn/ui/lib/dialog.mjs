// 共用對話框：設定分類、指引內容都用它。✕、Esc、點外面（遮罩）都能關；內容可捲動。
// teleport 到 body、position:fixed、層級 --z-mask（#536）：不管在哪個元件裡打開（例如對話區的大按鈕區），遮罩都蓋滿整個視窗，
// 不會被所在容器的層級（stacking context）困住而只蓋住一部分；分離模式的窄名單視窗與整合主視窗都能用。
// 這個檔在 node 也要能載入（測試），所以 Vue 只在元件 setup 裡才取用。

// 純邏輯：這個按鍵要不要關閉對話框
export const closesDialog = e => e?.key === 'Escape' && !e.defaultPrevented

export const AsnDialog = {
  props: { title: { type: String, required: true } },
  emits: ['close'],
  setup(props, { emit }) {
    const { onMounted, onBeforeUnmount, ref } = globalThis.Vue
    const box = ref(null)
    const onKey = e => { if (closesDialog(e)) { e.preventDefault(); emit('close') } }
    onMounted(() => { document.addEventListener('keydown', onKey, true); box.value?.focus() })
    onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true))
    return { box }
  },
  template: `<teleport to="body"><div class="dlg-back" @mousedown.self="$emit('close')">
    <div class="dlg" ref="box" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1">
      <header class="dlg-head"><h3>{{ title }}</h3><button class="dlg-x" type="button" aria-label="關閉" title="關閉" @click="$emit('close')">✕</button></header>
      <div class="dlg-body"><slot></slot></div>
    </div>
  </div></teleport>`,
}
