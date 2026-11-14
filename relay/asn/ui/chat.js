// 單一好友的對話視窗（分開模式）：只顯示，狀態與動作都交給名單視窗裡的樞紐（用事件溝通）。版面在 lib/chatpane.mjs。
import { LineIcon } from './lib/line-icons.mjs'
import { blockContextMenu } from './lib/nomenu.mjs'
import { ChatPane } from './lib/chatpane.mjs'
import { avatarSrc, selfAvatarSrc } from './lib/avatar.mjs'
import { normalizeLook } from './lib/merge.mjs'
import { plain } from './lib/text.mjs'
import { createMic } from './lib/mic.mjs'
import { browserAudio } from './lib/tts-player.mjs'
import { createVoiceUi } from './lib/voice-ui.mjs'
import { CALL_BEAT_MS } from './lib/call-beats.mjs'
import { RESIZE_DIRS, ctl, emit, initFrame, invoke, listen, photoApi, resizeFrom, shotApi, termViewApi, transport } from './lib/tauri.mjs'

const { createApp, ref, computed, onMounted, reactive } = Vue
await initFrame()
const id = new URLSearchParams(location.search).get('id') ?? ''

const app = createApp({
  setup() {
    const snap = ref(null), log = ref([])
    const f = computed(() => snap.value?.friends.find(x => x.id === id) ?? null)
    const roster = computed(() => snap.value?.friends ?? [])   // 名單上的夥伴：通話辨識偏向這些名字
    const me = computed(() => snap.value?.me ?? { nick: '我', status: 'online' })
    const look = computed(() => normalizeLook(snap.value?.ui))   // 頭像模式／文字底色／收合：由樞紐（設定頁）決定
    const avatars = ref({})   // 各設備上傳的大頭貼（節點 → data URL），由樞紐推送
    const friendAv = computed(() => (f.value ? avatarSrc(f.value, { avatars: avatars.value }) : ''))
    const meAv = computed(() => selfAvatarSrc({ selfNode: snap.value?.selfNode ?? '', windowName: snap.value?.windowName ?? '', avatars: avatars.value }))
    const voice = createVoiceUi({ invoke, listen, createMic, createAudio: browserAudio, reactive })   // 念出訊息＋語音輸入（金鑰與辨識都在 Rust 端）
    listen('asn:avatars', a => { avatars.value = a ?? {} })
    listen('asn:state', s => { snap.value = s })
    listen('asn:log', p => { if (p.id === id) log.value = p.log })
    const cards = ref([])   // 群組：待主持人確認的卡片（名單視窗的樞紐讀好推來）
    listen('asn:room', p => { if (p.id === id) cards.value = p.cards ?? [] })
    onMounted(() => {
      emit('asn:cmd', { op: 'hello', id })
      window.addEventListener('focus', () => emit('asn:cmd', { op: 'read', id }))
    })
    // 通話中每 20 秒告訴名單視窗一聲（它的「自動念」這時要暫停，免得回信念兩次）
    let callTimer = null
    const callState = active => {
      clearInterval(callTimer); callTimer = null
      emit('asn:call', { id, active })
      if (active) callTimer = setInterval(() => emit('asn:call', { id, active: true }), CALL_BEAT_MS)
    }
    const selfNode = computed(() => snap.value?.selfNode ?? '')
    // 往上捲到頂載入更舊的信：請名單視窗的樞紐代跑，等它回報（它補進記錄的更新會先經 asn:log 到這裡）
    const loadOlder = fid => new Promise(resolve => {
      let un = null, timer = null
      const done = r => { clearTimeout(timer); if (un) un(); resolve(r) }
      timer = setTimeout(() => done({ more: true, added: 0, error: true }), 60_000)
      Promise.resolve(listen('asn:older', r => { if (r?.id === fid) done(r) })).then(u => { un = typeof u === 'function' ? u : null })
      emit('asn:cmd', { op: 'older', id: fid })
    })
    // 傳附件：請名單視窗的樞紐代送，等它回報這一張的結果（一次選多張時一張一張等，#1497）
    let attachSeq = 0
    const attach = async (photo, caption, done) => {
      const token = `${Date.now().toString(36)}-${++attachSeq}`
      let un = null, timer = null, over = false
      const finish = r => { if (over) return; over = true; clearTimeout(timer); if (un) un(); if (typeof done === 'function') done(r) }
      timer = setTimeout(() => finish({ ok: false, error: '等太久沒有結果，請看對話裡有沒有出現' }), 170_000)
      try { const u = await listen('asn:attach-done', r => { if (r?.token === token) finish({ ok: r.ok !== false, error: r.error ?? '' }) }); un = typeof u === 'function' ? u : null } catch { /* 聽不到就只能等逾時 */ }
      if (over && un) un()
      emit('asn:cmd', { op: 'attach', id, photo, caption, token })   // 先掛好再送，回報不會比監聽早到
    }
    return {
      cards,
      groupMenu: op => emit('asn:cmd', { op: 'group-menu', id, what: op }),
      groupDecide: (cardId, approve) => emit('asn:cmd', { op: 'group-decide', id, cardId, approve }),
      termViewApi, callState, f, roster, me, transport, selfNode, loadOlder, log, look, friendAv, meAv, voice, photoApi, shotApi, plain, ctl, RESIZE_DIRS, resizeFrom,
      send: (text, opts) => emit('asn:cmd', { op: 'send', id, text, voice: opts?.voice === true, replySeq: opts?.replySeq }),
      nudge: () => emit('asn:cmd', { op: 'nudge', id }),
      attach,
      toggleDp: () => emit('asn:cmd', { op: 'dp' }),
    }
  },
})
app.component('chat-pane', ChatPane)
app.component('line-icon', LineIcon)
app.mount('#app')
blockContextMenu(document)
