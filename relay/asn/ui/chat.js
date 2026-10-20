// 單一好友的對話視窗：只顯示，狀態與動作都交給名單視窗裡的樞紐（用事件溝通）。
import { EMO, emo, fmt, fmtDate, initial, plain } from './lib/text.mjs'
import { ctl, emit, listen } from './lib/tauri.mjs'

const { createApp, ref, computed, nextTick, onMounted } = Vue
const STATUS = { online: '線上', busy: '忙碌', away: '暫離', offline: '顯示為離線' }
const id = new URLSearchParams(location.search).get('id') ?? ''

createApp({
  setup() {
    const snap = ref(null), log = ref([])
    const draft = ref(''), pickerOpen = ref(false), nudgeCooling = ref(false)
    const msgsEl = ref(null), composeEl = ref(null)
    const f = computed(() => snap.value?.friends.find(x => x.id === id) ?? null)
    const me = computed(() => snap.value?.me ?? { nick: '我', status: 'online' })

    const scrollDown = () => nextTick(() => { const el = msgsEl.value; if (el) el.scrollTop = el.scrollHeight })
    listen('asn:state', s => { snap.value = s })
    listen('asn:log', p => { if (p.id === id) { log.value = p.log; scrollDown() } })

    function send() {
      const text = draft.value.trim(); if (!text) return
      emit('asn:cmd', { op: 'send', id, text })
      draft.value = ''; pickerOpen.value = false
    }
    function nudge() {
      if (nudgeCooling.value) return
      nudgeCooling.value = true; setTimeout(() => { nudgeCooling.value = false }, 2500)
      emit('asn:cmd', { op: 'nudge', id })
    }
    function insertEmo(code) {
      draft.value = (draft.value ? draft.value + ' ' : '') + code
      pickerOpen.value = false
      nextTick(() => composeEl.value && composeEl.value.focus())
    }
    onMounted(() => {
      emit('asn:cmd', { op: 'hello', id })
      window.addEventListener('focus', () => emit('asn:cmd', { op: 'read', id }))
      composeEl.value && composeEl.value.focus()
    })
    return { STATUS, EMO, f, me, log, draft, pickerOpen, nudgeCooling, msgsEl, composeEl, emo, plain, initial, fmt, fmtDate, send, nudge, insertEmo, ctl }
  },
}).mount('#app')
