// 好友名單視窗：同時是整個程式的「樞紐」——AsnCore 跑在這裡，對話視窗與提示視窗只顯示、用事件下指令。
// 關掉這扇＝結束程式（Rust 端處理）。
import { blockContextMenu } from './lib/nomenu.mjs'
import { AsnCore } from './lib/core.mjs'
import { ADS, AD_MS, FIXED_TABS, goAd, groupHeading, groupRows, moreUnread, nextAd, normalizeTab, openAdWith, prevAd, statusNote } from './lib/tabs.mjs'
import { GUIDES, closeGuide, guideByKey, hideGuide, numbered, openGuide, rightView } from './lib/guides.mjs'
import { DIMS, groupOptions, loadDims, pageTabs, withTabDim } from './lib/dims.mjs'
import { normalizeSearchQuery, rosterShownGroups } from './lib/search.mjs'
import { emo, initial, plain } from './lib/text.mjs'
import { ChatPane } from './lib/chatpane.mjs'
import { avatarFor, avatarSrc, isAvatarDataUrl, removeAvatarUpload, uploadAvatarFile, selfAvatarSrc } from './lib/avatar.mjs'
import { avatarFromFile } from './lib/avatar-canvas.mjs'
import { BUBBLES, BUBBLE_LABEL, TOOLBARS, TOOLBAR_LABEL, DP_LABEL, DP_MODES, MODES, MODE_LABEL, normalizeBubble, normalizeDpMode, normalizeLook, normalizeMode, normalizeSize, switchMode, tabVisible, toggleCollapsed } from './lib/merge.mjs'
import { closeAllChatTabs, closeChatTab, closeOtherChatTabs, closeRightChatTabs, isPinned, normalizePinned, openChatTab, orderTabs, toggleChatPin } from './lib/ctabs.mjs'
import { FRAMES, FRAME_LABEL, SOUND_CHOICES, SOUND_LABEL, normalizeFrame, soundChoice, soundFromChoice, soundFromSaved } from './lib/prefs.mjs'
import { RESIZE_DIRS, ctl, emit, initFrame, invoke, listen, photoApi, resizeFrom, shotApi, store, transport } from './lib/tauri.mjs'
import { createMic } from './lib/mic.mjs'
import { browserAudio } from './lib/tts-player.mjs'
import { createVoiceUi } from './lib/voice-ui.mjs'
import { AUTO_CHOICES, AUTO_LABEL, STT_LANGS, STT_LANG_LABEL, STT_MODELS, STT_MODEL_LABEL, normalizeCfg, shouldAutoSpeak, sttStatusText } from './lib/voice-prefs.mjs'

const { createApp, reactive, ref, computed, watch } = Vue
const STATUS = { online: '線上', busy: '忙碌', away: '暫離', offline: '顯示為離線' }
const CONN_LABEL = { connecting: '連線中…', on: '已連線', off: '連線中斷，重試中' }

// ---------- 音效（WebAudio 合成） ----------
let audioCtx = null
function actx() {
  if (!audioCtx) { try { audioCtx = new AudioContext() } catch { return null } }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
  return audioCtx
}
function tone(freq, start, dur, type = 'sine', gain = 0.16) {
  const a = actx(); if (!a) return
  const o = a.createOscillator(), g = a.createGain(), t = a.currentTime + start
  o.type = type; o.frequency.value = freq
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(gain, t + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  o.connect(g).connect(a.destination)
  o.start(t); o.stop(t + dur + 0.05)
}
const SOUNDS = {
  login: () => { tone(659, 0, 0.35); tone(988, 0.14, 0.7) },
  msg: () => { tone(1175, 0, 0.18, 'triangle', 0.14); tone(880, 0.1, 0.32, 'triangle', 0.14) },
  nudge: () => { for (let i = 0; i < 7; i++) tone(95 + (i % 2) * 35, i * 0.07, 0.09, 'square', 0.05) },
}

const info = await invoke('startup_info')
document.title = `Agent Sync Network Messenger (${info.version})`
if (info.error) {
  document.body.textContent = `ASN 無法啟動：${info.error}`
  throw new Error(info.error)
}
const meStore = store('me')
const savedMe = (await meStore.load()) ?? {}
// 暱稱＝視窗名＝對外名字；以 Rust 端現用名為準，不再從存檔讀
const me = reactive({ psm: '', status: 'online', ...savedMe.me, nick: info.window_name })
const soundOn = ref(soundFromSaved(savedMe.sound))
const frame = ref(normalizeFrame(savedMe.frame))   // 視窗外框：自訂（預設，含舊存檔）／Windows 原生；Rust 端開視窗時讀同一份存檔
await initFrame()
const dims = reactive(loadDims(savedMe))   // 分頁依（設備／廠商／狀態）與分組依；舊存檔的 groupMode 在這裡轉換

// 視窗模式：分開（每位好友一扇對話視窗）／整合（一個視窗，右邊是對話分頁）。tabs／active 只在整合模式用，不存檔
// 視窗模式、頭像模式（左／右／整合）、文字底色（透明／色彩／自動）三個設定彼此獨立，分離與整合視窗都有效
const pinnedChat = normalizePinned(savedMe.pinnedChat)
const ui = reactive({ mode: normalizeMode(savedMe.winMode), ...normalizeLook(savedMe), tabs: [], active: '', pinnedChat, guide: '', showGuide: false })
const sizes = reactive({ split: normalizeSize(savedMe.splitSize, 'split'), merged: normalizeSize(savedMe.mergedSize, 'merged') })
const winSize = () => ({ w: window.innerWidth, h: window.innerHeight })
let switching = false

const core = new AsnCore({
  transport, store: store('chats'), selfNode: info.node, windowName: info.window_name,
  // 整合模式：只有「目前分頁」且主視窗開著沒最小化才算看得到
  isChatVisible: async id => (ui.mode === 'merged' ? tabVisible(ui, id, await invoke('main_visible')) : invoke('chat_visible', { id })),
  aliases: info.old_names,
  pollMs: info.poll_ms, rosterMs: info.roster_ms,
  log: m => console.info('[ASN]', m),
})

const friends = ref([])
const nodeOrder = ref([])
const conn = ref('connecting')
const sync = () => {
  const s = core.snapshot()
  friends.value = s.friends
  nodeOrder.value = s.nodeOrder
  conn.value = s.conn
  emit('asn:state', { ...s, me: { ...me }, ui: { dpMode: ui.dpMode, bubble: ui.bubble, toolbar: ui.toolbar, collapsed: ui.collapsed } })
}
const logs = reactive({})   // 整合模式的分頁直接讀這份；分開模式的對話視窗走 asn:log 事件
const pushLog = id => { const l = core.logOf(id).slice(-200); logs[id] = l; emit('asn:log', { id, log: l }) }

// 設備大頭貼：節點 → data URL。好友顯示用哪張由 avatar.mjs 的規則決定（AI 視窗一律自動產生；名單外的寄件人用他那台設備的圖）
const avatars = ref({})
core.on('avatars', () => { avatars.value = core.avatarMap(); emit('asn:avatars', avatars.value) })
const avOf = f => avatarSrc(f, { avatars: avatars.value })
const meAv = computed(() => selfAvatarSrc({ selfNode: info.node, windowName: info.window_name, avatars: avatars.value }))

core.on('state', sync)
core.on('log', pushLog)
const rooms = ref([]), roomsErr = ref(false)
async function refreshRooms() {
  try { rooms.value = groupRows((await invoke('relay_rooms'))?.rooms); roomsErr.value = false } catch { roomsErr.value = true }
}
// 語音：整合模式的對話分頁用這一份；設定存在 Rust 端的 voice.json（對話視窗也讀同一份）
const voice = createVoiceUi({ invoke, listen, createMic, createAudio: browserAudio, reactive })
const voiceCfg = reactive(normalizeCfg(await invoke('voice_cfg_get').catch(() => null)))
core.on('notify', n => {
  if (n.sound && soundOn.value && me.status !== 'busy') SOUNDS[n.sound]?.()
  if (shouldAutoSpeak(n, voiceCfg, me.status)) voice.speakAuto(`auto:${n.friend.id}:${Date.now()}`, n.line)   // 預設關
  if (n.shake) void invoke('shake', { id: n.friend.id, main: ui.mode === 'merged' })   // 整合模式抖整個主視窗
  if (n.toast) void invoke('show_toast', { toast: { cid: n.friend.id, title: plain(n.friend.nick), line: n.line, status: n.friend.status, hue: n.friend.hue, dp: n.friend.dp, av: (a => (a.kind === 'upload' ? a.src : null))(avatarFor(n.friend, { avatars: avatars.value })) } })
})

async function openChat(id) {
  const f = core.friends.get(id); if (!f) return
  core.markRead(id)
  if (ui.mode === 'merged') {   // 整合模式：在右邊開分頁（或切過去），不開新視窗
    Object.assign(ui, openChatTab(ui, id, ui.pinnedChat), hideGuide(ui))
    pushLog(id)
    await invoke('show_main')
    sync()
    return
  }
  await invoke('open_chat', { id, title: `${plain(f.nick)} - 對話` })
  sync(); pushLog(id)
}

// 對話視窗的指令
await listen('asn:cmd', async c => {
  if (c.op === 'hello') { sync(); emit('asn:avatars', avatars.value); pushLog(c.id); core.markRead(c.id) }
  else if (c.op === 'read') core.markRead(c.id)
  else if (c.op === 'dp') ui.collapsed = toggleCollapsed(ui.collapsed)
  else if (c.op === 'send') { const r = await core.send(c.id, c.text); if (!r.ok) console.info('[ASN] send failed', r.error) }
  else if (c.op === 'nudge') await core.nudge(c.id)
  else if (c.op === 'attach') await sendAttachTo(c.id, c.photo, c.caption)
})
const sendTo = async (id, text) => { const r = await core.send(id, text); if (!r.ok) console.info('[ASN] send failed', r.error) }
const nudgeTo = id => core.nudge(id)
const sendAttachTo = async (id, item, caption) => { const r = await core.sendAttachment(id, item, caption); if (!r.ok) console.info('[ASN] attachment failed', r.error) }
const activateTab = id => { ui.active = id; Object.assign(ui, hideGuide(ui)); core.markRead(id); sync() }
const closeOneChatTab = id => { Object.assign(ui, closeChatTab(ui, id)); if (ui.active) core.markRead(ui.active); sync() }
const applyChatTabClose = patch => { Object.assign(ui, patch); if (ui.active) core.markRead(ui.active); sync() }
const toggleDp = () => { ui.collapsed = toggleCollapsed(ui.collapsed) }

// 切換視窗模式：已開的對話接得上（分開→整合：對話視窗關掉變分頁；整合→分開：分頁開成視窗）
async function setMode(to) {
  to = normalizeMode(to)
  const from = ui.mode
  if (to === from || switching) return
  switching = true
  try {
    sizes[from] = normalizeSize(winSize(), from)
    const closed = from === 'split' ? await invoke('close_chats') : []
    const plan = switchMode(from, to, { tabs: ui.tabs, active: ui.active, windowIds: closed })
    ui.mode = to
    ui.showGuide = false
    ui.tabs = orderTabs(plan.tabs, ui.pinnedChat); ui.active = plan.active
    await invoke('main_layout', { merged: to === 'merged', w: sizes[to].w, h: sizes[to].h, recenter: false })
    if (ui.active) core.markRead(ui.active)
    for (const id of plan.openWindows) await openChat(id)
    for (const id of plan.tabs) pushLog(id)
    sync()
  } finally { switching = false }
}
// 視窗大小記住：每種模式各記各的（拖到邊界 resize 事件很多，停下來才存）
let sizeTimer = null
window.addEventListener('resize', () => {
  clearTimeout(sizeTimer)
  sizeTimer = setTimeout(() => { if (!switching) sizes[ui.mode] = normalizeSize(winSize(), ui.mode) }, 400)
})
if (ui.mode === 'merged') await invoke('main_layout', { merged: true, w: sizes.merged.w, h: sizes.merged.h, recenter: true })

await listen('relay-bell', () => void core.pull('bell'))   // Rust 端的 Realtime 門鈴
await listen('asn:open', c => void openChat(c.cid))   // 提示被點了

watch([me, soundOn, frame, dims, () => ui.mode, () => ui.dpMode, () => ui.bubble, () => ui.toolbar, () => ui.collapsed, () => ui.pinnedChat, sizes], () => { const { nick, ...rest } = me; void meStore.save({ me: rest, sound: soundOn.value, frame: frame.value, tabDim: dims.tabDim, groupDim: dims.groupDim, winMode: ui.mode, dpMode: ui.dpMode, bubble: ui.bubble, toolbar: ui.toolbar, dpCollapsed: ui.collapsed, pinnedChat: ui.pinnedChat, splitSize: sizes.split, mergedSize: sizes.merged }); sync() }, { deep: true })
// 設定頁改「分頁依」：分組若撞到自動換成剩下兩個裡的第一個
const setTabDim = v => Object.assign(dims, withTabDim(dims, v))
const pages = computed(() => pageTabs(friends.value, dims.tabDim, { selfNode: info.node, nodeOrder: nodeOrder.value }))

// 起始頁籤：平常是設備維度的本機；--shot 可用設定檔的 shotTab 指定固定頁籤（已拿掉的「通知」或任何不認得的值都忽略）
const startTab = info.shot ? normalizeTab(savedMe.shotTab) : ''
const shotTab = ref(startTab || (dims.tabDim === 'device' ? info.node : ''))
const adI = ref(0)   // 底部小廣告與「開始」頁大幅廣告共用同一個目前位置
const app = createApp({
  setup() {
    const tab = shotTab, moreOpen = ref(false)
    let adTimer = null
    const startAds = () => { clearInterval(adTimer); adTimer = setInterval(() => { adI.value = nextAd(adI.value) }, AD_MS) }
    // --shot 模式可用設定檔的 shotAd 固定停在某一則廣告（截圖用）；平常照常輪播
    if (info.shot && Number.isInteger(savedMe.shotAd)) adI.value = savedMe.shotAd
    else startAds()
    // 大幅廣告的左右鍵與小圓點：換了就重新計時，不會剛點完又被自動換掉
    const stepAd = d => { adI.value = d < 0 ? prevAd(adI.value) : nextAd(adI.value); if (!info.shot) startAds() }
    const jumpAd = i => { adI.value = goAd(i); if (!info.shot) startAds() }
    setInterval(() => void refreshRooms(), 60_000)
    void refreshRooms()
    const query = ref(''), nickErr = ref('')
    const collapsed = reactive({})
    const dev = pages
    const isDevice = computed(() => !FIXED_TABS.some(t => t.key === tab.value))   // 名單頁（設備／廠商／狀態的頁籤）；其餘是群組、指引、設定
    const moreOn = computed(() => dev.value.more.some(d => d.key === tab.value))
    const moreUnreadN = computed(() => moreUnread(dev.value.more))
    // 選到的頁籤不在現在的清單（改了維度、設備消失…）時退回第一個（設備維度的第一個就是本機）
    watch(dev, d => { if (!normalizeTab(tab.value, d.all.map(x => x.key))) tab.value = d.all[0]?.key ?? '' }, { immediate: true })
    const shown = computed(() => {
      if (!isDevice.value) return []
      return rosterShownGroups(friends.value, {
        tabDim: dims.tabDim, tabKey: tab.value, groupDim: dims.groupDim, selfNode: info.node, query: query.value, plainText: plain,
      })
    })
    const emptyText = computed(() => (normalizeSearchQuery(query.value) ? '沒有符合的聯絡人。' : conn.value !== 'on' ? '還沒連上收發室。' : '這一頁目前沒有視窗。'))
    const openAd = a => openAdWith(a, url => void invoke('open_url', { url }))
    // 改最上面的暱稱＝改對外名字；Rust 端驗證，不合法就還原並提示
    const commitNick = async () => {
      const want = String(me.nick ?? '').trim()
      if (want === info.window_name) { me.nick = info.window_name; nickErr.value = ''; return }
      try { await invoke('set_window_name', { name: want }); location.reload() }
      catch (e) { me.nick = info.window_name; nickErr.value = e.message; setTimeout(() => { nickErr.value = '' }, 5000) }
    }
    // 設定頁「大頭貼」：選圖 → 前端裁成正方形縮成 96×96（webp／png，≤ 32 KB）→ 上傳；也可以移除改回自動產生
    const avBusy = ref(false), avMsg = ref(''), avFile = ref(null)
    const selfHasUpload = computed(() => isAvatarDataUrl(avatars.value[info.node]))
    const say = t => { avMsg.value = t; setTimeout(() => { if (avMsg.value === t) avMsg.value = '' }, 6000) }
    const avMenu = ref(false)
    const avApi = { toDataUrl: avatarFromFile, setAvatar: v => core.setSelfAvatar(v) }
    async function pickAvatar(ev) {
      const file = ev.target.files?.[0]; ev.target.value = ''
      if (!file) return
      avBusy.value = true
      try { say((await uploadAvatarFile(file, avApi)).message) } finally { avBusy.value = false }
    }
    async function removeAvatar() {
      avBusy.value = true
      try { say((await removeAvatarUpload(avApi)).message) } finally { avBusy.value = false }
    }
    // 設定頁改「視窗外框」：Rust 端立刻改所有視窗的外框並通知各視窗的頁面換樣式
    const setFrame = async v => {
      frame.value = normalizeFrame(v)
      try { await invoke('set_frame', { native: frame.value === 'native' }) } catch (e) { say(e.message) }
    }
    // 指引：分離模式顯示在名單內容區，整合模式是右邊的一個分頁（純邏輯在 guides.mjs）
    const openedGuide = computed(() => guideByKey(ui.guide))
    const view = computed(() => rightView({ tabs: ui.tabs, guide: ui.guide, showGuide: ui.showGuide }))
    const openGuideKey = key => Object.assign(ui, openGuide(ui, key, ui.mode))
    const closeGuideView = () => Object.assign(ui, closeGuide())
    const showHome = () => Object.assign(ui, hideGuide(ui))
    const mergedTabs = computed(() => ui.tabs.map(id => friends.value.find(f => f.id === id)).filter(Boolean))
    const chatTabMenu = ref('')
    const chatTabMenuPin = computed(() => (chatTabMenu.value ? isPinned(chatTabMenu.value, ui.pinnedChat) : false))
    const closeChatTabMenu = () => { chatTabMenu.value = '' }
    const chatTabMenuPos = reactive({ x: 0, y: 0 })   // 選單出現在滑鼠位置（position:fixed），不受分頁列裁切
    const openChatTabMenu = (id, e) => { chatTabMenuPos.x = e?.clientX ?? 0; chatTabMenuPos.y = e?.clientY ?? 0; chatTabMenu.value = id }
    const tabPinLabel = computed(() => (chatTabMenuPin.value ? '取消固定分頁' : '固定分頁'))
    const runTabMenu = fn => { const id = chatTabMenu.value; closeChatTabMenu(); if (id) fn(id) }
    const menuCloseTab = () => runTabMenu(id => applyChatTabClose(closeChatTab(ui, id)))
    const menuCloseOther = () => runTabMenu(id => applyChatTabClose(closeOtherChatTabs(ui, id, ui.pinnedChat)))
    const menuCloseRight = () => runTabMenu(id => applyChatTabClose(closeRightChatTabs(ui, id, ui.pinnedChat)))
    const menuCloseAll = () => { closeChatTabMenu(); applyChatTabClose(closeAllChatTabs(ui, ui.pinnedChat)) }
    const menuTogglePin = () => runTabMenu(id => { const r = toggleChatPin(ui, id, ui.pinnedChat); ui.pinnedChat = r.pinned; ui.tabs = r.tabs })
    const isChatTabPinned = id => isPinned(id, ui.pinnedChat)
    // 設定頁「語音」：改了就寫回 Rust 端（驗證在那裡；失敗就還原成存檔的值並提示）
    const ttsVoices = ref({ enabled: true, voices: [], default: '' }), sttSt = ref(null), voiceMsg = ref('')
    const sttText = computed(() => sttStatusText(sttSt.value))
    const refreshVoice = async () => {
      try { ttsVoices.value = await invoke('tts_voices') } catch (e) { voiceMsg.value = e.message }
      try { sttSt.value = await invoke('stt_status') } catch { /* 取不到就不顯示 */ }
    }
    void refreshVoice()
    const saveVoice = async patch => {
      const next = normalizeCfg({ ...voiceCfg, ...patch })
      try { await invoke('voice_cfg_set', { cfg: next }); Object.assign(voiceCfg, next); voiceMsg.value = ''; void refreshVoice() }
      catch (e) { voiceMsg.value = e.message }
    }
    const installFromSettings = async () => {
      voiceMsg.value = '正在下載…'
      await voice.installStt()
      voiceMsg.value = voice.state.note
      void refreshVoice()
    }
    return {
      version: info.version, voice, voiceCfg, ttsVoices, sttSt, sttText, voiceMsg, saveVoice, installFromSettings, AUTO_CHOICES, AUTO_LABEL, STT_LANGS, STT_LANG_LABEL, STT_MODELS, STT_MODEL_LABEL,
      frame, FRAMES, FRAME_LABEL, setFrame, SOUND_CHOICES, SOUND_LABEL, soundChoice, soundFromChoice, RESIZE_DIRS, resizeFrom, avMenu,
      avOf, meAv, avBusy, avMsg, avFile, selfHasUpload, pickAvatar, removeAvatar,
      ui, MODES, MODE_LABEL, DP_MODES, DP_LABEL, BUBBLES, BUBBLE_LABEL, TOOLBARS, TOOLBAR_LABEL, normalizeDpMode, normalizeBubble, setMode, mergedTabs, logs, sendTo, nudgeTo, sendAttachTo, photoApi, shotApi, activateTab, closeChatTab: closeOneChatTab, toggleDp, plain,
      chatTabMenu, chatTabMenuPos, openChatTabMenu, closeChatTabMenu, tabPinLabel, menuCloseTab, menuCloseOther, menuCloseRight, menuCloseAll, menuTogglePin, isChatTabPinned,
      STATUS, CONN_LABEL, FIXED_TABS, ADS, DIMS, dims, setTabDim, groupOptions, dev, dimTab: computed(() => dims.tabDim), isDevice, moreOn, moreOpen, moreUnreadN, me, soundOn, friends, conn, shown, query, collapsed, nickErr, commitNick,
      tab, adI, rooms, roomsErr, emptyText, openAd, stepAd, jumpAd, groupHeading, statusNote,
      GUIDES, openedGuide, view, openGuideKey, closeGuideView, showHome,
      selfNode: info.node, emo, initial, openChat, ctl,
    }
  },
})
app.component('chat-pane', ChatPane)
// 一篇指引的顯示：全部用文字插值（不用 v-html），步驟自動編號
app.component('guide-doc', {
  props: { guide: { type: Object, required: true } },
  setup: props => ({ rows: computed(() => numbered(props.guide.blocks)) }),
  template: `<article class="guide-article"><h2>{{ guide.title }}</h2>
    <template v-for="(b, i) in rows" :key="i">
      <h3 v-if="b.k === 'h'">{{ b.t }}</h3>
      <p v-else-if="b.k === 'p'">{{ b.t }}</p>
      <p v-else-if="b.k === 'li'" class="g-step"><b>{{ b.n }}</b><span>{{ b.t }}</span></p>
      <pre v-else-if="b.k === 'code'" class="g-code"><code>{{ b.t }}</code></pre>
      <p v-else class="g-note">{{ b.t }}</p>
    </template></article>`,
})
app.mount('#app')

await core.start()
sync()

// ---------- --shot 模式：開一個對話、寄一封信＋一個震動、彈一則提示，然後截圖並結束 ----------
// 設定檔（asn-me.json）可帶：winMode（'merged' 才是整合模式，欄位名就是 winMode，不是 mode）、shotNoChat（true＝不開任何對話，
// 整合模式停在「開始」大幅廣告）、shotAd（固定停在第幾則廣告）、shotTab（起始頁籤）。
if (info.shot) {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const all = core.snapshot().friends
  const target = savedMe.shotNoChat ? null : (all.find(f => f.unread > 0) ?? all.find(f => f.status !== 'offline') ?? all[0])
  if (target) {
    await openChat(target.id)
    if (ui.mode === 'merged') { const other = all.find(f => f.id !== target.id && f.status !== 'offline'); if (other) await openChat(other.id); await openChat(target.id) }
    await sleep(600)
    await core.send(target.id, '收到！我晚點看一下 :)')
    await core.nudge(target.id)
    await sleep(400)
    core.emit('notify', { kind: 'login', friend: core.friends.get(target.id), line: '已經登入', toast: true })
  }
  await sleep(1500)
  await invoke('take_shot')
  // 沒開對話的整合模式：再各拍一張別則大幅廣告（正見、招租＝按鈕不可點）
  if (savedMe.shotNoChat && ui.mode === 'merged') {
    for (const [name, i] of [['ad-policy', 1], ['ad-rent', ADS.length - 1]]) { adI.value = i; await sleep(700); await invoke('take_shot', { tab: name }) }
    adI.value = Number.isInteger(savedMe.shotAd) ? savedMe.shotAd : 0
  }
  // 逐頁籤截圖：本機、第二台設備、群組、指引（清單與一篇內容）、設定
  const p = pages.value.all
  for (const [name, key] of [['local', p[0]?.key], ['device', p[1]?.key], ['last', p.at(-1)?.key], ['groups', 'groups'], ['guide', 'guide'], ['guide-doc', 'guide'], ['settings', 'settings']]) {
    if (!key) continue
    shotTab.value = key
    if (name === 'guide-doc') Object.assign(ui, openGuide(ui, 'bridge', ui.mode))
    await sleep(500)
    await invoke('take_shot', { tab: name })
    if (name === 'guide-doc') Object.assign(ui, closeGuide())
  }
  await core.stop()
  await invoke('quit_app')
}
blockContextMenu(document)
