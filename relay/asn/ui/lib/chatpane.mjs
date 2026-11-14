// 對話區元件：分開模式的對話視窗（chat.html）與整合模式右邊的分頁內容（list.html）共用同一份版面。
// 只顯示、只發事件（send／nudge／toggle-dp），不碰網路與 Tauri；信件內文與名稱一律先跳脫才進 v-html（訊息內文走 markdown.mjs，自帶跳脫與白名單淨化）。
import { renderMarkdown, handleLinkClick } from './markdown.mjs'
import { EMO, emo, fmt, fmtDate, initial, plain } from './text.mjs'
import { SEND_LABEL, SEND_LABEL_TERM, composeHintTitle, composePlaceholder, composeTermHint } from './compose.mjs'
import { foldBarArrow, SIDE_FOLD_LOCK_TIP, hasSideCol, isCollapsed, msgLayout, paneClasses, sideOf } from './merge.mjs'
import { autoAvatarDataUrl } from './avatar.mjs'
import { AsnAvatar } from './avatar-badge.mjs'
import { QUOTE_PREFIX, composeReply, findQuoted, replyTarget, splitQuote } from './reply-quote.mjs'
import { MENTION_MORE_HINT, applyMention, markMentions, mentionOptions, mentionQuery } from './mention.mjs'
import { FILE_ACCEPT, formatBytes, photoExpired, photoTitle } from './photo.mjs'
import { attachmentFromFile, imageFromBlob } from './photo-canvas.mjs'
import { Annotator } from './annotator.mjs'
import { ActionBar, canOfferConsole, groupMenuItems, opsMenuItems, sameFriend } from './actionbar.mjs'
import { TermView } from './term-view.mjs'
import { RemoteView, REMOTE_LABEL, REMOTE_TIP, askRemote, remoteEntry } from './term-remote.mjs'
import { GRACE_AGAIN_LABEL, TYPING_ENDED_TEXT, createGrace } from './term-grace.mjs'
import { RemoteInput, INPUT_LABEL, INPUT_TIP, INPUT_TEXT } from './term-remote-input.mjs'
import { TERM_BTN_MSG, TERM_BTN_TERM, askTermService, mTermToggle, restoreTop, scrollMemo, termEntry } from './term-entry.mjs'
import { headerPsm } from './tasks.mjs'
import { CallView } from './call-view.mjs'
import { ConfirmCards } from './group-sheet.mjs'
import { readLabel, readTitle } from './mobile-rooms.mjs'
import { canCallPartner } from './mobile-call.mjs'
import { CALL_END_NOTE, splitCallEnd } from './call-end.mjs'
import { dupCloseLabel, dupCloseText, shownMine, splitDupMark } from './dup-windows.mjs'
import { DICT_PHASE_TEXT, DICT_TIP, appendDictation } from './mobile-dictation.mjs'
import { isVoiceMsg } from './voice-mark.mjs'
import { shotFileName } from './shot.mjs'
import { buildNameHints } from './stt-text.mjs'
import { statusTip, tierOf } from './sent-status.mjs'
import { isAsnWindow, showsWaiting } from './roster.mjs'
import { noticeDevOf } from './notice.mjs'
import { loginNote, warnKind } from './head-tone.mjs'
import { DISPLAY_ONLY_TAG, displayOnlyHint, isDisplayOnly } from './display-only.mjs'
import { keepScroll, olderNote, rearmed, wantsOlder } from './scrollback.mjs'
import { clockLabel, composeFieldHeight, lineRows, sentStateText } from './line-chat.mjs'
import { MEMBER_NOT_FRIEND } from './groups.mjs'

const { ref, computed, watch, nextTick, onMounted, onBeforeUnmount, reactive } = Vue
const STATUS = { online: '線上', busy: '忙碌', running: '執行中・僅顯示', away: '暫離', offline: '顯示為離線', stopped: '已停止', quota: '額度用完', unavailable: '暫時不可用' }

export const ChatPane = {
  name: 'ChatPane',
  components: { Annotator, ActionBar, CallView, ConfirmCards, AsnAvatar, TermView, RemoteView, RemoteInput },
  props: {
    friend: { type: Object, default: null },
    me: { type: Object, default: () => ({ nick: '我', status: 'online' }) },
    friendAv: { type: String, default: '' },       // 大頭貼圖片網址（自動產生或設備上傳）
    meAv: { type: String, default: '' },
    log: { type: Array, default: () => [] },
    dpMode: { type: String, default: 'left' },     // 頭像模式：left／right＝側欄；inline＝頭像在每則訊息旁
    toolbar: { type: String, default: 'top' },     // 工具列位置：top（輸入框上方）／bottom（輸入框下方）
    bubble: { type: String, default: 'none' },     // 文字底色：none／color／auto
    dpLocked: { type: Boolean, default: false },     // 窗太窄被自動收起：展開鈕反灰
    dpCollapsed: { type: Boolean, default: false },  // 側欄收合（只對 left／right 有意義）
    active: { type: Boolean, default: true },      // 整合模式下只有目前分頁是 true；變成 true 時捲到底並聚焦輸入框
    winMode: { type: String, default: 'split' },   // split｜merged：整合模式用較短的輸入提示
    photoApi: { type: Object, default: null },     // photoApi.fetch 回 {data_url}、photoApi.save 回路徑：放大看與另存（Rust 端，金鑰不在前端）；沒給就不能放大
    shotApi: { type: Object, default: null },      // 截圖（lib/tauri.mjs 的 shotApi）；沒給或這個系統不支援就沒有截圖鈕
    noBar: { type: Boolean, default: false },
    // 看別台終端的「在畫面上」：手機把 active 固定給 false（不搶焦點），另外用這個告訴元件對話分頁正開著；沒給就跟 active 一樣
    viewActive: { type: Boolean, default: null },      // 手機對話頁：上方不放功能列（管理項目在手機頁自己的「⋯」），個人訊息也不拿掉「背景工作 N 件」
    agentApi: { type: Object, default: null },     // 上方功能列用（lib/tauri.mjs 的 transport）；沒給就沒有功能列
    termViewApi: { type: Object, default: null },
    remoteInputApi: { type: Object, default: null },  // 在別台夥伴的畫面打字（lib/tauri.mjs 的 remoteInputApi，0.2.10）；只有電腦版會給
    remoteViewApi: { type: Object, default: null },   // 看別台電腦上夥伴的畫面（lib/tauri.mjs 的 remoteViewApi）；只有電腦版會給   // 在畫面裡看終端（lib/tauri.mjs 的 termViewApi）；只有電腦版會給
    selfNode: { type: String, default: '' },       // 這台設備的節點代號（只拿來判斷是不是本機的視窗，不顯示）
    voice: { type: Object, default: null },        // 語音功能（lib/voice-ui.mjs 的 createVoiceUi）；沒給就沒有念出訊息與麥克風
    hideBusyWarn: { type: Boolean, default: false },  // 手機版：對方忙碌時不顯示黃色說明條（標題列已改黃底）
    callApi: { type: Object, default: null },      // 手機版的通話（lib/mobile-call.mjs 的 createMobileCall 工廠，另帶 phaseText）；電腦版不給，通話走 voice.newCall
    dictApi: { type: Object, default: null },     // 手機版的語音輸入（{ newDictation({ hints, onText }) }，工廠見 lib/mobile-dictation.mjs）；沒給或這支手機沒有語音辨識服務就沒有語音輸入鈕
    loadOlder: { type: Function, default: null },  // 往上捲到頂載入更舊的信：(好友 id) => Promise<{ more, added, busy?, error? }>；沒給就不載入
    hintNames: { type: Array, default: () => [] },  // 名單上的夥伴（給語音辨識偏向名字用，選填）；通話對象自己一定會帶
    enterSends: { type: Boolean, default: true },  // Enter 直接送出（電腦預設）；手機的軟鍵盤 Enter 是換行，傳送靠按鈕
    roomCards: { type: Array, default: () => [] },  // 群組：待主持人確認的請求卡片（lib/groups.mjs 的 confirmCards）；非群組不用
    groupMenu: { type: Boolean, default: false },   // 電腦版：對話上方大按鈕區的「群組」（邀請、輸入邀請碼、加 AI、成員與設定）與一對一「管理」裡的邀請；手機版有自己的「⋯」，不開這個
    skin: { type: String, default: '' },           // 外觀（lib/skin.mjs）：只有 line 才多輸出 LINE 版面要的節點；其他外觀的畫面一個節點都不變
    showBack: { type: Boolean, default: false },   // LINE 外觀標題列的「返回」（只在窄視窗單窗格時由名單視窗給 true）
    openMember: { type: Function, default: null },   // 群組：點成員（發言者的名字、頭像、「N 人離線」名單）跳到跟他的一對一（#1515）；回 false＝不在夥伴名單裡
    piModelsFor: { type: Function, default: null },   // 電腦版名單視窗：別台電腦的 pi 模型清單（給大按鈕「切換模型」用，和名單右鍵同一份）
  },
  emits: ['send', 'nudge', 'toggle-dp', 'attach', 'call-state', 'group-decide', 'group-menu', 'remote-started', 'remote-ended', 'back'],
  setup(props, { emit }) {
    const draft = ref(''), pickerOpen = ref(false), nudgeCooling = ref(false)
    // 現代外觀：輸入框的「＋」展開上方工具列（復古 Aero 下沒有這個選單）；點了裡面的工具就收起來（表情符號例外：它要接著選）
    const plusOpen = ref(false)
    function onToolbarClick(ev) {
      const b = ev.target && ev.target.closest && ev.target.closest('.tool')
      if (b && !b.closest('.tool-group')) plusOpen.value = false
    }
    // 點「＋」選單以外的任何地方就收起來；只在選單開著時才掛一個監聽，關了、換掉、元件卸載都會移除（不疊加）
    function onOutsidePress(ev) {
      const main = composeEl.value && composeEl.value.closest('.compose-main'), t = ev.target
      if (main && t && t.closest && main.contains(t) && (t.closest('.mc-plus') || t.closest('.toolbar'))) return
      plusOpen.value = false
    }
    watch(plusOpen, on => {
      document.removeEventListener('pointerdown', onOutsidePress, true)
      if (on) document.addEventListener('pointerdown', onOutsidePress, true)
    })
    onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutsidePress, true))
    const replying = ref(null)   // 正在回覆的那一則：{ author, excerpt, seq, index, mention }
    const msgsEl = ref(null), composeEl = ref(null)
    const isRoom = computed(() => props.friend?.room === true)
    const opsItems = computed(() => (props.groupMenu ? opsMenuItems(props.friend) : []))   // 大按鈕區「管理」選單裡的邀請（一對一）
    const groupItems = computed(() => (props.groupMenu ? groupMenuItems(props.friend) : []))   // 群組對話的「群組」按鈕選單
    const pickMenu = op => emit('group-menu', op)
    const isAsn = computed(() => isAsnWindow(props.friend))
    // 終端（#900／#901／#902）：這台電腦上、在共用終端服務裡的夥伴才有入口（上面那排第 2 格「終端」）；
    // 更新前開的舊夥伴照舊是前台／後台，下面常駐一行小字請本人重新開一次。打開時終端占滿訊息區，輸入框留著
    const termBase = computed(() => !!props.termViewApi && canOfferConsole(props.friend, props.selfNode) && props.friend?.status !== 'offline')
    const termViewName = computed(() => props.friend?.agent || props.friend?.nick || '')
    const termInService = ref(null)   // true／false／null（還沒查或查不到）
    const termEntryView = computed(() => termEntry(termBase.value, termInService.value))
    const canTermView = computed(() => termEntryView.value.term)
    const termViewOn = ref(false)
    const termShown = computed(() => termViewOn.value && canTermView.value)
    async function probeTerm() {
      const f = props.friend
      if (!termBase.value) { termInService.value = null; return }
      if (!props.active) return
      const r = await askTermService(props.termViewApi, termViewName.value)
      if (sameFriend(props.friend, f)) termInService.value = r
    }
    // 看別台電腦上的夥伴（#597）：那台在本人帳號底下、這台能發起才有入口，同樣放在第 2 格
    const remoteAvail = ref(null)
    const canRemote = computed(() => !canTermView.value && remoteEntry({ api: props.remoteViewApi, friend: props.friend, selfNode: props.selfNode, avail: remoteAvail.value }))
    const remoteOn = ref(false)
    const remoteShown = computed(() => remoteOn.value && canRemote.value)
    // 打字（0.2.10）：在看畫面時才有，按了換成可以打字的畫面；關掉看畫面就一起收掉
    const remoteTyping = ref(false)
    // 電腦版看／打字別台畫面的狀態：放在視窗最下面的狀態列（.typing），不在終端上方；手機也一樣（0.2.17），共用同一個 remoteBarState
    const remoteBar = ref(null), rinEl = ref(null)
    const setRemoteBar = (src, s) => { if (s) remoteBar.value = { ...s, src }; else if (remoteBar.value?.src === src) remoteBar.value = null }
    const stopTyping = () => rinEl.value?.stop?.()
    const canRemoteInput = computed(() => remoteShown.value && Boolean(props.remoteInputApi))
    const typingShown = computed(() => remoteTyping.value && canRemoteInput.value)
    // 終端畫面開著（本機或別台）：占滿訊息區，訊息列表收起來，兩種一模一樣
    const paneTermShown = computed(() => termShown.value || remoteShown.value)
    // 手機（noBar）的對話頁頂端「訊息／終端」切換（案 A，和電腦版同一個元件；按鈕字跟電腦版一樣）
    const remoteLive = computed(() => (props.viewActive === null ? props.active : props.viewActive))
    // 手機：離開對話分頁就結束觀看（那台的紅條會收掉）。電腦版（viewActive 沒給）：離開分頁不馬上結束，寬限內切回來照舊在，
    // 超過寬限在到期當下結束（term-grace.mjs）；打字中離開馬上結束打字（打字不適用寬限），切回來換回只看
    const rvEl = ref(null)
    const graceView = createGrace({ onExpire: () => rvEl.value?.expire?.() })
    // 打字中離開分頁：打字結束，切回來停在「已結束打字」，不自動重新發起（要本人按「重新看」，不替本人去打擾對方）
    const typingEndedNote = ref('')
    const restartView = () => { typingEndedNote.value = ''; rvEl.value?.again?.() }
    watch(remoteTyping, on => { if (on) typingEndedNote.value = '' })
    watch(remoteLive, a => {
      if (props.viewActive !== null) { if (!a) { remoteOn.value = false; remoteTyping.value = false } return }   // 手機：打字一起結束，回來不自動重新開始打字
      if (!a) { if (remoteTyping.value) { typingEndedNote.value = TYPING_ENDED_TEXT; remoteTyping.value = false } else if (remoteShown.value) graceView.leave(); return }
      if (graceView.back() === 'kept') nextTick(() => rvEl.value?.refit?.())
    })
    const mSwitch = computed(() => props.noBar && canRemote.value)
    const mToggle = computed(() => mTermToggle(remoteShown.value))
    const showMsgs = () => { remoteOn.value = false }
    watch(remoteShown, on => { if (!on) { remoteBar.value = null; typingEndedNote.value = ''; graceView.cancel() } })
    onBeforeUnmount(() => graceView.cancel())   // 關掉分頁時寬限計時一起收掉，不留到期後才跑的回呼
    const showTerm = () => { remoteOn.value = true; remoteTyping.value = false }   // 每次切到終端都先只看；要打字由本人從輸入框送出才開始
    async function probeRemote() {
      const f = props.friend
      if (!props.remoteViewApi || !f?.node || f.node === props.selfNode || !remoteLive.value) return
      const r = await askRemote(props.remoteViewApi, f.node)
      // 正在看的時候一時問不到（null），不要把這一格收掉：收掉會中斷剛開始的觀看
      if (sameFriend(props.friend, f) && !(r === null && remoteOn.value)) remoteAvail.value = r
    }
    const termBar = computed(() => (canRemote.value ? { ready: true, on: remoteShown.value, label: REMOTE_LABEL, tip: REMOTE_TIP } : { ready: canTermView.value, on: termShown.value }))
    const toggleTerm = () => {
      if (canRemote.value) { remoteOn.value = !remoteOn.value; remoteTyping.value = false; return }
      if (canTermView.value) termViewOn.value = !termViewOn.value
    }
    watch(() => props.friend?.id, () => { remoteOn.value = false; remoteAvail.value = null; void probeRemote() })
    watch(remoteLive, a => { if (a) void probeRemote() })
    onMounted(() => { void probeRemote() })
    watch(() => props.friend?.id, () => { termViewOn.value = false; termInService.value = null })
    watch(() => [props.friend?.id, props.friend?.status, termViewName.value, termBase.value, props.active].join('\n'), () => void probeTerm(), { immediate: true })
    // 訊息列表收起再回來，停在原本看的位置（原本在底部就回到底部，新訊息看得到）
    let termScroll = null
    watch(paneTermShown, on => {
      if (on) { termScroll = scrollMemo(msgsEl.value); return }
      const memo = termScroll
      termScroll = null
      nextTick(() => { const el = msgsEl.value; if (el) el.scrollTop = restoreTop(memo, el) })
    })
    const showWaiting = computed(() => showsWaiting(props.friend))
    const sideCol = computed(() => hasSideCol(props.dpMode))
    // 看別台的終端時（電腦版）：輸入框直接打進那個終端（#1288），提示字與按鈕字跟著換
    // 打字或觀看已經因為離開分頁而結束（狀態列有「重新看」）時退回「傳送」：要不要重新開始由本人按「重新看」決定，不由輸入框代按
    const viewRestartable = computed(() => Boolean(typingEndedNote.value) || (remoteBar.value?.src === 'view' && remoteBar.value.restartable === true))
    const remoteCompose = computed(() => canRemoteInput.value && !displayOnly.value && !viewRestartable.value)
    // 看本機夥伴的終端時（電腦版，#1378）：一樣直接打進那個終端，按鈕字與提示字和看別台相同；本機不用對方同意，沒有確認框、寬限與重新看
    const tvEl = ref(null)
    const localCompose = computed(() => termShown.value && Boolean(props.termViewApi?.input) && !displayOnly.value)
    const termCompose = computed(() => remoteCompose.value || localCompose.value)
    const composeHint = computed(() => (displayOnly.value ? displayOnlyHint(props.friend) : termCompose.value ? composeTermHint(termViewName.value) : composePlaceholder(props.winMode)))
    const composeTitle = computed(() => (displayOnly.value ? displayOnlyHint(props.friend) : termCompose.value ? '' : composeHintTitle(props.winMode)))
    const sendLabel = computed(() => (termCompose.value ? SEND_LABEL_TERM : SEND_LABEL))
    const collapsed = computed(() => isCollapsed(props.dpMode, props.dpCollapsed))
    const classes = computed(() => paneClasses({ dpMode: props.dpMode, bubble: props.bubble, collapsed: props.dpCollapsed, toolbar: props.toolbar }))
    const side = computed(() => sideOf(props.dpMode))
    const displayOnly = computed(() => !isRoom.value && isDisplayOnly(props.friend))   // 本機程序掃描的條目：只顯示，不能收信
    const loginText = computed(() => loginNote(props.friend))
    const isNotice = computed(() => props.friend?.isNotice === true)   // 「通知」對話（#848）：沒有上線狀態、沒有輸入列、沒有通話鈕
    const warn = computed(() => (displayOnly.value || isNotice.value ? null : warnKind(props.friend?.status, { hideBusy: props.hideBusyWarn })))
    const barArrow = computed(() => foldBarArrow(side.value, collapsed.value))
    const foldLocked = computed(() => props.dpLocked && collapsed.value)
    const foldTip = computed(() => (foldLocked.value ? SIDE_FOLD_LOCK_TIP : collapsed.value ? '展開大頭貼' : '收起大頭貼'))
    const lay = k => msgLayout(k, { dpMode: props.dpMode, bubble: props.bubble })
    // LINE 外觀：每則的「連續訊息／日期膠囊」旗標（lib/line-chat.mjs）；其他外觀不算
    const isLine = computed(() => props.skin === 'line')
    const lrows = computed(() => (isLine.value ? lineRows(props.log, { friendNick: props.friend?.nick }) : []))
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
    // 終端畫面：整句打進那個終端。還沒在打字就先開始（第一次那台會跳確認框），字由打字元件排著、開始了才送
    function sendToTerm(text) {
      draft.value = ''; pickerOpen.value = false
      if (localCompose.value) { nextTick(() => { if (tvEl.value?.sendLine) tvEl.value.sendLine(text); else restoreDraft(text) }); return }
      if (!typingShown.value) remoteTyping.value = true
      nextTick(() => { if (rinEl.value?.sendLine) rinEl.value.sendLine(text); else restoreDraft(text) })
    }
    // 沒送進終端的字放回輸入框（輸入框已經有新的字就接在後面，不蓋掉）
    function restoreDraft(text) {
      const t = String(text ?? '')
      if (!t) return
      draft.value = draft.value.trim() ? t + '\n' + draft.value : t
    }
    function send() {
      if (termCompose.value) { const t = draft.value.trim(); if (t) sendToTerm(t); return }
      let text = draft.value.trim(); if (!text || displayOnly.value) return
      const rep = replying.value
      if (rep) text = composeReply(rep, text)   // 引用行＋自動 @ 原作者＋使用者打的字
      if (rep) emit('send', text, { replySeq: rep.seq }); else emit('send', text)
      draft.value = ''; pickerOpen.value = false; replying.value = null
    }
    // ---- 群組 @ 點名：打 @ 跳出成員選單（上下鍵、Enter 或點選）；後台從內文的 @名字 解析點名，不另送欄位 ----
    const mention = ref(null)   // { q, options, idx }；沒有就是選單關著
    const menuEl = ref(null), mentionMore = ref(false)   // 選單下面還有沒看到的人，就顯示「往下滑」提示
    function syncMore() {
      const el = menuEl.value
      mentionMore.value = !!el && el.scrollHeight - el.scrollTop - el.clientHeight > 4
    }
    const afterMenu = () => nextTick(() => { syncMore(); menuEl.value?.querySelector('button.on')?.scrollIntoView({ block: 'nearest' }) })
    const bodyHtml = text => (isRoom.value ? markMentions(renderMarkdown(text), props.friend?.mentionable?.map(t => t.label)) : renderMarkdown(text))
    // LINE 外觀：輸入框隨字數變高，最多 6 行後內部捲動（算法在 line-chat.mjs 的 composeFieldHeight）；其他外觀不碰 style
    function fitCompose() {
      const el = composeEl.value
      if (!el) return
      if (!isLine.value) { if (el.style.height || el.style.overflowY) { el.style.height = ''; el.style.overflowY = '' } return }
      const cs = getComputedStyle(el), px = k => parseFloat(cs[k]) || 0
      el.style.height = '0px'
      const r = composeFieldHeight(el.scrollHeight, { lineH: px('lineHeight') || 22, extra: px('paddingTop') + px('paddingBottom'), border: px('borderTopWidth') + px('borderBottomWidth') })
      el.style.height = r.height + 'px'; el.style.overflowY = r.scroll ? 'auto' : 'hidden'
    }
    watch([draft, isLine], () => nextTick(fitCompose), { flush: 'post' })
    onMounted(() => nextTick(fitCompose))
    function onDraftInput() {
      if (!isRoom.value) return
      const q = mentionQuery(draft.value, composeEl.value?.selectionStart)
      const options = q ? mentionOptions(props.friend?.mentionable, q.query) : []
      mention.value = q && options.length ? { q, options, idx: 0 } : null
      mentionMore.value = false
      if (mention.value) afterMenu()
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
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); m.idx = (m.idx + (ev.key === 'ArrowDown' ? 1 : m.options.length - 1)) % m.options.length; afterMenu() }
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
    const canReply = m => !isNotice.value && !!replyTarget(m, { friend: props.friend, meName: props.me.nick, index: 0 })
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
    const showCallBtn = computed(() => !!props.callApi && !!call && !isNotice.value && canCallPartner(props.friend))   // 手機：工具列的「通話」鈕，只有 AI 夥伴才有
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
    // 同名兩個視窗的說明（#584）：記號行改成「關掉」按鈕；自己寄出的關閉指令改顯示白話
    const shownBody = m => {
      const b = m?.k === 'them' ? splitCallEnd(m.text) : { text: shownMine(m?.text), ends: false }
      const d = m?.k === 'them' && !isRoom.value ? splitDupMark(b.text) : { text: b.text, wins: [] }
      return { ...b, text: splitQuote(d.text).body, dup: d.wins }   // 開頭的引用行改畫成引用列，不重複顯示在內文
    }
    const voiceNote = computed(() => props.voice?.state.note || call?.state.note || dict?.state.note || props.voice?.state.tts.error || '')
    // 同名兩個視窗的「關掉第 N 個」：本人按了才寄關閉指令（#584）
    const dupDone = ref(new Set())
    const closeDup = (m, i, w) => {
      if (displayOnly.value) return
      dupDone.value = new Set(dupDone.value).add(msgKey(m, i))   // 同一則說明只按一次，免得連關兩個
      emit('send', dupCloseText(w.pid))
    }
    const dupPressed = (m, i) => dupDone.value.has(msgKey(m, i))
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
    // header 的個人訊息：背景工作件數已經在「工作項目」大按鈕上，拿掉那段（#539 之三）；群組照舊
    // 手機（noBar）沒有那顆按鈕，件數照樣留在個人訊息裡
    // ---- 群組：點成員跳一對一（#1515）。只有群組裡別人的訊息、而且有成員鍵（fk）才能點；自己的訊息不能點 ----
    const canJump = m => !!(isRoom.value && props.openMember && m && m.k === 'them' && m.fk)
    const jumpLabel = m => `開啟和 ${plain(m.who || props.friend?.nick || '')} 的對話`
    function jumpMember(key) {
      if (!key || !props.openMember) return
      let ok = false
      try { ok = props.openMember(key) !== false } catch { ok = false }
      if (!ok) photoMsg.value = MEMBER_NOT_FRIEND   // 不跳，用輸入列下方那一行說明
    }
    // 名字、頭像本身被點（不讓整則訊息的點擊（回覆選單）接著觸發）
    function onSpk(m, ev) { if (!canJump(m)) return; ev?.stopPropagation(); ev?.preventDefault(); jumpMember(m.fk) }
    const toPsm = computed(() => (props.friend?.room === true || props.noBar ? props.friend?.psm ?? '' : headerPsm(props.friend?.psm)))
    return { canJump, jumpLabel, jumpMember, onSpk, isLine, lrows, clockLabel, sentStateText, plusOpen, onToolbarClick, sendLabel, restoreDraft, tvEl, INPUT_TEXT, rvEl, restartView, typingEndedNote, GRACE_AGAIN_LABEL, remoteBar, rinEl, setRemoteBar, stopTyping, remoteLive, mSwitch, mToggle, showMsgs, showTerm, TERM_BTN_MSG, TERM_BTN_TERM, paneTermShown, remoteTyping, canRemoteInput, typingShown, INPUT_LABEL, INPUT_TIP, canRemote, remoteOn, remoteShown, termBar, canTermView, termViewOn, termShown, termEntryView, toggleTerm, termViewName, dupCloseLabel, closeDup, dupPressed, toPsm, displayOnly, DISPLAY_ONLY_TAG, actAt, tapMsg, replying, canReply, startReply, cancelReply, msgQuote, jumpTo, jumpNote, mention, menuEl, mentionMore, syncMore, MENTION_MORE_HINT, bodyHtml, onDraftInput, pickMention, onComposeKey, speakerAv, spkOff, spkVendorKey, isRoom, opsItems, groupItems, pickMenu, isVoiceMsg, showDictBtn, dictPhase, dictLabel, dictTip, dictClick, shownBody, CALL_END_NOTE, showCallBtn, isAsn, isNotice, showWaiting, noticeDevOf, warn, loginText, renderMarkdown, onBodyClick, onEnter, call, callActive, startCall, hangUp, micClick, msgKey, msgTier, msgStatusTip, readLabel, readTitle, speaking, speakTip, speak, micTip, voiceNote, docEl, FILE_ACCEPT, formatBytes, STATUS, EMO, sideCol, side, composeHint, composeTitle, collapsed, classes, lay, barArrow, foldTip, draft, pickerOpen, nudgeCooling, msgsEl, composeEl, noteText, onScroll, emo, plain, initial, fmt, fmtDate, send, nudge, insertEmo, fileEl, shotOk, annot, startShot, annotDone, annotCancel, photoBusy, photoMsg, savedHere, revealSaved, pickPhoto, onPaste, viewer, expired, openPhoto, saveViewer, closeViewer, photoTitle, foldLocked }
  },
  template: `
<div class="pane chatpane" :class="classes" v-if="friend">
  <action-bar :friend="friend" :self-node="selfNode" :api="agentApi" :active="active" :callable="!!call && !callApi" :term="termBar" v-if="!noBar && !isNotice && (!isRoom || opsItems.length || groupItems.length)" :ops="opsItems" :group="groupItems" :pi-models-for="piModelsFor" @ops="pickMenu" @call="startCall" @term="toggleTerm" :avatar="friendAv" :skin="skin" :show-back="showBack" @back="$emit('back')" @member="jumpMember"></action-bar>
  <p class="term-reopen-note" v-if="!noBar && !isRoom && termEntryView.note" role="note">{{ termEntryView.note }}</p>
  <div class="chatpane-body">
  <div class="chatpane-main">
  <term-view v-if="termShown" ref="tvEl" @unsent="restoreDraft" :api="termViewApi" :name="termViewName" :active="active" :keep="viewActive === null"></term-view>
  <remote-view v-if="remoteShown && !typingShown" ref="rvEl" :ended-note="typingEndedNote" :api="remoteViewApi" :node="friend.node" :name="termViewName" :machine="friend.device || friend.machine || friend.nodeName || ''" :active="remoteLive" :bar-inline="false" @cancel="showMsgs" @status="s => setRemoteBar('view', s)" @started="$emit('remote-started', $event)" @ended="$emit('remote-ended')"></remote-view>
  <remote-input v-if="typingShown" ref="rinEl" @unsent="restoreDraft" :bar-inline="false" @status="s => setRemoteBar('input', s)" :api="remoteInputApi" :node="friend.node" :name="termViewName" :machine="friend.device || friend.machine || friend.nodeName || ''" :active="active" @back="remoteTyping = false"></remote-input>
  <div class="conv" v-show="!paneTermShown">
    <div class="conv-main">
      <div class="to-line" :class="{ 'is-offline': !isRoom && friend.status === 'offline' }"><asn-avatar class="to-av" v-if="!isRoom" :src="friendAv" :friend="friend" :status="friend.status" :hue="friend.hue"></asn-avatar><span v-html="emo(friend.nick)"></span>
        <span class="to-psm" v-if="toPsm" v-html="emo(toPsm)"></span>
        <span class="to-busy to-readonly" v-if="displayOnly">{{ DISPLAY_ONLY_TAG }}</span>
        <span class="to-busy" v-if="warn && warn !== 'offline' && warn !== 'stopped' && warn !== 'login'">{{ STATUS[friend.status] }}，可能無法馬上回應</span>
      </div>
      <confirm-cards v-if="isRoom" :cards="roomCards" @decide="(id, ok) => $emit('group-decide', id, ok)"></confirm-cards>
      <div class="warn" v-if="warn === 'offline'">
        <i>i</i>
        <span>{{ plain(friend.nick) }} 目前離線，訊息會先留在 ASN，對方上線後才收得到。</span>
      </div>
      <div class="warn" v-if="warn === 'login'">
        <i>i</i>
        <span>{{ loginText }}</span>
      </div>
      <div class="warn" v-if="warn === 'stopped'">
        <i>i</i>
        <span>{{ plain(friend.nick) }} 已停止，寄來的信不會處理（會收到一則說明）。要恢復請在夥伴管理按「重開」。</span>
      </div>
      <div class="msgs" ref="msgsEl" aria-live="polite" @scroll.passive="onScroll">
        <div class="older-note" v-if="noteText">{{ noteText }}</div>
        <template v-for="(m, i) in log" :key="i">
          <div class="l-day" v-if="isLine && lrows[i] && lrows[i].pill">{{ lrows[i].pill }}</div>
          <div v-if="m.k === 'sys'" class="sys" :class="{ nudge: m.nudge }">{{ m.text }}</div>
          <div v-else class="msg" :data-i="i" :class="['al-' + lay(m.k).align, { mine: m.k === 'me', 'act-on': actAt === i, 'l-cont': isLine && lrows[i] && lrows[i].cont }]" @click="tapMsg(i, $event)">
            <div class="m-av m-av-spk" :class="{ 'is-off': spkOff(m), 'can-jump': canJump(m) }" :role="canJump(m) ? 'button' : null" :tabindex="canJump(m) ? 0 : null" :aria-label="canJump(m) ? jumpLabel(m) : null" @click="onSpk(m, $event)" @keydown.enter="onSpk(m, $event)" @keydown.space="onSpk(m, $event)" v-if="m.av"><asn-avatar :src="speakerAv(m)" :vendor="m.kind === 'ai' ? spkVendorKey(m) : ''" :status="spkOff(m) ? 'offline' : 'online'" :hue="friend.hue"></asn-avatar></div>
            <div class="m-av m-av-spk m-av-me" v-if="isRoom && m.k === 'me'"><div class="dp xs" :style="{ '--h': 205 }"><span><img :src="meAv" alt=""></span></div></div>
            <div class="m-av" v-if="lay(m.k).avatar && !m.badge && !m.av"><asn-avatar :src="friendAv" :friend="isRoom ? null : friend" :status="friend.status" :hue="friend.hue"></asn-avatar></div>
            <div class="m-main">
              <div class="l-name" v-if="isLine && m.k === 'them' && !(lrows[i] && lrows[i].cont)"><span class="spk-av" :class="'is-' + m.kind" v-if="m.badge && !m.av" aria-hidden="true">{{ initial(plain(m.who || friend.nick)) }}</span><span class="who-name" :class="{ 'can-jump': canJump(m) }" :role="canJump(m) ? 'button' : null" :tabindex="canJump(m) ? 0 : null" :aria-label="canJump(m) ? jumpLabel(m) : null" @click="onSpk(m, $event)" @keydown.enter="onSpk(m, $event)" @keydown.space="onSpk(m, $event)">{{ plain(m.who || friend.nick) }}</span><span class="who-dev" v-if="noticeDevOf(m, isNotice)"> · {{ plain(noticeDevOf(m, isNotice)) }}</span><span class="who-badge" :class="'is-' + m.kind" v-if="m.badge && !(m.kind === 'ai' && m.av)">{{ m.badge }}</span></div>
              <div class="who" v-if="!isLine"><span class="spk-av" :class="'is-' + m.kind" v-if="m.badge && !m.av" aria-hidden="true">{{ initial(plain(m.who || friend.nick)) }}</span><template v-if="m.k === 'me'">{{ plain(me.nick) }}</template><span class="who-name" v-else :class="{ 'can-jump': canJump(m) }" :role="canJump(m) ? 'button' : null" :tabindex="canJump(m) ? 0 : null" :aria-label="canJump(m) ? jumpLabel(m) : null" @click="onSpk(m, $event)" @keydown.enter="onSpk(m, $event)" @keydown.space="onSpk(m, $event)">{{ plain(m.who || friend.nick) }}</span><span class="who-dev" v-if="noticeDevOf(m, isNotice)"> · {{ plain(noticeDevOf(m, isNotice)) }}</span><span class="who-badge" :class="'is-' + m.kind" v-if="m.badge && !(m.kind === 'ai' && m.av)">{{ m.badge }}</span>：<time>{{ fmt(m.t) }}</time><span class="from-dev" v-if="m.k === 'me' && m.from">從 {{ plain(m.from) }}</span><span class="voice-tag" v-if="m.k === 'me' && isVoiceMsg(m)" title="這則是通話中說的，辨識成文字後寄出">🎤 語音</span><span v-if="m.k === 'me' && msgTier(m) && msgTier(m) !== 'sent'" class="msg-st" :class="'st-' + msgTier(m)" :title="msgStatusTip(m)" :aria-label="msgStatusTip(m)">{{ msgTier(m) === 'delivered' ? '✓' : '✓✓' }}</span><span v-if="isRoom && m.k === 'me' && readLabel(m.rd)" class="read-n" :class="{ all: m.rd.n >= m.rd.total }" :title="readTitle(m.rd)">{{ readLabel(m.rd) }}</span>
                <button v-if="voice && m.k === 'them' && m.text" class="spk" :class="{ on: speaking(m, i) }" type="button" @click="speak(m, i)" :aria-label="speakTip(m, i)" :title="speakTip(m, i)">
                  <svg v-if="!speaking(m, i)" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 9.5v5h3.6L12 18.5v-13L7.6 9.5z" fill="currentColor"/><path d="M15 9.2a4 4 0 0 1 0 5.6M17.4 6.8a7.4 7.4 0 0 1 0 10.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
                  <svg v-else viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/></svg>
                </button>
              </div>
              <div class="m-dev" v-if="m.dev && !noticeDevOf(m, isNotice)">{{ plain(m.dev) }}</div>
              <button v-if="msgQuote(m)" class="quote" type="button" @click="jumpTo(m, i)" :title="'跳到原訊息：' + plain(msgQuote(m).excerpt)"><b>{{ plain(msgQuote(m).author) }}</b><span>{{ plain(msgQuote(m).excerpt) }}</span></button>
              <div class="l-line" v-if="isLine">
                <div class="l-meta">
                  <span class="l-st" v-if="sentStateText(m, isRoom)" :class="[isRoom ? 'l-rd' : 'st-' + msgTier(m), { all: isRoom && m.rd && m.rd.n >= m.rd.total }]" :title="isRoom ? readTitle(m.rd) : msgStatusTip(m)" :aria-label="isRoom ? readLabel(m.rd) : msgStatusTip(m)">{{ sentStateText(m, isRoom) }}</span>
                  <span class="l-dev" v-if="m.k === 'me' && m.from">從 {{ plain(m.from) }}</span>
                  <span class="l-voice" v-if="m.k === 'me' && isVoiceMsg(m)" title="這則是通話中說的，辨識成文字後寄出">🎤 語音</span>
                  <time class="l-time">{{ clockLabel(m.t) }}</time>
                  <button v-if="voice && m.k === 'them' && m.text" class="spk" :class="{ on: speaking(m, i) }" type="button" @click="speak(m, i)" :aria-label="speakTip(m, i)" :title="speakTip(m, i)">
                    <svg v-if="!speaking(m, i)" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 9.5v5h3.6L12 18.5v-13L7.6 9.5z" fill="currentColor"/><path d="M15 9.2a4 4 0 0 1 0 5.6M17.4 6.8a7.4 7.4 0 0 1 0 10.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
                    <svg v-else viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/></svg>
                  </button>
                </div>
                <div class="m-body" :class="['tone-' + lay(m.k).tone, 'md-on']" v-if="shownBody(m).text" v-html="bodyHtml(shownBody(m).text)" @click="onBodyClick"></div>
              </div>
              <div class="m-body" :class="['tone-' + lay(m.k).tone, 'md-on']" v-if="!isLine && shownBody(m).text" v-html="bodyHtml(shownBody(m).text)" @click="onBodyClick"></div>
              <div class="dup-act" v-if="shownBody(m).dup.length" aria-label="關掉重複的視窗">
                <button v-for="w in shownBody(m).dup" :key="w.pid" class="dup-close" type="button" :disabled="dupPressed(m, i) || displayOnly" @click="closeDup(m, i, w)" :title="dupCloseLabel(w.n)">{{ dupCloseLabel(w.n) }}</button>
              </div>
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
  <div class="compose-row" :class="{ 'is-term': mSwitch && remoteShown }" v-if="!isNotice">
    <div class="compose-main">
      <div class="toolbar" :class="{ 'mc-open': plusOpen, 'mc-has-dict': showDictBtn }" @click="onToolbarClick" @keydown.esc="plusOpen = false">
        <span class="tool-group">
          <button class="tool icon" type="button" @click="pickerOpen = !pickerOpen" :aria-expanded="pickerOpen" aria-label="表情符號" title="表情符號">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="#ffd84a" stroke="#b58a00"/><circle cx="8.6" cy="9.6" r="1.4" fill="#5a3b00"/><circle cx="15.4" cy="9.6" r="1.4" fill="#5a3b00"/><path d="M7.2 14c1.2 2.6 3 3.6 4.8 3.6s3.6-1 4.8-3.6" fill="none" stroke="#5a3b00" stroke-width="1.6" stroke-linecap="round"/></svg>
            <line-icon name="emoji"></line-icon>
          </button>
        </span>
        <button class="tool icon call" type="button" v-if="showCallBtn && !displayOnly" @click="startCall" :disabled="callActive || dictPhase !== 'idle'" aria-label="通話" title="通話：用說的跟這位夥伴對話，回信會念出來">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6.6 3.5l2.4-.6 1.7 4.2-1.9 1.6a11.5 11.5 0 0 0 5.5 5.5l1.6-1.9 4.2 1.7-.6 2.4a2.6 2.6 0 0 1-2.6 2C10.1 18.4 5.6 13.9 4.6 6.1a2.6 2.6 0 0 1 2-2.6z" fill="#2f9a45" stroke="#1f6b2f" stroke-width="1.2" stroke-linejoin="round"/></svg>
          <line-icon name="call"></line-icon>
        </button>
        <button class="tool icon dict" :class="{ rec: dictPhase === 'listening', busy: dictPhase === 'starting' }" type="button" v-if="showDictBtn" @click="dictClick" :disabled="callActive" :aria-pressed="dictPhase === 'listening'" aria-label="語音輸入" :title="dictTip">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="9" y="3.5" width="6" height="11" rx="3" fill="currentColor"/><path d="M5.8 11.5a6.2 6.2 0 0 0 12.4 0M12 17.7v3M8.6 20.7h6.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
          <line-icon name="dict"></line-icon>
          <span class="dict-state" v-if="dictLabel">{{ dictLabel }}</span>
        </button>
        <button class="tool icon" type="button" v-if="!isRoom" @click="nudge" :disabled="nudgeCooling" aria-label="傳送震動" title="傳送震動">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="8.2" y="4.5" width="7.6" height="15" rx="1.8" fill="#dfeaf6" stroke="#4a5d73" stroke-width="1.4"/><circle cx="12" cy="16.6" r="1" fill="#4a5d73"/><path d="M4.6 8.5l-2 3.5 2 3.5M19.4 8.5l2 3.5-2 3.5" fill="none" stroke="#d9302b" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <line-icon name="nudge"></line-icon>
        </button>
        <button class="tool icon" type="button" @click="fileEl && fileEl.click()" :disabled="photoBusy" aria-label="傳照片" title="傳照片（也可以直接貼上圖片）">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" fill="#e8f3ff" stroke="#4a5d73" stroke-width="1.4"/><circle cx="8.5" cy="10" r="1.7" fill="#f2b632"/><path d="M4.5 17l4.6-4.4 3.2 3 2.6-2.4 4.6 3.8" fill="none" stroke="#2f7d3c" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <line-icon name="photo"></line-icon>
        </button>
        <input ref="fileEl" type="file" accept="image/*" hidden @change="pickPhoto" aria-hidden="true" tabindex="-1">
        <button class="tool icon" type="button" @click="docEl && docEl.click()" :disabled="photoBusy" aria-label="傳送檔案" title="傳送檔案（pdf、txt、md、json、csv、zip、docx、xlsx、pptx，單檔 25 MB 內）">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 2.5h8.5L19 7v14.5H6z" fill="#fff" stroke="#4a5d73" stroke-width="1.4" stroke-linejoin="round"/><path d="M14.5 2.5V7H19" fill="none" stroke="#4a5d73" stroke-width="1.4" stroke-linejoin="round"/><path d="M9 12h7M9 15.5h7" stroke="#2f7d3c" stroke-width="1.5" stroke-linecap="round"/></svg>
          <line-icon name="file"></line-icon>
        </button>
        <input ref="docEl" type="file" :accept="FILE_ACCEPT + ',image/*'" hidden @change="pickPhoto" aria-hidden="true" tabindex="-1">
        <button class="tool icon" type="button" v-if="shotApi && shotOk" @click="startShot" :disabled="photoBusy || !!annot" aria-label="截圖" title="截圖（框選螢幕任一區域，可畫筆標註後傳送）">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M7 3v14h14M3 7h14v14" fill="none" stroke="#4a5d73" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 14l4-4" stroke="#d9302b" stroke-width="1.8" stroke-linecap="round"/></svg>
          <line-icon name="shot"></line-icon>
        </button>
        <button class="tool icon mic" :class="{ rec: voice && voice.state.mic.phase === 'recording', busy: voice && (voice.state.mic.phase === 'recognizing' || voice.state.mic.phase === 'starting') }" type="button" v-if="voice" @click="micClick" :aria-label="micTip" :aria-pressed="voice.state.mic.phase === 'recording'" :title="micTip">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="9" y="3.5" width="6" height="11" rx="3" fill="currentColor"/><path d="M5.8 11.5a6.2 6.2 0 0 0 12.4 0M12 17.7v3M8.6 20.7h6.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
          <line-icon name="mic"></line-icon>
        </button>
        <!-- 對話／終端切換（手機）：一顆、放在這排最後面；字與圖示寫按了會去哪裡，不做選中樣式；沒有終端可看的夥伴不顯示 -->
        <button class="tool icon m-sw m-term-switch" type="button" v-if="mSwitch" :aria-label="mToggle.label" :title="mToggle.label" @click="remoteShown ? showMsgs() : showTerm()"><img :src="mToggle.icon" alt="" width="22" height="22"><line-icon :name="mToggle.line" :size="22"></line-icon></button>
        <div class="picker" v-if="pickerOpen && (!isLine || plusOpen)" role="menu">
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
        <ul class="mention-menu" ref="menuEl" v-if="mention" role="listbox" aria-label="選擇要點名的成員" @scroll.passive="syncMore">
          <li v-for="(o, i) in mention.options" :key="o.label"><button type="button" role="option" :class="{ on: i === mention.idx }" :aria-selected="i === mention.idx" @mousedown.prevent @click="pickMention(o)"><span class="mention-name">{{ o.label }}</span><small class="who-badge" :class="'is-' + o.kind">{{ o.badge }}</small></button></li>
          <li class="mention-more" v-if="mentionMore" aria-hidden="true">{{ MENTION_MORE_HINT }} ▾</li>
        </ul>
        <!-- 現代外觀的單列膠囊（#1421 B2）：「＋」開上方那排工具、語音輸入放右邊（手機的 dict 或電腦的 mic，擇一）；復古 Aero 下這幾顆整個不顯示 -->
        <button class="mc-plus" type="button" @click="plusOpen = !plusOpen" @keydown.esc="plusOpen = false" :aria-expanded="plusOpen" aria-label="附件與更多" title="附件與更多">
          <line-icon name="plus"></line-icon>
        </button>
        <!-- LINE 外觀（#1449 第三張）：「＋」旁攤開一顆圖片鈕（同一個選檔 input 與 pickPhoto），表情鈕放在輸入框內右側（同一個 pickerOpen）；其他外觀不輸出 -->
        <button class="lc-photo" type="button" v-if="isLine" @click="fileEl && fileEl.click()" :disabled="photoBusy" aria-label="傳照片" title="傳照片（也可以直接貼上圖片）"><line-icon name="photo"></line-icon></button>
        <textarea ref="composeEl" v-model="draft" @input="onDraftInput" @click="onDraftInput" @keydown="onComposeKey" @keydown.enter.exact="onEnter" @paste="onPaste" :placeholder="composeHint" :title="composeTitle || undefined" aria-label="輸入訊息" :disabled="displayOnly"></textarea>
        <button class="lc-emo" type="button" v-if="isLine" @click="plusOpen = false; pickerOpen = !pickerOpen" :aria-expanded="pickerOpen" :disabled="displayOnly" aria-label="表情符號" title="表情符號"><line-icon name="emoji"></line-icon></button>
        <div class="picker lc-picker" v-if="isLine && pickerOpen && !plusOpen" role="menu">
          <button v-for="[code, icon] in EMO" :key="code" type="button" :title="code" @click="insertEmo(code)" role="menuitem">{{ icon }}</button>
        </div>
        <button class="mc-dict" :class="{ rec: dictPhase === 'listening', busy: dictPhase === 'starting' }" type="button" v-if="showDictBtn" @click="dictClick" :disabled="callActive" :aria-pressed="dictPhase === 'listening'" aria-label="語音輸入" :title="dictTip">
          <line-icon name="dict"></line-icon>
          <span class="dict-state" v-if="dictLabel">{{ dictLabel }}</span>
        </button>
        <button class="mc-dict mc-mic" :class="{ rec: voice && voice.state.mic.phase === 'recording', busy: voice && (voice.state.mic.phase === 'recognizing' || voice.state.mic.phase === 'starting') }" type="button" v-if="voice && !showDictBtn" @click="micClick" :aria-label="micTip" :aria-pressed="voice.state.mic.phase === 'recording'" :title="micTip">
          <line-icon name="mic"></line-icon>
        </button>
        <button class="aero-btn" type="submit" :aria-label="sendLabel" :disabled="displayOnly || !draft.trim()">{{ sendLabel }}</button>
      </form>
    </div>
  </div>
  </div>
  <aside class="dp-side" v-if="sideCol" :class="'dp-side-' + side">
    <div class="dp-side-stack" v-show="!collapsed">
      <div class="dp-grp">
        <asn-avatar size="xl" :src="friendAv" :friend="isRoom ? null : friend" :status="friend.status" :hue="friend.hue"></asn-avatar>
        <button class="dp-fold-bar" type="button" @click="$emit('toggle-dp')" :disabled="foldLocked" :aria-label="foldTip" :aria-expanded="!collapsed" :title="foldTip">{{ barArrow }}</button>
      </div>
      <div class="dp-grp">
        <div class="dp xl" :class="'st-' + me.status" :style="{ '--h': 205 }"><span><img :src="meAv" alt=""></span></div>
        <button class="dp-fold-bar" type="button" @click="$emit('toggle-dp')" :disabled="foldLocked" :aria-label="foldTip" :aria-expanded="!collapsed" :title="foldTip">{{ barArrow }}</button>
      </div>
    </div>
    <button class="dp-fold-strip" type="button" v-if="collapsed" @click="$emit('toggle-dp')" :disabled="foldLocked" :aria-label="foldTip" :aria-expanded="false" :title="foldTip">{{ barArrow }}</button>
  </aside>
  </div>
  <div class="typing" :class="remoteBar && ['typing-remote', 'typing-' + remoteBar.level]" role="status">
    <template v-if="remoteBar && remoteBar.level === 'danger'">{{ remoteBar.text }}<button v-if="remoteBar.stoppable" class="aero-btn" type="button" @click="stopTyping">{{ INPUT_TEXT.stop }}</button><span class="typing-extra" v-if="voiceNote"> {{ voiceNote }}</span></template>
    <template v-else-if="voiceNote">{{ voiceNote }}</template>
    <template v-else-if="remoteBar">{{ remoteBar.text }}<button v-if="remoteBar.restartable" class="aero-btn" type="button" @click="restartView">{{ GRACE_AGAIN_LABEL }}</button></template>
    <template v-else-if="jumpNote">{{ jumpNote }}</template>
    <template v-else-if="photoMsg">{{ photoMsg }}<button v-if="savedHere" class="aero-btn" type="button" @click="revealSaved">開啟資料夾</button></template>
    <template v-else-if="showWaiting">✎ 已送出，等對方回信…</template>
    <template v-else-if="friend.lastAt">上次接收訊息是 {{ fmtDate(friend.lastAt) }}</template>
  </div>
  <teleport to="body" :disabled="!callApi">
    <call-view v-if="callActive" :state="call.state" :name="plain(friend.nick)" :avatar="friendAv" :hue="friend.hue" :status="friend.status" :phase-text="callApi && callApi.phaseText" @hangup="hangUp" @mute="call.toggleMute()"></call-view>
  </teleport>
  <teleport to="body" v-if="annot"><annotator :blob="annot.blob" :caption="draft.trim()" :busy="annot.busy" :message="annot.msg" @done="annotDone" @cancel="annotCancel"></annotator></teleport>
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
