// 對話視窗上方的大按鈕功能列（#40，仿舊 MSN 對話視窗頂端那排）。
// 分層原則（小良哥 10/21）：只影響「這一則訊息」的（傳檔、截圖、表情、震動、語音）留在輸入框旁的小工具列；
// 影響「整個代理」的才放這裡。這裡只放目前已經做好的：顯示／背景（主控台視窗）、切換模型、子代理，以及離線夥伴的「喚醒」。
// 子代理（#27）已加；權限詢問等功能做好後再加按鈕，沒有功能就不放假按鈕。
import { isDisplayOnly } from './display-only.mjs'
import { AsnDialog } from './dialog.mjs'
import { canOfferModelSwitch, confirmText, createModelSwitcher, modelSwitchBlock } from './model-switch.mjs'
import { SUBAGENT_POLL_MS, canOfferSubagents, subagentView } from './subagents.mjs'
import { BUDDY_CONSOLE_LABEL, CONSOLE_QUERY_TIMEOUT_MS, consoleReq, consoleToggleLabel, engineForProfile, withTimeout } from './partner-launch-ui.mjs'
import { initialOpsCtx, menuItems, partnerEngine, sharedWhy } from './partner-ops.mjs'
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

/** 能不能切換主控台視窗：只有本機、非雲端代理、已經開起來的視窗。 */
export function canOfferConsole(friend, selfNode) {
  return !consoleBlock(friend, selfNode)
}

/** 「背景／前台切換」在查詢之前就已經知道不能用的原因（能用回空字串）；判斷與 canOfferConsole 完全相同。 */
export function consoleBlock(friend, selfNode) {
  if (!friend) return '沒有選到夥伴'
  if (friend.room === true) return '群組沒有視窗可以切換'
  if (friend.pending) return '這個視窗還在開啟中，開好後才能切換前景或背景'
  if (friend.engine === 'acp') return '這個夥伴由 ASN 內建通道執行，沒有視窗可以切換'
  if (friend.node !== selfNode) return '這個視窗在另一台電腦上，只能在那台電腦的 ASN 切換前景或背景'
  return ''
}

/** 通話按鈕：夥伴要在線（離線的話信只會留在收發室，通話等不到回覆），而且這個環境有語音功能。 */
export function canOfferCall(friend, { hasVoice = true } = {}) {
  if (!hasVoice || !friend || friend.pending || friend.room === true || isDisplayOnly(friend)) return false
  return friend.status !== 'offline'
}

/**
 * 喚醒按鈕：只有「離線的 AI 夥伴」才有（在線的不顯示）。可按的條件與右鍵選單同一套（lib/partner-ops.mjs 的 menuItems）：
 * 有登入、電腦在線且開放遠端管理；不能按就反灰，原因寫在提示裡。回 { show, ok, reason }。
 */
export function wakeButtonView(friend, ctx = {}) {
  if (!friend || friend.pending || friend.room === true || friend.status !== 'offline' || partnerEngine(friend) !== 'claude') return { show: false, ok: false, reason: '' }
  const it = menuItems(friend, ctx).find(i => i.key === 'resume')
  return it ? { show: true, ok: it.ok, reason: it.reason } : { show: false, ok: false, reason: '' }
}

/**
 * 「管理」大按鈕的選單項目（原本在收件人列的「⋯」，小良哥 10/23 改搬到大按鈕區，下拉才不會被下面的東西蓋住）。
 * 群組：邀請別人加入、加我的另一個 AI、成員與設定；一對一：只有能邀請的夥伴才有「邀請別人加入」；沒有項目就不放按鈕。
 */
export function opsMenuItems(friend) {
  if (!friend) return []
  if (friend.room === true) return [
    { key: 'invite', label: '邀請別人加入' },
    { key: 'addai', label: '加我的另一個 AI' },
    { key: 'manage', label: '成員與設定' },
  ]
  return canInviteFrom(friend) ? [{ key: 'invite', label: '邀請別人加入' }] : []
}

/**
 * 「管理」選單的完整項目：夥伴管理（沿用名單右鍵的 manageItems：詳情、改名、關閉視窗、換班接手、封存等，反灰與原因照原邏輯）
 * ＋分隔線＋邀請等（opsMenuItems）。切換模型、喚醒在大按鈕區已有自己的按鈕，這裡不重複。
 * 夥伴項目的 key 加「p:」前綴，避免和邀請等項目撞名；第一個邀請項目帶 sep:true（前面有夥伴項目時才畫分隔線）。
 */
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

export function managePanelItems(friend, ctx = {}, extra = [], local = {}) {
  const all = manageItems(friend, ctx)
  // 項目固定（和名單右鍵、手機同一套同一個順序）：最前面「背景／前台切換」，接著 manageItems 的全部項目；用不到的反灰並附原因。
  // 切換模型、背景／前台切換要問這個視窗自己（local.model／local.console＝{ ok, reason }），其餘照 manageItems
  const partner = all.length ? [
    { key: 'p:console', label: BUDDY_CONSOLE_LABEL, ok: local.console?.ok === true, reason: local.console?.ok === true ? '' : (local.console?.reason || '找不到這個夥伴的主控台視窗') },
    ...withAdoptItem(all.map(i => {
      const o = i.key === 'model' && local.model ? local.model : i
      return { key: `p:${i.key}`, label: `${i.label}${['close', 'archive', 'unarchive', 'resume', 'model'].includes(i.key) ? '' : '…'}`, ok: o.ok, reason: o.ok ? '' : o.reason }
    }), adoptItem(friend, local.selfNode)),
  ] : []
  const rest = extra.map((i, n) => ({ ...i, ok: true, reason: '', sep: n === 0 && partner.length > 0 }))
  return [...partner, ...rest]
}

/** 顯示／背景按鈕的字與提示。 */
export function consoleButtonView(visible) {
  return visible
    ? { label: consoleToggleLabel(true), tip: '把這個代理的視窗收到背景，對話照常進行' }
    : { label: consoleToggleLabel(false), tip: '把這個代理的視窗叫回前台' }
}

/** 「管理」大按鈕＋選單：選單搬到 body 用 position:fixed 定位（不被對話區的捲動容器、輸入框蓋住或裁掉）。 */
export const OpsMenuButton = {
  name: 'OpsMenuButton',
  props: { items: { type: Array, default: () => [] } },
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
    function toggle() { open.value = !open.value; pos.ready = false; if (open.value) void place() }
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
  <button class="abtn" type="button" ref="btn" :class="{ on: open }" aria-haspopup="true" :aria-expanded="open" aria-label="管理" title="邀請別人加入、成員與設定等管理動作" @click="toggle">
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

export const ActionBar = {
  name: 'ActionBar',
  components: { AsnDialog, PartnerOpDialog, OpsMenuButton },
  props: {
    friend: { type: Object, default: null },
    selfNode: { type: String, default: '' },
    api: { type: Object, default: null },        // 要有 partnerConsoleQuery／partnerConsoleSet／modelSwitchQuery／modelSwitchRun（lib/tauri.mjs 的 transport）
    active: { type: Boolean, default: true },
    callable: { type: Boolean, default: false },   // 這個視窗有語音功能（由對話區決定）
    ops: { type: Array, default: () => [] },       // 「管理」按鈕的選單項目（opsMenuItems）；空的就不放按鈕
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
    const wakeDlg = reactive({ open: false, item: null })   // 夥伴管理的對話框（喚醒也用這個）
    const archiveNote = ref('')
    const engine = computed(() => friendEngine(props.friend))
    const name = computed(() => props.friend?.agent || props.friend?.nick || '')
    const showConsole = computed(() => Boolean(props.api) && canOfferConsole(props.friend, props.selfNode) && cons.state === 'toggle')
    const isRoom = computed(() => props.friend?.room === true)
    const showModel = computed(() => !isRoom.value && Boolean(props.api) && canOfferModelSwitch(props.friend, { selfNode: props.selfNode, engine: engine.value }))
    const showSubs = computed(() => !isRoom.value && Boolean(props.api?.subagentsQuery) && canOfferSubagents(props.friend, { selfNode: props.selfNode, engine: engine.value }))
    const subView = computed(() => subagentView(subs.q))
    const showCall = computed(() => canOfferCall(props.friend, { hasVoice: props.callable }))
    const wake = computed(() => (props.api && !isRoom.value ? wakeButtonView(props.friend, opsCtx) : { show: false, ok: false, reason: '' }))
    // 「背景／前台切換」「切換模型」不能用的原因：還沒查到就說檢查中，查到切不了用查到的原因，查之前就知道的用 consoleBlock／modelSwitchBlock
    const localPanel = computed(() => {
      const f = props.friend
      const consoleWhy = consoleBlock(f, props.selfNode) || (cons.state === 'toggle' ? '' : cons.state === 'checking' ? '檢查中…' : cons.reason || '找不到這個夥伴的主控台視窗')
      return {
        selfNode: props.selfNode,
        console: { ok: !consoleWhy && cons.state === 'toggle' && Boolean(props.api), reason: consoleWhy || (props.api ? '' : '這個畫面不能切換視窗') },
        model: { ok: showModel.value, reason: modelSwitchBlock(f, { selfNode: props.selfNode, engine: engine.value }) || (props.api ? '' : '這個畫面不能切換模型') },
      }
    })
    const opsAll = computed(() => (props.api && !isRoom.value ? managePanelItems(props.friend, opsCtx, props.ops, localPanel.value) : props.ops.map(i => ({ ...i, ok: true, reason: '' }))))
    const show = computed(() => showCall.value || showConsole.value || showModel.value || showSubs.value || wake.value.show || opsAll.value.length > 0)
    const consoleView = computed(() => consoleButtonView(cons.visible))
    const switcher = computed(() => (props.api ? createModelSwitcher({ transport: props.api, log: m => console.info('[ASN]', m) }) : null))
    const dlgText = computed(() => confirmText(name.value, model.current, dlg.target?.label ?? ''))

    async function loadConsole() {
      const f = props.friend
      if (!props.api || !canOfferConsole(f, props.selfNode)) { cons.state = 'none'; return }
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
    let wakeRetry = null
    async function loadWake() {
      const f = props.friend
      if (!props.api || !f || f.room === true) return
      const ctx = await loadOpsContext(props.api)
      if (!sameFriend(props.friend, f)) return
      Object.assign(opsCtx, ctx)
      // 查詢失敗（登入狀態或電腦設定）：幾秒後自動再查，直到查到為止
      if (ctx.signedIn === null || !ctx.loaded) { clearTimeout(wakeRetry); wakeRetry = setTimeout(() => { if (props.friend) void loadWake() }, 5000) }
    }
    function openWake() {
      const it = menuItems(props.friend, opsCtx).find(i => i.key === 'resume')
      if (!it?.ok) return
      Object.assign(wakeDlg, { open: true, item: it })
    }
    let noteTimer = null
    async function pickOps(key) {
      if (!key.startsWith('p:')) { emit('ops', key); return }
      const it = opsAll.value.find(i => i.key === key)
      if (!it?.ok) return   // 反灰的項目：點了什麼都不做
      const op = key.slice(2)
      if (op === 'console') { void toggleConsole(); return }
      if (op === 'model') { void toggleModelMenu(); return }
      if (op === 'adopt') { emit('ops', 'adopt'); return }   // 接手清單在名單視窗裡，經 group-menu 通道請它打開
      if (op === 'archive' || op === 'unarchive') {
        const r = await runArchive(props.api, props.friend, op === 'archive')
        archiveNote.value = r.text
        clearTimeout(noteTimer); noteTimer = setTimeout(() => { archiveNote.value = '' }, 6000)
        return
      }
      Object.assign(wakeDlg, { open: true, item: { key: op, ok: true, reason: '' } })
    }
    function stopSubs() { if (subTimer) { clearInterval(subTimer); subTimer = null } }
    function startSubs() {
      stopSubs()
      subs.q = null
      if (!showSubs.value) return
      void loadSubs()
      subTimer = setInterval(() => { if (props.active) void loadSubs() }, SUBAGENT_POLL_MS)
    }
    function toggleSubs() { subs.open = !subs.open; model.open = false; if (subs.open) void loadSubs() }
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
    const onDoc = e => { if ((model.open || subs.open) && root.value && !root.value.contains(e.target)) { model.open = false; subs.open = false } }
    onMounted(() => { document.addEventListener('mousedown', onDoc, true); if (props.active) void loadConsole(); startSubs(); void loadWake() })
    onBeforeUnmount(() => { document.removeEventListener('mousedown', onDoc, true); stopSubs(); clearTimeout(wakeRetry) })
    watch(() => props.active, a => { if (a) { void loadConsole(); void loadSubs(); void loadWake() } })
    watch(() => props.friend?.id, () => { model.open = false; subs.open = false; wakeDlg.open = false; void loadConsole(); startSubs(); void loadWake() })
    watch(() => props.friend?.status, () => { void loadWake() })
    return { root, isRoom, opsAll, pickOps, archiveNote, wake, wakeDlg, openWake, showCall, startCall: () => emit('call'), cons, model, subs, subView, showSubs, toggleSubs, dlg, show, showConsole, showModel, consoleView, dlgText, toggleConsole, toggleModelMenu, pick, closeDlg, submit, copyManual }
  },
  template: `
<div class="actionbar" ref="root" v-if="show" role="toolbar" aria-label="代理功能列">
  <button v-if="showCall" class="abtn" type="button" aria-label="通話" title="語音通話：用說的跟這位夥伴對話，回信會念出來（再按掛斷）" @click="startCall">
    <img src="img/ab-call.svg" alt="" width="32" height="32"><span class="ab-name">通話</span>
  </button>
  <button v-if="showConsole" class="abtn" type="button" :disabled="cons.busy" :title="consoleView.tip" :aria-label="consoleView.label" @click="toggleConsole">
    <img src="img/ab-window.svg" alt="" width="32" height="32"><span class="ab-name">{{ consoleView.label }}</span>
  </button>
  <button v-if="wake.show" class="abtn" type="button" :disabled="!wake.ok" :title="wake.ok ? '叫醒這位夥伴：在原本的資料夾開視窗，接回原本的對話' : wake.reason" aria-label="喚醒" @click="openWake">
    <img src="img/ab-wake.svg" alt="" width="32" height="32"><span class="ab-name">喚醒</span>
  </button>
  <partner-op-dialog v-if="wakeDlg.open" :friend="friend" :op="wakeDlg.item.key" :item="wakeDlg.item" :api="api" @close="wakeDlg.open = false"></partner-op-dialog>
  <div class="ab-wrap" v-if="showModel">
    <button class="abtn" type="button" :class="{ on: model.open }" aria-haspopup="true" :aria-expanded="model.open" aria-label="切換模型" title="切換這個代理使用的模型（會關掉原視窗再接續對話）" @click="toggleModelMenu">
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
  <div class="ab-wrap" v-if="showSubs">
    <button class="abtn" type="button" :class="{ on: subs.open }" aria-haspopup="true" :aria-expanded="subs.open" :aria-label="subView.label" :title="subView.tip" @click="toggleSubs">
      <img src="img/ab-agent.svg" alt="" width="32" height="32"><span class="ab-name">{{ subView.label }} ▾</span>
    </button>
    <ul class="ab-menu ab-subs" v-if="subs.open" role="menu">
      <li class="menu-note" v-if="!subView.count">{{ subView.empty }}</li>
      <li class="ab-sub" v-for="it in subView.items" :key="it.id" role="menuitem"><span class="ab-sub-text">{{ it.text }}</span><span class="ab-sub-kind" v-if="it.kind">{{ it.kind }}</span></li>
      <li class="menu-note" v-if="subView.more">還有 {{ subView.more }} 個沒列出</li>
    </ul>
  </div>
  <ops-menu-button v-if="opsAll.length" :items="opsAll" @pick="pickOps"></ops-menu-button>
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
