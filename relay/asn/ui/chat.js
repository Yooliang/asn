// 單一好友的對話視窗（分開模式）：只顯示，狀態與動作都交給名單視窗裡的樞紐（用事件溝通）。版面在 lib/chatpane.mjs。
import { ChatPane } from './lib/chatpane.mjs'
import { avatarSrc, selfAvatarSrc } from './lib/avatar.mjs'
import { normalizeLook } from './lib/merge.mjs'
import { plain } from './lib/text.mjs'
import { ctl, emit, listen } from './lib/tauri.mjs'

const { createApp, ref, computed, onMounted } = Vue
const id = new URLSearchParams(location.search).get('id') ?? ''

const app = createApp({
  setup() {
    const snap = ref(null), log = ref([])
    const f = computed(() => snap.value?.friends.find(x => x.id === id) ?? null)
    const me = computed(() => snap.value?.me ?? { nick: '我', status: 'online' })
    const look = computed(() => normalizeLook(snap.value?.ui))   // 頭像模式／文字底色／收合：由樞紐（設定頁）決定
    const avatars = ref({})   // 各設備上傳的大頭貼（節點 → data URL），由樞紐推送
    const friendAv = computed(() => (f.value ? avatarSrc(f.value, { avatars: avatars.value }) : ''))
    const meAv = computed(() => selfAvatarSrc({ selfNode: snap.value?.selfNode ?? '', windowName: snap.value?.windowName ?? '', avatars: avatars.value }))
    listen('asn:avatars', a => { avatars.value = a ?? {} })
    listen('asn:state', s => { snap.value = s })
    listen('asn:log', p => { if (p.id === id) log.value = p.log })
    onMounted(() => {
      emit('asn:cmd', { op: 'hello', id })
      window.addEventListener('focus', () => emit('asn:cmd', { op: 'read', id }))
    })
    return {
      f, me, log, look, friendAv, meAv, plain, ctl,
      send: text => emit('asn:cmd', { op: 'send', id, text }),
      nudge: () => emit('asn:cmd', { op: 'nudge', id }),
      toggleDp: () => emit('asn:cmd', { op: 'dp' }),
    }
  },
})
app.component('chat-pane', ChatPane)
app.mount('#app')
