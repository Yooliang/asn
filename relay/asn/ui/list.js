// 好友名單視窗：同時是整個程式的「樞紐」——AsnCore 跑在這裡，對話視窗與提示視窗只顯示、用事件下指令。
// 關掉這扇＝結束程式（Rust 端處理）。
import { AsnCore } from './lib/core.mjs'
import { groupByDevice } from './lib/roster.mjs'
import { emo, initial, plain } from './lib/text.mjs'
import { ctl, emit, invoke, listen, store, transport } from './lib/tauri.mjs'

const { createApp, reactive, ref, computed, watch } = Vue
const STATUS = { online: '線上', busy: '忙碌', away: '馬上回來', offline: '顯示為離線' }
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
const me = reactive({ nick: info.window_name, psm: '', status: 'online', ...savedMe.me })
const soundOn = ref(savedMe.sound !== false)

const core = new AsnCore({
  transport, store: store('chats'), selfNode: info.node, windowName: info.window_name,
  isChatVisible: id => invoke('chat_visible', { id }),
  pollMs: info.poll_ms, rosterMs: info.roster_ms,
  log: m => console.info('[ASN]', m),
})

const friends = ref([])
const conn = ref('connecting')
const sync = () => {
  const s = core.snapshot()
  friends.value = s.friends
  conn.value = s.conn
  emit('asn:state', { ...s, me: { ...me } })
}
const pushLog = id => emit('asn:log', { id, log: core.logOf(id).slice(-200) })

core.on('state', sync)
core.on('log', pushLog)
core.on('notify', n => {
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

watch([me, soundOn], () => { void meStore.save({ me: { ...me }, sound: soundOn.value }); sync() }, { deep: true })

createApp({
  setup() {
    const query = ref(''), settingsOpen = ref(false), nameDraft = ref(info.window_name)
    const collapsed = reactive({})
    const groups = computed(() => {
      const q = query.value.trim().toLowerCase()
      const match = c => !q || plain(c.nick).toLowerCase().includes(q)
      return groupByDevice(friends.value, { selfNode: info.node, match })
    })
    const saveName = async () => { await invoke('set_window_name', { name: nameDraft.value.trim() }); location.reload() }
    return {
      STATUS, CONN_LABEL, me, soundOn, friends, conn, groups, query, collapsed, settingsOpen, nameDraft,
      windowName: info.window_name, selfNode: info.node, emo, initial, openChat, ctl, saveName,
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
  await core.stop()
  await invoke('quit_app')
}
