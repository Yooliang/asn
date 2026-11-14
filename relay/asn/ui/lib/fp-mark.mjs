// 設備列的指紋小圖示（#1499，小良哥 11-14）：取代「已確認／未確認」的文字膠囊。
// 同一個圖示在兩個平台各自的意思（asn真 11-14 定）：
//   手機：核對過那台電腦的指紋＝彩色；還沒核對＝灰色。
//   電腦：記住了那支手機的指紋＝彩色（說明帶 8 碼指紋，讓人核對）；還沒記住＝灰色。
// 滑過（title）或長按（手機）會出現說明；aria-label 寫同一句。圖形和線條圖示同一份（line-icons 的 fingerprint），
// 所以現代外觀是線條版；復古 Aero 不隱藏，另外加一圈底色讓它在 Aero 的灰底上看得清楚（style.css 的 .fpm）。
import { iconShapes } from './line-icons.mjs'

export const FP_MARK_TEXT = {
  phoneOn: '已確認指紋',
  phoneOff: '尚未確認指紋',
  deskOn: fp8 => (fp8 ? `已記住指紋 ${fp8}` : '已記住指紋'),
  deskOff: '還沒記住指紋',
}
const LONG_MS = 450   // 長按多久出現說明
const SHOW_MS = 2500  // 說明出現多久

/** 手機的設備列：known＝這台在「認得的電腦」裡的紀錄（沒有回 null，不畫） */
export const phoneFpMark = known => (known ? { on: known.confirmed === true, label: known.confirmed === true ? FP_MARK_TEXT.phoneOn : FP_MARK_TEXT.phoneOff } : null)
/** 電腦的設備列（只有手機有指紋）：known＝記住的那支手機（沒有＝還沒記住）；fp8＝前 8 碼 */
export const deskFpMark = (known, fp8) => (known ? { on: true, label: FP_MARK_TEXT.deskOn(fp8) } : { on: false, label: FP_MARK_TEXT.deskOff })

/** <fp-mark :on="true" label="已確認指紋">：on＝彩色，否則灰色 */
export const FpMark = {
  name: 'FpMark',
  props: { on: { type: Boolean, default: false }, label: { type: String, required: true }, size: { type: [Number, String], default: 18 } },
  setup(props) {
    const { h, ref, onBeforeUnmount } = globalThis.Vue
    const tip = ref(false)
    let hold = 0, hide = 0
    const clear = () => { clearTimeout(hold); hold = 0 }
    const show = () => { tip.value = true; clearTimeout(hide); hide = setTimeout(() => { tip.value = false }, SHOW_MS) }
    onBeforeUnmount(() => { clear(); clearTimeout(hide) })
    return () => h('span', {
      class: ['fpm', props.on ? 'on' : 'off'], role: 'img', 'aria-label': props.label, title: props.label, tabindex: '0',
      // 長按（手機沒有滑過）：按住一下就出現說明；放開或移開就取消
      onPointerdown: e => { if (e.pointerType !== 'mouse') { clear(); hold = setTimeout(show, LONG_MS) } },
      onPointerup: clear, onPointerleave: clear, onPointercancel: clear,
      onContextmenu: e => { if (tip.value || hold) e.preventDefault() },
      onFocus: show, onBlur: () => { tip.value = false },
    }, [
      h('svg', { viewBox: '0 0 24 24', width: props.size, height: props.size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
        iconShapes('fingerprint').map(([tag, attrs]) => h(tag, attrs))),
      tip.value ? h('span', { class: 'fpm-tip', role: 'tooltip' }, props.label) : null,
    ])
  },
}
