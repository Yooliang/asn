// 對話裡的一張圖（#1911）：依狀態畫縮圖／大圖／下載中／失敗／太大／過期。只顯示、只發事件，下載與排隊在 chatpane.mjs。
// 可以點開大圖的狀態（大圖已到、下載中、還沒捲進畫面）整張是一顆按鈕（class 仍叫 photo，冒煙探測與樣式沿用）；
// 失敗、太大、過期不是整張可點，裡面各自有按鈕或沒有動作，所以外層不用按鈕（按鈕裡不能再放按鈕）。
import { TEXT } from './photo-inline.mjs'

const GONE_RATIO = 0.62   // 過期的虛線框：高 ÷ 寬

export const AttPhoto = {
  name: 'AttPhoto',
  props: {
    p: { type: Object, required: true },
    state: { type: String, default: 'wait' },      // expired｜ready｜failed｜big｜loading｜wait（photo-inline.mjs 的 inlineState）
    src: { type: String, default: '' },            // 大圖（ready）或縮圖；沒有就是灰框
    box: { type: Object, required: true },          // { w, h, known }：單張的框大小
    cell: { type: Number, default: 0 },             // >0＝方格裡的一格，邊長就是它
    title: { type: String, default: '' },
    bigText: { type: String, default: TEXT.bigBtn },
    canOpen: { type: Boolean, default: true },      // 沒有 photoApi 就不能點開
  },
  emits: ['open', 'retry', 'load'],
  setup(props) {
    const T = TEXT
    const clickable = () => props.canOpen && (props.state === 'ready' || props.state === 'loading' || props.state === 'wait')
    const style = () => {
      if (props.cell > 0) return { width: props.cell + 'px', height: props.cell + 'px' }
      if (props.state === 'expired') return { width: Math.max(props.box.w, 160) + 'px', height: Math.round(Math.max(props.box.w, 160) * GONE_RATIO) + 'px' }
      return { width: props.box.w + 'px', height: props.box.h + 'px' }
    }
    const cls = () => ({
      [`st-${props.state}`]: true, blur: props.state === 'loading' || props.state === 'failed' || props.state === 'big',
      gone: props.state === 'expired', cell: props.cell > 0, nodim: !props.box.known && props.cell <= 0,
    })
    const aria = () => `照片：${props.title}${props.state === 'expired' ? '（已過期）' : ''}`
    return { T, clickable, style, cls, aria }
  },
  template: `
    <component :is="clickable() ? 'button' : 'div'" :type="clickable() ? 'button' : null" class="photo att-frame" :class="cls()" :style="style()"
      :data-att="p.id" :data-state="state" :title="title" :aria-label="aria()" @click="clickable() && $emit('open')">
      <img v-if="src && state !== 'expired'" :src="src" alt="">
      <span class="att-ov" v-if="state === 'loading'"><span class="att-spin" aria-hidden="true"></span><span class="att-t">{{ T.loading }}</span></span>
      <span class="att-ov" v-else-if="state === 'failed'" role="alert">
        <span class="att-t">{{ T.failTitle }}</span><small>{{ T.failHint }}</small>
        <button class="att-pill" type="button" @click.stop="$emit('retry')">{{ T.retry }}</button>
      </span>
      <span class="att-ov" v-else-if="state === 'big'">
        <button class="att-pill alt" type="button" @click.stop="$emit('load')">{{ bigText }}</button><small>{{ T.bigHint }}</small>
      </span>
      <span class="att-ov" v-else-if="state === 'expired'">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-4.5 3.5 3 3-2.5L20 16"/><path d="M3 3l18 18"/></svg>
        <span class="att-t">{{ T.expiredTitle }}</span><small>{{ T.expiredHint }}</small>
      </span>
    </component>`,
}
