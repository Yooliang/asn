// 單一好友的對話視窗（分開模式）：只顯示，狀態與動作都交給名單視窗裡的樞紐（用事件溝通）。版面在 lib/chatpane.mjs。
import { LineIcon } from './lib/line-icons.mjs'
import { blockContextMenu } from './lib/nomenu.mjs'
import { ChatPane } from './lib/chatpane.mjs'
import { avatarSrc, selfAvatarSrc } from './lib/avatar.mjs'
import { normalizeLook } from './lib/merge.mjs'
import { effectiveLook, initSkin, normalizeSkin } from './lib/skin.mjs'
import { plain } from './lib/text.mjs'
import { memberFriendId } from './lib/groups.mjs'
import { createMic } from './lib/mic.mjs'
import { browserAudio } from './lib/tts-player.mjs'
import { createVoiceUi } from './lib/voice-ui.mjs'
import { CALL_BEAT_MS } from './lib/call-beats.mjs'
import { RESIZE_DIRS, createWindowHub, ctl, emit, initFrame, invoke, photoApi, resizeFrom, shotApi, termViewApi, transport } from './lib/tauri.mjs'
import { installUiLog } from './lib/ui-log.mjs'
// 這個視窗的 [ASN] 記錄也寫進 ui.log（#2106 ⑥），行裡帶視窗名
installUiLog({ source: 'chat' })

const { createApp, ref, computed, onMounted, reactive } = Vue
await initFrame()
const id = new URLSearchParams(location.search).get('id') ?? ''

const app = createApp({
  setup() {
    const snap = ref(null), log = ref([])
    const f = computed(() => snap.value?.friends.find(x => x.id === id) ?? null)
    const roster = computed(() => snap.value?.friends ?? [])   // 名單上的夥伴：通話辨識偏向這些名字
    const me = computed(() => snap.value?.me ?? { nick: '我', status: 'online' })
    // 外觀：開窗時讀一次，之後別的視窗改了會改 <html data-skin>（skin-boot.js），這裡跟著看；LINE 固定頭像在旁、底色自動（只在讀的時候覆寫，不寫回）
    const skin = ref(initSkin())
    new MutationObserver(() => { skin.value = normalizeSkin(document.documentElement.dataset.skin) }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin'] })
    const look = computed(() => effectiveLook(skin.value, normalizeLook(snap.value?.ui)))   // 頭像模式／文字底色／收合：由樞紐（設定頁）決定
    const avatars = ref({})   // 各設備上傳的大頭貼（節點 → data URL），由樞紐推送
    const friendAv = computed(() => (f.value ? avatarSrc(f.value, { avatars: avatars.value }) : ''))
    const meAv = computed(() => selfAvatarSrc({ selfNode: snap.value?.selfNode ?? '', windowName: snap.value?.windowName ?? '', avatars: avatars.value }))
    const eventHub = createWindowHub()   // 終端畫面與語音共用同一座事件中心（#2038 PR-6）；tauri.mjs 與 initFrame 各自另有一座，只訂不相干的事件
    const voice = createVoiceUi({ invoke, hub: eventHub, createMic, createAudio: browserAudio, reactive })   // 念出訊息＋語音輸入（金鑰與辨識都在 Rust 端）
    // 視窗之間的事件（名單視窗的樞紐送來）：同一座事件中心，視窗關閉時一起消失，不單獨退訂
    eventHub.subscribe('asn:avatars', a => { avatars.value = a ?? {} })
    eventHub.subscribe('asn:state', s => { snap.value = s })
    eventHub.subscribe('asn:log', p => { if (p.id === id) log.value = p.log })
    const cards = ref([])   // 群組：待主持人確認的卡片（名單視窗的樞紐讀好推來）
    eventHub.subscribe('asn:room', p => { if (p.id === id) cards.value = p.cards ?? [] })
    // 先等四個接收處都向橋註冊完再跟名單視窗打招呼，回的快照才不會比接收處早到；掛不起來就記一行、照送（跟以前一樣不擋）
    const sayHello = async () => {
      try { await eventHub.readyFor(['asn:avatars', 'asn:state', 'asn:log', 'asn:room']) } catch (e) { console.warn(`[ASN] 對話視窗的事件沒掛好（asn:avatars／asn:state／asn:log／asn:room），照送 hello：${e?.message ?? e}`) }
      emit('asn:cmd', { op: 'hello', id })
    }
    onMounted(() => {
      void sayHello()
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
    // opts.toSeq：群組訊息編號點了、往前補載到那一則（#1530）
    const loadOlder = (fid, opts) => new Promise(resolve => {
      let off = () => {}, timer = null, over = false
      // 收到自己的回報或 60 秒逾時，兩者其一就退訂（退訂是同步的，橋還沒註冊完也能擋住）
      const done = r => { if (over) return; over = true; clearTimeout(timer); off(); resolve(r) }
      off = eventHub.subscribe('asn:older', r => { if (r?.id === fid) done(r) })
      timer = setTimeout(() => done({ more: true, added: 0, error: true }), 60_000)
      void (async () => {
        // 先掛好再送，回報不會比接收處早到；掛不起來就記一行、照送（最差等到逾時）
        try { await eventHub.readyFor(['asn:older']) } catch (e) { console.warn(`[ASN] 事件 asn:older 沒掛好，照送：${e?.message ?? e}`) }
        if (!over) emit('asn:cmd', { op: 'older', id: fid, ...(Number.isInteger(opts?.toSeq) ? { toSeq: opts.toSeq } : {}) })
      })()
    })
    // 群組裡點成員（#1515）：在夥伴名單裡就請名單視窗照從名單點進去一樣開；不在名單回 false（畫面自己說明）
    const openMember = key => {
      const id = memberFriendId(key, snap.value?.friends ?? [])
      if (!id) return false
      emit('asn:cmd', { op: 'open-chat', id })
      return true
    }
    // 傳附件：請名單視窗的樞紐代送，等它回報這一張的結果（一次選多張時一張一張等，#1497）
    let attachSeq = 0
    const attach = async (photo, caption, done) => {
      const token = `${Date.now().toString(36)}-${++attachSeq}`
      let off = () => {}, timer = null, over = false
      const finish = r => { if (over) return; over = true; clearTimeout(timer); off(); if (typeof done === 'function') done(r) }
      off = eventHub.subscribe('asn:attach-done', r => { if (r?.token === token) finish({ ok: r.ok !== false, error: r.error ?? '' }) })
      timer = setTimeout(() => finish({ ok: false, error: '等太久沒有結果，請看對話裡有沒有出現' }), 170_000)
      try { await eventHub.readyFor(['asn:attach-done']) } catch (e) { console.warn(`[ASN] 事件 asn:attach-done 沒掛好，照送（聽不到就只能等逾時）：${e?.message ?? e}`) }
      if (over) return   // 等的期間已經逾時結束
      emit('asn:cmd', { op: 'attach', id, photo, caption, token })   // 先掛好再送，回報不會比接收處早到
    }
    return {
      openMember,
      cards,
      groupMenu: op => emit('asn:cmd', { op: 'group-menu', id, what: op }),
      groupDecide: (cardId, approve) => emit('asn:cmd', { op: 'group-decide', id, cardId, approve }),
      skin, termViewApi, eventHub, callState, f, roster, me, transport, selfNode, loadOlder, log, look, friendAv, meAv, voice, photoApi, shotApi, plain, ctl, RESIZE_DIRS, resizeFrom,
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
