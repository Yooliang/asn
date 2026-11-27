// 「提醒與聲音」頁共用元件 AsnNotifyPanel（#1763 C4，規格 U6）：電腦設定（lib/settings-panel.mjs）與手機設定（m.html）都用這一個。
// 項目清單由 notifyItems(caps) 產生，只用 F1 定好的能力名稱（shells/caps-*.mjs）：desktopToast＝右下角通知與提示音（電腦）、vibrate＝振動（手機）、push＝推播（手機的安卓外殼）。
// 「聲音」那三項（通知聲音、震動聲音、收到檔案聲音）在 lib/setting-needs.mjs 跟右下角通知同一列登記（notify，需要 desktopToast），所以歸 desktopToast，不另外加能力。
// 這個元件只負責畫與發事件：不碰 Tauri、不存任何東西。勾選用 toggle（{ key, on }）、推播用 push（on）交給殼；
// 手機的 prefs.vibrate*、推播開關與 Android 外殼的接線（權限、註冊）都留在殼（m.js）。
// 版面照殼的 data-layout（shells/platform-attrs.mjs）：split＝電腦（一個一個勾選）、stack＝手機（放在一張卡裡，推播底下有說明與權限提示）。
// 這一張只搬不改：兩種版面的標籤、順序、字都跟搬家前逐字相同；沿用原本的 class（chk、m-card、m-check、m-fine、m-err），沒有新增樣式，所以沒有 CSS 要搬。
import { NOTIFY_ITEMS } from '../lib/prefs.mjs'
import { PUSH_TEXT } from '../lib/mobile-push.mjs'

export const NOTIFY_LAYOUTS = Object.freeze(['split', 'stack'])

// 手機的兩個震動開關（字與順序照搬家前的 m.html）；key 是 prefs 的欄位名
const VIBRATE_ITEMS = [
  { key: 'vibrateNudge', label: '對方傳來「震動」時，手機跟著震動' },
  { key: 'vibrateMsg', label: '收到新訊息時輕輕震一下' },
]

// 這張能力表下有哪些項目（順序：右下角通知那一組、震動、推播）。token＝設定值清單與 setting-needs 裡的標記，測試用它比對 needs。
export function notifyItems(caps) {
  const out = []
  if (caps?.desktopToast === true) for (const i of NOTIFY_ITEMS) out.push({ kind: 'toggle', key: i.key, label: i.label, token: 'notify' })
  if (caps?.vibrate === true) for (const i of VIBRATE_ITEMS) out.push({ kind: 'toggle', key: i.key, label: i.label, token: `prefs.${i.key}` })
  if (caps?.push === true) out.push({ kind: 'push', key: 'push', label: PUSH_TEXT.label, token: 'prefs.push' })
  return out
}

export const AsnNotifyPanel = {
  name: 'AsnNotifyPanel',
  props: {
    items: { type: Array, default: () => [] },                                // notifyItems(caps) 的結果
    values: { type: Object, default: () => ({}) },                            // 勾選的現值：電腦是 st.notify，手機是 prefs
    push: { type: Object, default: () => ({ show: false }) },                 // 推播的畫面狀態（pushSettingView 的結果：show、checked、note、denied）；show 為 false 整組不顯示
    layout: { type: String, default: 'split' },                               // split＝電腦、stack＝手機（填別的值一律當 split）
  },
  emits: ['toggle', 'push'],
  setup(props) {
    const { computed } = globalThis.Vue
    const stack = computed(() => props.layout === 'stack')
    const lay = computed(() => (stack.value ? 'is-stack' : 'is-split'))
    const toggles = computed(() => props.items.filter(i => i.kind === 'toggle'))
    const pushItem = computed(() => props.items.find(i => i.kind === 'push') ?? null)
    return { stack, lay, toggles, pushItem }
  },
  template: `<template v-if="!stack">
    <label v-for="i in toggles" :key="i.key" class="chk asn-notify-item" :class="lay"><input type="checkbox" :checked="values[i.key]" @change="$emit('toggle', { key: i.key, on: $event.target.checked })" :aria-label="i.label" /><span>{{ i.label }}</span></label>
  </template>
  <template v-else>
    <div class="m-card m-form asn-notify-card" :class="lay">
      <label v-for="i in toggles" :key="i.key" class="m-check asn-notify-item"><input type="checkbox" :checked="values[i.key]" @change="$emit('toggle', { key: i.key, on: $event.target.checked })"> {{ i.label }}</label>
      <template v-if="pushItem && push.show">
        <label class="m-check asn-notify-push"><input type="checkbox" :checked="push.checked" @change="$emit('push', $event.target.checked)"> {{ pushItem.label }}</label>
        <p class="m-fine">{{ push.note }}</p>
        <p class="m-err" role="status" v-if="push.denied">{{ push.denied }}</p>
      </template>
    </div>
  </template>`,
}
