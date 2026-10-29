// 對話視窗上方的大按鈕功能列（#40，仿舊 MSN 對話視窗頂端那排）。
// 分層原則（小良哥 10/21）：只影響「這一則訊息」的（傳檔、截圖、表情、震動、語音）留在輸入框旁的小工具列；影響「整個代理」的才放這裡。
// #539：一對一固定 6 格（通話／前台顯示・後台隱藏或 ACP 模式／切換模型／子代理／工作項目／管理），用不到的反灰、原因寫在提示（20 字內），不再隱藏。
// 格子的內容與反灰規則全部在純函式 barSlots；名單右鍵（list.js）也用同一個函式與 partnerMenuItems，兩邊不各寫一套。
import { isDisplayOnly } from './display-only.mjs'
import { AsnDialog } from './dialog.mjs'
import { confirmText, createModelSwitcher, modelSwitchBlock } from './model-switch.mjs'
import { SUBAGENT_POLL_MS, subagentView } from './subagents.mjs'
import { CONSOLE_QUERY_TIMEOUT_MS, consoleReq, engineForProfile, withTimeout } from './partner-launch-ui.mjs'
import { REASON, initialOpsCtx, menuItems, partnerEngine, sharedWhy } from './partner-ops.mjs'
import { manageItems, runArchive } from './archive.mjs'
import { PartnerOpDialog, loadOpsContext } from './partner-ops-ui.mjs'
import { canInviteFrom } from './groups.mjs'
import { placeMenu } from './menu-place.mjs'

/** 這位代理用哪一家的指令（名單上沒寫就看啟動設定，再沒有就當 Claude）。 */
export function friendEngine(friend) {
  return friend?.engine || engineForProfile(friend?.launchProfile || 'claude')
}

/** 查詢回來時，畫面上的還是同一位夥伴嗎（名單每次更新會換新物件，不能只比物件本身）。 */
export function sameFriend(a, b) {
  if (!a || !b) return false
  return a === b || (Boolean(a.id) && a.id === b.id)
}

// ---------- 反灰原因（20 字內） ----------
export const WHY_MAX = 20
const BRIEF = new Map([
  [REASON.closed, '這台電腦沒開放遠端管理'],
  [REASON.deviceOffline, '電腦不在線，叫不醒'],
  [REASON.cloud, '雲端代理，沒有視窗可管'],
  [REASON.otherEngine, '這個引擎暫不開放管理'],
  [REASON.restartOnlyAcp, '只用在內建通道的工作者'],
  [REASON.removeOnlyAcp, '只用在內建通道的工作者'],
])
const BRIEF_RE = [
  [/^這是這台電腦上自己開的/, '自己開的程式，只能顯示'],
  [/^這個 pi 視窗已離線/, 'pi 視窗已離線'],
  [/^這個內建通道的工作者已離線/, '工作者已離線'],
  [/^這個視窗已離線，要先喚醒/, '視窗已離線，要先喚醒'],
  [/^查不到這台電腦的設定/, '查不到這台電腦的設定'],
  [/^查不到登入狀態/, '查不到登入狀態'],
  [/不需要喚醒；要重新啟動/, '不用喚醒，請用「重開」'],
]
/** 反灰的說明縮成 20 字內（大按鈕提示、管理選單、名單右鍵共用）；已經夠短的原樣，認得的長句換成短說法，其餘截斷。 */
export function briefWhy(reason) {
  const s = String(reason ?? '').trim()
  if (s.length <= WHY_MAX) return s
  const hit = BRIEF.get(s) ?? BRIEF_RE.find(([re]) => re.test(s))?.[1]
  return hit ?? `${s.slice(0, WHY_MAX - 1)}…`
}

/** 「前台／後台」在查詢之前就已經知道不能用的原因（能用回空字串）；判斷與 canOfferConsole 完全相同。 */
export function consoleBlock(friend, selfNode) {
  if (!friend) return '沒有選到夥伴'
  if (friend.room === true) return '群組沒有視窗可以切換'
  if (friend.pending) return '視窗還在開啟中'
  if (partnerEngine(friend) === 'acp') return '內建通道執行，沒有視窗'
  if (friend.node !== selfNode) return '視窗在另一台電腦上'
  return ''
}
/** 能不能切換主控台視窗：只有本機、非內建通道、已經開起來的視窗。 */
export function canOfferConsole(friend, selfNode) {
  return !consoleBlock(friend, selfNode)
}

/** 通話不能用的原因：夥伴要在線（離線的話信只會留在收發室，通話等不到回覆），而且這個環境有語音功能。 */
export function callBlock(friend, { hasVoice = true } = {}) {
  if (!friend) return '沒有選到夥伴'
  if (friend.room === true) return '群組不能通話'
  if (friend.pending) return '視窗還在開啟中'
  if (isDisplayOnly(friend)) return '只能顯示，不能通話'
  if (!hasVoice) return '這個畫面沒有語音功能'
  if (friend.status === 'offline') return '夥伴離線，不能通話'
  return ''
}
export function canOfferCall(friend, opts = {}) {
  return !callBlock(friend, opts)
}

/**
 * 喚醒（離線的 AI 夥伴）：#539 起不放大按鈕，改在「管理」裡（p:resume，離線才可按）。這個函式留給「條件與右鍵同一套」的對照：
 * 只有離線的 Claude 視窗才算；不能按的原因照 menuItems。回 { show, ok, reason }。
 */
export function wakeButtonView(friend, ctx = {}) {
  if (!friend || friend.pending || friend.room === true || friend.status !== 'offline' || partnerEngine(friend) !== 'claude') return { show: false, ok: false, reason: '' }
  const it = menuItems(friend, ctx).find(i => i.key === 'resume')
  return it ? { show: true, ok: it.ok, reason: it.reason } : { show: false, ok: false, reason: '' }
}

// ---------- 固定 6 格 ----------
export const BAR_KEYS = ['call', 'window', 'model', 'subs', 'tasks', 'manage']
export const WINDOW_LABEL = { hide: '後台隱藏', show: '前台顯示', idle: '前台／後台', acp: 'ACP 模式' }
export const TASKS_WHY = '下一版開放'
const BAR_LABEL = { call: '通話', window: WINDOW_LABEL.idle, model: '切換模型', subs: '子代理', tasks: '工作項目', manage: '管理' }
const OFFLINE_WHY = '夥伴離線，要先喚醒'
const slot = (key, label, why) => ({ key, label, ok: !why, reason: why ? briefWhy(why) : '' })

// 前台／後台：查到能切才可按；查詢中、查不到都反灰
function consoleStateWhy(c = {}) {
  if (c.state === 'toggle') return ''
  if (c.state === 'checking') return '檢查中…'
  return c.reason || '找不到這個夥伴的視窗'
}
function windowSlot(f, engine, ctx) {
  if (engine === 'acp') return { key: 'window', label: WINDOW_LABEL.acp, ok: false, reason: '內建通道執行，沒有視窗' }
  const c = ctx.console ?? {}
  const why = consoleBlock(f, ctx.selfNode) || (f.status === 'offline' ? OFFLINE_WHY : '') || (ctx.api ? '' : '這個畫面不能切換視窗') || consoleStateWhy(c)
  const label = why ? WINDOW_LABEL.idle : c.visible ? WINDOW_LABEL.hide : WINDOW_LABEL.show
  return slot('window', label, why)
}
// 切換模型的查詢結果（Claude 視窗；右鍵選單開選單時就查）：沒給就只看查詢前的條件
function modelQueryWhy(q) {
  if (!q) return ''
  if (q.state === 'checking') return '檢查中…'
  if (q.state === 'none') return q.reason || '找不到這個視窗'
  return Array.isArray(q.items) && q.items.length ? '' : '查不到可切換的模型'
}
// 切換模型：ACP 工作者、pi 視窗走夥伴管理（和右鍵同一套 menuItems：ACP 手動輸入代號、pi 向 pi 查清單）；其他走 Claude 視窗的切換
function modelSlot(f, engine, ctx) {
  if (f.pending) return slot('model', BAR_LABEL.model, '視窗還在開啟中')
  if (!ctx.api) return slot('model', BAR_LABEL.model, '這個畫面不能切換模型')
  if (engine === 'acp' || engine === 'pi') {
    const it = menuItems(f, ctx.ops ?? {}).find(i => i.key === 'model')
    return slot('model', BAR_LABEL.model, it ? it.reason : '這位夥伴不能切換模型')
  }
  const why = (isDisplayOnly(f) ? '只能顯示，不能切換' : '') || modelSwitchBlock(f, { selfNode: ctx.selfNode, engine: friendEngine(f) })
    || (f.status === 'offline' ? OFFLINE_WHY : '') || modelQueryWhy(ctx.modelQuery)
  return slot('model', BAR_LABEL.model, why)
}
function subsSlot(f, engine, ctx) {
  const why = (f.pending ? '視窗還在開啟中' : '') || (isDisplayOnly(f) ? '只能顯示，不能查看' : '') || (engine !== 'claude' ? '只有 Claude 有子代理' : '')
    || (f.node !== ctx.selfNode ? '視窗在另一台電腦上' : '') || (f.status === 'offline' ? OFFLINE_WHY : '') || (ctx.subagents ? '' : '這個畫面不能查看')
  return slot('subs', ctx.subLabel || BAR_LABEL.subs, why)
}

/**
 * 一對一對話上方的固定 6 格（#539）：回 [{ key, label, ok, reason }]，順序固定為 BAR_KEYS；不能用的 ok:false，reason 20 字內。
 * ctx：{ selfNode, api（有沒有 transport）, callable（有沒有語音）, console（{ state, visible, reason }：查主控台的結果）,
 *        subagents（能不能查子代理）, subLabel, ops（夥伴管理要用的設定：loadOpsContext）, modelQuery（選填：切換模型的查詢結果）, manageCount（管理選單有幾項） }
 * 第 2 格依夥伴類型：ACP 工作者固定「ACP 模式」反灰；其他是前台顯示／後台隱藏。「工作項目」這一版先反灰（下一版開放）。
 */
export function barSlots(friend, ctx = {}) {
  if (!friend) return BAR_KEYS.map(k => ({ key: k, label: BAR_LABEL[k], ok: false, reason: '沒有選到夥伴' }))
  const engine = partnerEngine(friend)
  return [
    slot('call', BAR_LABEL.call, callBlock(friend, { hasVoice: ctx.callable === true })),
    windowSlot(friend, engine, ctx),
    modelSlot(friend, engine, ctx),
    subsSlot(friend, engine, ctx),
    slot('tasks', BAR_LABEL.tasks, TASKS_WHY),
    slot('manage', BAR_LABEL.manage, (ctx.manageCount ?? 0) > 0 ? '' : '沒有可管理的項目'),
  ]
}
/** 切換模型要不要走夥伴管理的對話框（ACP 手動輸入代號、pi 向 pi 查清單）；否則是 Claude 視窗的型號選單。 */
export const modelViaPartnerOp = friend => ['acp', 'pi'].includes(partnerEngine(friend))

/** 群組「管理」大按鈕的選單項目：邀請別人加入、加我的另一個 AI、成員與設定；一對一：只有能邀請的夥伴才有「邀請別人加入」。 */
export function opsMenuItems(friend) {
  if (!friend) return []
  if (friend.room === true) return [
    { key: 'invite', label: '邀請別人加入' },
    { key: 'addai', label: '加我的另一個 AI' },
    { key: 'manage', label: '成員與設定' },
  ]
  return canInviteFrom(friend) ? [{ key: 'invite', label: '邀請別人加入' }] : []
}

// 「把這台電腦上開著的終端納入管理…」（小良哥 #753、#757 用詞）：放在夥伴管理那段、封存之前。
// 點了打開接手清單（adopt 對話框，候選窗格、接手、允許代答／代送都沿用）；對方已經是 ASN 開的終端、或不在這台電腦時反灰並寫原因。
export const ADOPT_LABEL = '把這台電腦上開著的終端納入管理…'
export const ADOPT_TIP = '你自己在終端開的 grok、claude、agy、pi 或 codex，可以交給 ASN 看狀態、提醒你回答；預設只能看，要代送文字得另外允許。'
export function adoptItem(friend, selfNode = '') {
  const why = friend?.entryKind === 'term' ? '這個夥伴已經由 ASN 管理' : (!selfNode || friend?.node !== selfNode) ? '只能在那台電腦上納入管理' : ''
  return { key: 'p:adopt', label: ADOPT_LABEL, tip: ADOPT_TIP, ok: why === '', reason: why }
}
// 插在封存／取消封存之前；沒有封存項目就放最後
function withAdoptItem(items, adopt) {
  const i = items.findIndex(x => x.key === 'p:archive' || x.key === 'p:unarchive')
  return i < 0 ? [...items, adopt] : [...items.slice(0, i), adopt, ...items.slice(i)]
}

/**
 * 夥伴管理項目（「管理」選單與名單右鍵共用同一份）：沿用 manageItems（詳情、改名、關閉視窗、換班接手、喚醒、重開、移除、封存）加「納入管理」；
 * 拿掉「切換模型」（大按鈕與右鍵各有自己那一格）；前台／後台也不在這裡。喚醒只有離線時可按（照 menuItems）。
 * key 加「p:」前綴；反灰原因縮成 20 字內。不是 AI 夥伴回空陣列。
 */
const NO_DOTS = ['close', 'archive', 'unarchive', 'resume']
export function partnerMenuItems(friend, ctx = {}, selfNode = '') {
  const all = manageItems(friend, ctx).filter(i => i.key !== 'model')
  if (!all.length) return []
  const items = all.map(i => ({ key: `p:${i.key}`, label: `${i.label}${NO_DOTS.includes(i.key) ? '' : '…'}`, ok: i.ok, reason: i.ok ? '' : briefWhy(i.reason) }))
  return withAdoptItem(items, adoptItem(friend, selfNode))
}

/** 「管理」選單的完整項目：夥伴管理（partnerMenuItems）＋分隔線＋邀請等（extra＝opsMenuItems）。local.selfNode＝這台的節點。 */
export function managePanelItems(friend, ctx = {}, extra = [], local = {}) {
  const partner = partnerMenuItems(friend, ctx, local.selfNode)
  const rest = extra.map((i, n) => ({ ...i, ok: true, reason: '', sep: n === 0 && partner.length > 0 }))
  return [...partner, ...rest]
}

/** 前台／後台按鈕的字與提示。 */
export function consoleButtonView(visible) {
  return visible
    ? { label: WINDOW_LABEL.hide, tip: '把這個代理的視窗收到背景，對話照常進行' }
    : { label: WINDOW_LABEL.show, tip: '把這個代理的視窗叫回前台' }
}

/** 「管理」大按鈕＋選單：選單搬到 body 用 position:fixed 定位（不被對話區的捲動容器、輸入框蓋住或裁掉）。沒有項目時反灰，原因放提示。 */
export const OpsMenuButton = {
  name: 'OpsMenuButton',
  props: { items: { type: Array, default: () => [] }, disabled: { type: Boolean, default: false }, reason: { type: String, default: '' } },
  emits: ['pick'],
  setup(props, { emit }) {
    const { ref, reactive, computed, nextTick, onMounted, onBeforeUnmount } = globalThis.Vue
    const open = ref(false)
    const btn = ref(null), pop = ref(null)
    const pos = reactive({ x: 0, y: 0, ready: false })
    async function place() {
      await nextTick()
      if (!btn.value || !pop.value) return
      const r = btn.value.getBoundingClientRect(), w = pop.value.offsetWidth, h = pop.value.offsetHeight
      const p = placeMenu({ x: r.left, y: r.bottom + 2 }, { w, h }, { w: window.innerWidth, h: window.innerHeight })
      Object.assign(pos, { x: p.x, y: p.y, ready: true })
    }
    function toggle() { if (props.disabled) return; open.value = !open.value; pos.ready = false; if (open.value) void place() }
    // 不能用的項目只是「看起來反灰」還不夠：點了不送出任何動作（選單也不收起，使用者可以接著讀說明）
    function pick(it) { if (it.ok === false) return; open.value = false; emit('pick', it.key) }
    const onDoc = e => { if (open.value && !btn.value?.contains(e.target) && !pop.value?.contains(e.target)) open.value = false }
    const onKey = e => { if (e.key === 'Escape') open.value = false }
    onMounted(() => { document.addEventListener('mousedown', onDoc, true); window.addEventListener('keydown', onKey); window.addEventListener('resize', place) })
    onBeforeUnmount(() => { document.removeEventListener('mousedown', onDoc, true); window.removeEventListener('keydown', onKey); window.removeEventListener('resize', place) })
    const view = computed(() => sharedWhy(props.items))
    return { open, btn, pop, pos, toggle, pick, view }
  },
  template: `
<div class="ab-wrap">
  <button class="abtn" type="button" ref="btn" data-slot="manage" :class="{ on: open }" :disabled="disabled" aria-haspopup="true" :aria-expanded="open" aria-label="管理" :title="disabled ? reason : '詳情、改名、喚醒、邀請別人加入等管理動作'" @click="toggle">
    <img src="img/ab-more.svg" alt="" width="32" height="32"><span class="ab-name">管理 ▾</span>
  </button>
  <teleport to="body">
    <ul class="ab-menu ab-ops" v-if="open" ref="pop" role="menu" :style="{ left: pos.x + 'px', top: pos.y + 'px', visibility: pos.ready ? 'visible' : 'hidden' }">
      <li class="menu-note menu-shared" v-for="n in view.notes" :key="n" role="note">{{ n }}</li>
      <template v-for="it in view.rows" :key="it.key"><li class="ab-sep" v-if="it.sep" role="separator"></li><li><button type="button" role="menuitem" :class="{ off: it.ok === false }" :aria-disabled="it.ok === false ? 'true' : 'false'" :aria-describedby="it.ok === false ? 'ops-why-' + it.key : null" :title="it.ok === false ? it.reason : ''" @click="pick(it)"><span class="mi-t">{{ it.label }}</span><small class="menu-why" v-if="it.ok === false && it.why" :id="'ops-why-' + it.key">{{ it.why }}</small></button></li></template>
    </ul>
  </teleport>
</div>`,
}

const CALL_TIP = '語音通話：用說的跟這位夥伴對話，回信會念出來（再按掛斷）'
const MODEL_TIP = '切換這個代理使用的模型'

export const ActionBar = {
  name: 'ActionBar',
  components: { AsnDialog, PartnerOpDialog, OpsMenuButton },
  props: {
    friend: { type: Object, default: null },
    selfNode: { type: String, default: '' },
    api: { type: Object, default: null },        // 要有 partnerConsoleQuery／partnerConsoleSet／modelSwitchQuery／modelSwitchRun（lib/tauri.mjs 的 transport）；沒給就不放一對一的 6 格
    active: { type: Boolean, default: true },
    callable: { type: Boolean, default: false },   // 這個視窗有語音功能（由對話區決定）
    ops: { type: Array, default: () => [] },       // 「管理」按鈕的邀請等項目（opsMenuItems）
    piModelsFor: { type: Function, default: null },   // 別台電腦的 pi 模型清單（名單視窗的 remotePiModelsFor）；沒給＝別台的 pi 退回輸入框
  },
  emits: ['call', 'ops'],
  setup(props, { emit }) {
    const { ref, computed, reactive, watch, onMounted, onBeforeUnmount } = globalThis.Vue
    const cons = reactive({ state: 'none', visible: true, busy: false, reason: '' })   // state：none／checking／toggle
    const model = reactive({ open: false, state: 'none', reason: '', current: '', items: [], st: null })
    const subs = reactive({ open: false, q: null })
    const dlg = reactive({ open: false, target: null, busy: false, error: '', manual: '', done: '', copied: false })
    const root = ref(null)
    const opsCtx = reactive(initialOpsCtx())
    const opDlg = reactive({ open: false, item: null })   // 夥伴管理的對話框（喚醒、ACP／pi 的切換模型也用這個）
    const archiveNote = ref('')
    const engine = computed(() => friendEngine(props.friend))
    const name = computed(() => props.friend?.agent || props.friend?.nick || '')
    const isRoom = computed(() => props.friend?.room === true)
    const subView = computed(() => subagentView(subs.q))
    const opsAll = computed(() => (props.api && !isRoom.value ? managePanelItems(props.friend, opsCtx, props.ops, { selfNode: props.selfNode }) : props.ops.map(i => ({ ...i, ok: true, reason: '' }))))
    const slotList = computed(() => barSlots(props.friend, {
      selfNode: props.selfNode, api: Boolean(props.api), callable: props.callable, console: cons,
      subagents: Boolean(props.api?.subagentsQuery), subLabel: subView.value.label, ops: opsCtx, manageCount: opsAll.value.length,
    }))
    const slot = computed(() => Object.fromEntries(slotList.value.map(s => [s.key, s])))
    const showBar = computed(() => Boolean(props.api) || opsAll.value.length > 0)
    const showSubs = computed(() => slot.value.subs.ok)
    const consoleView = computed(() => consoleButtonView(cons.visible))
    const switcher = computed(() => (props.api ? createModelSwitcher({ transport: props.api, log: m => console.info('[ASN]', m) }) : null))
    const dlgText = computed(() => confirmText(name.value, model.current, dlg.target?.label ?? ''))
    // pi 的模型清單：本機的直接問 pi；別台的用名單視窗收到的回報（和名單右鍵同一份）
    const piModels = computed(() => {
      const f = props.friend
      if (!f || !props.api) return null
      return f.node === props.selfNode ? (props.api.piModels ?? null) : (props.piModelsFor?.(f.node) ?? null)
    })

    async function loadConsole() {
      const f = props.friend
      if (!props.api || !canOfferConsole(f, props.selfNode) || f.status === 'offline') { cons.state = 'none'; cons.reason = ''; return }
      cons.state = 'checking'; cons.reason = ''
      const q = await withTimeout(props.api.partnerConsoleQuery(consoleReq(props.friend, engine.value)), CONSOLE_QUERY_TIMEOUT_MS)
      if (!sameFriend(props.friend, f)) return
      if (q?.can_toggle ?? q?.canToggle) { cons.state = 'toggle'; cons.visible = Boolean(q.visible) } else { cons.state = 'none'; cons.reason = String(q?.reason || '') }
    }
    async function toggleConsole() {
      if (cons.busy || cons.state !== 'toggle') return
      cons.busy = true
      try {
        const r = await props.api.partnerConsoleSet({ ...consoleReq(props.friend, engine.value), visible: !cons.visible })
        if (r?.ok) cons.visible = Boolean(r.visible)
      } catch (e) { console.info('[ASN] 主控台切換', e.message) } finally { cons.busy = false }
    }
    let subTimer = null
    async function loadSubs() {
      const f = props.friend
      if (!props.active || !showSubs.value) return
      try {
        const q = await withTimeout(props.api.subagentsQuery({ name: name.value }), CONSOLE_QUERY_TIMEOUT_MS)
        if (sameFriend(props.friend, f)) subs.q = q
      } catch (e) { console.info('[ASN] 子代理查詢', e.message) }
    }
    let opsRetry = null
    async function loadOps() {
      const f = props.friend
      if (!props.api || !f || f.room === true) return
      const ctx = await loadOpsContext(props.api)
      if (!sameFriend(props.friend, f)) return
      Object.assign(opsCtx, ctx)
      // 查詢失敗（登入狀態或電腦設定）：幾秒後自動再查，直到查到為止
      if (ctx.signedIn === null || !ctx.loaded) { clearTimeout(opsRetry); opsRetry = setTimeout(() => { if (props.friend) void loadOps() }, 5000) }
    }
    let noteTimer = null
    async function pickOps(key) {
      if (!key.startsWith('p:')) { emit('ops', key); return }
      const it = opsAll.value.find(i => i.key === key)
      if (!it?.ok) return   // 反灰的項目：點了什麼都不做
      const op = key.slice(2)
      if (op === 'adopt') { emit('ops', 'adopt'); return }   // 接手清單在名單視窗裡，經 group-menu 通道請它打開
      if (op === 'archive' || op === 'unarchive') {
        const r = await runArchive(props.api, props.friend, op === 'archive')
        archiveNote.value = r.text
        clearTimeout(noteTimer); noteTimer = setTimeout(() => { archiveNote.value = '' }, 6000)
        return
      }
      Object.assign(opDlg, { open: true, item: { key: op, ok: true, reason: '' } })
    }
    function stopSubs() { if (subTimer) { clearInterval(subTimer); subTimer = null } }
    function startSubs() {
      stopSubs()
      subs.q = null
      if (!showSubs.value) return
      void loadSubs()
      subTimer = setInterval(() => { if (props.active) void loadSubs() }, SUBAGENT_POLL_MS)
    }
    function toggleSubs() { if (!slot.value.subs.ok) return; subs.open = !subs.open; model.open = false; if (subs.open) void loadSubs() }
    // 切換模型：ACP／pi 開夥伴管理的對話框（和名單右鍵同一條路）；Claude 視窗開型號選單
    function onModel() {
      if (!slot.value.model.ok) return
      if (modelViaPartnerOp(props.friend)) { model.open = false; subs.open = false; Object.assign(opDlg, { open: true, item: { key: 'model', ok: true, reason: '' } }); return }
      void toggleModelMenu()
    }
    async function toggleModelMenu() {
      subs.open = false
      if (model.open) { model.open = false; return }
      model.open = true
      model.state = 'checking'
      const st = await switcher.value.query(name.value)
      Object.assign(model, { state: st.state, reason: st.reason, current: st.current, items: st.items, st })
    }
    function pick(item) {
      if (item.disabled || item.checked || !model.st) return
      Object.assign(dlg, { open: true, target: item, busy: false, error: '', manual: '', done: '', copied: false })
      model.open = false
    }
    function closeDlg() { if (!dlg.busy) dlg.open = false }
    async function submit() {
      if (dlg.busy || dlg.done) return
      dlg.busy = true; dlg.error = ''; dlg.manual = ''
      const r = await switcher.value.run(name.value, model.st, dlg.target.id)
      dlg.busy = false
      if (r.ok) dlg.done = r.message
      else { dlg.error = r.message; dlg.manual = r.manual }
    }
    async function copyManual() {
      try { await navigator.clipboard.writeText(dlg.manual); dlg.copied = true } catch (e) { console.info('[ASN] 複製失敗', e.message) }
    }
    function startCall() { if (slot.value.call.ok) emit('call') }
    const onDoc = e => { if ((model.open || subs.open) && root.value && !root.value.contains(e.target)) { model.open = false; subs.open = false } }
    onMounted(() => { document.addEventListener('mousedown', onDoc, true); if (props.active) void loadConsole(); startSubs(); void loadOps() })
    onBeforeUnmount(() => { document.removeEventListener('mousedown', onDoc, true); stopSubs(); clearTimeout(opsRetry) })
    watch(() => props.active, a => { if (a) { void loadConsole(); void loadSubs(); void loadOps() } })
    watch(() => props.friend?.id, () => { model.open = false; subs.open = false; opDlg.open = false; void loadConsole(); startSubs(); void loadOps() })
    watch(() => props.friend?.status, () => { void loadConsole(); void loadOps() })
    watch(showSubs, () => startSubs())
    return { root, isRoom, showBar, slot, opsAll, pickOps, archiveNote, opDlg, piModels, startCall, cons, model, subs, subView, toggleSubs, onModel, dlg, consoleView, dlgText, toggleConsole, pick, closeDlg, submit, copyManual, CALL_TIP, MODEL_TIP }
  },
  template: `
<div class="actionbar" ref="root" v-if="showBar" role="toolbar" aria-label="代理功能列">
  <template v-if="!isRoom && api">
    <button class="abtn" type="button" data-slot="call" :disabled="!slot.call.ok" aria-label="通話" :title="slot.call.ok ? CALL_TIP : slot.call.reason" @click="startCall">
      <img src="img/ab-call.svg" alt="" width="32" height="32"><span class="ab-name">通話</span>
    </button>
    <button class="abtn" type="button" data-slot="window" :disabled="!slot.window.ok || cons.busy" :aria-label="slot.window.label" :title="slot.window.ok ? consoleView.tip : slot.window.reason" @click="toggleConsole">
      <img src="img/ab-window.svg" alt="" width="32" height="32"><span class="ab-name">{{ slot.window.label }}</span>
    </button>
    <div class="ab-wrap">
      <button class="abtn" type="button" data-slot="model" :class="{ on: model.open }" :disabled="!slot.model.ok" aria-haspopup="true" :aria-expanded="model.open" aria-label="切換模型" :title="slot.model.ok ? MODEL_TIP : slot.model.reason" @click="onModel">
        <img src="img/ab-model.svg" alt="" width="32" height="32"><span class="ab-name">切換模型 ▾</span>
      </button>
      <ul class="ab-menu" v-if="model.open" role="menu">
        <li class="menu-note" v-if="model.state === 'checking'">檢查中…</li>
        <template v-else>
          <li class="menu-note" v-if="model.state === 'none'">{{ model.reason }}</li>
          <template v-else>
            <li class="menu-note">目前：{{ model.current }}</li>
            <li v-for="m in model.items" :key="m.id"><button type="button" role="menuitemradio" :aria-checked="m.checked" :disabled="m.disabled" @click="pick(m)">{{ m.checked ? '✓ ' : '　' }}{{ m.label }}</button></li>
            <li class="menu-note" v-if="model.reason">{{ model.reason }}</li>
          </template>
        </template>
      </ul>
    </div>
    <div class="ab-wrap">
      <button class="abtn" type="button" data-slot="subs" :class="{ on: subs.open }" :disabled="!slot.subs.ok" aria-haspopup="true" :aria-expanded="subs.open" :aria-label="slot.subs.label" :title="slot.subs.ok ? subView.tip : slot.subs.reason" @click="toggleSubs">
        <img src="img/ab-agent.svg" alt="" width="32" height="32"><span class="ab-name">{{ slot.subs.label }} ▾</span>
      </button>
      <ul class="ab-menu ab-subs" v-if="subs.open" role="menu">
        <li class="menu-note" v-if="!subView.count">{{ subView.empty }}</li>
        <li class="ab-sub" v-for="it in subView.items" :key="it.id" role="menuitem"><span class="ab-sub-text">{{ it.text }}</span><span class="ab-sub-kind" v-if="it.kind">{{ it.kind }}</span></li>
        <li class="menu-note" v-if="subView.more">還有 {{ subView.more }} 個沒列出</li>
      </ul>
    </div>
    <button class="abtn" type="button" data-slot="tasks" :disabled="!slot.tasks.ok" aria-label="工作項目" :title="slot.tasks.reason">
      <img src="img/ab-tasks.svg" alt="" width="32" height="32"><span class="ab-name">工作項目</span>
    </button>
  </template>
  <partner-op-dialog v-if="opDlg.open" :friend="friend" :op="opDlg.item.key" :item="opDlg.item" :api="api" :pi-models="piModels" @close="opDlg.open = false"></partner-op-dialog>
  <ops-menu-button v-if="(!isRoom && api) || opsAll.length" :items="opsAll" :disabled="!isRoom && !slot.manage.ok" :reason="slot.manage.reason" @pick="pickOps"></ops-menu-button>
  <span class="ab-note" v-if="archiveNote" role="status">{{ archiveNote }}</span>
  <asn-dialog v-if="dlg.open" :title="dlgText.title" @close="closeDlg">
    <p class="launch-notice-body" v-if="!dlg.done">{{ dlgText.lead }}</p>
    <ul class="model-points" v-if="!dlg.done && !dlg.error"><li v-for="p in dlgText.points" :key="p">{{ p }}</li></ul>
    <p class="launch-notice-body" v-if="dlg.busy">切換中，請稍候…（舊視窗關掉、新視窗開好大約要十幾秒）</p>
    <p class="launch-notice-body" v-if="dlg.done">{{ dlg.done }}</p>
    <p class="launch-notice-body model-err" v-if="dlg.error">{{ dlg.error }}</p>
    <div v-if="dlg.manual">
      <p class="launch-notice-body">可以把下面這行貼到終端機，手動接續對話：</p>
      <textarea class="model-manual" readonly rows="3" :value="dlg.manual" aria-label="手動重開指令"></textarea>
    </div>
    <div class="partner-actions">
      <button class="aero-btn" type="button" v-if="dlg.manual" @click="copyManual">{{ dlg.copied ? '已複製' : '複製指令' }}</button>
      <button class="aero-btn" type="button" :disabled="dlg.busy" @click="closeDlg">{{ dlg.done || dlg.error ? '關閉' : dlgText.cancel }}</button>
      <button class="aero-btn primary" type="button" v-if="!dlg.done && !dlg.error" :disabled="dlg.busy" @click="submit">{{ dlgText.ok }}</button>
    </div>
  </asn-dialog>
</div>`,
}
