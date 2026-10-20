// 好友名單視窗：同時是整個程式的「樞紐」——AsnCore 跑在這裡，對話視窗與提示視窗只顯示、用事件下指令。
// 關掉這扇＝結束程式（Rust 端處理）。
import { AsnCore } from './lib/core.mjs'
import { ADS, AD_MS, FIXED_TABS, addNotice, fmtTime, groupHeading, groupRows, moreUnread, nextAd, statusNote } from './lib/tabs.mjs'
import { DIMS, groupItems, groupOptions, loadDims, pageItems, pageTabs, withTabDim } from './lib/dims.mjs'
import { emo, initial, plain } from './lib/text.mjs'
import { ctl, emit, invoke, listen, store, transport } from './lib/tauri.mjs'

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
if (info.error) {
  document.body.textContent = `ASN 無法啟動：${info.error}`
  throw new Error(info.error)
}
const meStore = store('me')
const savedMe = (await meStore.load()) ?? {}
// 暱稱＝視窗名＝對外名字；以 Rust 端現用名為準，不再從存檔讀
const me = reactive({ psm: '', status: 'online', ...savedMe.me, nick: info.window_name })
const soundOn = ref(savedMe.sound !== false)
const dims = reactive(loadDims(savedMe))   // 分頁依（設備／廠商／狀態）與分組依；舊存檔的 groupMode 在這裡轉換

const core = new AsnCore({
  transport, store: store('chats'), selfNode: info.node, windowName: info.window_name,
  isChatVisible: id => invoke('chat_visible', { id }),
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
  emit('asn:state', { ...s, me: { ...me } })
}
const pushLog = id => emit('asn:log', { id, log: core.logOf(id).slice(-200) })

core.on('state', sync)
core.on('log', pushLog)
const notices = ref([])
const rooms = ref([]), roomsErr = ref(false)
async function refreshRooms() {
  try { rooms.value = groupRows((await invoke('relay_rooms'))?.rooms); roomsErr.value = false } catch { roomsErr.value = true }
}
core.on('notify', n => {
  if (n.kind === 'msg' || n.kind === 'nudge') notices.value = addNotice(notices.value, { cid: n.friend.id, who: plain(n.friend.nick), line: n.line, kind: n.kind })
  if (n.sound && soundOn.value && me.status !== 'busy') SOUNDS[n.sound]?.()
  if (n.shake) void invoke('shake', { id: n.friend.id })
  if (n.toast) void invoke('show_toast', { toast: { cid: n.friend.id, title: plain(n.friend.nick), line: n.line, status: n.friend.status, hue: n.friend.hue, dp: n.friend.dp } })
})

async function openChat(id) {
  const f = core.friends.get(id); if (!f) return
  core.markRead(id)
  await invoke('open_chat', { id, title: `${plain(f.nick)} - 對話` })
  sync(); pushLog(id)
}

// 對話視窗的指令
await listen('asn:cmd', async c => {
  if (c.op === 'hello') { sync(); pushLog(c.id); core.markRead(c.id) }
  else if (c.op === 'read') core.markRead(c.id)
  else if (c.op === 'send') { const r = await core.send(c.id, c.text); if (!r.ok) console.info('[ASN] send failed', r.error) }
  else if (c.op === 'nudge') await core.nudge(c.id)
})
await listen('relay-bell', () => void core.pull('bell'))   // Rust 端的 Realtime 門鈴
await listen('asn:open', c => void openChat(c.cid))   // 提示被點了

watch([me, soundOn, dims], () => { const { nick, ...rest } = me; void meStore.save({ me: rest, sound: soundOn.value, tabDim: dims.tabDim, groupDim: dims.groupDim }); sync() }, { deep: true })
// 設定頁改「分頁依」：分組若撞到自動換成剩下兩個裡的第一個
const setTabDim = v => Object.assign(dims, withTabDim(dims, v))
const pages = computed(() => pageTabs(friends.value, dims.tabDim, { selfNode: info.node, nodeOrder: nodeOrder.value }))

const shotTab = ref(dims.tabDim === 'device' ? info.node : '')
createApp({
  setup() {
    const tab = shotTab, moreOpen = ref(false), adI = ref(0)
    setInterval(() => { adI.value = nextAd(adI.value) }, AD_MS)
    setInterval(() => void refreshRooms(), 60_000)
    void refreshRooms()
    const query = ref(''), nickErr = ref('')
    const collapsed = reactive({})
    const dev = pages
    const isDevice = computed(() => !FIXED_TABS.some(t => t.key === tab.value))   // 名單頁（設備／廠商／狀態的頁籤）；其餘是群組、通知、設定
    const moreOn = computed(() => dev.value.more.some(d => d.key === tab.value))
    const moreUnreadN = computed(() => moreUnread(dev.value.more))
    // 選到的頁籤不在現在的清單（改了維度、設備消失…）時退回第一個（設備維度的第一個就是本機）
    watch(dev, d => { if (!d.all.some(x => x.key === tab.value) && !FIXED_TABS.some(t => t.key === tab.value)) tab.value = d.all[0]?.key ?? '' }, { immediate: true })
    const shown = computed(() => {
      if (!isDevice.value) return []
      const q = query.value.trim().toLowerCase()
      const items = pageItems(friends.value, dims.tabDim, tab.value, c => !q || plain(c.nick).toLowerCase().includes(q))
      return groupItems(items, dims.groupDim, { selfNode: info.node })
    })
    const emptyText = computed(() => (query.value.trim() ? '沒有符合的聯絡人。' : conn.value !== 'on' ? '還沒連上收發室。' : '這一頁目前沒有視窗。'))
    const openAd = a => { if (a.url) void invoke('open_url', { url: a.url }) }
    // 改最上面的暱稱＝改對外名字；Rust 端驗證，不合法就還原並提示
    const commitNick = async () => {
      const want = String(me.nick ?? '').trim()
      if (want === info.window_name) { me.nick = info.window_name; nickErr.value = ''; return }
      try { await invoke('set_window_name', { name: want }); location.reload() }
      catch (e) { me.nick = info.window_name; nickErr.value = e.message; setTimeout(() => { nickErr.value = '' }, 5000) }
    }
    return {
      STATUS, CONN_LABEL, FIXED_TABS, ADS, DIMS, dims, setTabDim, groupOptions, dev, dimTab: computed(() => dims.tabDim), isDevice, moreOn, moreOpen, moreUnreadN, me, soundOn, friends, conn, shown, query, collapsed, nickErr, commitNick,
      tab, adI, rooms, roomsErr, notices, emptyText, openAd, groupHeading, statusNote, fmtTime,
      selfNode: info.node, emo, initial, openChat, ctl,
    }
  },
}).mount('#app')

await core.start()
sync()

// ---------- --shot 模式：開一個對話、寄一封信＋一個震動、彈一則提示，然後截圖並結束 ----------
if (info.shot) {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const all = core.snapshot().friends
  const target = all.find(f => f.unread > 0) ?? all.find(f => f.status !== 'offline') ?? all[0]
  if (target) {
    await openChat(target.id)
    await sleep(600)
    await core.send(target.id, '收到！我晚點看一下 :)')
    await core.nudge(target.id)
    await sleep(400)
    core.emit('notify', { kind: 'login', friend: core.friends.get(target.id), line: '已經登入', toast: true })
  }
  await sleep(1500)
  await invoke('take_shot')
  // 逐頁籤截圖：本機、第二台設備、群組、通知、設定
  const p = pages.value.all
  for (const [name, key] of [['local', p[0]?.key], ['device', p[1]?.key], ['groups', 'groups'], ['notices', 'notices'], ['settings', 'settings']]) {
    if (!key) continue
    shotTab.value = key
    await sleep(500)
    await invoke('take_shot', { tab: name })
  }
  await core.stop()
  await invoke('quit_app')
}
