// 看別台電腦上夥伴的畫面（#597 別台看畫面）。**只能看：** 這裡沒有任何打字、貼上、按鍵的路，
// xterm 也關掉輸入（disableStdin）。畫面內容在 Rust 端解密、擋重放、再過濾過才送來；xterm 只寫入，不解析連結。
// 按下去就直接開始（11-08 起不再確認本人），之後在背景回報狀態。
import { frameToWrite, loadXterm, xtermOptions } from './term-view.mjs'
import { installWideChars } from './term-width.mjs'
import { GRACE_ENDED_TEXT } from './term-grace.mjs'
const { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } = globalThis.Vue ?? {}

// 第 2 格的字和本機終端一樣（#1029 前是「看畫面」）
export const REMOTE_LABEL = '終端'
export const REMOTE_TIP = '看這位夥伴在那台電腦上的終端（只能看；再按一次回到訊息）'
export const FRAME_EVENT = 'term-view-remote-frame'
export const END_EVENT = 'term-view-remote-end'
/** 到期前多久提醒（毫秒） */
export const WARN_BEFORE_MS = 60_000

export const REMOTE_TEXT = {
  waiting: '等那台電腦回應……',
  watching: (machine, name) => `正在看「${machine}」上「${name}」的畫面（只能看）`,
  soon: '再 1 分鐘就會結束，要繼續看請結束後再按一次。',
  stop: '結束',
  again: '再看一次',
  failed: '沒有開始。',
}

/**
 * 電腦版把狀態放在視窗最下面的狀態列（手機照舊在終端上方一條）：這裡算出狀態列要顯示的 { text, level }，沒有就回 null。
 * level：info（正在看）、ask（等對方回應）、warn（快到期、結束）、danger（正在打字、送不出去，要醒目）。
 * 優先順序：結束的說明 > 送不出去 > 目前狀態；快到期的提醒接在目前狀態後面。
 */
export function remoteBarState({ phase, soon, note, warn, main, danger }) {
  if (phase === 'ended') return note ? { text: note, level: 'warn' } : null
  if (warn) return { text: warn, level: 'danger' }
  const base = (phase === 'starting' || phase === 'waiting') ? { text: main.waiting, level: 'ask' } : (main.active ? { text: main.active, level: danger ? 'danger' : 'info' } : null)
  if (!base) return null
  return soon ? { text: `${base.text} ${REMOTE_TEXT.soon}`, level: base.level === 'danger' ? 'danger' : 'warn' } : base
}

/** 這位夥伴能不能從這台看：電腦版、別台電腦的、不是離線、那台在本人帳號底下而且這台能發起（avail＝電腦端回的 true／false／null） */
export function remoteEntry({ api, friend, selfNode, avail }) {
  return Boolean(api) && Boolean(friend?.node) && friend.node !== selfNode && friend?.status !== 'offline' && avail === true
}

/** 問電腦端這台能不能看那台：true／false；問不到回 null（原因只進 console） */
export async function askRemote(api, node) {
  if (!api || typeof api.available !== 'function' || !node) return null
  try {
    const r = await api.available(node)
    return typeof r === 'boolean' ? r : null
  } catch (e) {
    console.info('[ASN] 查不到這台能不能看那台的畫面', String(e?.message ?? e))
    return null
  }
}

/**
 * 手機看終端：xterm 依電腦端的列數固定高度，區塊比它矮（鍵盤開著）時，最底下的輸入列會在可見範圍外。
 * 回傳要把外層 scrollTop 設成多少，才讓游標那一整列看得到；不用動回 null。
 * follow＝使用者沒有自己捲離底部（false 就完全不動，不把正在看舊內容的人拉回來）。
 * offset＝畫面頂端離外層內容頂端的距離（內距）。
 */
export function cursorScrollTop({ cursorRow, rowHeight, viewHeight, scrollTop, maxScroll, follow, offset = 0 }) {
  if (!follow) return null
  const row = Number(cursorRow), h = Number(rowHeight), view = Number(viewHeight)
  if (!(h > 0) || !(view > 0) || !Number.isFinite(row) || row < 0) return null
  const top = offset + row * h, bottom = top + h
  const cur = Number(scrollTop) || 0
  let want = null
  if (bottom > cur + view) want = bottom - view
  else if (top < cur) want = top
  if (want === null) return null
  const t = Math.min(Math.max(0, Number(maxScroll) || 0), Math.max(0, Math.ceil(want)))
  return Math.abs(t - cur) < 0.5 ? null : t
}

/** 位置差在這個像素內，不算使用者捲的（鍵盤開關造成的版面夾值、慣性殘留、瀏覽器多送的 scroll 事件） */
export const USER_SCROLL_SLACK = 8

/**
 * 手機看終端的「使用者是否自己捲離」狀態。和電腦版 createFollow 不同：我們把 scrollTop 設在游標列下緣（不是最底），
 * 所以不能用「在最底」判斷。
 * - onProgrammatic(t)：我們自己設了 scrollTop；之後離 t 在 USER_SCROLL_SLACK 內的 scroll 事件都不算使用者捲的。
 * - onScroll(scrollTop, { cursorVisible })：離最後一次自己設的位置超過 SLACK 才算使用者捲的；
 *   捲到游標看不到的地方就 away，捲回游標看得到的位置就恢復（不是捲到最底）。
 * - away()：true 時 cursorScrollTop 要用 follow=false。reset()：重新開始。
 */
export function createCursorFollow(slack = USER_SCROLL_SLACK) {
  let userAway = false, lastSet = null
  return {
    away: () => userAway,
    onProgrammatic: t => { lastSet = Number(t) },
    // 容器大小變了（鍵盤收起／長高）：瀏覽器會把 scrollTop 夾回新範圍並送 scroll 事件，那不是使用者捲的。
    // 還沒捲離時，把夾值後的位置當成「自己設的」，讓那次事件落在 slack 內；已經捲離的不動（使用者的意思照舊）
    onLayout: scrollTop => { if (!userAway) lastSet = Number(scrollTop) },
    onScroll: (scrollTop, { cursorVisible }) => {
      // 小幅變動不會讓人「捲離」，但游標看得到時可以恢復
      if (lastSet !== null && Math.abs(scrollTop - lastSet) <= slack) { if (cursorVisible) userAway = false; return false }
      userAway = !cursorVisible
      return true
    },
    reset: () => { userAway = false; lastSet = null },
  }
}

/** 唯讀的 xterm 設定：在本機看畫面的設定上關掉輸入 */
export const remoteXtermOptions = size => ({ ...xtermOptions(size), disableStdin: true })

/**
 * 開始之後才建 xterm：等畫面元素真的掛上去。元素不在（例如發起時這一格被收掉了）就回 null，
 * 由呼叫的一方結束這次觀看，不丟「Terminal requires a parent element」。
 */
export async function openTerm(Terminal, options, hostRef, tick, alive) {
  for (let i = 0; i < 3; i++) {
    if (!alive()) return null
    const el = hostRef.value
    if (el && el.isConnected !== false) {
      const term = new Terminal(options)
      installWideChars(term)
      term.attachCustomWheelEventHandler(() => false)
      term.open(el)
      return term
    }
    await tick()
  }
  return null
}

/**
 * 註冊事件監聽，但只在這一次發起還算數時留著：listen 是非同步的，註冊完時那一次可能已經作廢（收掉或重新發起），
 * 這時馬上解除、回 null，不然監聽會一直留著（收掉時 cleanup 已經跑過，不會再收它）。
 */
export async function listenWhile(api, event, fn, wanted) {
  const off = await api.listen(event, fn)
  if (wanted()) return off
  try { off?.() } catch { /* 解除失敗不影響 */ }
  return null
}

/** 錯誤訊息給本人看的部分：Rust 端回的已經是白話；空的就用通用的 */
export function startError(e) {
  const s = String(e?.message ?? e ?? '').trim()
  return s || REMOTE_TEXT.failed
}

export const RemoteView = {
  props: {
    api: { type: Object, required: true },        // lib/tauri.mjs 的 remoteViewApi
    node: { type: String, required: true },
    name: { type: String, required: true },       // 夥伴名（那台的視窗名）
    machine: { type: String, default: '' },       // 那台電腦的名字
    active: { type: Boolean, default: true },
    barInline: { type: Boolean, default: true },  // true＝狀態文字在終端上方一條（手機）；false＝交給外層放到視窗最下面的狀態列（電腦版，用 status 事件傳）
    endedNote: { type: String, default: '' },     // 電腦版：一掛上就是「已結束」、寫這句、不發起（打字中離開分頁），等本人按「重新看」才發起
  },
  // cancel：本人取消了發起前的確認（手機，mobile-remote-view.mjs）。不顯示錯誤，交給外層切回訊息
  // started：發起成功（帶 Rust 回的資料，手機用來顯示那台的確認狀態）；ended：這次觀看結束或被收掉
  emits: ['cancel', 'status', 'started', 'ended'],
  setup(props, { emit }) {
    const host = ref(null), phase = ref(props.endedNote ? 'ended' : 'starting'), note = ref(props.endedNote), soon = ref(false)
    const expired = ref(Boolean(props.endedNote))   // 電腦版：離開分頁而結束（狀態列要有「重新看」）
    const bar = computed(() => remoteBarState({ phase: phase.value, soon: soon.value, note: note.value, warn: '', main: { waiting: REMOTE_TEXT.waiting, active: phase.value === 'watching' ? REMOTE_TEXT.watching(props.machine || props.node, props.name) : '' }, danger: false }))
    watch(() => (bar.value ? bar.value.level + '|' + bar.value.text + '|' + expired.value : ''), () => { if (!props.barInline) emit('status', bar.value ? { ...bar.value, restartable: expired.value } : null) }, { immediate: true })
    let id = '', term = null, offFrame = null, offEnd = null, warnTimer = 0, alive = true
    // 手機：游標那一列要看得到。follow＝使用者沒自己捲離底部；程式自己設的捲動位置不算使用者捲的（createFollow 內處理）
    let follow = createCursorFollow(), ro = null, scrollEl = null, lastSize = ''
    // 大小有沒有變（和上次記的比）。scroll 事件和 ResizeObserver 回呼誰先到都不一定（算繪流程裡 scroll 事件在 ResizeObserver 之前），
    // 所以兩邊都先問這個：先到的那邊負責把這次當成「版面造成」，不看位置差，比開一個時間窗穩（不會誤吞使用者緊接著的真捲動）
    const sizeChanged = el => {
      const now = el.clientWidth + 'x' + el.clientHeight
      const changed = lastSize !== '' && now !== lastSize
      lastSize = now
      return changed
    }
    const followMax = el => Math.max(0, el.scrollHeight - el.clientHeight)
    // 游標那一列要把 scrollTop 設到哪（null＝已經看得到、不用動）；follow 傳 true 就是「不管使用者有沒有捲離」，用來判斷游標看不看得到
    const cursorTarget = followFlag => {
      const el = host.value, screen = el?.querySelector?.('.xterm-screen')
      if (!el || !screen || !term?.rows) return undefined
      const rowHeight = screen.clientHeight / term.rows
      const offset = screen.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
      return cursorScrollTop({ cursorRow: term.buffer?.active?.cursorY, rowHeight, viewHeight: el.clientHeight, scrollTop: el.scrollTop, maxScroll: followMax(el), follow: followFlag, offset })
    }
    const keepCursorVisible = () => {
      const t = cursorTarget(!follow.away())
      if (t === null || t === undefined) return
      follow.onProgrammatic(t)
      host.value.scrollTop = t
    }
    const onUserScroll = () => {
      const el = host.value
      if (!el) return
      if (sizeChanged(el)) { follow.onLayout(el.scrollTop); keepCursorVisible(); return }   // 大小剛變：夾值造成的，不是使用者
      const t = cursorTarget(true)
      if (t !== undefined) follow.onScroll(el.scrollTop, { cursorVisible: t === null })
    }
    const onResize = () => {
      const el = host.value
      if (el && sizeChanged(el)) follow.onLayout(el.scrollTop)
      keepCursorVisible()
    }
    const unwatchScroll = () => {
      ro?.disconnect?.(); ro = null
      scrollEl?.removeEventListener?.('scroll', onUserScroll); scrollEl = null
    }
    // 每次發起一個序號：這一格收掉或重新發起時，舊的就作廢。手機的本人確認可能很晚才回來，作廢的就算回 ok 也不送 start
    let gen = 0
    const onVisible = () => { if (id) void props.api.pause(id, document.visibilityState === 'hidden').catch(() => {}) }
    const cleanup = () => {
      clearTimeout(warnTimer)
      offFrame?.(); offEnd?.(); offFrame = offEnd = null
      document.removeEventListener('visibilitychange', onVisible)
      unwatchScroll()
      term?.dispose?.(); term = null
      emit('ended')   // 每次收掉都告訴外層（手機用來收起「確認指紋」條）；收掉前沒開始過也無妨
    }
    const finish = text => { cleanup(); phase.value = 'ended'; note.value = text; id = '' }
    const start = async () => {
      const my = ++gen
      const wanted = () => alive && my === gen
      cleanup()
      phase.value = 'starting'; note.value = ''; soon.value = false; expired.value = false
      try {
        const Terminal = await loadXterm()
        if (!wanted()) return
        // lib/tauri.mjs 的 listen 交給回呼的已經是內容本身（不是 { payload }）。#1029 第一版前這裡讀 ev.payload，每一幅都被丟掉，畫面一直停在「等」
        // 每個監聽註冊完先看這一次還算不算數：已作廢就馬上解除，不掛到 offFrame／offEnd 上
        const offF = await listenWhile(props.api, FRAME_EVENT, f => {
          if (!f || f.id !== id || !term) return
          if (phase.value !== 'watching') phase.value = 'watching'
          // 窗格的欄、列數和畫面不一樣就跟著改（#903）：游標列是窗格內的列號，xterm 的列數不同時最後一列會落在別處
          const c = Number(f.meta?.cols), r = Number(f.meta?.rows)
          if (Number.isInteger(c) && Number.isInteger(r) && c > 0 && r > 0 && (term.cols !== c || term.rows !== r) && typeof term.resize === 'function') term.resize(c, r)
          term.write(frameToWrite(f), keepCursorVisible)   // 寫完（游標位置更新後）再調捲動位置
        }, wanted)
        if (!offF) return
        offFrame = offF
        const offE = await listenWhile(props.api, END_EVENT, e => { if (e?.id === id) finish(e.text || '') }, wanted)
        if (!offE) return
        offEnd = offE
        const r = await props.api.start(props.node, props.name, props.machine, { wanted })
        // 發起的時候這一格被收掉了（或又重新發起）：這次已經開始，要記得結束，不然那台會一直送到到期
        if (!wanted()) { if (r?.id) void props.api.stop(r.id).catch(() => {}); return }
        id = r.id
        phase.value = 'waiting'
        emit('started', { ...r, machine: props.machine || props.node })
        term = await openTerm(Terminal, remoteXtermOptions({ cols: 120, rows: 40 }), host, nextTick, () => alive)
        if (!term) { stop(); if (alive) finish(REMOTE_TEXT.failed); return }
        document.addEventListener('visibilitychange', onVisible)
        follow = createCursorFollow()
        scrollEl = host.value
        lastSize = ''; if (scrollEl) sizeChanged(scrollEl)
        scrollEl?.addEventListener?.('scroll', onUserScroll, { passive: true })
        if (typeof ResizeObserver === 'function' && scrollEl) { ro = new ResizeObserver(onResize); ro.observe(scrollEl) }
        const left = Number(r.expires_s) * 1000 - Date.now() - WARN_BEFORE_MS
        warnTimer = setTimeout(() => { soon.value = true }, Math.max(0, left))
      } catch (e) {
        if (!wanted()) return   // 已經作廢的那一次：不管結果是什麼都不動畫面
        if (e?.code === 'cancel') { cleanup(); emit('cancel'); return }   // 什麼都沒送，也不留錯誤
        console.info('[ASN] 看別台畫面沒有開始', String(e?.message ?? e))
        finish(startError(e))
      }
    }
    const stop = () => { if (id) void props.api.stop(id).catch(() => {}) }
    // 電腦版離開分頁超過寬限：現在就結束（對方的紅條收掉）。發起到一半的也作廢，等它回來時會自己結束
    const expire = () => {
      if (phase.value === 'ended') return
      gen++; stop(); finish(GRACE_ENDED_TEXT); expired.value = true
    }
    // 切回來：畫面在隱藏期間沒有版面，重畫一次並把游標那一列捲到看得到
    const refit = () => { if (term) { term.refresh?.(0, Math.max(0, (term.rows || 1) - 1)); keepCursorVisible() } }
    onMounted(() => { if (props.active && !props.endedNote) void start() })
    onBeforeUnmount(() => { alive = false; gen++; stop(); cleanup(); if (!props.barInline) emit('status', null) })
    return { host, phase, note, soon, again: start, expire, refit, expired, TEXT: REMOTE_TEXT }
  },
  template: `
<div class="term-view term-remote" :class="{ 'term-desk': !barInline }">
  <p class="term-view-ask" role="status" v-if="barInline && (phase === 'starting' || phase === 'waiting')">{{ TEXT.waiting }}</p>
  <p class="term-remote-bar" role="status" v-else-if="barInline && phase === 'watching'">{{ TEXT.watching(machine || node, name) }}</p>
  <p class="term-view-lost" role="status" v-if="barInline && soon && phase !== 'ended'">{{ TEXT.soon }}</p>
  <div class="term-view-screen" ref="host" aria-label="別台電腦上的畫面（只能看）" v-show="phase === 'waiting' || phase === 'watching'"></div>
  <p class="term-view-lost" role="status" v-if="phase === 'ended'">{{ barInline ? note : '' }}<button class="aero-btn" type="button" v-if="barInline || !expired" @click="again">{{ TEXT.again }}</button></p>
</div>`,
}
