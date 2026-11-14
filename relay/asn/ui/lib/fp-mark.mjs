// 設備列的指紋小圖示（#1499，小良哥 11-14）：取代「已確認／未確認」的文字膠囊。
// 四種狀態（審查 11-14：不能只靠顏色、綠色只給「確認過」；小良哥：有通過的有顏色，不然就是灰色）：
//   confirmed   手機核對過那台電腦的指紋：綠色＋小勾
//   unconfirmed 手機還沒核對：灰色＋小「!」（小良哥：沒通過就是灰色；「!」讓它跟「離線」分得開）
//   remembered  電腦記住了那支手機的指紋：中性藍、不加記號（電腦對手機沒有「確認」這回事，不用綠色以免看成已確認）
//   unknown     電腦還沒記住：灰色＋小「!」
// 滑過（title）、長按（手機）或鍵盤聚焦會出現說明；aria-label 寫同一句。指紋圖形和線條圖示同一份（line-icons 的 fingerprint），
// 現代外觀是線條版；復古 Aero 不隱藏，另外加一圈底色讓它在 Aero 的灰底上看得清楚（style.css 的 .fpm）。
import { iconShapes } from './line-icons.mjs'

export const FP_MARK_TEXT = {
  phoneOn: '已確認指紋',
  phoneOff: '尚未確認指紋',
  deskOn: fp8 => (fp8 ? `已記住指紋 ${fp8}` : '已記住指紋'),
  deskOff: '還沒記住指紋',
}
export const FP_KINDS = ['confirmed', 'unconfirmed', 'remembered', 'unknown']
// 右下角的小記號：勾＝確認過；「!」＝還沒確認／還沒記住
const BADGE = {
  confirmed: [['path', { d: 'M3.2 6.2l1.9 1.9 3.7-4' }]],
  unconfirmed: [['path', { d: 'M6 2.8v3.6' }], ['path', { d: 'M6 8.9v.1' }]],
  unknown: [['path', { d: 'M6 2.8v3.6' }], ['path', { d: 'M6 8.9v.1' }]],
}
const LONG_MS = 450   // 長按多久出現說明
const SHOW_MS = 2500  // 說明出現多久

/** 手機的設備列：known＝這台在「認得的電腦」裡的紀錄（沒有回 null，不畫） */
export const phoneFpMark = known => (known ? (known.confirmed === true ? { kind: 'confirmed', label: FP_MARK_TEXT.phoneOn } : { kind: 'unconfirmed', label: FP_MARK_TEXT.phoneOff }) : null)
/** 電腦的設備列（只有手機有指紋）：known＝記住的那支手機（沒有＝還沒記住）；fp8＝前 8 碼 */
export const deskFpMark = (known, fp8) => (known ? { kind: 'remembered', label: FP_MARK_TEXT.deskOn(fp8) } : { kind: 'unknown', label: FP_MARK_TEXT.deskOff })

/** <fp-mark kind="confirmed" label="已確認指紋"> */
export const FpMark = {
  name: 'FpMark',
  props: { kind: { type: String, required: true }, label: { type: String, required: true }, size: { type: [Number, String], default: 18 } },
  setup(props) {
    const { h, ref, onBeforeUnmount } = globalThis.Vue
    const tip = ref(false)
    let hold = 0, hide = 0
    const clear = () => { clearTimeout(hold); hold = 0 }
    const show = () => { tip.value = true; clearTimeout(hide); hide = setTimeout(() => { tip.value = false }, SHOW_MS) }
    onBeforeUnmount(() => { clear(); clearTimeout(hide) })
    return () => {
      const kind = FP_KINDS.includes(props.kind) ? props.kind : 'unknown'
      const badge = BADGE[kind]
      return h('span', {
        class: ['fpm', kind], role: 'img', 'aria-label': props.label, title: props.label, tabindex: '0', 'data-kind': kind,
        // 長按（手機沒有滑過）：按住一下就出現說明；放開或移開就取消
        onPointerdown: e => { if (e.pointerType !== 'mouse') { clear(); hold = setTimeout(show, LONG_MS) } },
        onPointerup: clear, onPointerleave: clear, onPointercancel: clear,
        onContextmenu: e => { if (tip.value || hold) e.preventDefault() },
        onFocus: show, onBlur: () => { tip.value = false },
      }, [
        h('svg', { viewBox: '0 0 24 24', width: props.size, height: props.size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
          iconShapes('fingerprint').map(([tag, attrs]) => h(tag, attrs))),
        badge ? h('svg', { class: 'fpm-badge', viewBox: '0 0 12 12', width: 11, height: 11, fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
          [h('circle', { cx: '6', cy: '6', r: '5.4', class: 'fpm-badge-bg' }), ...badge.map(([tag, attrs]) => h(tag, attrs))]) : null,
        tip.value ? h('span', { class: 'fpm-tip', role: 'tooltip' }, props.label) : null,
      ])
    }
  },
}
