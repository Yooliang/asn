// 在別台電腦上夥伴的畫面打字（0.2.10）。和「看畫面」（term-remote.mjs，只能看）分開：這裡才有打字的路。
// 按下去就直接發起（11-08 起這台不再確認本人），那台會請那邊的人同意（或那邊的人設過不用每次問）。
// 打的字在 Rust 端編序號、加密、補送；畫面這邊只把 xterm 收到的按鍵交給 remoteInputApi.send。
// 多行的貼上先問一次；送不出去（太快、太多、網路不穩）就在畫面上說，不默默丟掉。
import { frameToWrite, loadXterm, xtermOptions } from './term-view.mjs'
import { FRAME_EVENT, END_EVENT, WARN_BEFORE_MS, REMOTE_TEXT, openTerm, remoteBarState, startError } from './term-remote.mjs'
const { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } = globalThis.Vue ?? {}

export const INPUT_LABEL = '打字'
/** 一整句送進去後隔多久按 Enter（分開送，免得那個視窗把整句連 Enter 當成貼上） */
export const ENTER_DELAY_MS = 120
export const INPUT_TIP = '在那台電腦上這位夥伴的視窗打字（那邊的人要同意；2 分鐘沒打字會自動結束）'

export const INPUT_TEXT = {
  waiting: '等那台電腦回應……那邊的人可能要按「允許」。',
  typing: (machine, name) => `正在「${machine}」上「${name}」打字：你打的字會直接送進那個視窗，包括回答權限框`,
  soon: '再 1 分鐘就會結束，要繼續打字請結束後再開一次。',
  stop: '結束打字',
  back: '改回只能看',
  again: '再開一次',
  pasteAsk: n => `要貼上 ${n} 行嗎？貼上之後那個視窗可能會一次執行好幾行。`,
  paste: '貼上',
  cancel: '取消',
  sendFailed: '這段沒有送出，請再試一次。',
}

/** 可以打字的 xterm 設定：和本機看畫面一樣，只是不關輸入 */
export const inputXtermOptions = size => ({ ...xtermOptions(size), disableStdin: false })

/** 貼上的文字有幾行；一行以內不用問 */
export function pasteLines(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '')
  return s ? s.split('\n').length : 0
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
    barInline: { type: Boolean, default: true },  // 同 RemoteView：false＝狀態文字交給外層的狀態列（status 事件）；結束打字的鈕也由外層放（呼叫 stop）
  },
  emits: ['back', 'status', 'unsent'],   // unsent：輸入框送來的那句沒送出去（多行按了取消、還沒開始就結束），交還給外層
  setup(props, { emit }) {
    const host = ref(null), phase = ref('starting'), note = ref(''), soon = ref(false), warn = ref(''), askPaste = ref(null)
    const bar = computed(() => remoteBarState({ phase: phase.value, soon: soon.value, note: note.value, warn: warn.value, main: { waiting: INPUT_TEXT.waiting, active: phase.value === 'typing' ? INPUT_TEXT.typing(props.machine || props.node, props.name) : '' }, danger: true }))
    watch(() => (bar.value ? bar.value.level + '|' + bar.value.text + '|' + phase.value : ''), () => { if (!props.barInline) emit('status', bar.value ? { ...bar.value, stoppable: phase.value === 'typing' } : null) }, { immediate: true })
    let id = '', term = null, offFrame = null, offEnd = null, warnTimer = 0, alive = true
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
      // 輸入框那句還在等確認時又貼上別段：那句交還給輸入框，不要被這次蓋掉
      if (lineAsk) { lineAsk = false; const t = askPaste.value; askPaste.value = null; if (t) emit('unsent', t) }
      if (pasteLines(text) > 1) askPaste.value = text
      else send(text, true)
    }
    // 下方輸入框送來的一整句（#1288）：打進那個視窗再按 Enter。還沒開始打字（等那台同意）就先排著，開始了才送；
    // 多行的先問一次（和貼上同一個框）。沒送出去就結束（那台拒絕、逾時）時，交還給外層放回輸入框
    let queued = null, lineAsk = false
    // 整句沒送出去就交還給輸入框（不用重打）；整句送出了才按 Enter（Enter 沒送出只提示，不重複放回）
    const typeLine = (text, multi) => {
      void send(text, multi).then(ok => {
        if (!ok) { emit('unsent', text); return }
        setTimeout(() => { void send('\r', false) }, ENTER_DELAY_MS)
      })
    }
    const flush = () => {
      if (queued === null || phase.value !== 'typing') return
      const t = queued; queued = null
      if (pasteLines(t) > 1) { lineAsk = true; askPaste.value = t } else typeLine(t, false)
    }
    const sendLine = text => {
      const t = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '')
      if (!t) return
      if (queued !== null) emit('unsent', queued)
      queued = t
      if (phase.value === 'ended') void start(); else flush()
    }
    watch(phase, p => { if (p === 'typing') flush() })
    const pasteYes = () => { const t = askPaste.value; askPaste.value = null; if (lineAsk) { lineAsk = false; typeLine(t, true) } else send(t, true) }
    const pasteNo = () => { const t = askPaste.value; askPaste.value = null; if (lineAsk) { lineAsk = false; emit('unsent', t) } }
    const cleanup = () => {
      clearTimeout(warnTimer)
      offFrame?.(); offEnd?.(); offFrame = offEnd = null
      document.removeEventListener('visibilitychange', onVisible)
      host.value?.removeEventListener('paste', onPaste, true)
      term?.dispose?.(); term = null
    }
    const finish = text => {
      cleanup(); phase.value = 'ended'; note.value = text; id = ''
      const left = queued ?? (lineAsk ? askPaste.value : null)
      queued = null; lineAsk = false; askPaste.value = null
      if (left) emit('unsent', left)
    }
    const start = async () => {
      cleanup()
      phase.value = 'starting'; note.value = ''; soon.value = false; warn.value = ''
      try {
        const Terminal = await loadXterm()
        // lib/tauri.mjs 的 listen 交給回呼的已經是內容本身（不是 { payload }）
        offFrame = await props.api.listen(FRAME_EVENT, f => {
          if (!f || f.id !== id || !term) return
          if (phase.value !== 'typing') phase.value = 'typing'
          term.write(frameToWrite(f))
        })
        offEnd = await props.api.listen(END_EVENT, e => { if (e?.id === id) finish(e.text || '') })
        const r = await props.api.start(props.node, props.name, props.machine)
        id = r.id
        if (!alive) { stop(); return }
        phase.value = 'waiting'
        term = await openTerm(Terminal, inputXtermOptions({ cols: 120, rows: 40 }), host, nextTick, () => alive)
        if (!term) { stop(); if (alive) finish(REMOTE_TEXT.failed); return }
        term.onData(d => send(d, false))
        host.value?.addEventListener('paste', onPaste, true)
        document.addEventListener('visibilitychange', onVisible)
        const left = Number(r.expires_s) * 1000 - Date.now() - WARN_BEFORE_MS
        warnTimer = setTimeout(() => { soon.value = true }, Math.max(0, left))
      } catch (e) {
        console.info('[ASN] 別台打字沒有開始', String(e?.message ?? e))
        finish(startError(e))
      }
    }
    const stop = () => { if (id) void props.api.stop(id).catch(() => {}) }
    const back = () => { stop(); cleanup(); emit('back') }
    onMounted(() => { if (props.active) void start() })
    onBeforeUnmount(() => { alive = false; stop(); cleanup(); const left = queued ?? (lineAsk ? askPaste.value : null); queued = null; if (left) emit('unsent', left); if (!props.barInline) emit('status', null) })
    return { host, phase, note, soon, warn, askPaste, again: start, stop, back, sendLine, pasteYes, pasteNo, pasteLines, TEXT: INPUT_TEXT }
  },
  template: `
<div class="term-view term-remote term-remote-input" :class="{ 'term-desk': !barInline }">
  <p class="term-view-ask" role="status" v-if="barInline && (phase === 'starting' || phase === 'waiting')">{{ TEXT.waiting }}</p>
  <p class="term-remote-bar term-remote-typing" role="status" v-else-if="barInline && phase === 'typing'">{{ TEXT.typing(machine || node, name) }}
    <button class="aero-btn" type="button" @click="stop">{{ TEXT.stop }}</button>
  </p>
  <p class="term-view-lost" role="status" v-if="barInline && soon && phase !== 'ended'">{{ TEXT.soon }}</p>
  <p class="term-view-lost" role="alert" v-if="barInline && warn">{{ warn }}</p>
  <p class="term-view-ask" role="alert" v-if="askPaste">{{ TEXT.pasteAsk(pasteLines(askPaste)) }}
    <button class="aero-btn" type="button" @click="pasteYes">{{ TEXT.paste }}</button>
    <button class="aero-btn" type="button" @click="pasteNo">{{ TEXT.cancel }}</button>
  </p>
  <div class="term-view-screen" ref="host" aria-label="別台電腦上的畫面（可以打字）" v-show="phase === 'waiting' || phase === 'typing'"></div>
  <p class="term-view-lost" role="status" v-if="phase === 'ended'">{{ barInline ? note : '' }}
    <button class="aero-btn" type="button" @click="again">{{ TEXT.again }}</button>
    <button class="aero-btn" type="button" @click="back">{{ TEXT.back }}</button>
  </p>
</div>`,
}
