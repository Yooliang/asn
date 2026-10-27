// 對話區元件：分開模式的對話視窗（chat.html）與整合模式右邊的分頁內容（list.html）共用同一份版面。
// 只顯示、只發事件（send／nudge／toggle-dp），不碰網路與 Tauri；信件內文與名稱一律先跳脫才進 v-html（訊息內文走 markdown.mjs，自帶跳脫與白名單淨化）。
import { renderMarkdown, handleLinkClick } from './markdown.mjs'
import { EMO, emo, fmt, fmtDate, initial, plain } from './text.mjs'
import { composeHintTitle, composePlaceholder } from './compose.mjs'
import { foldBarArrow, hasSideCol, isCollapsed, msgLayout, paneClasses, sideOf } from './merge.mjs'
import { autoAvatarDataUrl } from './avatar.mjs'
import { AsnAvatar } from './avatar-badge.mjs'
import { QUOTE_PREFIX, composeReply, findQuoted, replyTarget, splitQuote } from './reply-quote.mjs'
import { applyMention, markMentions, mentionOptions, mentionQuery } from './mention.mjs'
import { FILE_ACCEPT, formatBytes, photoExpired, photoTitle } from './photo.mjs'
import { attachmentFromFile, imageFromBlob } from './photo-canvas.mjs'
import { Annotator } from './annotator.mjs'
import { ActionBar, opsMenuItems } from './actionbar.mjs'
import { CallView } from './call-view.mjs'
import { ConfirmCards } from './group-sheet.mjs'
import { roomAttachAllowed } from './groups.mjs'
import { readLabel, readTitle } from './mobile-rooms.mjs'
import { canCallPartner } from './mobile-call.mjs'
import { CALL_END_NOTE, splitCallEnd } from './call-end.mjs'
import { DICT_PHASE_TEXT, DICT_TIP, appendDictation } from './mobile-dictation.mjs'
import { isVoiceMsg } from './voice-mark.mjs'
import { shotFileName } from './shot.mjs'
import { buildNameHints } from './stt-text.mjs'
import { statusTip, tierOf } from './sent-status.mjs'
import { isAsnWindow, showsWaiting } from './roster.mjs'
import { warnKind } from './head-tone.mjs'
import { DISPLAY_ONLY_TAG, displayOnlyHint, isDisplayOnly } from './display-only.mjs'
import { keepScroll, olderNote, rearmed, wantsOlder } from './scrollback.mjs'

const { ref, computed, watch, nextTick, onMounted, onBeforeUnmount, reactive } = Vue
const STATUS = { online: '線上', busy: '忙碌', away: '暫離', offline: '顯示為離線', stopped: '已停止' }

export const ChatPane = {
  name: 'ChatPane',
  components: { Annotator, ActionBar, CallView, ConfirmCards, AsnAvatar },
  props: {
    friend: { type: Object, default: null },
    me: { type: Object, default: () => ({ nick: '我', status: 'online' }) },
    friendAv: { type: String, default: '' },       // 大頭貼圖片網址（自動產生或設備上傳）
    meAv: { type: String, default: '' },
    log: { type: Array, default: () => [] },
    dpMode: { type: String, default: 'left' },     // 頭像模式：left／right＝側欄；inline＝頭像在每則訊息旁
    toolbar: { type: String, default: 'top' },     // 工具列位置：top（輸入框上方）／bottom（輸入框下方）
    bubble: { type: String, default: 'none' },     // 文字底色：none／color／auto
    dpCollapsed: { type: Boolean, default: false },  // 側欄收合（只對 left／right 有意義）
    active: { type: Boolean, default: true },      // 整合模式下只有目前分頁是 true；變成 true 時捲到底並聚焦輸入框
    winMode: { type: String, default: 'split' },   // split｜merged：整合模式用較短的輸入提示
    photoApi: { type: Object, default: null },     // photoApi.fetch 回 {data_url}、photoApi.save 回路徑：放大看與另存（Rust 端，金鑰不在前端）；沒給就不能放大
    shotApi: { type: Object, default: null },      // 截圖（lib/tauri.mjs 的 shotApi）；沒給或這個系統不支援就沒有截圖鈕
    agentApi: { type: Object, default: null },     // 上方功能列用（lib/tauri.mjs 的 transport）；沒給就沒有功能列
    selfNode: { type: String, default: '' },       // 這台設備的節點代號（只拿來判斷是不是本機的視窗，不顯示）
    voice: { type: Object, default: null },        // 語音功能（lib/voice-ui.mjs 的 createVoiceUi）；沒給就沒有念出訊息與麥克風
    hideBusyWarn: { type: Boolean, default: false },  // 手機版：對方忙碌時不顯示黃色說明條（標題列已改黃底）
    callApi: { type: Object, default: null },      // 手機版的通話（lib/mobile-call.mjs 的 createMobileCall 工廠，另帶 phaseText）；電腦版不給，通話走 voice.newCall
    dictApi: { type: Object, default: null },     // 手機版的語音輸入（{ newDictation({ hints, onText }) }，工廠見 lib/mobile-dictation.mjs）；沒給或這支手機沒有語音辨識服務就沒有語音輸入鈕
    loadOlder: { type: Function, default: null },  // 往上捲到頂載入更舊的信：(好友 id) => Promise<{ more, added, busy?, error? }>；沒給就不載入
    hintNames: { type: Array, default: () => [] },  // 名單上的夥伴（給語音辨識偏向名字用，選填）；通話對象自己一定會帶
    enterSends: { type: Boolean, default: true },  // Enter 直接送出（電腦預設）；手機的軟鍵盤 Enter 是換行，傳送靠按鈕
    roomCards: { type: Array, default: () => [] },  // 群組：待主持人確認的請求卡片（lib/groups.mjs 的 confirmCards）；非群組不用
    groupMenu: { type: Boolean, default: false },   // 電腦版：對話上方的「⋯」（邀請別人加入、成員與設定）；手機版有自己的「⋯」，不開這個
  },
  emits: ['send', 'nudge', 'toggle-dp', 'attach', 'call-state', 'group-decide', 'group-menu'],
  setup(props, { emit }) {
    const draft = ref(''), pickerOpen = ref(false), nudgeCooling = ref(false)
    const replying = ref(null)   // 正在回覆的那一則：{ author, excerpt, seq, index, mention }
    const msgsEl = ref(null), composeEl = ref(null)
    const isRoom = computed(() => props.friend?.room === true)
    const attachOk = computed(() => roomAttachAllowed(props.friend))   // 群組有外部成員（別的帳號）時沒有附件鈕
    const opsItems = computed(() => (props.groupMenu ? opsMenuItems(props.friend) : []))   // 大按鈕區的「管理」選單
    const pickMenu = op => emit('group-menu', op)
    const isAsn = computed(() => isAsnWindow(props.friend))
    const showWaiting = computed(() => showsWaiting(props.friend))
    const sideCol = computed(() => hasSideCol(props.dpMode))
    const composeHint = computed(() => (displayOnly.value ? displayOnlyHint(props.friend) : composePlaceholder(props.winMode)))
    const composeTitle = computed(() => (displayOnly.value ? displayOnlyHint(props.friend) : composeHintTitle(props.winMode)))
    const collapsed = computed(() => isCollapsed(props.dpMode, props.dpCollapsed))
    const classes = computed(() => paneClasses({ dpMode: props.dpMode, bubble: props.bubble, collapsed: props.dpCollapsed, toolbar: props.toolbar }))
    const side = computed(() => sideOf(props.dpMode))
    const displayOnly = computed(() => !isRoom.value && isDisplayOnly(props.friend))   // 本機程序掃描的條目：只顯示，不能收信
    const warn = computed(() => (displayOnly.value ? null : warnKind(props.friend?.status, { hideBusy: props.hideBusyWarn })))
    const barArrow = computed(() => foldBarArrow(side.value, collapsed.value))
    const foldTip = computed(() => (collapsed.value ? '展開大頭貼' : '收起大頭貼'))
    const lay = k => msgLayout(k, { dpMode: props.dpMode, bubble: props.bubble })
    const scrollDown = () => nextTick(() => { const el = msgsEl.value; if (el) el.scrollTop = el.scrollHeight })
    // ---- 往上捲自動載入更舊的信：捲到距頂端 120px 內就向樞紐要；載入後停在原本看的那一則 ----
    const older = reactive({})   // 好友 id → 'loading'｜'done'（沒有更早的了）
    let armed = true, keep = null   // armed：上次失敗後要先離開頂端才再試；keep：載入前的 scrollTop／scrollHeight（載入完成後補償）
    const noteText = computed(() => olderNote(older[props.friend?.id], props.log.length > 0))
    function applyKeep() {
      const el = msgsEl.value
      if (el && keep) el.scrollTop = keepScroll(keep.top, keep.h, el.scrollHeight)
      keep = null
    }
    async function checkTop() {
      const el = msgsEl.value, f = props.friend
      if (!el || !f || !props.loadOlder || keep) return
      if (!wantsOlder({ top: el.scrollTop, state: older[f.id], armed, visible: el.clientHeight > 0, hasLog: props.log.length > 0 })) return
      const id = f.id
      older[id] = 'loading'
      await nextTick()   // 頂端的小字長出來之後再量高度
      keep = { top: el.scrollTop, h: el.scrollHeight }
      let r
      try { r = await props.loadOlder(id) } catch { r = { more: true, added: 0, error: true } }
      if (r?.error) armed = false
      older[id] = r && r.more === false ? 'done' : undefined
      await nextTick()
      applyKeep()
      await checkTop()   // 補償後仍在頂端附近（例如這批很短）就接著載入下一批
    }
    function onScroll() {
      const el = msgsEl.value
      if (!el) return
      if (rearmed(el.scrollTop)) armed = true
      void checkTop()
    }
    watch(() => props.log, () => { if (!keep) scrollDown(); nextTick(checkTop) })   // 載入中的更新由載入完成後補償位置，不跳到底
    watch(() => props.friend?.id, () => { armed = true; nextTick(checkTop) })
    watch(() => props.active, a => { if (a) { scrollDown(); nextTick(() => { composeEl.value && composeEl.value.focus(); checkTop() }) } })
    function send() {
      let text = draft.value.trim(); if (!text || displayOnly.value) return
      const rep = replying.value
      if (rep) text = composeReply(rep, text)   // 引用行＋自動 @ 原作者＋使用者打的字
      if (rep) emit('send', text, { replySeq: rep.seq }); else emit('send', text)
      draft.value = ''; pickerOpen.value = false; replying.value = null
    }
    // ---- 群組 @ 點名：打 @ 跳出成員選單（上下鍵、Enter 或點選）；後台從內文的 @名字 解析點名，不另送欄位 ----
    const mention = ref(null)   // { q, options, idx }；沒有就是選單關著
    const bodyHtml = text => (isRoom.value ? markMentions(renderMarkdown(text), props.friend?.mentionable?.map(t => t.label)) : renderMarkdown(text))
    function onDraftInput() {
      if (!isRoom.value) return
      const q = mentionQuery(draft.value, composeEl.value?.selectionStart)
      const options = q ? mentionOptions(props.friend?.mentionable, q.query) : []
      mention.value = q && options.length ? { q, options, idx: 0 } : null
    }
    function pickMention(o) {
      const m = mention.value; if (!m) return
      const pick = o ?? m.options[m.idx]
      const r = applyMention(draft.value, m.q, pick.label)
      draft.value = r.text; mention.value = null
      nextTick(() => { const el = composeEl.value; if (el) { el.focus(); el.setSelectionRange(r.caret, r.caret) } })
    }
    function onComposeKey(ev) {
      const m = mention.value; if (!m) return
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); m.idx = (m.idx + (ev.key === 'ArrowDown' ? 1 : m.options.length - 1)) % m.options.length }
      else if (ev.key === 'Tab') { ev.preventDefault(); pickMention() }
      else if (ev.key === 'Escape') { ev.stopPropagation(); mention.value = null }
    }
    function onEnter(ev) {
      if (mention.value) { ev.preventDefault(); pickMention(); return }
      if (!props.enterSends) return
      ev.preventDefault()
      send()
    }
    function nudge() {
      if (nudgeCooling.value) return
      nudgeCooling.value = true; setTimeout(() => { nudgeCooling.value = false }, 2500)
      emit('nudge')
    }
    // ---- 照片：選圖／貼上 → 前端壓縮（長邊 2048、webp、≤ 5 MB）→ 發 photo 事件（樞紐經 Rust 上傳寄出）；輸入框裡的字當說明 ----
    const fileEl = ref(null), photoBusy = ref(false), photoMsg = ref('')
    async function sendFile(file) {
      if (!file || photoBusy.value) return
      photoBusy.value = true; photoMsg.value = '處理中…'
      try {
        const photo = await attachmentFromFile(file)
        const caption = draft.value.trim()
        emit('attach', photo, caption)
        draft.value = ''; pickerOpen.value = false; photoMsg.value = ''
      } catch (e) { photoMsg.value = e.message } finally { photoBusy.value = false }
    }
    function pickPhoto(ev) { const f = ev.target.files && ev.target.files[0]; ev.target.value = ''; void sendFile(f) }
    // 貼上圖片：先進標註畫面（可以直接按「傳送」不畫），不再直接送出
    function onPaste(ev) {
      const item = [...(ev.clipboardData?.items ?? [])].find(i => i.kind === 'file' && /^image\//.test(i.type))
      if (item) { ev.preventDefault(); openAnnot(item.getAsFile(), 'paste') }
    }
    // ---- 截圖＋標註：Rust 端隱藏視窗、框選螢幕任一區域 → 標註畫面 → 確定後走一樣的送出圖片流程 ----
    const shotOk = ref(false), annot = ref(null)   // annot：{ blob, name, busy, msg }
    function openAnnot(blob, from) {
      if (!blob || annot.value) return
      annot.value = { blob, name: from === 'paste' ? 'paste.png' : shotFileName(), busy: false, msg: '' }
    }
    async function startShot() {
      if (!props.shotApi || photoBusy.value || annot.value) return
      photoBusy.value = true; photoMsg.value = ''
      try { openAnnot(await props.shotApi.capture(), 'shot') } catch (e) { photoMsg.value = e.message } finally { photoBusy.value = false }
    }
    async function annotDone({ blob, caption }) {
      const a = annot.value; if (!a || a.busy) return
      a.busy = true; a.msg = ''
      try {
        const photo = await imageFromBlob(blob, a.name)
        emit('attach', photo, caption || draft.value.trim())
        draft.value = ''; annot.value = null
        nextTick(() => composeEl.value && composeEl.value.focus())
      } catch (e) { a.msg = e.message; a.busy = false }
    }
    function annotCancel() { annot.value = null; nextTick(() => composeEl.value && composeEl.value.focus()) }
    // ---- 放大看：點縮圖才向收發室換下載網址（Rust 端）；另存時由系統對話框選位置 ----
    const viewer = ref(null)
    const expired = p => photoExpired(p)
    // 一般檔案不預覽：點了先跳出「另存新檔」選位置（取消就不下載），結果顯示在底下那一行
    const savedHere = ref(false)
    async function saveFile(p) {
      savedHere.value = false; photoMsg.value = ''
      try {
        const path = await props.photoApi.save(p.id, p.name)
        if (path) { photoMsg.value = `已存到：${path}`; savedHere.value = true }
      } catch (e) { photoMsg.value = e.message }
    }
    async function revealSaved() {
      try { await props.photoApi.reveal() } catch (e) { photoMsg.value = e.message; savedHere.value = false }
    }
    async function openPhoto(p) {
      if (!props.photoApi || photoExpired(p)) return
      if (p.kind === 'file') return saveFile(p)
      viewer.value = { id: p.id, name: p.name, saved: false, title: photoTitle(p), thumb: p.thumb, src: '', msg: '載入中…', busy: false }
      try {
        const r = await props.photoApi.fetch(p.id)
        if (viewer.value && viewer.value.id === p.id) { viewer.value.src = r.data_url; viewer.value.msg = '' }
      } catch (e) { if (viewer.value && viewer.value.id === p.id) viewer.value.msg = e.message }
    }
    async function saveViewer() {
      const v = viewer.value; if (!v || v.busy || !v.src) return
      v.busy = true
      v.saved = false
      try {
        const path = await props.photoApi.save(v.id, v.name)
        if (path) { v.msg = `已存到：${path}`; v.saved = true } else v.msg = ''
      } catch (e) { v.msg = e.message } finally { v.busy = false }
    }
    const closeViewer = () => { viewer.value = null }
    function insertEmo(code) {
      draft.value = (draft.value ? draft.value + ' ' : '') + code
      pickerOpen.value = false
      nextTick(() => composeEl.value && composeEl.value.focus())
    }
    // 語音輸入：辨識完的字接在輸入框後面讓人確認，不自動送出
    function micClick() {
      if (!props.voice) return
      void props.voice.toggleMic(text => {
        draft.value = draft.value && !/\s$/.test(draft.value) ? draft.value + ' ' + text : draft.value + text
        nextTick(() => composeEl.value && composeEl.value.focus())
      })
    }
    // ---- 針對某則訊息回覆（#225）：引用顯示在訊息上方，點引用跳回原訊息；群組自動 @ 原作者 ----
    const canReply = m => !!replyTarget(m, { friend: props.friend, meName: props.me.nick, index: 0 })
    function startReply(m, i) {
      replying.value = replyTarget(m, { friend: props.friend, meName: props.me.nick, index: i })
      nextTick(() => composeEl.value && composeEl.value.focus())
    }
    // 手機沒有滑過：點訊息切換下方的回覆與叫醒順序（點到連結、按鈕、引用不算）
    const actAt = ref(-1)
    function tapMsg(i, e) {
      if (e?.target?.closest?.('a,button,input,textarea,.quote')) return
      actAt.value = actAt.value === i ? -1 : i
    }
    const cancelReply = () => { replying.value = null; nextTick(() => composeEl.value && composeEl.value.focus()) }
    const msgQuote = m => m?.reply ?? splitQuote(m?.text).quote
    const jumpNote = ref('')
    function jumpTo(m, i) {
      const q = msgQuote(m)
      const at = findQuoted(props.log, i, q, { meName: props.me.nick })
      const el = at >= 0 ? msgsEl.value?.querySelector(`[data-i="${at}"]`) : null
      clearTimeout(jumpTimer)
      if (!el) { jumpNote.value = '找不到原訊息，可能在更早的紀錄。'; jumpTimer = setTimeout(() => { jumpNote.value = '' }, 3500); return }
      jumpNote.value = ''
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1400)
    }
    let jumpTimer = null
    watch(() => props.friend?.id, () => { replying.value = null; jumpNote.value = '' })
    const spkOf = m => props.friend?.spk?.[m.fk] ?? null   // 後台給的成員狀態 { vendor, off }；舊後台沒有就是 null（當在線、廠商不明）
    const spkOff = m => spkOf(m)?.off === true
    const spkVendorKey = m => String(spkOf(m)?.vendor ?? '') || 'other'   // 發言者的廠商鍵（舊後台沒帶就用通用圖）；圖示由 <asn-avatar> 換成內建固定字串
    const speakerAv = m => autoAvatarDataUrl(m.av)   // 群組發言者的大頭貼：與個人名單同一套預設圖
    const msgKey = (m, i) => (m.id ? String(m.id) : `${m.t}:${i}`)
    const msgTier = m => tierOf(m)
    const msgStatusTip = m => statusTip(m)
    const speaking = (m, i) => !!props.voice && props.voice.state.tts.key === msgKey(m, i) && props.voice.state.tts.phase !== 'idle'
    const speakTip = (m, i) => (speaking(m, i) ? '停止念出' : '念出這則訊息')
    const speak = (m, i) => props.voice && props.voice.speak(msgKey(m, i), shownBody(m).text)
    const MIC_TIP = { starting: '準備麥克風…按一下取消', recording: '聆聽中…說完了，按一下辨識（Esc 取消）', recognizing: '辨識中…按一下取消' }
    const micTip = computed(() => MIC_TIP[props.voice?.state.mic.phase] || '語音輸入（按一下開始說話）')
    // ---- 通話（#99）：每個面板自己一個通話；回信到達（log 變多）時交給通話念出來。換夥伴、切走分頁、關掉面板都自動掛斷 ----
    const call = props.callApi?.newCall ? props.callApi.newCall({ hints: () => buildNameHints(props.friend, props.hintNames) }) : props.voice?.newCall ? props.voice.newCall({ send: (t, o) => emit('send', t, o), hints: () => buildNameHints(props.friend, props.hintNames) }) : null
    const showCallBtn = computed(() => !!props.callApi && !!call && canCallPartner(props.friend))   // 手機：工具列的「通話」鈕，只有 AI 夥伴才有
    const callActive = computed(() => !!call && call.state.active)
    const startCall = () => { if (call && !call.state.active) void call.start(props.log) }
    const hangUp = () => { if (call) void call.end() }
    if (call) {
      watch(callActive, a => emit('call-state', a))   // 分開模式：對話視窗廣播給名單視窗，通話中不重複自動念
      watch([() => props.log, () => props.log.length], () => call.onLog(props.log))
      watch(() => props.friend?.id, () => { void call.end() })
      watch(() => props.active, a => { if (!a) void call.end() })
      onBeforeUnmount(() => { void call.end() })
    }
    // ---- 語音輸入（手機）：辨識完的字接在輸入框後面，不自動送出；通話中不給按（外殼的事件接收者只有一個） ----
    const dict = props.dictApi?.newDictation ? props.dictApi.newDictation({
      hints: () => buildNameHints(props.friend, props.hintNames),
      onText: text => { draft.value = appendDictation(draft.value, text); nextTick(() => composeEl.value && composeEl.value.focus()) },
    }) : null
    const showDictBtn = computed(() => !!dict)
    const dictPhase = computed(() => dict?.state.phase || 'idle')
    const dictLabel = computed(() => DICT_PHASE_TEXT[dictPhase.value] || '')
    const dictTip = computed(() => DICT_TIP[dictPhase.value] || DICT_TIP.idle)
    const dictClick = () => { if (dict && !callActive.value) void dict.toggle() }
    if (dict) {
      watch(() => props.friend?.id, () => dict.stop())
      watch(() => props.active, a => { if (!a) dict.stop() })
      onBeforeUnmount(() => dict.stop())
    }
    // 對方（通話對象）回信最後一行的結束記號不顯示在對話裡，改顯示一行小提示
    const shownBody = m => {
      const b = m?.k === 'them' ? splitCallEnd(m.text) : { text: String(m?.text ?? ''), ends: false }
      return { ...b, text: splitQuote(b.text).body }   // 開頭的引用行改畫成引用列，不重複顯示在內文
    }
    const voiceNote = computed(() => props.voice?.state.note || call?.state.note || dict?.state.note || props.voice?.state.tts.error || '')
    onMounted(() => {
      scrollDown(); if (props.active) composeEl.value && composeEl.value.focus()
      if (props.shotApi) props.shotApi.supported().then(v => { shotOk.value = v === true }).catch(() => {})
      window.addEventListener('keydown', onKey)
    })
    // Esc：先關放大的照片；沒有的話取消語音輸入（準備中／錄音中／辨識中，只有目前看得到的面板處理）
    function onKey(e) {
      if (e.key !== 'Escape') return
      if (viewer.value) { closeViewer(); return }
      if (props.active && props.voice && props.voice.state.mic.phase !== 'idle') { e.preventDefault(); void props.voice.cancelMic() }
    }
    onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
    const docEl = ref(null)
    // 訊息內文裡的連結：不在 WebView 導覽，一律交給系統瀏覽器（Rust 端 open_link 再驗一次協定）
    const onBodyClick = ev => handleLinkClick(ev, url => globalThis.__TAURI__?.core?.invoke?.('open_link', { url }))
    return { displayOnly, DISPLAY_ONLY_TAG, actAt, tapMsg, replying, canReply, startReply, cancelReply, msgQuote, jumpTo, jumpNote, mention, bodyHtml, onDraftInput, pickMention, onComposeKey, speakerAv, spkOff, spkVendorKey, isRoom, attachOk, opsItems, pickMenu, isVoiceMsg, showDictBtn, dictPhase, dictLabel, dictTip, dictClick, shownBody, CALL_END_NOTE, showCallBtn, isAsn, showWaiting, warn, renderMarkdown, onBodyClick, onEnter, call, callActive, startCall, hangUp, micClick, msgKey, msgTier, msgStatusTip, readLabel, readTitle, speaking, speakTip, speak, micTip, voiceNote, docEl, FILE_ACCEPT, formatBytes, STATUS, EMO, sideCol, side, composeHint, composeTitle, collapsed, classes, lay, barArrow, foldTip, draft, pickerOpen, nudgeCooling, msgsEl, composeEl, noteText, onScroll, emo, plain, initial, fmt, fmtDate, send, nudge, insertEmo, fileEl, shotOk, annot, startShot, annotDone, annotCancel, photoBusy, photoMsg, savedHere, revealSaved, pickPhoto, onPaste, viewer, expired, openPhoto, saveViewer, closeViewer, photoTitle }
  },
  template: `
<div class="pane chatpane" :class="classes" v-if="friend">
  <action-bar :friend="friend" :self-node="selfNode" :api="agentApi" :active="active" :callable="!!call && !callApi" v-if="!isRoom || opsItems.length" :ops="opsItems" @ops="pickMenu" @call="startCall"></action-bar>
  <div class="chatpane-body">
  <div class="chatpane-main">
  <div class="conv">
    <div class="conv-main">
      <div class="to-line" :class="{ 'is-offline': !isRoom && friend.status === 'offline' }"><asn-avatar class="to-av" v-if="!isRoom" :src="friendAv" :friend="friend" :status="friend.status" :hue="friend.hue"></asn-avatar><span v-html="emo(friend.nick)"></span>
        <span class="to-psm" v-if="friend.psm" v-html="emo(friend.psm)"></span>
        <span class="to-busy to-readonly" v-if="displayOnly">{{ DISPLAY_ONLY_TAG }}</span>
        <span class="to-busy" v-if="warn && warn !== 'offline' && warn !== 'stopped'">{{ STATUS[friend.status] }}，可能無法馬上回應</span>
      </div>
      <confirm-cards v-if="isRoom" :cards="roomCards" @decide="(id, ok) => $emit('group-decide', id, ok)"></confirm-cards>
      <div class="warn" v-if="warn === 'offline'">
        <i>i</i>
        <span>{{ plain(friend.nick) }} 目前離線，訊息會先留在 ASN，對方上線後才收得到。</span>
      </div>
      <div class="warn" v-if="warn === 'stopped'">
        <i>i</i>
        <span>{{ plain(friend.nick) }} 已停止，寄來的信不會處理（會收到一則說明）。要恢復請在夥伴管理按「重開」。</span>
      </div>
      <div class="msgs" ref="msgsEl" aria-live="polite" @scroll.passive="onScroll">
        <div class="older-note" v-if="noteText">{{ noteText }}</div>
        <template v-for="(m, i) in log" :key="i">
          <div v-if="m.k === 'sys'" class="sys" :class="{ nudge: m.nudge }">{{ m.text }}</div>
          <div v-else class="msg" :data-i="i" :class="['al-' + lay(m.k).align, { mine: m.k === 'me', 'act-on': actAt === i }]" @click="tapMsg(i, $event)">
            <div class="m-av m-av-spk" :class="{ 'is-off': spkOff(m) }" v-if="m.av"><asn-avatar :src="speakerAv(m)" :vendor="m.kind === 'ai' ? spkVendorKey(m) : ''" :status="spkOff(m) ? 'offline' : 'online'" :hue="friend.hue"></asn-avatar></div>
            <div class="m-av m-av-spk m-av-me" v-if="isRoom && m.k === 'me'"><div class="dp xs" :style="{ '--h': 205 }"><span><img :src="meAv" alt=""></span></div></div>
            <div class="m-av" v-if="lay(m.k).avatar && !m.badge && !m.av"><asn-avatar :src="friendAv" :friend="isRoom ? null : friend" :status="friend.status" :hue="friend.hue"></asn-avatar></div>
            <div class="m-main">
              <div class="who"><span class="spk-av" :class="'is-' + m.kind" v-if="m.badge && !m.av" aria-hidden="true">{{ initial(plain(m.who || friend.nick)) }}</span>{{ m.k === 'me' ? plain(me.nick) : plain(m.who || friend.nick) }}<span class="who-badge" :class="'is-' + m.kind" v-if="m.badge && !(m.kind === 'ai' && m.av)">{{ m.badge }}</span>：<time>{{ fmt(m.t) }}</time><span class="from-dev" v-if="m.k === 'me' && m.from">從 {{ plain(m.from) }}</span><span class="voice-tag" v-if="m.k === 'me' && isVoiceMsg(m)" title="這則是通話中說的，辨識成文字後寄出">🎤 語音</span><span v-if="m.k === 'me' && msgTier(m) && msgTier(m) !== 'sent'" class="msg-st" :class="'st-' + msgTier(m)" :title="msgStatusTip(m)" :aria-label="msgStatusTip(m)">{{ msgTier(m) === 'delivered' ? '✓' : '✓✓' }}</span><span v-if="isRoom && m.k === 'me' && readLabel(m.rd)" class="read-n" :class="{ all: m.rd.n >= m.rd.total }" :title="readTitle(m.rd)">{{ readLabel(m.rd) }}</span>
                <button v-if="voice && m.k === 'them' && m.text" class="spk" :class="{ on: speaking(m, i) }" type="button" @click="speak(m, i)" :aria-label="speakTip(m, i)" :title="speakTip(m, i)">
                  <svg v-if="!speaking(m, i)" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 9.5v5h3.6L12 18.5v-13L7.6 9.5z" fill="currentColor"/><path d="M15 9.2a4 4 0 0 1 0 5.6M17.4 6.8a7.4 7.4 0 0 1 0 10.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
                  <svg v-else viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/></svg>
                </button>
              </div>
              <button v-if="msgQuote(m)" class="quote" type="button" @click="jumpTo(m, i)" :title="'跳到原訊息：' + plain(msgQuote(m).excerpt)"><b>{{ plain(msgQuote(m).author) }}</b><span>{{ plain(msgQuote(m).excerpt) }}</span></button>
              <div class="m-body" :class="['tone-' + lay(m.k).tone, 'md-on']" v-if="shownBody(m).text" v-html="bodyHtml(shownBody(m).text)" @click="onBodyClick"></div>
              <div class="m-act" v-if="canReply(m) || (m.wake && m.wake.length)">
                <button v-if="canReply(m)" class="reply-btn" type="button" @click="startReply(m, i)" aria-label="回覆這則訊息" title="回覆這則訊息">回覆</button>
                <div class="wake-tags" v-if="m.wake && m.wake.length" aria-label="叫醒順序"><template v-for="(w, wi) in m.wake" :key="wi"><span v-if="wi > 0 && !w.off && !m.wake[wi - 1].off" class="wake-arrow" aria-hidden="true">→</span><span class="wake-tag" :class="{ off: w.off }" :title="w.off ? '不通知' : ''">{{ w.label }}</span></template></div>
              </div>
              <div class="call-end-note" v-if="shownBody(m).ends">{{ CALL_END_NOTE }}</div>
              <div class="unanswered" v-if="m.k === 'me' && m.unanswered != null && !isAsn">{{ m.unanswered > 0 ? '超過 ' + m.unanswered + ' 分鐘未回' : '對方視窗已關閉，未回' }}</div>
              <div class="photos" v-if="m.photos && m.photos.length">
                <template v-for="p in m.photos" :key="p.id">
                  <button v-if="p.kind === 'file'" type="button" class="filecard" :class="{ gone: expired(p) }" :title="photoTitle(p)" :aria-label="'檔案：' + photoTitle(p) + (expired(p) ? '（已過期）' : '，點一下下載並另存')" :disabled="expired(p) || !photoApi" @click="openPhoto(p)">
                    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M6 2.5h8.5L19 7v14.5H6z" fill="#fff" stroke="#4a5d73" stroke-width="1.4" stroke-linejoin="round"/><path d="M14.5 2.5V7H19" fill="none" stroke="#4a5d73" stroke-width="1.4" stroke-linejoin="round"/></svg>
                    <span class="fc-text"><span class="fc-name">{{ p.name }}</span><span class="fc-sub">{{ expired(p) ? '已過期，檔案已刪除' : formatBytes(p.bytes) + '　點一下下載並另存' }}</span></span>
                  </button>
                  <button v-else type="button" class="photo" :class="{ gone: expired(p) }" :title="photoTitle(p)" :aria-label="'照片：' + photoTitle(p)" :disabled="expired(p) || !photoApi" @click="openPhoto(p)">
                    <img v-if="p.thumb && !expired(p)" :src="p.thumb" alt="">
                    <span v-else class="photo-ph">{{ expired(p) ? '照片已過期' : '照片' }}</span>
                  </button>
                </template>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
  <div class="compose-row">
    <div class="compose-main">
      <div class="toolbar">
        <span class="tool-group">
          <button class="tool icon" type="button" @click="pickerOpen = !pickerOpen" :aria-expanded="pickerOpen" aria-label="表情符號" title="表情符號">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="#ffd84a" stroke="#b58a00"/><circle cx="8.6" cy="9.6" r="1.4" fill="#5a3b00"/><circle cx="15.4" cy="9.6" r="1.4" fill="#5a3b00"/><path d="M7.2 14c1.2 2.6 3 3.6 4.8 3.6s3.6-1 4.8-3.6" fill="none" stroke="#5a3b00" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
        </span>
        <button class="tool icon call" type="button" v-if="showCallBtn && !displayOnly" @click="startCall" :disabled="callActive || dictPhase !== 'idle'" aria-label="通話" title="通話：用說的跟這位夥伴對話，回信會念出來">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6.6 3.5l2.4-.6 1.7 4.2-1.9 1.6a11.5 11.5 0 0 0 5.5 5.5l1.6-1.9 4.2 1.7-.6 2.4a2.6 2.6 0 0 1-2.6 2C10.1 18.4 5.6 13.9 4.6 6.1a2.6 2.6 0 0 1 2-2.6z" fill="#2f9a45" stroke="#1f6b2f" stroke-width="1.2" stroke-linejoin="round"/></svg>
        </button>
        <button class="tool icon dict" :class="{ rec: dictPhase === 'listening', busy: dictPhase === 'starting' }" type="button" v-if="showDictBtn" @click="dictClick" :disabled="callActive" :aria-pressed="dictPhase === 'listening'" aria-label="語音輸入" :title="dictTip">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="9" y="3.5" width="6" height="11" rx="3" fill="currentColor"/><path d="M5.8 11.5a6.2 6.2 0 0 0 12.4 0M12 17.7v3M8.6 20.7h6.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
          <span class="dict-state" v-if="dictLabel">{{ dictLabel }}</span>
        </button>
        <button class="tool icon" type="button" v-if="!isRoom" @click="nudge" :disabled="nudgeCooling" aria-label="傳送震動" title="傳送震動">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="8.2" y="4.5" width="7.6" height="15" rx="1.8" fill="#dfeaf6" stroke="#4a5d73" stroke-width="1.4"/><circle cx="12" cy="16.6" r="1" fill="#4a5d73"/><path d="M4.6 8.5l-2 3.5 2 3.5M19.4 8.5l2 3.5-2 3.5" fill="none" stroke="#d9302b" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="tool icon" type="button" v-if="attachOk" @click="fileEl && fileEl.click()" :disabled="photoBusy" aria-label="傳照片" title="傳照片（也可以直接貼上圖片）">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" fill="#e8f3ff" stroke="#4a5d73" stroke-width="1.4"/><circle cx="8.5" cy="10" r="1.7" fill="#f2b632"/><path d="M4.5 17l4.6-4.4 3.2 3 2.6-2.4 4.6 3.8" fill="none" stroke="#2f7d3c" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <input ref="fileEl" type="file" accept="image/*" hidden @change="pickPhoto" aria-hidden="true" tabindex="-1">
        <button class="tool icon" type="button" v-if="attachOk" @click="docEl && docEl.click()" :disabled="photoBusy" aria-label="傳送檔案" title="傳送檔案（pdf、txt、md、json、csv、zip、docx、xlsx、pptx，單檔 25 MB 內）">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 2.5h8.5L19 7v14.5H6z" fill="#fff" stroke="#4a5d73" stroke-width="1.4" stroke-linejoin="round"/><path d="M14.5 2.5V7H19" fill="none" stroke="#4a5d73" stroke-width="1.4" stroke-linejoin="round"/><path d="M9 12h7M9 15.5h7" stroke="#2f7d3c" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
        <input ref="docEl" type="file" :accept="FILE_ACCEPT + ',image/*'" hidden @change="pickPhoto" aria-hidden="true" tabindex="-1">
        <template v-if="attachOk"><button class="tool icon" type="button" v-if="shotApi && shotOk" @click="startShot" :disabled="photoBusy || !!annot" aria-label="截圖" title="截圖（框選螢幕任一區域，可畫筆標註後傳送）">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M7 3v14h14M3 7h14v14" fill="none" stroke="#4a5d73" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 14l4-4" stroke="#d9302b" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button></template>
        <button class="tool icon mic" :class="{ rec: voice && voice.state.mic.phase === 'recording', busy: voice && (voice.state.mic.phase === 'recognizing' || voice.state.mic.phase === 'starting') }" type="button" v-if="voice" @click="micClick" :aria-label="micTip" :aria-pressed="voice.state.mic.phase === 'recording'" :title="micTip">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="9" y="3.5" width="6" height="11" rx="3" fill="currentColor"/><path d="M5.8 11.5a6.2 6.2 0 0 0 12.4 0M12 17.7v3M8.6 20.7h6.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
        </button>
        <div class="picker" v-if="pickerOpen" role="menu">
          <button v-for="[code, icon] in EMO" :key="code" type="button" :title="code" @click="insertEmo(code)" role="menuitem">{{ icon }}</button>
        </div>
      </div>
      <div class="voice-install" v-if="voice && voice.state.install.needed" role="alert">
        <span v-if="!voice.state.install.busy">語音輸入在這台電腦上辨識，聲音不會上傳。第一次使用要先下載辨識引擎與語音模型（約 200 MB，只下載一次）。</span>
        <span v-else>{{ voice.state.install.text }}</span>
        <button class="aero-btn" type="button" :disabled="voice.state.install.busy" @click="voice.installStt()">下載</button>
        <button class="aero-btn" type="button" :disabled="voice.state.install.busy" @click="voice.dismissInstall()">取消</button>
      </div>
      <div class="reply-bar" v-if="replying"><span class="reply-bar-text"><b>回覆 {{ plain(replying.author) }}</b>：{{ plain(replying.excerpt) }}</span><button class="reply-bar-x" type="button" @click="cancelReply" aria-label="取消回覆" title="取消回覆">✕</button></div>
      <form class="composer" @submit.prevent="send">
        <ul class="mention-menu" v-if="mention" role="listbox" aria-label="選擇要點名的成員">
          <li v-for="(o, i) in mention.options" :key="o.label"><button type="button" role="option" :class="{ on: i === mention.idx }" :aria-selected="i === mention.idx" @mousedown.prevent @click="pickMention(o)"><span class="mention-name">{{ o.label }}</span><small class="who-badge" :class="'is-' + o.kind">{{ o.badge }}</small></button></li>
        </ul>
        <textarea ref="composeEl" v-model="draft" @input="onDraftInput" @click="onDraftInput" @keydown="onComposeKey" @keydown.enter.exact="onEnter" @paste="onPaste" :placeholder="composeHint" :title="composeTitle || undefined" aria-label="輸入訊息" :disabled="displayOnly"></textarea>
        <button class="aero-btn" type="submit" :disabled="displayOnly || !draft.trim()">傳送</button>
      </form>
    </div>
  </div>
  </div>
  <aside class="dp-side" v-if="sideCol" :class="'dp-side-' + side">
    <div class="dp-side-stack" v-show="!collapsed">
      <div class="dp-grp">
        <asn-avatar size="xl" :src="friendAv" :friend="isRoom ? null : friend" :status="friend.status" :hue="friend.hue"></asn-avatar>
        <button class="dp-fold-bar" type="button" @click="$emit('toggle-dp')" :aria-label="foldTip" :aria-expanded="!collapsed" :title="foldTip">{{ barArrow }}</button>
      </div>
      <div class="dp-grp">
        <div class="dp xl" :class="'st-' + me.status" :style="{ '--h': 205 }"><span><img :src="meAv" alt=""></span></div>
        <button class="dp-fold-bar" type="button" @click="$emit('toggle-dp')" :aria-label="foldTip" :aria-expanded="!collapsed" :title="foldTip">{{ barArrow }}</button>
      </div>
    </div>
    <button class="dp-fold-strip" type="button" v-if="collapsed" @click="$emit('toggle-dp')" :aria-label="foldTip" :aria-expanded="false" :title="foldTip">{{ barArrow }}</button>
  </aside>
  </div>
  <div class="typing" role="status">
    <template v-if="voiceNote">{{ voiceNote }}</template>
    <template v-else-if="jumpNote">{{ jumpNote }}</template>
    <template v-else-if="photoMsg">{{ photoMsg }}<button v-if="savedHere" class="aero-btn" type="button" @click="revealSaved">開啟資料夾</button></template>
    <template v-else-if="showWaiting">✎ 已送出，等對方回信…</template>
    <template v-else-if="friend.lastAt">上次接收訊息是 {{ fmtDate(friend.lastAt) }}</template>
  </div>
  <teleport to="body" :disabled="!callApi">
    <call-view v-if="callActive" :state="call.state" :name="plain(friend.nick)" :avatar="friendAv" :hue="friend.hue" :status="friend.status" :phase-text="callApi && callApi.phaseText" @hangup="hangUp" @mute="call.toggleMute()"></call-view>
  </teleport>
  <annotator v-if="annot" :blob="annot.blob" :caption="draft.trim()" :busy="annot.busy" :message="annot.msg" @done="annotDone" @cancel="annotCancel"></annotator>
  <teleport to="body" v-if="viewer">
  <div class="photo-viewer" @click.self="closeViewer" @keydown.esc="closeViewer" role="dialog" aria-modal="true" aria-label="放大看照片">
    <div class="pv-bar">
      <span class="pv-name">{{ viewer.title }}</span>
      <button class="aero-btn" type="button" @click="saveViewer" :disabled="viewer.busy || !viewer.src">另存</button>
      <button class="aero-btn" type="button" @click="closeViewer">關閉</button>
    </div>
    <div class="pv-body" @click.self="closeViewer">
      <img v-if="viewer.src" :src="viewer.src" :alt="viewer.title">
      <img v-else-if="viewer.thumb" class="pv-thumb" :src="viewer.thumb" alt="">
      <div class="pv-msg" v-if="viewer.msg" role="status">{{ viewer.msg }}<button v-if="viewer.saved" class="aero-btn" type="button" @click="revealSaved">開啟資料夾</button></div>
    </div>
  </div>
  </teleport>
</div>
<div class="pane" v-else><div class="empty-chat">找不到這位朋友。</div></div>`,
}
