// 對話視窗上方的大按鈕功能列（#40，仿舊 MSN 對話視窗頂端那排）。
// 分層原則（小良哥 10/21）：只影響「這一則訊息」的（傳檔、截圖、表情、震動、語音）留在輸入框旁的小工具列；
// 影響「整個代理」的才放這裡。這裡只放目前已經做好的：顯示／背景（主控台視窗）與切換模型。
// 子代理（#27）已加；權限詢問等功能做好後再加按鈕，沒有功能就不放假按鈕。
import { AsnDialog } from './dialog.mjs'
import { canOfferModelSwitch, confirmText, createModelSwitcher } from './model-switch.mjs'
import { SUBAGENT_POLL_MS, canOfferSubagents, subagentView } from './subagents.mjs'
import { CONSOLE_QUERY_TIMEOUT_MS, consoleToggleLabel, engineForProfile, withTimeout } from './partner-launch-ui.mjs'

/** 這位代理用哪一家的指令（名單上沒寫就看啟動設定，再沒有就當 Claude）。 */
export function friendEngine(friend) {
  return friend?.engine || engineForProfile(friend?.launchProfile || 'claude')
}

/** 能不能切換主控台視窗：只有本機、非雲端代理、已經開起來的視窗。 */
export function canOfferConsole(friend, selfNode) {
  if (!friend || friend.pending) return false
  if (friend.engine === 'acp') return false
  return friend.node === selfNode
}

/** 通話按鈕：夥伴要在線（離線的話信只會留在收發室，通話等不到回覆），而且這個環境有語音功能。 */
export function canOfferCall(friend, { hasVoice = true } = {}) {
  if (!hasVoice || !friend || friend.pending) return false
  return friend.status !== 'offline'
}

/** 顯示／背景按鈕的字與提示。 */
export function consoleButtonView(visible) {
  return visible
    ? { label: consoleToggleLabel(true), tip: '把這個代理的視窗收到背景，對話照常進行' }
    : { label: consoleToggleLabel(false), tip: '把這個代理的視窗叫回前台' }
}

export const ActionBar = {
  name: 'ActionBar',
  components: { AsnDialog },
  props: {
    friend: { type: Object, default: null },
    selfNode: { type: String, default: '' },
    api: { type: Object, default: null },        // 要有 partnerConsoleQuery／partnerConsoleSet／modelSwitchQuery／modelSwitchRun（lib/tauri.mjs 的 transport）
    active: { type: Boolean, default: true },
    callable: { type: Boolean, default: false },   // 這個視窗有語音功能（由對話區決定）
  },
  emits: ['call'],
  setup(props, { emit }) {
    const { ref, computed, reactive, watch, onMounted, onBeforeUnmount } = globalThis.Vue
    const cons = reactive({ state: 'none', visible: true, busy: false })   // state：none／toggle
    const model = reactive({ open: false, state: 'none', reason: '', current: '', items: [], st: null })
    const subs = reactive({ open: false, q: null })
    const dlg = reactive({ open: false, target: null, busy: false, error: '', manual: '', done: '', copied: false })
    const root = ref(null)
    const engine = computed(() => friendEngine(props.friend))
    const name = computed(() => props.friend?.agent || props.friend?.nick || '')
    const showConsole = computed(() => Boolean(props.api) && canOfferConsole(props.friend, props.selfNode) && cons.state === 'toggle')
    const showModel = computed(() => Boolean(props.api) && canOfferModelSwitch(props.friend, { selfNode: props.selfNode, engine: engine.value }))
    const showSubs = computed(() => Boolean(props.api?.subagentsQuery) && canOfferSubagents(props.friend, { selfNode: props.selfNode, engine: engine.value }))
    const subView = computed(() => subagentView(subs.q))
    const showCall = computed(() => canOfferCall(props.friend, { hasVoice: props.callable }))
    const show = computed(() => showCall.value || showConsole.value || showModel.value || showSubs.value)
    const consoleView = computed(() => consoleButtonView(cons.visible))
    const switcher = computed(() => (props.api ? createModelSwitcher({ transport: props.api, log: m => console.info('[ASN]', m) }) : null))
    const dlgText = computed(() => confirmText(name.value, model.current, dlg.target?.label ?? ''))

    async function loadConsole() {
      const f = props.friend
      if (!props.api || !canOfferConsole(f, props.selfNode)) { cons.state = 'none'; return }
      const q = await withTimeout(props.api.partnerConsoleQuery({ engine: engine.value, name: name.value }), CONSOLE_QUERY_TIMEOUT_MS)
      if (props.friend !== f) return
      if (q?.can_toggle ?? q?.canToggle) { cons.state = 'toggle'; cons.visible = Boolean(q.visible) } else cons.state = 'none'
    }
    async function toggleConsole() {
      if (cons.busy || cons.state !== 'toggle') return
      cons.busy = true
      try {
        const r = await props.api.partnerConsoleSet({ engine: engine.value, name: name.value, visible: !cons.visible })
        if (r?.ok) cons.visible = Boolean(r.visible)
      } catch (e) { console.info('[ASN] 主控台切換', e.message) } finally { cons.busy = false }
    }
    let subTimer = null
    async function loadSubs() {
      const f = props.friend
      if (!props.active || !showSubs.value) return
      try {
        const q = await withTimeout(props.api.subagentsQuery({ name: name.value }), CONSOLE_QUERY_TIMEOUT_MS)
        if (props.friend === f) subs.q = q
      } catch (e) { console.info('[ASN] 子代理查詢', e.message) }
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
    onMounted(() => { document.addEventListener('mousedown', onDoc, true); if (props.active) void loadConsole(); startSubs() })
    onBeforeUnmount(() => { document.removeEventListener('mousedown', onDoc, true); stopSubs() })
    watch(() => props.active, a => { if (a) { void loadConsole(); void loadSubs() } })
    watch(() => props.friend?.id, () => { model.open = false; subs.open = false; void loadConsole(); startSubs() })
    return { root, showCall, startCall: () => emit('call'), cons, model, subs, subView, showSubs, toggleSubs, dlg, show, showConsole, showModel, consoleView, dlgText, toggleConsole, toggleModelMenu, pick, closeDlg, submit, copyManual }
  },
  template: `
<div class="actionbar" ref="root" v-if="show" role="toolbar" aria-label="代理功能列">
  <button v-if="showCall" class="abtn" type="button" aria-label="通話" title="語音通話：用說的跟這位夥伴對話，回信會念出來（再按掛斷）" @click="startCall">
    <img src="img/ab-call.svg" alt="" width="32" height="32"><span class="ab-name">通話</span>
  </button>
  <button v-if="showConsole" class="abtn" type="button" :disabled="cons.busy" :title="consoleView.tip" :aria-label="consoleView.label" @click="toggleConsole">
    <img src="img/ab-window.svg" alt="" width="32" height="32"><span class="ab-name">{{ consoleView.label }}</span>
  </button>
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
