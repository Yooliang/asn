// 手機版（安卓）主程式：單一畫面——名單 → 點進對話 → 返回。和電腦版共用 AsnCore（收寄信、記錄）、ChatPane（對話版面）與 Rust 端指令；
// 電腦才有的功能（內建收發室、開 Claude 視窗、密碼小幫手、用量、系統匣、多視窗）手機沒有，這個檔案也不叫它們。
// 打開 App 才收信：前景時照電腦版的節奏輪詢，加上門鈴一響就拉；回到前景時立刻拉一次（推播留給第二期）。
import { AsnCore } from './lib/core.mjs'
import { ChatPane } from './lib/chatpane.mjs'
import { avatarSrc, isAvatarDataUrl, removeAvatarUpload, selfAvatarSrc, uploadAvatarFile } from './lib/avatar.mjs'
import { avatarFromFile } from './lib/avatar-canvas.mjs'
import { PROVIDERS, canStart, errorText, phaseText } from './lib/login.mjs'
import { BANNER_MS, DEFAULT_PREFS, afterBind, androidBridge, chatNav, initialNav, meNav, normalizeNav, normalizePrefs, notifyPlan, rosterGroups, savePhotoOnPhone, totalUnread } from './lib/mobile.mjs'
import { groupHeading, statusNote } from './lib/tabs.mjs'
import { emo, plain } from './lib/text.mjs'
import { authApi, invoke, listen, store } from './lib/tauri.mjs'

const { createApp, reactive, ref, computed, watch } = Vue
const STATUS = { online: '線上', busy: '忙碌', away: '暫離', offline: '顯示為離線' }
const CONN_LABEL = { connecting: '連線中…', on: '已連線', off: '連線中斷，重試中' }
const bridge = androidBridge(window)

// 手機只用得到這幾個 Rust 指令（金鑰與權杖都在 Rust 端，這裡拿不到）
const transport = {
  list: () => invoke('relay_list'),
  inbox: () => invoke('relay_inbox'),
  ack: ids => invoke('relay_ack', { ids }),
  send: payload => invoke('relay_send', { payload }),
  history: (node, agent, partnerId) => invoke('relay_chat_history', { node, agent: agent || null, partnerId: partnerId || null }),   // 後台的往來記錄（90 天；要登入，本機只當快取）
  sentStatus: ids => invoke('relay_sent_status', { ids }).then(r => r?.status ?? []),
  avatar: node => invoke('relay_avatar', { node }),
  setAvatar: avatar => invoke('relay_set_avatar', { avatar }),
  sendAttachment: payload => invoke('relay_send_attachment', { payload }),
}
// 照片放大與收到的檔案：另存＝存進 App 私有資料夾，再請外殼複製到「下載/ASN」
const photoApi = {
  fetch: id => invoke('relay_attachment_fetch', { id }),
  save: async (id, name) => savePhotoOnPhone(await invoke('relay_attachment_save', { id, name }), bridge),
  reveal: async () => bridge?.openDownloads(),
}

const info = await invoke('startup_info')
document.title = 'ASN'

const screen = ref('boot'), fatal = ref('')
const login = reactive({ phase: 'idle', provider: '', error: '' })
const loginNote = computed(() => (login.phase === 'waiting' ? `${phaseText('waiting', login.provider)}（瀏覽器登入完會自動回到 ASN；沒有回來的話，請自己切回來。）` : phaseText(login.phase, login.provider)))

async function finishLogin() {
  login.phase = 'setting'
  try {
    const out = await authApi.bind()
    const plan = afterBind(out, bridge)
    if (plan.action === 'relaunch') { bridge.relaunch(); return }
    if (plan.action === 'ask') { login.error = plan.text; login.phase = 'error'; return }
    location.reload()
  } catch (e) { login.error = errorText(e); login.phase = 'error' }
}
async function startLogin(key) {
  if (!canStart(login.phase)) return
  login.provider = key; login.error = ''; login.phase = 'waiting'
  try { await authApi.login(key) } catch (e) { login.error = errorText(e); login.phase = 'error'; return }
  await finishLogin()
}
const cancelLogin = () => { void authApi.cancel(); login.phase = 'idle' }

const nav = reactive(initialNav())
const me = reactive({ psm: '', status: 'online', nick: info.window_name })
const prefs = reactive({ ...DEFAULT_PREFS })
const friends = ref([]), conn = ref('connecting')
const logs = reactive({})
const avatars = ref({})
const query = ref(''), collapsed = reactive({})
const banner = ref(null), shake = ref(false), refreshing = ref(false)
let core = null
let bannerTimer = null

if (info.needs_login) {
  screen.value = 'login'
  // 已登入、只差替這支手機建節點（上次建立中斷）：不用再登入一次
  const st = await authApi.status().catch(() => null)
  if (!info.can_skip_login && st?.signed_in) void finishLogin()
} else if (info.error) {
  fatal.value = info.error
  screen.value = 'fatal'
} else {
  screen.value = 'main'
}

if (screen.value === 'main') {
  const meStore = store('me')
  const saved = (await meStore.load()) ?? {}
  Object.assign(me, { psm: '', status: 'online', ...saved.me, nick: info.window_name })
  Object.assign(prefs, normalizePrefs(saved.mobilePrefs))
  watch([me, prefs], () => { const { nick, ...rest } = me; void meStore.save({ ...saved, me: rest, mobilePrefs: { ...prefs } }) }, { deep: true })
  watch(() => [me.status, me.psm], () => { void invoke('set_presence', { status: me.status, psm: me.psm ?? '' }).catch(() => {}) }, { immediate: true })

  core = new AsnCore({
    transport, store: store('chats'), selfNode: info.node, windowName: info.window_name,
    isChatVisible: async id => document.visibilityState === 'visible' && nav.chat === id,   // 正在看那位的對話才算「看得到」（不算未讀）
    aliases: info.old_names, pollMs: info.poll_ms, rosterMs: info.roster_ms,
    log: m => console.info('[ASN]', m),
  })
  const sync = () => { const s = core.snapshot(); friends.value = s.friends; conn.value = s.conn }
  const pushLog = id => { logs[id] = core.logOf(id).slice(-200) }
  core.on('state', sync)
  core.on('log', pushLog)
  core.on('avatars', () => { avatars.value = core.avatarMap() })
  core.on('notify', n => {
    const plan = notifyPlan(n, { openId: nav.chat, foreground: document.visibilityState === 'visible', prefs })
    if (plan.vibrate) { if (bridge) bridge.vibrate(plan.vibrate); else navigator.vibrate?.(plan.vibrate) }
    if (plan.shake) { shake.value = true; setTimeout(() => { shake.value = false }, 700) }
    if (plan.banner) { banner.value = plan.banner; clearTimeout(bannerTimer); bannerTimer = setTimeout(() => { banner.value = null }, BANNER_MS) }
  })
  await listen('relay-bell', () => void core.pull('bell'))   // Rust 端的門鈴（前景時有效）
  // 回到前景：立刻拉一次信、更新名單、補正在看的那位的往來記錄
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    void core.pull('resume'); void core.refreshRoster()
    if (nav.chat) { core.markRead(nav.chat); void core.syncHistory(nav.chat) }
  })
  await core.start()
  sync()
}

// ---------- 導覽：每往下一層就推一筆瀏覽記錄，系統返回鍵＝上一頁（名單層再按才退到背景） ----------
history.replaceState(initialNav(), '')
window.addEventListener('popstate', e => {
  Object.assign(nav, normalizeNav(e.state))
  if (nav.chat) core?.markRead(nav.chat)
})
const go = next => { history.pushState(next, ''); Object.assign(nav, next) }

const app = createApp({
  setup() {
    const groups = computed(() => rosterGroups(friends.value, { query: query.value, selfNode: info.node, selfName: info.window_name, plainText: plain }))
    const unreadTotal = computed(() => totalUnread(friends.value))
    const emptyText = computed(() => (query.value.trim() ? '找不到符合的聯絡人。' : conn.value === 'off' ? '連不上收發室，請檢查網路。' : '名單上還沒有夥伴。'))
    const avOf = f => avatarSrc(f, { avatars: avatars.value })
    const avById = id => { const f = friends.value.find(x => x.id === id); return f ? avOf(f) : '' }
    const meAv = computed(() => selfAvatarSrc({ selfNode: info.node, windowName: info.window_name, avatars: avatars.value }))
    const chatFriend = computed(() => friends.value.find(f => f.id === nav.chat) ?? null)
    const chatLog = computed(() => logs[nav.chat] ?? [])

    function openChat(id) {
      const f = core.friends.get(id); if (!f) return
      core.markRead(id)
      pushLog(id)
      void core.syncHistory(id)   // 打開對話：向後台補這位夥伴 90 天的往來（以後台為準；失敗就用本機快取）
      banner.value = null
      go(chatNav(id))
    }
    const pushLog = id => { logs[id] = core.logOf(id).slice(-200) }
    const back = () => history.back()
    const goMe = () => { if (nav.tab !== 'me') go(meNav()) }
    const goList = () => { if (nav.tab === 'me') history.back() }
    const openBanner = () => { const b = banner.value; banner.value = null; if (b) openChat(b.id) }

    const sendTo = async (id, text) => { const r = await core.send(id, text); if (!r.ok) console.info('[ASN] send failed', r.error) }
    const nudgeTo = id => core.nudge(id)
    const sendAttachTo = async (id, item, caption) => { const r = await core.sendAttachment(id, item, caption); if (!r.ok) console.info('[ASN] attachment failed', r.error) }
    const refreshAll = async () => { refreshing.value = true; try { await Promise.all([core.refreshRoster(), core.pull('manual')]) } finally { refreshing.value = false } }

    // 「我」：暱稱（Rust 端驗證，不合法就還原並提示）、大頭貼（裁成正方形縮成 96×96 上傳）
    const nickErr = ref('')
    const commitNick = async () => {
      const want = String(me.nick ?? '').trim()
      if (want === info.window_name) { me.nick = info.window_name; nickErr.value = ''; return }
      try { await invoke('set_window_name', { name: want }); location.reload() }
      catch (e) { me.nick = info.window_name; nickErr.value = e.message; setTimeout(() => { nickErr.value = '' }, 5000) }
    }
    const avBusy = ref(false), avMsg = ref(''), avFile = ref(null)
    const selfHasUpload = computed(() => isAvatarDataUrl(avatars.value[info.node]))
    const say = t => { avMsg.value = t; setTimeout(() => { if (avMsg.value === t) avMsg.value = '' }, 6000) }
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

    const acct = ref({ signed_in: false, email: '' })
    void authApi.status().then(s => { acct.value = s ?? acct.value }).catch(() => {})
    const accountText = computed(() => (acct.value.signed_in ? `已登入：${acct.value.email || '（沒有 email）'}` : '尚未登入'))
    const loggingOut = ref(false)
    async function doLogout() {
      if (loggingOut.value) return
      loggingOut.value = true
      try { await authApi.logout(); location.reload() } catch (e) { loggingOut.value = false; say(e.message) }
    }

    return {
      screen, fatal, login, loginNote, PROVIDERS, canStart, startLogin, cancelLogin,
      nav, me, prefs, conn, query, collapsed, groups, unreadTotal, emptyText, STATUS, CONN_LABEL, info, banner, shake, refreshing,
      avOf, avById, meAv, chatFriend, chatLog, photoApi, emo, groupHeading, statusNote,
      openChat, back, goMe, goList, openBanner, sendTo, nudgeTo, sendAttachTo, refreshAll,
      nickErr, commitNick, avBusy, avMsg, avFile, selfHasUpload, pickAvatar, removeAvatar, accountText, loggingOut, doLogout,
    }
  },
})
app.component('chat-pane', ChatPane)
app.mount('#app')
