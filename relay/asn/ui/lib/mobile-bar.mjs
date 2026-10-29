// 手機對話頁的大按鈕列（#539 之四）：格子與反灰規則全部來自 mobile-ops.mjs 的 phoneBarSlots（＝電腦版的 barSlots），這裡只負責畫。
// 412 寬一列只放圖示；名稱與原因放 aria-label／title，長按（或點到反灰的）在列下方顯示一行字。
// 反灰一律用 aria-disabled（不用原生 disabled）：讀屏與長按都讀得到原因；點了在 tap 裡擋掉、不送出。
import { BAR_ICON, slotTip } from './mobile-ops.mjs'

export const LONG_PRESS_MS = 500
export const TIP_MS = 3000

export const MobileBar = {
  name: 'MobileBar',
  props: { slots: { type: Array, default: () => [] } },
  emits: ['pick'],
  setup(props, { emit }) {
    const { ref, onBeforeUnmount } = globalThis.Vue
    const tip = ref('')
    let pressTimer = 0, tipTimer = 0, pressed = false
    function showTip(s) {
      tip.value = slotTip(s)
      clearTimeout(tipTimer)
      tipTimer = setTimeout(() => { tip.value = '' }, TIP_MS)
    }
    function press(s) {
      pressed = false
      clearTimeout(pressTimer)
      pressTimer = setTimeout(() => { pressed = true; showTip(s) }, LONG_PRESS_MS)
    }
    function release() { clearTimeout(pressTimer) }
    // 長按過就不算點擊；反灰的只顯示原因
    function tap(s) {
      release()
      if (pressed) { pressed = false; return }
      if (!s.ok) { showTip(s); return }
      tip.value = ''
      emit('pick', s.key)
    }
    onBeforeUnmount(() => { clearTimeout(pressTimer); clearTimeout(tipTimer) })
    return { tip, tap, press, release, showTip, icon: k => BAR_ICON[k] ?? BAR_ICON.manage, slotTip }
  },
  template: `
<div class="m-abar" v-if="slots.length">
  <div class="m-abar-row" role="toolbar" aria-label="代理功能列">
    <button v-for="s in slots" :key="s.key" class="m-abtn" type="button" :data-slot="s.key" :aria-disabled="s.ok ? null : 'true'" :aria-label="s.label" :title="slotTip(s)"
      @click="tap(s)" @pointerdown="press(s)" @pointerup="release" @pointercancel="release" @pointerleave="release" @contextmenu.prevent="showTip(s)">
      <img :src="icon(s.key)" alt="" width="28" height="28"><span class="m-abadge" v-if="s.count > 0" :aria-label="s.count + ' 件'">{{ s.count }}</span>
    </button>
  </div>
  <p class="m-abar-tip" v-if="tip" role="status">{{ tip }}</p>
</div>`,
}
