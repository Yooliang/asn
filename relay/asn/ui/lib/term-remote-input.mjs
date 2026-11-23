// 在別台電腦上夥伴的畫面打字（0.2.10）。和「看畫面」（term-remote.mjs，只能看）分開：這裡才有打字的路。
// 按下去就直接發起（11-08 起這台不再確認本人）；0.2.33 起那台也不再跳確認框，只看那台有沒有開「允許遠端在這台打字」。
// 打的字在 Rust 端編序號、加密、補送；畫面這邊只把 xterm 收到的按鍵交給 remoteInputApi.send。
// 多行的貼上先問一次；送不出去（太快、太多、網路不穩）就在畫面上說，不默默丟掉。
import { frameToWrite, loadXterm, xtermOptions, pasteSummary, PASTE_TEXT } from './term-view.mjs'
import { FRAME_EVENT, END_EVENT, WARN_BEFORE_MS, REMOTE_TEXT, openTerm, remoteBarState, startError } from './term-remote.mjs'
import { ENTER_DELAY_MS, createLineSender, pasteLines } from './term-line.mjs'
import { KEYS_TEXT, droppedGrew, createKeyChain } from './term-keys.mjs'
export { ENTER_DELAY_MS, pasteLines }
const { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } = globalThis.Vue ?? {}

export const INPUT_LABEL = '打字'
export const INPUT_TIP = '在那台電腦上這位夥伴的視窗打字（那台要開著「允許遠端在這台打字」；2 分鐘沒打字會自動結束）'

export const INPUT_TEXT = {
  waiting: '正在連到那台電腦……',
  typing: (machine, name) => `正在「${machine}」上「${name}」打字：你打的字會直接送進那個視窗，包括回答權限框`,
  soon: '再 1 分鐘就會結束，要繼續打字請結束後再開一次。',
  stop: '結束打字',
  back: '改回只能看',
  waitReply: '正在連到那台電腦',
  refused: reason => (reason ? `沒有開始打字：${reason}` : '沒有開始打字，字已放回輸入框'),
  again: '再開一次',
  sendFailed: '這段沒有送出，請再試一次。',
}

/** 可以打字的 xterm 設定：和本機看畫面一樣，只是不關輸入 */
export const inputXtermOptions = size => ({ ...xtermOptions(size), disableStdin: false })

/** 開始打字前本人取消了手機的本人驗證（生物辨識或螢幕鎖）：這次沒有開始，輸入框那句會放回去 */
export const INPUT_NOT_VERIFIED = '沒有完成本人驗證，這次沒有開始打字'

/** 打字沒開始的話：本人取消驗證另外講；其他照看畫面的說法（Rust 端回的已經是白話，空的用通用的） */
export function inputStartError(e) {
  return e?.code === 'cancel' ? INPUT_NOT_VERIFIED : startError(e)
}

/** 送字失敗的話：Rust 端回的已經是白話、也寫了這段沒有送出（例如「打太快了，這段沒有送出，請再試一次」）；空的用通用的 */
export function sendError(e) {
  const s = String(e?.message ?? e ?? '').trim()
  return s || INPUT_TEXT.sendFailed
}

export const RemoteInput = {
  props: {
    api: { type: Object, required: true },        // lib/tauri.mjs 的 remoteInputApi
    node: { type: String, required: true },
    name: { type: String, required: true },
    machine: { type: String, default: '' },
    active: { type: Boolean, default: true },
    snap: { type: String, default: null },       // 送出後、連上那台前：最後一幅畫面的原文（帶顏色的跳脫序列）直接寫進這個 xterm 當底，上面疊「正在連到那台電腦」（#1647、#1762）；沒給＝不疊
    barInline: { type: Boolean, default: true },  // 同 RemoteView：false＝狀態文字交給外層的狀態列（status 事件）；結束打字的鈕也由外層放（呼叫 stop）
  },
  emits: ['back', 'status', 'unsent', 'screen', 'phase', 'refused'],   // unsent：輸入框送來的那句沒送出去（多行按了取消、還沒開始就結束），交還給外層；screen：最新一幅的字與欄數（複製畫面文字、找登入網址用）
  setup(props, { emit }) {
    // 掛上時 active 就是 false：不啟動，停在「已結束」的樣子（有再開一次、改回只能看），不會一直顯示等待（#1760）
    const host = ref(null), phase = ref(props.active ? 'starting' : 'ended'), note = ref(''), soon = ref(false), warn = ref(''), askPaste = ref(null)
    const bar = computed(() => remoteBarState({ phase: phase.value, soon: soon.value, note: note.value, warn: warn.value, main: { waiting: INPUT_TEXT.waiting, active: phase.value === 'typing' ? INPUT_TEXT.typing(props.machine || props.node, props.name) : '' }, danger: true }))
    watch(() => (bar.value ? bar.value.level + '|' + bar.value.text + '|' + phase.value : ''), () => { if (!props.barInline) emit('status', bar.value ? { ...bar.value, stoppable: phase.value === 'typing' } : null) }, { immediate: true })
    let id = '', term = null, offFrame = null, offEnd = null, warnTimer = 0, alive = true
    // 收到畫面時 xterm 還沒建好：只留最新一幅（不排隊），建好立刻補畫（#1760）
    let pendingFrame = null
    // 每次發起編一個號；收掉、重新發起、active 變 false 後，舊的那一次回來就不再往下做（#1760）
    let startGen = 0
    // 按鍵列（#1512 B）：還沒開始打字就先排著，開始了才依序送；那台回報拿掉幾批按鍵的數字（變大就告訴本人）
    let keyQueue = [], lastDropped = 0
    const onVisible = () => { if (id) void props.api.pause(id, document.visibilityState === 'hidden').catch(() => {}) }
    // 回 Promise<boolean>：送出去了沒（沒在打字、沒東西也算沒送）
    const send = (data, paste) => {
      if (!id || phase.value !== 'typing' || !data) return Promise.resolve(false)
      return props.api.send(id, data, paste).then(() => { warn.value = ''; return true }).catch(e => {
        console.info('[ASN] 別台打字沒送出', String(e?.message ?? e))
        warn.value = sendError(e)
        return false
      })
    }
    // 貼上：自己接，不讓 xterm 當成按鍵送；多行先問
    const onPaste = ev => {
      const text = ev.clipboardData?.getData('text/plain') ?? ''
      ev.preventDefault(); ev.stopPropagation()
      if (!text) return
      yieldAsk()   // 輸入框那句還在等確認時又貼上別段：那句交還給輸入框
      if (pasteLines(text) > 1) askPaste.value = text
      else send(text, true)
    }
    // 下方輸入框送來的一整句（#1288）：打進那個視窗再按 Enter。還沒開始打字（等那台同意）就先排著，開始了才送；
    // 多行的先問一次（和貼上同一個框）。沒送出去就結束（那台拒絕、逾時）時，交還給外層放回輸入框。邏輯和看本機共用（term-line.mjs）
    const { sendLine, flush, yieldAsk, answer, takeLeft } = createLineSender({
      send, askPaste, emit, ready: () => phase.value === 'typing', ended: () => phase.value === 'ended', restart: () => { void start() },
    })
    // 按鍵列的一顆：跟打字同一條路（那台交給窗格前照樣重讀畫面）。輸入框那句排在前面時，等它的 Enter 送完再送。
    // 按鍵串成一條：前一顆送出、確認回來了才送下一顆，順序不看 IPC 誰先到（「↓」「Enter」反過來就選錯項，#1561 asn真 審查必修）；
    // 有一顆沒送出，後面排著的全部不送（不能少了「↓」還按 Enter）。結束打字時也一併作廢
    const keyChain = createKeyChain(seq => send(seq, false))
    const chainKey = seq => keyChain.push(seq)
    const flushKeys = () => { const ks = keyQueue; keyQueue = []; ks.forEach(chainKey) }
    const sendKey = seq => {
      if (!seq) return
      if (phase.value === 'typing') { void chainKey(seq); return }
      keyQueue.push(seq)
      if (phase.value === 'ended') void start()
    }
    watch(phase, p => { if (p === 'typing') reached = true })
    watch(phase, p => { if (p === 'typing') flush() })
    watch(phase, p => emit('phase', p), { immediate: true })
    watch(phase, p => { if (p === 'typing' && keyQueue.length) setTimeout(flushKeys, ENTER_DELAY_MS + 50) })
    const pasteYes = () => { if (answer(true)) return; const t = askPaste.value; askPaste.value = null; send(t, true) }
    const pasteNo = () => { if (!answer(false)) askPaste.value = null }
    const cleanup = () => {
      clearTimeout(warnTimer)
      pendingFrame = null
      offFrame?.(); offEnd?.(); offFrame = offEnd = null
      document.removeEventListener('visibilitychange', onVisible)
      host.value?.removeEventListener('paste', onPaste, true)
      term?.dispose?.(); term = null
    }
    let reached = false   // 有沒有真的進過「可以打字」；沒進過就結束＝對方不允許、逾時或沒開始
    const finish = text => {
      cleanup(); phase.value = 'ended'; note.value = text; id = ''
      const left = takeLeft(); askPaste.value = null
      if (left) emit('unsent', left)
      if (!reached && alive) emit('refused', text)   // 外層收到就回到只能看、寫明原因（#1647）
      keyQueue = []; keyChain.cancel()   // 排著的、串著還沒送的按鍵都不留到下一次（按鍵不像整句可以放回輸入框）
    }
    const wireTerm = () => {
      term.onData(d => send(d, false))
      host.value?.addEventListener('paste', onPaste, true)
      document.addEventListener('visibilitychange', onVisible)
    }
    // 畫面框：連上之前有底圖（snap）就顯示（彩色底圖寫在這個框裡）；沒有底圖照舊，要到等那台回覆才顯示
    const hostShown = computed(() => phase.value === 'waiting' || phase.value === 'typing' || (props.snap !== null && phase.value === 'starting'))
    // 把一幅畫面畫上去（有 xterm 才會呼叫）
    const drawFrame = f => {
      if (phase.value !== 'typing') phase.value = 'typing'
      reached = true   // 直接記，不等 phase 的監看（那是下一輪才跑，這幅畫面後馬上結束會被當成沒進過）
      term.write(frameToWrite(f))
      emit('screen', { text: String(f.text ?? ''), cols: Number(f.meta?.cols) || 0 })
      if (droppedGrew(lastDropped, f.meta?.keys_dropped)) { lastDropped = Number(f.meta.keys_dropped); warn.value = KEYS_TEXT.dropped }
    }
    const start = async () => {
      if (!props.active) return
      stop()            // 上一次若還在，先通知那台結束，不留兩條連線（#1760）
      cleanup()
      const gen = ++startGen
      const current = () => alive && gen === startGen && props.active
      id = ''           // 上一次的 id 不能留著：start 回來前收到的畫面要靠「沒有 id」先暫存（#1760）
      reached = false   // 每次重新發起都重算：這次有沒有真的進過打字，不看上一次（#1760）
      phase.value = 'starting'; note.value = ''; soon.value = false; warn.value = ''; lastDropped = 0
      try {
        const Terminal = await loadXterm()
        // 有最後一幅畫面（snap）：先建 xterm、把原文寫進去，等連上那台的這段保留原本的彩色畫面（#1762）。沒有就照舊，連上了才建
        if (props.snap !== null) {
          await nextTick()
          term = await openTerm(Terminal, inputXtermOptions({ cols: 120, rows: 40 }), host, nextTick, current)
          if (!term) { if (current()) finish(REMOTE_TEXT.failed); return }
          wireTerm()
          term.write(frameToWrite({ text: props.snap }))
        }
        // lib/tauri.mjs 的 listen 交給回呼的已經是內容本身（不是 { payload }）
        // 註冊完時這一次已作廢（收掉、重新發起、active 變 false）：自己註冊的馬上解除，不動新一次的
        const offF = await props.api.listen(FRAME_EVENT, f => {
          if (!f) return
          if (!id) { pendingFrame = f; return }   // start 還沒回來、不知道這次的 id：先留著，回來後比對 id 再補畫
          if (f.id !== id) return
          if (!term) { pendingFrame = f; return }
          drawFrame(f)
        })
        if (!current()) { offF?.(); return }
        offFrame = offF
        const offE = await props.api.listen(END_EVENT, e => { if (e?.id === id) finish(e.text || '') })
        if (!current()) { offE?.(); return }
        offEnd = offE
        // 手機的 start 先等本人確認（生物辨識）：確認回來時這個畫面已經收掉就不送（電腦版不看第四個參數）
        const r = await props.api.start(props.node, props.name, props.machine, { wanted: current })
        // 這次已經開始了才作廢：要結束，不然那台會一直送到到期
        if (!current()) { stopId(r?.id); return }
        id = r.id
        phase.value = 'waiting'
        if (!term) {
          term = await openTerm(Terminal, inputXtermOptions({ cols: 120, rows: 40 }), host, nextTick, current)
          if (!term) { stopId(r.id); if (current()) finish(REMOTE_TEXT.failed); return }   // 用這一次的 r.id：共用的 id 可能已是新一次的（#1760）
          wireTerm()
        }
        // 建好前（或 start 回來前）收到的那一幅，現在補畫；不是這一次的就丟掉
        if (pendingFrame) { const f = pendingFrame; pendingFrame = null; if (f.id === id) drawFrame(f) }
        const left = Number(r.expires_s) * 1000 - Date.now() - WARN_BEFORE_MS
        warnTimer = setTimeout(() => { soon.value = true }, Math.max(0, left))
      } catch (e) {
        console.info('[ASN] 別台打字沒有開始', String(e?.message ?? e))
        if (alive && !current()) return   // 已作廢的那一次出錯，不去動新的一次
        finish(inputStartError(e))
      }
    }
    // 通知那台結束；送不到只寫 log（那台到期也會自己停），不打擾畫面
    const stopId = x => { if (x) void props.api.stop(x).catch(e => console.info('[ASN] 別台打字結束沒送到', x, String(e?.message ?? e))) }
    const stop = () => stopId(id)
    const back = () => { stop(); cleanup(); emit('back') }
    onMounted(() => { if (props.active) void start() })
    // active 變化（#1760）：false→true 啟動；true→false 照結束的流程收掉（字放回輸入框、不再收畫面、通知那台結束）
    watch(() => props.active, a => {
      if (a) { if (phase.value === 'ended') void start(); return }
      startGen++   // 還在發起中的那一次作廢
      if (phase.value === 'ended') return
      stop(); finish('')
    })
    onBeforeUnmount(() => { alive = false; stop(); cleanup(); const left = takeLeft(); if (left) emit('unsent', left); if (!props.barInline) emit('status', null) })
    return { host, hostShown, phase, note, soon, warn, askPaste, again: start, stop, back, sendLine, sendKey, pasteYes, pasteNo, pasteLines, pasteSummary, PASTE_TEXT, TEXT: INPUT_TEXT }
  },
  template: `
<div class="term-view term-remote term-remote-input" :class="{ 'term-desk': !barInline }">
  <p class="term-view-ask" role="status" v-if="barInline && (phase === 'starting' || phase === 'waiting')">{{ TEXT.waiting }}</p>
  <p class="term-remote-bar term-remote-typing" role="status" v-else-if="barInline && phase === 'typing'">{{ TEXT.typing(machine || node, name) }}
    <button class="aero-btn" type="button" @click="stop">{{ TEXT.stop }}</button>
  </p>
  <p class="term-view-lost" role="status" v-if="barInline && soon && phase !== 'ended'">{{ TEXT.soon }}</p>
  <p class="term-view-lost" role="alert" v-if="barInline && warn">{{ warn }}</p>
  <p class="term-view-ask" role="alert" v-if="askPaste">{{ pasteSummary(askPaste, name) }}
    <button class="aero-btn" type="button" @click="pasteYes">{{ PASTE_TEXT.yes }}</button>
    <button class="aero-btn" type="button" @click="pasteNo">{{ PASTE_TEXT.no }}</button>
  </p>
  <div class="term-wait-cover" role="status" v-if="snap !== null && (phase === 'starting' || phase === 'waiting')"><p class="term-wait-note">{{ TEXT.waitReply }}</p></div>
  <div class="term-view-screen" ref="host" aria-label="別台電腦上的畫面（可以打字）" v-show="hostShown"></div>
  <p class="term-view-lost" role="status" v-if="phase === 'ended'">{{ barInline ? note : '' }}
    <button class="aero-btn" type="button" @click="again">{{ TEXT.again }}</button>
    <button class="aero-btn" type="button" @click="back">{{ TEXT.back }}</button>
  </p>
</div>`,
}
