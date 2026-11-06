// 在畫面裡看夥伴的終端、打字（#597）。畫面內容由 Rust 端過濾過才送來；打字走 term_view_input（只有本機畫面這一個入口，
// Rust 端再檢查一次：開著的畫面、視窗在前景、窗格是 ASN 開的、授權），字一次一支送進窗格、不丟字。
// xterm.js 打包在 ui/vendor，要看時才載入。全程在本機，不連外。
import { viewHint } from './partner-notice.mjs'
/** 畫面上提示多久查一次 */
export const HINT_POLL_MS = 3_000
const { ref, watch, onMounted, onBeforeUnmount, nextTick } = globalThis.Vue ?? {}

const FRAME_EVENT = 'term-view-frame'
const CLOSED_EVENT = 'term-view-closed'
const INPUT_ERROR_EVENT = 'term-view-input-error'
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 40

export const TERM_VIEW_NOTE = '點一下畫面就能打字。終端視窗如果開著，那邊也是同一個畫面。'
export const TERM_VIEW_NOTE_READONLY = '這裡只能看。終端視窗如果開著，那邊也是同一個畫面。'
/** 一次貼上最多幾個字（再多請分段）：Rust 端上限是 256 KB，中文一字最多 3 位元組 */
export const PASTE_MAX_CHARS = 80000
// 只有在共用終端服務裡的夥伴才看得到這個畫面（#900），讀不到就是讀不到：不猜原因，真正的原因進 console
export const TERM_VIEW_LOST = '暫時讀不到這個畫面。'

/** 一幅畫面要寫給 xterm 的內容：清掉重畫，最後把游標放回窗格的位置。一次寫完，xterm 只會畫一次，不會閃 */
export function frameToWrite(frame) {
  const body = String(frame?.text ?? '').replace(/\r?\n/g, '\r\n').replace(/(\r\n)+$/, '')
  const x = Math.max(0, Number(frame?.meta?.cursor_x) || 0)
  const y = Math.max(0, Number(frame?.meta?.cursor_y) || 0)
  return `\x1b[0m\x1b[H\x1b[2J${body}\x1b[0m\x1b[${y + 1};${x + 1}H`
}

/** 組完字之後多久內送出的那一筆還算輸入法組字的結果（毫秒） */
export const IME_RECENT_MS = 150

/**
 * 追蹤輸入法組字（#956 只用來記紀錄）。attach(textarea) 掛上 composition 事件；recent()＝組字中或剛組完。
 * now 可注入（測試）
 */
export function imeTracker(now = () => Date.now()) {
  let composing = false, endedAt = -Infinity
  return {
    attach(el) {
      if (!el?.addEventListener) return
      el.addEventListener('compositionstart', () => { composing = true })
      el.addEventListener('compositionend', () => { composing = false; endedAt = now() })
    },
    recent: () => composing || now() - endedAt <= IME_RECENT_MS,
  }
}

/** 貼上的字要不要先問：多行才問（一般終端的慣例），單行直接送 */
export function pasteNeedsConfirm(text) {
  return /[\r\n]/.test(String(text ?? '').replace(/[\r\n]+$/, ''))
}

/** 貼上確認列的文字：幾行、幾個字 */
export function pasteSummary(text) {
  const t = String(text ?? '')
  const lines = t.replace(/[\r\n]+$/, '').split(/\r\n|\r|\n/).length
  return `要貼上 ${lines} 行、${[...t].length} 個字，送進這位夥伴的終端？`
}

// 貼上的按鍵：回 false 就是 xterm 不處理，瀏覽器照常貼上（走原本的貼上確認）；否則 xterm 會把 Ctrl+V 送成控制字元並擋掉貼上
export function termKeyHandler(e) {
  if (e.type !== 'keydown') return true
  const k = String(e.key || '').toLowerCase()
  if ((e.ctrlKey || e.metaKey) && !e.altKey && k === 'v') return false
  if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && k === 'insert') return false
  return true
}

/** 要讓游標那一列看得到（下面多留一列），捲動位置該在哪 */
export function followTarget({ cursorRow, rowHeight, clientHeight, scrollHeight }) {
  const max = Math.max(0, scrollHeight - clientHeight)
  return Math.min(max, Math.max(0, (cursorRow + 2) * rowHeight - clientHeight))
}

/**
 * 要不要跟著游標捲。使用者往上捲就先不跟，捲回游標或底部再跟。
 * 自己設定捲動位置也會觸發 scroll 事件：和剛設的位置一樣的就不算使用者捲的。
 */
export function createFollow() {
  let following = true, lastSet = null
  const SLACK = 2
  return {
    following: () => following,
    place: top => { lastSet = top },
    onScroll: (scrollTop, target) => {
      const mine = lastSet !== null && Math.abs(scrollTop - lastSet) <= SLACK
      lastSet = null   // 只算一次：使用者之後捲回同一個位置，要算他捲的
      if (!mine) following = scrollTop >= target - SLACK
    },
  }
}

/**
 * 一次觀看：開、收畫面、關。deps：
 *   open() → 觀看編號；close(編號)；listen(事件, fn) → 取消函式；
 *   createTerm({ cols, rows }) → { resize, write, dispose }（可以是 Promise）；onLost(原因)；onPainted(一幅，選填)；
 *   sendInput(編號, 字, 是不是貼上)（選填，沒給就只看）；onInputError({ message, lost_bytes })（選填）
 */
export function createTermViewSession(deps) {
  let viewId = null, term = null, stopped = false, lastSeq = 0, size = null, chain = Promise.resolve()
  const unlisten = []
  const early = new Map()   // 開好之前就到的畫面：每個編號只留最新一幅

  const paint = async frame => {
    if (stopped || frame.seq <= lastSeq) return
    lastSeq = frame.seq
    const cols = Number(frame.meta?.cols) || DEFAULT_COLS, rows = Number(frame.meta?.rows) || DEFAULT_ROWS
    if (!term) {
      term = await deps.createTerm({ cols, rows })
      if (stopped) { term.dispose(); term = null; return }
      size = { cols, rows }
    }
    if (size.cols !== cols || size.rows !== rows) { term.resize(cols, rows); size = { cols, rows } }
    term.write(frameToWrite(frame))
    deps.onPainted?.(frame)
  }
  // 一幅一幅照順序畫；xterm 載入中到的畫面排在後面
  const enqueue = frame => {
    chain = chain.then(() => paint(frame)).catch(e => { console.info('[ASN] 終端畫面畫不出來', String(e?.message ?? e)); lost(String(e?.message ?? e)) })
  }
  const lost = reason => {
    if (stopped) return
    stop()
    deps.onLost?.(reason)
  }
  // 打字：開好之前、關掉之後都不送。字一支一支照順序送；送不出去就回報，不假裝成功。
  // 排隊在這裡（一個接一個等前一個回來），順序不會亂；Rust 端還有自己的佇列與上限
  let inputChain = Promise.resolve()
  const input = (data, paste = false, ime = false) => {
    if (stopped || viewId === null || !deps.sendInput || !data) return false
    const id = viewId
    inputChain = inputChain
      .then(() => (stopped ? null : deps.sendInput(id, data, !!paste, !!ime)))
      .catch(e => deps.onInputError?.({ message: String(e?.message ?? e), lost_bytes: 0 }))
    return true
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    for (const u of unlisten) { try { u() } catch { /* 已經取消 */ } }
    unlisten.length = 0
    if (viewId !== null) Promise.resolve(deps.close(viewId)).catch(e => console.info('[ASN] 關閉觀看失敗', String(e?.message ?? e)))
    if (term) { term.dispose(); term = null }
  }
  const start = async () => {
    try {
      const add = async (evt, fn) => {
        const u = await deps.listen(evt, fn)
        if (stopped) { u(); return }
        unlisten.push(u)
      }
      await add(FRAME_EVENT, f => {
        if (viewId === null) early.set(f.view_id, f)
        else if (f.view_id === viewId) enqueue(f)
      })
      await add(INPUT_ERROR_EVENT, e => {
        if (viewId !== null && e.view_id === viewId) deps.onInputError?.({ message: String(e.message ?? ''), lost_bytes: Number(e.lost_bytes) || 0 })
      })
      await add(CLOSED_EVENT, c => {
        if (viewId === null) early.set(c.view_id, { closed: c.reason })
        else if (c.view_id === viewId) { console.info('[ASN] 終端畫面結束', c.reason); lost(c.reason) }
      })
      if (stopped) return
      const id = await deps.open()
      if (stopped) { await deps.close(id); return }   // 開到一半就被關掉：不留著背景讀畫面
      viewId = id
      const first = early.get(id)
      early.clear()
      if (first?.closed) lost(first.closed)
      else if (first) enqueue(first)
    } catch (e) {
      console.info('[ASN] 開不了終端畫面', String(e?.message ?? e))
      lost(String(e?.message ?? e))
    }
  }
  return { start, stop, input, flushed: () => chain, inputFlushed: () => inputChain, viewId: () => viewId }
}

let xtermLoad = null
/** 第一次要看才載入 xterm.js 和它的樣式 */
export function loadXterm() {
  if (globalThis.Terminal) return Promise.resolve(globalThis.Terminal)
  xtermLoad ??= new Promise((resolve, reject) => {
    const css = document.createElement('link')
    css.rel = 'stylesheet'
    css.href = 'vendor/xterm.css'
    document.head.appendChild(css)
    const s = document.createElement('script')
    s.src = 'vendor/xterm.js'
    s.onload = () => (globalThis.Terminal ? resolve(globalThis.Terminal) : reject(new Error('xterm 沒有載入')))
    s.onerror = () => reject(new Error('xterm 載入失敗'))
    document.head.appendChild(s)
  }).catch(e => { xtermLoad = null; throw e })
  return xtermLoad
}

/** 給 xterm 的設定：收輸入（送去哪由 Rust 端檢查）、沒有捲動記錄（每幅都是整個畫面） */
export const xtermOptions = ({ cols, rows }) => ({
  cols, rows,
  disableStdin: false,
  scrollback: 0,
  cursorBlink: false,
  cursorInactiveStyle: 'block',   // 沒點進去的時候，不設就看不清楚游標在哪
  allowProposedApi: false,
  logLevel: 'off',
  fontSize: 13,
  fontFamily: '"Cascadia Mono", Consolas, "Microsoft JhengHei", monospace',
})

export const TermView = {
  name: 'TermView',
  props: {
    api: { type: Object, required: true },    // lib/tauri.mjs 的 termViewApi
    id: { type: String, default: '' },        // 終端編號（ASN 開的 grok、agy）
    name: { type: String, default: '' },      // 夥伴視窗名（Claude）
    active: { type: Boolean, default: true },   // 看不到時不讀窗格
    canBack: { type: Boolean, default: false },   // 對話區裡打開時訊息區會收起來（#901）：要有切回去的按鈕
  },
  emits: ['back'],
  setup(props) {
    const host = ref(null), lostText = ref(''), inputError = ref(''), pendingPaste = ref(''), pasteNote = ref(''), askHint = ref('')
    // 夥伴停在要你回答的地方：本機的同意框這時不跳，改在畫面上方提示
    let hintTimer = 0
    const refreshHint = async () => {
      if (!props.name || !props.api.notices || !props.active) { askHint.value = ''; return }
      try { askHint.value = viewHint(await props.api.notices(), props.name) } catch { askHint.value = '' }
    }
    onMounted(() => { void refreshHint(); hintTimer = setInterval(() => void refreshHint(), HINT_POLL_MS) })
    onBeforeUnmount(() => clearInterval(hintTimer))
    let xtermRef = null
    let session = null, follow = createFollow(), lastRow = 0, lastRows = DEFAULT_ROWS
    // 窗格比區塊高時，游標（輸入框、權限框）常在下面：跟著捲，使用者往上看時不打擾
    const target = () => {
      const el = host.value, screen = el?.querySelector('.xterm-screen')
      if (!screen) return 0
      return followTarget({ cursorRow: lastRow, rowHeight: screen.clientHeight / lastRows, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight })
    }
    const followCursor = frame => {
      lastRow = Math.max(0, Number(frame?.meta?.cursor_y) || 0)
      lastRows = Number(frame?.meta?.rows) || DEFAULT_ROWS
      if (!follow.following()) return
      const t = target()
      follow.place(t)
      host.value.scrollTop = t
    }
    const onScroll = () => follow.onScroll(host.value.scrollTop, target())
    const stop = () => { if (session) { session.stop(); session = null } xtermRef = null; pendingPaste.value = '' }
    const typed = (data, paste = false, ime = false) => {
      if (!session || !data) return
      inputError.value = ''
      session.input(data, paste, ime)
    }
    // 輸入法組字（#956）：組字中、或剛組完的那一筆標成 ime，只用來記紀錄（Rust 端只記數量，不記內容）
    const ime = imeTracker()
    // 貼上一律由這裡接手（不讓 xterm 自己處理，它不知道窗格裡的程式有沒有開 bracketed paste）：
    // 單行直接送，多行先問；太長請分段
    const onPaste = ev => {
      const text = ev.clipboardData?.getData('text') ?? ''
      ev.preventDefault()
      ev.stopPropagation()
      if (!text) return
      if ([...text].length > PASTE_MAX_CHARS) { inputError.value = '一次貼太多了，請分段貼上。'; return }
      if (pasteNeedsConfirm(text)) { pendingPaste.value = text; pasteNote.value = pasteSummary(text); return }
      typed(text, true)
    }
    const confirmPaste = () => { const t = pendingPaste.value; pendingPaste.value = ''; typed(t, true); xtermRef?.focus() }
    const cancelPaste = () => { pendingPaste.value = ''; xtermRef?.focus() }
    const focusTerm = () => xtermRef?.focus()
    const start = () => {
      stop()
      lostText.value = ''
      follow = createFollow()
      const target = props.id ? { id: props.id } : { name: props.name }
      session = createTermViewSession({
        open: () => props.api.open(target),
        close: viewId => props.api.close(viewId),
        listen: props.api.listen,
        sendInput: props.api.input ? (viewId, data, paste, imeFlag) => props.api.input(viewId, data, paste, imeFlag) : undefined,
        onInputError: e => { inputError.value = e.lost_bytes ? `${e.message}（有 ${e.lost_bytes} 位元組沒送出）` : e.message },
        createTerm: async size => {
          const Terminal = await loadXterm()
          await nextTick()
          const t = new Terminal(xtermOptions(size))
          // 沒有捲動記錄時，xterm 會把滾輪換成方向鍵送給程式、還攔下事件，外層就捲不動。滾輪一律交給外層
          t.attachCustomWheelEventHandler(() => false)
          // 貼上鍵不讓 xterm 吃掉，交給瀏覽器貼上
          t.attachCustomKeyEventHandler(termKeyHandler)
          t.open(host.value)
          // 打字：xterm 給的按鍵序列原樣送；Rust 端再檢查一次（不是按鍵的序列、不在前景、沒開著都不送）
          ime.attach(t.textarea)
          t.onData(d => typed(d, false, ime.recent()))
          xtermRef = t
          return t
        },
        onLost: () => { session = null; lostText.value = TERM_VIEW_LOST },
        onPainted: followCursor,
      })
      void session.start()
    }
    watch(() => [props.active, props.id, props.name].join('\n'), () => { if (props.active) start(); else stop() })
    onMounted(() => { if (props.active) start() })
    onBeforeUnmount(stop)
    return { askHint, host, lostText, inputError, pendingPaste, pasteNote, onScroll, onPaste, confirmPaste, cancelPaste, focusTerm, retry: start, note: props.api.input ? TERM_VIEW_NOTE : TERM_VIEW_NOTE_READONLY }
  },
  template: `
<div class="term-view">
  <p class="term-view-note">{{ note }}</p>
  <p class="term-view-ask" v-if="askHint" role="status">{{ askHint }}</p>
  <button class="aero-btn term-view-back" type="button" v-if="canBack" @click="$emit('back')">回到訊息</button>
  <div class="term-view-screen" ref="host" aria-label="終端畫面" @scroll.passive="onScroll" @click="focusTerm" @paste.capture="onPaste"></div>
  <p class="term-view-paste" v-if="pendingPaste" role="alert">{{ pasteNote }}<button class="aero-btn" type="button" @click="confirmPaste">送出</button><button class="aero-btn" type="button" @click="cancelPaste">取消</button></p>
  <p class="term-view-lost" v-if="inputError" role="status">{{ inputError }}</p>
  <p class="term-view-lost" v-if="lostText" role="status">{{ lostText }}<button class="aero-btn" type="button" @click="retry">重試</button></p>
</div>`,
}
