// 在畫面裡看夥伴的終端（#597）。只看不打字：不接 xterm 的輸入，畫面內容由 Rust 端過濾過才送來（launch/term_view.rs）。
// xterm.js 打包在 ui/vendor，要看時才載入。全程在本機，不連外。
const { ref, watch, onMounted, onBeforeUnmount, nextTick } = globalThis.Vue ?? {}

const FRAME_EVENT = 'term-view-frame'
const CLOSED_EVENT = 'term-view-closed'
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 40

export const TERM_VIEW_NOTE = '這裡只能看。終端視窗如果開著，那邊也是同一個畫面。'
export const TERM_VIEW_LOST = '暫時讀不到這個畫面，視窗可能已經關了。'

/** 一幅畫面要寫給 xterm 的內容：清掉重畫，最後把游標放回窗格的位置。一次寫完，xterm 只會畫一次，不會閃 */
export function frameToWrite(frame) {
  const body = String(frame?.text ?? '').replace(/\r?\n/g, '\r\n').replace(/(\r\n)+$/, '')
  const x = Math.max(0, Number(frame?.meta?.cursor_x) || 0)
  const y = Math.max(0, Number(frame?.meta?.cursor_y) || 0)
  return `\x1b[0m\x1b[H\x1b[2J${body}\x1b[0m\x1b[${y + 1};${x + 1}H`
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
 *   createTerm({ cols, rows }) → { resize, write, dispose }（可以是 Promise）；onLost(原因)；onPainted(一幅，選填)
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
  return { start, stop, flushed: () => chain, viewId: () => viewId }
}

let xtermLoad = null
/** 第一次要看才載入 xterm.js 和它的樣式 */
function loadXterm() {
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

/** 給 xterm 的設定：不收輸入、沒有捲動記錄（每幅都是整個畫面） */
export const xtermOptions = ({ cols, rows }) => ({
  cols, rows,
  disableStdin: true,
  scrollback: 0,
  cursorBlink: false,
  cursorInactiveStyle: 'block',   // 這個 xterm 不拿焦點，不設就看不清楚游標在哪
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
    canBack: { type: Boolean, default: false },   // 視窗矮時訊息區會收起來：對話窗要有切回去的按鈕
  },
  emits: ['back'],
  setup(props) {
    const host = ref(null), lostText = ref('')
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
    const stop = () => { if (session) { session.stop(); session = null } }
    const start = () => {
      stop()
      lostText.value = ''
      follow = createFollow()
      const target = props.id ? { id: props.id } : { name: props.name }
      session = createTermViewSession({
        open: () => props.api.open(target),
        close: viewId => props.api.close(viewId),
        listen: props.api.listen,
        createTerm: async size => {
          const Terminal = await loadXterm()
          await nextTick()
          const t = new Terminal(xtermOptions(size))
          t.open(host.value)
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
    return { host, lostText, onScroll, retry: start, note: TERM_VIEW_NOTE }
  },
  template: `
<div class="term-view">
  <p class="term-view-note">{{ note }}</p>
  <button class="aero-btn term-view-back" type="button" v-if="canBack" @click="$emit('back')">回到訊息</button>
  <div class="term-view-screen" ref="host" aria-label="終端畫面" @scroll.passive="onScroll"></div>
  <p class="term-view-lost" v-if="lostText" role="status">{{ lostText }}<button class="aero-btn" type="button" @click="retry">重試</button></p>
</div>`,
}
