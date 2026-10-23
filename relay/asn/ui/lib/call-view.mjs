// 通話畫面（#99）：蓋在對話區上面，大頭像、狀態文字、計時、靜音與掛斷。只顯示、只發事件，不碰麥克風與網路（邏輯在 call-session.mjs）。
// 所有字都當純文字輸出（不走會解析網頁語法的那條路），對方回的字幕不會被當成網頁語法。
import { PHASE_TEXT, formatCallTime } from './call-session.mjs'

const { computed } = globalThis.Vue

export const CallView = {
  name: 'CallView',
  props: {
    state: { type: Object, required: true },     // call-session 的 state
    name: { type: String, default: '' },
    avatar: { type: String, default: '' },
    hue: { type: [Number, String], default: 205 },
    status: { type: String, default: 'online' },
    phaseText: { type: Object, default: null },  // 各階段的說法（手機版有自己的）；沒給就用電腦版的
  },
  emits: ['hangup', 'mute'],
  setup(props) {
    const statusText = computed(() => (props.state.muted && props.state.phase !== 'speaking' && props.state.phase !== 'starting' ? '已靜音：你說的話不會送出' : (props.phaseText || PHASE_TEXT)[props.state.phase] || ''))
    const time = computed(() => formatCallTime(props.state.seconds))
    const level = computed(() => (props.state.muted ? 0 : Math.round((props.state.level || 0) * 100)))
    return { statusText, time, level }
  },
  template: `
<div class="callview" :class="{ mobile: !!phaseText }" role="dialog" aria-modal="true" :aria-label="'與 ' + name + ' 通話中'">
  <div class="call-top">通話中<span class="call-time" aria-label="通話時間">{{ time }}</span></div>
  <div class="call-who">
    <div class="dp xl" :class="[ 'st-' + status, { speaking: state.phase === 'speaking' } ]" :style="{ '--h': hue }"><span><img :src="avatar" alt=""></span></div>
    <div class="call-name">{{ name }}</div>
    <div class="call-status" role="status" aria-live="polite">{{ statusText }}</div>
    <div class="call-meter" aria-hidden="true"><i :style="{ width: level + '%' }"></i></div>
  </div>
  <div class="call-caps">
    <p class="call-cap" v-if="state.heard"><b>你：</b>{{ state.heard }}</p>
    <p class="call-cap" v-if="state.reply"><b>{{ name }}：</b>{{ state.reply }}</p>
    <p class="call-note" v-if="state.note" role="alert">{{ state.note }}</p>
  </div>
  <div class="call-actions">
    <button class="aero-btn" type="button" :aria-pressed="state.muted" :disabled="state.phase === 'starting'" @click="$emit('mute')">{{ state.muted ? '取消靜音' : '靜音' }}</button>
    <button class="aero-btn call-hang" type="button" @click="$emit('hangup')">掛斷</button>
  </div>
</div>`,
}
