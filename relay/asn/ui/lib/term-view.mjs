// 在畫面裡看夥伴的終端、打字（#597）。畫面內容由 Rust 端過濾過才送來；打字走 term_view_input（只有本機畫面這一個入口，
// Rust 端再檢查一次：開著的畫面、視窗在前景、窗格是 ASN 開的、授權），字一次一支送進窗格、不丟字。
// xterm.js 打包在 ui/vendor，要看時才載入。全程在本機，不連外。
import { viewHint } from './partner-notice.mjs'
import { HISTORY_LINES, atBottom, createHistory, historyScrollTop, historyToWrite, scrollWantsHistory, wheelWantsHistory } from './term-history.mjs'
/** 畫面上提示多久查一次 */
export const HINT_POLL_MS = 3_000
const { ref, watch, onMounted, onBeforeUnmount, nextTick } = globalThis.Vue ?? {}

const FRAME_EVENT = 'term-view-frame'
const CLOSED_EVENT = 'term-view-closed'
const INPUT_ERROR_EVENT = 'term-view-input-error'
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 40

/** 停止跟隨時畫面右下角的提示字 */
export const TERM_VIEW_LATEST = '回到最新'
/** 一次貼上最多幾個字（再多請分段）：Rust 端上限是 256 KB，中文一字最多 3 位元組 */
export const PASTE_MAX_CHARS = 80000
// 只有在共用終端服務裡的夥伴才看得到這個畫面（#900），讀不到就是讀不到：不猜原因，真正的原因進 console
export const TERM_VIEW_LOST = '暫時讀不到這個畫面。'

/** 一幅畫面要寫給 xterm 的內容：清掉重畫，最後把游標放回窗格的位置。一次寫完，xterm 只會畫一次，不會閃 */
export function frameToWrite(frame) {
  const full = String(frame?.text ?? '').replace(/\r?\n/g, '\r\n')
  // #903：有捲動紀錄時，WezTerm 的 get-text 會比畫面多回最多 2 行（畫面上方的捲動紀錄），
  // 但游標列號是畫面內的列號。只留最後 rows 行，文字的第 N 行才會和 cursor_y 對上。
  // --escapes 的輸出是每列一個 \r\n，整份最後再多一個裸換行：先去掉這一個，再去掉最後一列的結尾，剩下的就是一列一個元素
  const rows = Number(frame?.meta?.rows)
  let body = full
  if (Number.isInteger(rows) && rows > 0) {
    const lines = full.replace(/(\r\n)$/, '').split('\r\n')
    // 最後多出來的那個元素是『整份結尾的裸換行』切出來的：純文字時是空字串，真的有顏色時會是殘留的重置序列（例如 `ESC[39m`），不是空字串。
    // 看不見的內容（空或只有顏色／字元集序列）就是這個假列；只在行數超過 rows 時才去掉，剛好 rows 行時不動
    if (lines.length > rows && lines[lines.length - 1].replace(/\x1b\[[0-9;:]*m|\x1b\(B/g, '') === '') lines.pop()
    // 去掉假列之後一律用處理過的 lines 重組（不能留著原文：原文結尾還帶著那個殘留序列，寫進 xterm 會多一個換行、多捲一列）
    body = (lines.length > rows ? lines.slice(-rows) : lines).join('\r\n')
  }
  body = body.replace(/(\r\n)+$/, '')
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
 * 要不要跟著游標捲（#904）。只有人在底部附近（scrollTop 接近外層可捲的最大值 max，容許 2px）才跟；
 * 人往上捲離開底部就停止跟隨，之後每幅畫面都不碰 scrollTop；捲回底部附近才恢復。
 * 自己設定捲動位置也會觸發 scroll 事件：和剛設的位置一樣的就不算使用者捲的。
 * onScroll(scrollTop, max)：max＝scrollHeight - clientHeight。resume(top)：點「回到最新」，直接恢復跟隨。
 */
export function createFollow() {
  let following = true, lastSet = null
  const SLACK = 2
  return {
    following: () => following,
    place: top => { lastSet = top },
    resume: top => { following = true; lastSet = top },
    onScroll: (scrollTop, max) => {
      const mine = lastSet !== null && Math.abs(scrollTop - lastSet) <= SLACK
      lastSet = null   // 只算一次：使用者之後捲回同一個位置，要算他捲的
      if (!mine) following = scrollTop >= max - SLACK
      return mine
    },
  }
}

/** 跟隨時這幅畫面要把 scrollTop 設成多少：只往下推進、不後退；不跟隨或不需要動回 null */
export function followScrollTo({ following, current, target }) {
  return following && target > current ? target : null
}

/** 「回到最新」提示：停止跟隨、或正在看凍結的歷史（#904 B3）才顯示 */
export function latestVisible(following, frozen = false) {
  return following === false || frozen === true
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
  const hist = createHistory()   // 往上看更早的內容（#904 B3）：平常 live，要到歷史後凍結重畫
  const now = () => (deps.now ? deps.now() : Date.now())

  const paint = async frame => {
    if (stopped || frame.seq <= lastSeq) return
    lastSeq = frame.seq
    const cols = Number(frame.meta?.cols) || DEFAULT_COLS, rows = Number(frame.meta?.rows) || DEFAULT_ROWS
    if (!term) {
      term = await deps.createTerm({ cols, rows })
      if (stopped) { term.dispose(); term = null; return }
      size = { cols, rows }
    }
    // 凍結（看歷史）時新的畫面幅只存起來，不寫進 xterm，閱讀時內容才不會被推走
    if (!hist.frame(frame)) return
    if (size.cols !== cols || size.rows !== rows) { term.resize(cols, rows); size = { cols, rows } }
    term.write(frameToWrite(frame))
    deps.onPainted?.(frame)
  }
  // 一幅一幅照順序畫；xterm 載入中到的畫面排在後面
  const enqueue = frame => {
    chain = chain.then(() => paint(frame)).catch(e => { console.info('[ASN] 終端畫面畫不出來', String(e?.message ?? e)); lost(String(e?.message ?? e)) })
  }
  // 向後端要一次歷史（只有 live 且不在冷卻才會真的要）。拿到有歷史的就凍結：xterm 拉高成「歷史＋畫面」列，通知畫面調整捲動位置
  const applyHistory = (token, payload) => {
    if (stopped || !term) return
    const m = payload?.meta ?? {}
    const cols = Number(m.cols) || size.cols, rows = Number(m.rows) || size.rows
    const plan = historyToWrite(payload?.text, { ...m, rows })
    if (!hist.loaded(token, plan.histCount, now())) { deps.onHistoryState?.(hist.state()); return }
    term.resize(cols, plan.totalRows)
    size = { cols, rows: plan.totalRows }
    term.write(plan.data)
    deps.onHistoryState?.('frozen', { histCount: plan.histCount, totalRows: plan.totalRows, rows })
  }
  const wantHistory = () => {
    if (stopped || viewId === null || !term || !deps.history) return false
    const token = hist.request(now())
    if (!token) return false
    deps.onHistoryState?.('loading')
    const id = viewId
    Promise.resolve().then(() => deps.history(id, HISTORY_LINES)).then(
      payload => { chain = chain.then(() => applyHistory(token, payload)).catch(e => console.info('[ASN] 歷史畫不出來', String(e?.message ?? e))) },
      e => { console.info('[ASN] 讀不到更早的內容', String(e?.message ?? e)); hist.failed(token, now()); deps.onHistoryState?.(hist.state()) },
    )
    return true
  }
  // 回到最新：解除凍結，xterm 恢復成窗格大小，用最新一幅重畫
  const backToBottom = () => {
    const was = hist.state()
    const f = hist.release()
    if (was !== 'live') deps.onHistoryState?.('live')
    if (!f || !term || stopped) return false
    const cols = Number(f.meta?.cols) || DEFAULT_COLS, rows = Number(f.meta?.rows) || DEFAULT_ROWS
    term.resize(cols, rows)
    size = { cols, rows }
    term.write(frameToWrite(f))
    deps.onPainted?.(f)
    return true
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
  return { start, stop, input, wantHistory, backToBottom, frozen: () => hist.frozen(), historyState: () => hist.state(), flushed: () => chain, inputFlushed: () => inputChain, viewId: () => viewId }
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
  },
  setup(props) {
    const host = ref(null), lostText = ref(''), inputError = ref(''), pendingPaste = ref(''), pasteNote = ref(''), askHint = ref(''), behind = ref(false), histLoading = ref(false)
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
      if (session?.frozen()) return   // 看歷史時不動捲動位置
      lastRow = Math.max(0, Number(frame?.meta?.cursor_y) || 0)
      lastRows = Number(frame?.meta?.rows) || DEFAULT_ROWS
      const t = followScrollTo({ following: follow.following(), current: host.value.scrollTop, target: target() })
      if (t === null) return
      follow.place(t)
      host.value.scrollTop = t
    }
    const maxTop = () => Math.max(0, host.value.scrollHeight - host.value.clientHeight)
    const refreshBehind = () => { behind.value = latestVisible(follow.following(), !!session?.frozen()) }
    const toBottom = () => {
      const top = maxTop()
      follow.resume(top)
      host.value.scrollTop = top
    }
    // 回到最新：解除凍結（xterm 縮回窗格大小、用最新一幅重畫），外層捲到最底、恢復跟隨。縮回後高度要等下一個畫面才準，補捲一次
    const resumeLive = () => {
      session?.backToBottom()
      toBottom()
      refreshBehind()
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { if (host.value && !session?.frozen()) { toBottom(); refreshBehind() } })
    }
    const onScroll = () => {
      const el = host.value, max = maxTop()
      const mine = follow.onScroll(el.scrollTop, max)
      if (session?.frozen()) { if (!mine && atBottom(el.scrollTop, max)) resumeLive(); else refreshBehind(); return }
      if (scrollWantsHistory({ scrollTop: el.scrollTop, max, mine })) session?.wantHistory()
      refreshBehind()
    }
    // 滾輪往上、而且已在最頂（含內容沒超過容器、本來就捲不動）：想看更舊的
    const onPullUp = ev => { if (wheelWantsHistory({ deltaY: ev.deltaY, scrollTop: host.value.scrollTop })) session?.wantHistory() }
    const jumpLatest = () => { resumeLive(); behind.value = false }
    // 歷史狀態變了：載入中顯示小字；凍結後保持使用者看到的位置不跳（原本的畫面部分留在原處，歷史出現在上方）
    let snap = { max: 0, rowHeight: 0 }   // 去要歷史那一刻的外層可捲高度與列高：xterm 拉高之後這兩個值就變了
    const onHistoryState = (state, info) => {
      histLoading.value = state === 'loading'
      if (state === 'loading' && host.value) {
        const screen = host.value.querySelector('.xterm-screen')
        snap = { max: maxTop(), rowHeight: screen ? screen.clientHeight / lastRows : 0 }
      }
      if (state !== 'frozen' || !host.value) return
      const oldTop = host.value.scrollTop
      const apply = () => {
        if (!host.value || !session?.frozen()) return
        const top = historyScrollTop({ oldTop, oldMax: snap.max, histCount: info.histCount, rowHeight: snap.rowHeight, newMax: maxTop() })
        follow.place(top)
        host.value.scrollTop = top
      }
      refreshBehind()
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(apply))
      else apply()
    }
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
      behind.value = false
      histLoading.value = false
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
        history: props.api.history ? (viewId, lines) => props.api.history(viewId, lines) : undefined,
        onHistoryState,
      })
      void session.start()
    }
    watch(() => [props.active, props.id, props.name].join('\n'), () => { if (props.active) start(); else stop() })
    onMounted(() => { if (props.active) start() })
    onBeforeUnmount(stop)
    return { askHint, host, lostText, inputError, pendingPaste, pasteNote, onScroll, onPaste, confirmPaste, cancelPaste, focusTerm, retry: start, behind, histLoading, jumpLatest, onPullUp, TERM_VIEW_LATEST }
  },
  template: `
<div class="term-view">
  <p class="term-view-ask" v-if="askHint" role="status">{{ askHint }}</p>
  <div class="term-view-screen" ref="host" aria-label="終端畫面" @scroll.passive="onScroll" @wheel.passive="onPullUp" @click="focusTerm" @paste.capture="onPaste"></div>
  <p class="term-view-loading" v-if="histLoading" role="status">讀取更早的內容…</p>
  <button class="aero-btn term-view-latest" type="button" v-if="behind" @click="jumpLatest">{{ TERM_VIEW_LATEST }}</button>
  <p class="term-view-paste" v-if="pendingPaste" role="alert">{{ pasteNote }}<button class="aero-btn" type="button" @click="confirmPaste">送出</button><button class="aero-btn" type="button" @click="cancelPaste">取消</button></p>
  <p class="term-view-lost" v-if="inputError" role="status">{{ inputError }}</p>
  <p class="term-view-lost" v-if="lostText" role="status">{{ lostText }}<button class="aero-btn" type="button" @click="retry">重試</button></p>
</div>`,
}
