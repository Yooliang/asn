// 手機版（安卓）主程式：單一畫面——名單 → 點進對話 → 返回。和電腦版共用 AsnCore（收寄信、記錄）、ChatPane（對話版面）與 Rust 端指令；
// 電腦才有的功能（內建收發室、開 Claude 視窗、密碼小幫手、用量、系統匣、多視窗）手機沒有，這個檔案也不叫它們。
// 打開 App 才收信：前景時照電腦版的節奏輪詢，加上門鈴一響就拉；回到前景時立刻拉一次（推播留給第二期）。
import { AsnCore } from './lib/core.mjs'
import { ChatPane } from './lib/chatpane.mjs'
import { avatarSrc, isAvatarDataUrl, removeAvatarUpload, selfAvatarSrc, uploadAvatarFile } from './lib/avatar.mjs'
import { avatarFromFile } from './lib/avatar-canvas.mjs'
import { PROVIDERS, canStart, errorText, phaseText } from './lib/login.mjs'
import { BANNER_MS, DEFAULT_PREFS, TABS, TAB_LABEL, accountDisplayName, SWIPE_BLOCK_SELECTOR, indicatorPos, lastMessage, pagerShift, swipeLock, swipeStartOk, swipeTarget, tabIndex, tabNav, threadRows, threadTime, UPDATE_CHECK_MS, afterBind, androidBridge, bannerText, buttonLabel, chatNav, initialNav, initialUpdate, installOutcome, launchNav, meNav, normalizeNav, normalizePrefs, notifyPlan, rosterGroups, savePhotoOnPhone, PTR_LOADING_H, PULL_TEXT, pullHeight, pullPhase, pullRatio, shouldAutoCheck, shouldRefreshOnRelease, totalUnread, BACKFILL_GAP_MS, backfillQueue, lastWords, vendorBadgeHtml, updateCheckErrorText, withAvailable, withFailure, withProgress } from './lib/mobile.mjs'
import { LAUNCH_GIVE_UP_MS, LAUNCH_POLL_MS, appearedIn, buildLaunchRequest, initialLaunch, launchChoices, launchDevices, launchEligibility, launchErrorText, launchFormError, machinesByNode, progressView } from './lib/mobile-launch.mjs'
import { friendId } from './lib/roster.mjs'
import { defaultPartnerName } from './lib/partner.mjs'
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
const friends = ref([]), conn = ref('connecting'), nodeOrder = ref([])
const logs = reactive({})
const avatars = ref({})
const query = ref(''), collapsed = reactive({})
const banner = ref(null), shake = ref(false), refreshing = ref(false)
// 自動更新（自行安裝版才有；Rust 端與外殼都沒編進 Google Play 版）。測試用的清單網址只收 127.0.0.1（Rust 端再擋一次）
const upd = reactive(initialUpdate())
const ownerName = ref('')   // 帳號層的名字（租戶稱呼）
const updTestUrl = (() => { try { return localStorage.getItem('asnUpdateTestUrl') || null } catch { return null } })()
const updArgs = () => (updTestUrl ? { url: updTestUrl } : {})
async function checkUpdate(manual = false) {
  if (!upd.enabled || upd.checking || upd.phase === 'downloading') return
  upd.checking = true; if (manual) upd.manual = ''
  try {
    const found = await invoke('android_update_check', updArgs())
    Object.assign(upd, withAvailable(upd, found))
    if (manual) upd.manual = found?.available ? `有新版本 ${found.version}。` : '目前已是最新版。'
  } catch (e) { if (manual) upd.manual = updateCheckErrorText(e.message) } finally { upd.checking = false }   // 官網連不上、回錯誤一律說「暫時無法檢查更新」，不顯示原始錯誤
}
async function startUpdate() {
  if (upd.phase === 'downloading') return
  Object.assign(upd, withProgress(upd, { done: 0, total: 0 }), { error: '', hint: '' })
  try {
    const r = await invoke('android_update_download', updArgs())   // Rust 端下載並驗 sha256，不符就拒絕
    const out = installOutcome(bridge ? bridge.installApk(r.path) : 'unsupported')
    upd.phase = 'available'; upd.hint = out.hint
  } catch (e) { Object.assign(upd, withFailure(upd, e.message)) }
}
let core = null
const lastMap = reactive({})   // 夥伴 id → 最後說的一句話（名單第三行）
const threadMap = reactive({})   // 夥伴 id → 最後一則訊息（雙方都算；「對話」分頁用）
const refreshLast = id => { const lg = core?.logOf(id); lastMap[id] = lastWords(lg); threadMap[id] = lastMessage(lg) }
let startCore = null
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
  ownerName.value = typeof saved.ownerName === 'string' ? saved.ownerName : ''
  watch([me, prefs, ownerName], () => { const { nick, ...rest } = me; void meStore.save({ ...saved, me: rest, mobilePrefs: { ...prefs }, ownerName: ownerName.value }) }, { deep: true })
  watch(() => [me.status, me.psm], () => { void invoke('set_presence', { status: me.status, psm: me.psm ?? '' }).catch(() => {}) }, { immediate: true })

  core = new AsnCore({
    transport, store: store('chats'), selfNode: info.node, windowName: info.window_name,
    isChatVisible: async id => document.visibilityState === 'visible' && nav.chat === id,   // 正在看那位的對話才算「看得到」（不算未讀）
    aliases: info.old_names, pollMs: info.poll_ms, rosterMs: info.roster_ms,
    log: m => console.info('[ASN]', m),
  })
  const sync = () => { const s = core.snapshot(); friends.value = s.friends; conn.value = s.conn; nodeOrder.value = s.nodeOrder; for (const f of s.friends) refreshLast(f.id) }
  const pushLog = id => { logs[id] = core.logOf(id).slice(-200) }
  core.on('state', sync)
  core.on('log', id => { pushLog(id); refreshLast(id) })
  core.on('avatars', () => { avatars.value = core.avatarMap() })
  core.on('notify', n => {
    const plan = notifyPlan(n, { openId: nav.chat, foreground: document.visibilityState === 'visible', prefs })
    if (plan.vibrate) { if (bridge) bridge.vibrate(plan.vibrate); else navigator.vibrate?.(plan.vibrate) }
    if (plan.shake) { shake.value = true; setTimeout(() => { shake.value = false }, 700) }
    if (plan.banner) { banner.value = plan.banner; clearTimeout(bannerTimer); bannerTimer = setTimeout(() => { banner.value = null }, BANNER_MS) }
  })
  await listen('relay-bell', () => void core.pull('bell'))   // Rust 端的門鈴（前景時有效）
  await listen('android-update-progress', p => { if (upd.phase === 'downloading') Object.assign(upd, withProgress(upd, p)) })   // 下載完才到的進度事件不能把畫面又拉回「下載中」
  upd.enabled = bridge?.selfUpdateEnabled() === true
  setInterval(() => { if (shouldAutoCheck(upd, prefs)) void checkUpdate() }, UPDATE_CHECK_MS)
  // 回到前景：立刻拉一次信、更新名單、補正在看的那位的往來記錄
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    void core.pull('resume'); void core.refreshRoster()
    if (nav.chat) { core.markRead(nav.chat); void core.syncHistory(nav.chat) }
  })
  startCore = async () => { void (shouldAutoCheck(upd, prefs) && checkUpdate()); await core.start(); sync() }   // 掛上畫面之後才開始（第一次收信要連網，不能讓畫面空等）
}

// ---------- 導覽：每往下一層就推一筆瀏覽記錄，系統返回鍵＝上一頁（名單層再按才退到背景） ----------
history.replaceState(initialNav(), '')
window.addEventListener('popstate', e => {
  Object.assign(nav, normalizeNav(e.state))
  if (nav.chat) core?.markRead(nav.chat)
})
const go = next => { history.pushState(next, ''); Object.assign(nav, next) }
// 切大分頁：從「夥伴」出去推一筆瀏覽記錄（返回鍵回到夥伴）；其他分頁之間互換不增加記錄
function goTab(t) {
  if (!TABS.includes(t) || t === nav.tab || nav.chat || nav.sheet) return
  if (nav.tab === 'list') go(tabNav(t))
  else if (t === 'list') history.back()
  else { const n = tabNav(t); history.replaceState(n, ''); Object.assign(nav, n) }
}
const backAsync = () => new Promise(res => { const h = () => { window.removeEventListener('popstate', h); res() }; window.addEventListener('popstate', h); history.back() })

// 下拉重整的小動畫區（夥伴、對話兩頁各一個）：我們自己的機器人，只用 transform／opacity 動
const PtrZone = {
  props: { ptr: { type: Object, required: true } },
  setup(props) { return { text: Vue.computed(() => PULL_TEXT[props.ptr.phase]) } },
  template: `<div class="m-ptr" :class="[ptr.phase, { dragging: ptr.dragging }]" :style="{ height: ptr.h + 'px', '--p': ptr.ratio }" role="status" :aria-hidden="ptr.h === 0">
    <svg class="m-ptr-bot" viewBox="140 120 220 250" width="56" height="64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="ptrBlue" x1="20%" y1="0%" x2="80%" y2="100%"><stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#1e3a8a"/></linearGradient>
        <linearGradient id="ptrWhite" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#cbd5e1"/></linearGradient>
      </defs>
      <g class="m-ptr-body"><path d="M 180 270 C 180 270, 160 360, 250 360 C 340 360, 320 270, 320 270 Z" fill="url(#ptrBlue)"/><path d="M 190 270 C 190 270, 175 350, 250 350 C 325 350, 310 270, 310 270 Z" fill="url(#ptrWhite)"/><rect x="225" y="300" width="50" height="15" rx="7.5" fill="#f59e0b"/></g>
      <g class="m-ptr-head"><rect x="150" y="130" width="200" height="150" rx="75" fill="url(#ptrBlue)"/><rect x="160" y="140" width="180" height="130" rx="65" fill="url(#ptrWhite)"/><rect x="175" y="155" width="150" height="95" rx="45" fill="#0f172a"/>
        <g class="m-ptr-eyes" stroke="#22d3ee" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M 205 200 L 215 190 L 225 200"/><path d="M 275 200 L 285 190 L 295 200"/></g>
        <path class="m-ptr-smile" d="M 235 215 Q 250 225 265 215" stroke="#22d3ee" stroke-width="7" stroke-linecap="round" fill="none"/></g>
    </svg>
    <span class="m-ptr-tx" v-if="ptr.h > 24">{{ text }}</span>
  </div>`,
}

// 左右滑動切換大分頁的手勢狀態（夥伴／對話／設置的橫向翻頁，以及對話畫面裡的滑動）
const sw = reactive({ mode: '', locked: '', x0: 0, y0: 0, t0: 0, dx: 0, shift: 0, width: 360, dragging: false })

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
      go(chatNav(id, nav.tab))
    }
    const pushLog = id => { logs[id] = core.logOf(id).slice(-200) }
    const back = () => history.back()
    const openBanner = () => { const b = banner.value; banner.value = null; if (b) openChat(b.id) }

    const sendTo = async (id, text) => { const r = await core.send(id, text); if (!r.ok) console.info('[ASN] send failed', r.error) }
    const nudgeTo = id => core.nudge(id)
    const sendAttachTo = async (id, item, caption) => { const r = await core.sendAttachment(id, item, caption); if (!r.ok) console.info('[ASN] attachment failed', r.error) }
    // ---------- 開新夥伴（遠端開視窗）：手機只下指令，視窗開在那台電腦上。要本人簽章（Rust 端沒憑證就不送） ----------
    const lch = reactive({ ...initialLaunch(), vphase: 'sending' })
    const lchData = reactive({ machines: {}, loaded: false, error: '' })
    const lchCtx = computed(() => ({ machines: lchData.machines, loaded: lchData.loaded, signedIn: acct.value.signed_in, friends: friends.value }))
    const lchDevices = computed(() => launchDevices(friends.value, { selfNode: info.node, nodeOrder: nodeOrder.value, ...lchCtx.value }))
    const lchElig = computed(() => (lch.node ? launchEligibility(lch.node, lchCtx.value) : { ok: false, reason: '' }))
    const lchFormErr = computed(() => (lch.node ? launchFormError(lch, lchElig.value) : ''))
    const lchChoices = computed(() => launchChoices(lchData.machines[lch.node]))
    async function loadLaunchers() {
      lchData.error = ''
      try { lchData.machines = machinesByNode(await invoke('android_launchers', {})); lchData.loaded = true } catch (e) { lchData.loaded = false; lchData.error = launchErrorText(e.message) }
    }
    function pickLaunchDevice(node) {
      if (!launchEligibility(node, lchCtx.value).ok) return
      const c = launchChoices(lchData.machines[node])
      Object.assign(lch, { node, deviceLabel: lchDevices.value.find(d => d.key === node)?.label ?? '', error: '' })
      if (!c.models.some(m => m.profileId === lch.profile)) lch.profile = c.models[0]?.profileId ?? ''
      if (!c.cwds.includes(lch.cwd)) lch.cwd = c.cwds[0] ?? ''
      if (!lch.name.trim()) lch.name = defaultPartnerName(friends.value, lch.profile)
    }
    function openLaunch(node) {
      if (lch.phase === 'progress' && lch.vphase !== 'done' && lch.vphase !== 'failed') { go(launchNav()); return }   // 還在開：回到進度畫面
      Object.assign(lch, initialLaunch(), { vphase: 'sending' })
      go(launchNav())
      void loadLaunchers().then(() => { if (node) pickLaunchDevice(node) })
    }
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    async function trackLaunch(t) {
      const stop = Date.now() + LAUNCH_GIVE_UP_MS
      while (lch.id === t.id && Date.now() < stop) {
        await sleep(LAUNCH_POLL_MS)
        let row = null
        try { row = ((await invoke('android_launchers', { ids: [t.id] }))?.launches ?? []).find(l => l.id === t.id) } catch { /* 下一輪再問 */ }
        if (row?.status === 'ok' || row?.status === 'unconfirmed') await core.refreshRoster()
        const appeared = appearedIn(friends.value, t.node, t.name)
        const v = progressView(row, appeared, t.name)
        if (lch.id !== t.id) return
        Object.assign(lch, { vphase: v.phase, text: v.text })
        if (appeared) {
          lch.friendId = friendId(t.node, t.name)
          if (nav.sheet !== 'launch') banner.value = { id: lch.friendId, nick: t.name, line: '已經開好了，點一下開始對話', status: 'online', hue: 200 }
          return
        }
        if (v.phase === 'failed') return
      }
      if (lch.id === t.id) Object.assign(lch, { vphase: 'waiting', text: '還沒看到新視窗出現在名單上。可以稍後再看看名單。' })
    }
    async function submitLaunch() {
      lch.error = lchFormErr.value
      if (lch.error || lch.busy) return   // 不能開的電腦（不在線、沒開放、沒登入）或欄位不對：不送出
      lch.busy = true
      try {
        const name = lch.name.trim()
        const r = await invoke('android_launch', { body: buildLaunchRequest(lch) })
        if (!r?.id) throw new Error('送出失敗')
        Object.assign(lch, { phase: 'progress', id: r.id, since: Date.now(), friendId: '', detail: '', ...(({ phase, text }) => ({ vphase: phase, text }))(progressView(null, false)) })
        void trackLaunch({ id: r.id, node: lch.node, name })
      } catch (e) { lch.error = launchErrorText(e.message) } finally { lch.busy = false }
    }
    function openLaunched() { const id = lch.friendId; if (!id) return; history.back(); setTimeout(() => openChat(id), 50) }
    // 名單第三行「最後一句話」：本機有記錄就用；沒有的（例如剛裝）向後台補一次往來（每位最多一次、依畫面順序、慢慢來、整個執行期有上限），補到的記錄存在本機當快取
    const lastOf = id => lastMap[id] ?? ''
    const backfillTried = new Set()
    let backfilling = false
    async function backfillLast() {
      if (backfilling || !acct.value.signed_in) return
      backfilling = true
      try {
        for (;;) {
          const order = groups.value.flatMap(g => g.items)
          const [id] = backfillQueue(order, { lastOf, tried: backfillTried })
          if (!id) break
          backfillTried.add(id)
          await core.syncHistory(id)
          refreshLast(id)
          await new Promise(r => setTimeout(r, BACKFILL_GAP_MS))
        }
      } finally { backfilling = false }
    }
    watch([() => friends.value.length, () => acct.value.signed_in], () => { void backfillLast() })
    const refreshAll = async () => { refreshing.value = true; try { await Promise.all([core.refreshRoster(), core.pull('manual')]) } finally { refreshing.value = false } }
    // 下拉重整：頁面捲到最上面時往下拉，頂端長出機器人；拉過門檻放開才更新，完成後收回。夥伴與對話兩頁各一組（設置頁沒有）
    function makePtr() {
      const ptr = reactive({ h: 0, ratio: 0, phase: 'idle', dragging: false, el: null })
      let y0 = null
      const set = h => { ptr.h = h; ptr.ratio = pullRatio(h); ptr.phase = pullPhase(h, refreshing.value) }
      const start = e => { y0 = !refreshing.value && (ptr.el?.scrollTop ?? 1) <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null }
      const move = e => {
        if (y0 === null) return
        if (sw.locked === 'h') { y0 = null; ptr.dragging = false; set(0); return }   // 已經是左右滑動：不拉重整
        const dy = e.touches[0].clientY - y0
        if (dy <= 0 || (ptr.el?.scrollTop ?? 1) > 0) { if (ptr.h) { set(0); ptr.dragging = false } return }
        if (e.cancelable) e.preventDefault()   // 拉到頂時不讓系統的捲動／回彈搶走手勢
        ptr.dragging = true
        set(pullHeight(dy))
      }
      const end = async () => {
        if (y0 === null) return
        y0 = null; ptr.dragging = false
        if (!shouldRefreshOnRelease(ptr.h, refreshing.value)) { set(0); return }
        const t0 = Date.now()
        ptr.h = PTR_LOADING_H; ptr.phase = 'loading'
        await refreshAll()
        await new Promise(r => setTimeout(r, Math.max(0, 700 - (Date.now() - t0))))   // 至少讓「更新中…」看得到一下
        set(0)
      }
      return { ptr, start, move, end }
    }
    const pf = makePtr(), pc = makePtr()

    // 左右滑動切換大分頁。夥伴／對話／設置三頁並排，手指拖動時整排跟著動，放開吸附到最近的一頁；
    // 在單一對話畫面裡也能滑：對話滑走，回到它下面那一頁的左邊或右邊那一頁。
    // 邊緣 24px 留給系統的返回手勢；輸入框、工具列、放大照片上不接手；水平位移要明顯大於垂直（2 倍）才算，所以上下捲動與文字選取不會被誤判。
    const idx = computed(() => tabIndex(nav.tab))
    const pagerStyle = computed(() => ({ transform: `translate3d(calc(${-idx.value * 100 / 3}% + ${sw.shift}px), 0, 0)` }))
    const chatStyle = computed(() => (sw.mode === 'chat' || sw.shift ? { transform: `translate3d(${sw.mode === 'chat' ? sw.shift : 0}px, 0, 0)` } : {}))
    const indicator = computed(() => indicatorPos(idx.value, sw.mode === 'pager' ? sw.shift : 0, sw.width))
    function swipeStart(e, mode) {
      sw.mode = ''; sw.locked = ''
      if (e.touches.length !== 1 || nav.sheet) return
      const t = e.touches[0]
      if (!swipeStartOk(t.clientX, window.innerWidth)) return
      if (e.target?.closest?.(SWIPE_BLOCK_SELECTOR)) return
      if (String(window.getSelection?.() ?? '').length > 0) return   // 正在選文字
      Object.assign(sw, { mode, x0: t.clientX, y0: t.clientY, t0: Date.now(), dx: 0, shift: 0, width: window.innerWidth })
    }
    function swipeMove(e) {
      if (!sw.mode) return
      const t = e.touches[0]
      const dx = t.clientX - sw.x0, dy = t.clientY - sw.y0
      if (!sw.locked) {
        const l = swipeLock(dx, dy)
        if (l === 'v') { sw.mode = ''; return }
        if (l !== 'h') return
        sw.locked = 'h'; sw.dragging = true
        for (const z of [pf, pc]) { z.ptr.dragging = false; if (z.ptr.h && !refreshing.value) { z.ptr.h = 0; z.ptr.ratio = 0; z.ptr.phase = 'idle' } }
      }
      if (e.cancelable) e.preventDefault()
      sw.dx = dx
      sw.shift = pagerShift(idx.value, dx)
    }
    async function swipeEnd() {
      const { mode, locked, dx, t0, width } = sw
      if (!mode || locked !== 'h') { sw.mode = ''; sw.locked = ''; sw.dragging = false; return }
      sw.dragging = false; sw.locked = ''
      const target = swipeTarget({ index: idx.value, dx, dt: Date.now() - t0, width })
      if (mode === 'pager') {
        sw.shift = 0; sw.mode = ''
        if (target !== idx.value) goTab(TABS[target])
        return
      }
      // 對話畫面：滑夠遠就把對話滑出去（底下的分頁排跟著一起滑，隔壁那一頁滑進來），再無動畫地換成「回到分頁、切到隔壁那頁」（畫面位置完全相同，不會閃）；不夠遠就彈回來
      if (target === idx.value) { sw.shift = 0; sw.mode = ''; return }
      sw.shift = dx > 0 ? width : -width
      await new Promise(r => setTimeout(r, 220))
      sw.dragging = true   // 換狀態這一瞬間不要動畫
      await backAsync()
      sw.mode = ''
      goTab(TABS[target]); sw.shift = 0
      await Vue.nextTick()
      sw.dragging = false
    }
    const threads = computed(() => threadRows(friends.value, id => threadMap[id]))
    const threadTimeText = t => threadTime(t)

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
    // 我的名字（帳號層）：先用上次存的，登入帳號的資料取到後更新並存起來（離線也有名字可顯示）
    void authApi.accountInfo().then(i => { if (typeof i?.owner_name === 'string') ownerName.value = i.owner_name }).catch(() => {})
    const myName = computed(() => accountDisplayName(ownerName.value, acct.value.email))
    const meForChat = computed(() => ({ ...me, nick: myName.value }))   // 對話裡自己的名字用帳號名；設備名只在「從 …」小標
    const accountText = computed(() => (acct.value.signed_in ? `已登入：${acct.value.email || '（沒有 email）'}` : '尚未登入'))
    const loggingOut = ref(false)
    async function doLogout() {
      if (loggingOut.value) return
      loggingOut.value = true
      try { await authApi.logout(); location.reload() } catch (e) { loggingOut.value = false; say(e.message) }
    }

    return {
      screen, fatal, login, loginNote, PROVIDERS, canStart, startLogin, cancelLogin,
      upd, updText: computed(() => bannerText(upd)), updButton: computed(() => buttonLabel(upd)), startUpdate, checkUpdate,
      pf, pc, sw, pagerStyle, chatStyle, indicator, swipeStart, swipeMove, swipeEnd, goTab, TABS, TAB_LABEL, threads, threadTimeText, myName, meForChat, lastOf, vendorIcon: vendorBadgeHtml,
      nav, me, prefs, conn, query, collapsed, groups, unreadTotal, emptyText, STATUS, CONN_LABEL, info, banner, shake, refreshing,
      avOf, avById, meAv, chatFriend, chatLog, photoApi, emo, groupHeading, statusNote,
      lch, lchData, lchDevices, lchElig, lchFormErr, lchChoices, openLaunch, pickLaunchDevice, submitLaunch, openLaunched,
      openChat, back, openBanner, sendTo, nudgeTo, sendAttachTo, refreshAll,
      nickErr, commitNick, avBusy, avMsg, avFile, selfHasUpload, pickAvatar, removeAvatar, accountText, loggingOut, doLogout,
    }
  },
})
app.component('chat-pane', ChatPane)
app.component('ptr-zone', PtrZone)
app.mount('#app')
// 根元素（#app）自己的屬性不在 Vue 編譯的樣板裡，:class 綁不上去；登入畫面的背景類別在這裡手動切
watch(screen, s => document.getElementById('app').classList.toggle('is-login', s === 'login'), { immediate: true })
document.getElementById('splash')?.remove()
void startCore?.()
