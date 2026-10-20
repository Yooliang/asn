// 對話區元件：分開模式的對話視窗（chat.html）與整合模式右邊的分頁內容（list.html）共用同一份版面。
// 只顯示、只發事件（send／nudge／toggle-dp），不碰網路與 Tauri；信件內文與名稱一律先 emo()（跳脫）才進 v-html。
import { EMO, emo, fmt, fmtDate, initial, plain } from './text.mjs'
import { foldArrow, hasSideCol, isCollapsed, msgLayout, paneClasses, sideOf } from './merge.mjs'

const { ref, computed, watch, nextTick, onMounted } = Vue
const STATUS = { online: '線上', busy: '忙碌', away: '暫離', offline: '顯示為離線' }

export const ChatPane = {
  name: 'ChatPane',
  props: {
    friend: { type: Object, default: null },
    me: { type: Object, default: () => ({ nick: '我', status: 'online' }) },
    log: { type: Array, default: () => [] },
    dpMode: { type: String, default: 'left' },     // 頭像模式：left／right＝側欄；inline＝頭像在每則訊息旁
    toolbar: { type: String, default: 'top' },     // 工具列位置：top（輸入框上方）／bottom（輸入框下方）
    bubble: { type: String, default: 'none' },     // 文字底色：none／color／auto
    dpCollapsed: { type: Boolean, default: false },  // 側欄收合（只對 left／right 有意義）
    active: { type: Boolean, default: true },      // 整合模式下只有目前分頁是 true；變成 true 時捲到底並聚焦輸入框
  },
  emits: ['send', 'nudge', 'toggle-dp'],
  setup(props, { emit }) {
    const draft = ref(''), pickerOpen = ref(false), nudgeCooling = ref(false)
    const msgsEl = ref(null), composeEl = ref(null)
    const sideCol = computed(() => hasSideCol(props.dpMode))
    const collapsed = computed(() => isCollapsed(props.dpMode, props.dpCollapsed))
    const classes = computed(() => paneClasses({ dpMode: props.dpMode, bubble: props.bubble, collapsed: props.dpCollapsed, toolbar: props.toolbar }))
    const arrow = computed(() => foldArrow(sideOf(props.dpMode), collapsed.value))
    const foldTip = computed(() => (collapsed.value ? '展開大頭貼' : '收起大頭貼'))
    const lay = k => msgLayout(k, { dpMode: props.dpMode, bubble: props.bubble })
    const scrollDown = () => nextTick(() => { const el = msgsEl.value; if (el) el.scrollTop = el.scrollHeight })
    watch(() => props.log, scrollDown)
    watch(() => props.active, a => { if (a) { scrollDown(); nextTick(() => composeEl.value && composeEl.value.focus()) } })
    function send() {
      const text = draft.value.trim(); if (!text) return
      emit('send', text)
      draft.value = ''; pickerOpen.value = false
    }
    function nudge() {
      if (nudgeCooling.value) return
      nudgeCooling.value = true; setTimeout(() => { nudgeCooling.value = false }, 2500)
      emit('nudge')
    }
    function insertEmo(code) {
      draft.value = (draft.value ? draft.value + ' ' : '') + code
      pickerOpen.value = false
      nextTick(() => composeEl.value && composeEl.value.focus())
    }
    onMounted(() => { scrollDown(); if (props.active) composeEl.value && composeEl.value.focus() })
    return { STATUS, EMO, sideCol, collapsed, classes, lay, arrow, foldTip, draft, pickerOpen, nudgeCooling, msgsEl, composeEl, emo, plain, initial, fmt, fmtDate, send, nudge, insertEmo }
  },
  template: `
<div class="pane chatpane" :class="classes" v-if="friend">
  <div class="conv">
    <div class="conv-main">
      <div class="to-line">給：<span v-html="emo(friend.nick)"></span>
        <span class="to-psm" v-if="friend.psm" v-html="emo(friend.psm)"></span>
      </div>
      <div class="warn" v-if="friend.status !== 'online'">
        <i>i</i>
        <span v-if="friend.status === 'offline'">{{ plain(friend.nick) }} 目前離線，訊息會先留在收發室，對方上線後才收得到。</span>
        <span v-else>{{ plain(friend.nick) }} 的狀態是{{ STATUS[friend.status] }}，可能無法馬上回應。</span>
      </div>
      <div class="msgs" ref="msgsEl" aria-live="polite">
        <template v-for="(m, i) in log" :key="i">
          <div v-if="m.k === 'sys'" class="sys" :class="{ nudge: m.nudge }">{{ m.text }}</div>
          <div v-else class="msg" :class="['al-' + lay(m.k).align, { mine: m.k === 'me' }]">
            <div class="m-av" v-if="lay(m.k).avatar"><div class="dp xs" :class="'st-' + friend.status" :style="{ '--h': friend.hue }"><span>{{ friend.dp }}</span></div></div>
            <div class="m-main">
              <div class="who">{{ m.k === 'me' ? plain(me.nick) : plain(friend.nick) }} 說：<time>{{ fmt(m.t) }}</time></div>
              <div class="m-body" :class="'tone-' + lay(m.k).tone" v-html="emo(m.text)"></div>
            </div>
          </div>
        </template>
      </div>
    </div>
    <button class="dp-fold" type="button" v-if="sideCol" @click="$emit('toggle-dp')" :aria-label="foldTip" :aria-expanded="!collapsed" :title="foldTip">{{ arrow }}</button>
    <div class="dp-col" v-if="sideCol && !collapsed">
      <div class="dp xl" :class="'st-' + friend.status" :style="{ '--h': friend.hue }"><span>{{ friend.dp }}</span></div>
    </div>
  </div>
  <div class="compose-row">
    <div class="compose-main">
      <div class="toolbar">
        <span class="tool-group">
          <button class="tool icon" type="button" @click="pickerOpen = !pickerOpen" :aria-expanded="pickerOpen" aria-label="表情符號" title="表情符號">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="#ffd84a" stroke="#b58a00"/><circle cx="8.6" cy="9.6" r="1.4" fill="#5a3b00"/><circle cx="15.4" cy="9.6" r="1.4" fill="#5a3b00"/><path d="M7.2 14c1.2 2.6 3 3.6 4.8 3.6s3.6-1 4.8-3.6" fill="none" stroke="#5a3b00" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
          <button class="tool caret" type="button" @click="pickerOpen = !pickerOpen" :aria-expanded="pickerOpen" aria-label="開啟表情選單" title="表情選單">▾</button>
        </span>
        <button class="tool icon" type="button" @click="nudge" :disabled="nudgeCooling" aria-label="傳送震動" title="傳送震動">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="8.2" y="4.5" width="7.6" height="15" rx="1.8" fill="#dfeaf6" stroke="#4a5d73" stroke-width="1.4"/><circle cx="12" cy="16.6" r="1" fill="#4a5d73"/><path d="M4.6 8.5l-2 3.5 2 3.5M19.4 8.5l2 3.5-2 3.5" fill="none" stroke="#d9302b" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="picker" v-if="pickerOpen" role="menu">
          <button v-for="[code, icon] in EMO" :key="code" type="button" :title="code" @click="insertEmo(code)" role="menuitem">{{ icon }}</button>
        </div>
      </div>
      <form class="composer" @submit.prevent="send">
        <textarea ref="composeEl" v-model="draft" @keydown.enter.exact.prevent="send" placeholder="輸入訊息，Enter 傳送，Shift+Enter 換行" aria-label="輸入訊息"></textarea>
        <button class="aero-btn" type="submit" :disabled="!draft.trim()">傳送</button>
      </form>
    </div>
    <span class="dp-fold-sp" v-if="sideCol"></span>
    <div class="dp-col" v-if="sideCol && !collapsed">
      <div class="dp xl" :class="'st-' + me.status" :style="{ '--h': 205 }"><span>{{ initial(me.nick) }}</span></div>
    </div>
  </div>
  <div class="typing">
    <template v-if="friend.waiting">✎ 已送出，等對方回信…</template>
    <template v-else-if="friend.lastAt">上次接收訊息是 {{ fmtDate(friend.lastAt) }}</template>
  </div>
</div>
<div class="pane" v-else><div class="empty-chat">找不到這位朋友。</div></div>`,
}
