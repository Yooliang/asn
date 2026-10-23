// 電腦版「管理夥伴視窗」介面（名單右鍵、對話上方「喚醒」大按鈕共用）：查設定、送出並輪詢進度、各動作的對話框文字，以及對話框元件。
// 判斷全部用 lib/partner-ops.mjs 的 menuItems／buildOpRequest／opFormError／progressView／infoRows，這裡不另寫一套。
// 純繁體中文；不顯示節點代號與夥伴 ID。node 也要能載入（測試），所以 Vue 只在元件 setup 裡才取用。
import { AsnDialog } from './dialog.mjs'
import { machinesByNode } from './mobile-launch.mjs'
import { OP_LABEL, OP_POLL_MS, buildOpRequest, infoRows, opErrorText, opFormError, partnerEngine, progressView } from './partner-ops.mjs'

// 查「能不能管理」要用的設定：有沒有登入、各台電腦在線與否與開放與否。查不到的一律當沒查到（loaded:false → 反灰並說明）
export async function loadOpsContext(api) {
  const out = { machines: {}, loaded: false, signedIn: false }
  try { out.signedIn = (await api.authStatus?.())?.signed_in === true } catch { out.signedIn = false }
  try { out.machines = machinesByNode(await api.launchers()); out.loaded = true } catch { out.loaded = false }
  return out
}

const failView = text => ({ phase: 'failed', done: true, text })

// 送出一個操作並輪詢到完成或逾時。onUpdate(view) 每次進度都會呼叫；cancelled() 回 true 就停手（對話框被關掉）。
// 回最後一個 view（被取消回 null）。api 要有 partnerOp／partnerOps（lib/tauri.mjs 的 transport）。
export async function runPartnerOp(api, friend, op, input, { onUpdate = () => {}, cancelled = () => false, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), pollMs = OP_POLL_MS } = {}) {
  const sentAt = now()
  let id = ''
  try { id = (await api.partnerOp(buildOpRequest(friend, op, input)))?.id ?? '' } catch (e) {
    const v = failView(opErrorText(e?.message)); onUpdate(v); return v
  }
  if (!id) { const v = failView('送出失敗，請稍後再試'); onUpdate(v); return v }
  onUpdate(progressView(null, { op, sentAt, now: now() }))
  for (;;) {
    await sleep(pollMs)
    if (cancelled()) return null
    let row = null
    try { row = ((await api.partnerOps([id]))?.ops ?? []).find(o => o?.id === id) ?? null } catch { /* 暫時連不上：繼續等，太久由 progressView 判逾時 */ }
    const v = progressView(row ?? { status: 'pending' }, { op, sentAt, now: now() })
    if (op === 'info' && row?.status === 'ok') v.rows = infoRows(row.result)
    onUpdate(v)
    if (v.done) return v
  }
}

// 各動作的對話框文字（給人看；device＝設備名）。confirm＝要先確認；auto＝不用確認直接送出
export function opDialogText(op, name, device = '', engine = 'claude') {
  const where = device ? `在「${device}」上的` : ''
  const title = { info: `${name} 的詳情`, rename: '改名', close: '關閉視窗', handover: '接班換手', resume: '喚醒', restart: '重開' }[op] ?? OP_LABEL[op] ?? ''
  switch (op) {
    case 'rename': return { title, lead: `要把「${name}」改成什麼名字？名字只能用英數、連字號、中文，1～40 字，不能以連字號開頭。`, points: [], ok: '改名', auto: false }
    case 'close': return { title, lead: `關掉「${name}」${where}視窗？對話記錄會留著。`, points: [], ok: '關閉視窗', auto: false }
    case 'restart': return { title, lead: `要重開「${name}」${where}背景工作者嗎？會先結束它的程序，再由收發室重新啟動，對話會保留。`, points: [], ok: '重開', auto: false }
    case 'handover': return engine === 'acp' ? {
      title, lead: `要讓「${name}」${where}背景工作者接班換手嗎？`, ok: '開始換手', auto: false,
      points: ['這類夥伴不會請前任寫交接，也沒有前任的對話紀錄可讀', '清掉目前的對話，結束它的程序，由收發室重新啟動', '新的對話第一句會是接班說明，請它先向寄件人確認進度'],
    } : {
      title, lead: `要讓「${name}」${where}視窗接班換手嗎？`, ok: '開始換手', auto: false,
      points: ['先請它把交接寫到一個檔案（最久等十分鐘，沒寫完也會繼續）', '再關掉它的視窗', '用同一個名字開一個新的，新夥伴會先讀交接檔和前任最後的對話紀錄，接著把工作做下去'],
    }
    case 'resume': return { title, lead: `叫醒「${name}」${where}視窗，接回原本的對話。`, points: [], ok: '喚醒', auto: true }
    default: return { title, lead: '', points: [], ok: '確定', auto: op === 'info' }
  }
}

export const PartnerOpDialog = {
  name: 'PartnerOpDialog',
  components: { AsnDialog },
  props: {
    friend: { type: Object, required: true },
    op: { type: String, required: true },
    api: { type: Object, required: true },
    item: { type: Object, default: null },   // menuItems 的那一項（反灰就不送出）
  },
  emits: ['close', 'done'],
  setup(props, { emit }) {
    const { ref, reactive, computed, onMounted, onBeforeUnmount } = globalThis.Vue
    const name = props.friend.agent || props.friend.nick
    const text = computed(() => opDialogText(props.op, name, props.friend.device, partnerEngine(props.friend)))
    const form = reactive({ newName: name, note: '' })
    const st = reactive({ phase: 'form', error: '', busy: false, view: null })
    let closed = false
    async function submit() {
      if (st.busy) return
      const err = opFormError(props.friend, props.op, form, props.item)
      if (err) { st.error = err; return }
      st.error = ''; st.busy = true; st.phase = 'progress'
      st.view = progressView(null, { op: props.op })
      const v = await runPartnerOp(props.api, props.friend, props.op, form, { onUpdate: x => { if (!closed) st.view = x }, cancelled: () => closed })
      st.busy = false
      if (v?.phase === 'done') emit('done', { op: props.op, view: v })
    }
    function close() { closed = true; emit('close') }
    onMounted(() => { if (text.value.auto) void submit() })
    onBeforeUnmount(() => { closed = true })
    return { text, form, st, submit, close, name }
  },
  template: `
<asn-dialog :title="text.title" @close="close">
  <template v-if="st.phase === 'form'">
    <p class="launch-notice-body">{{ text.lead }}</p>
    <label class="op-field" v-if="op === 'rename'">新名字
      <input class="set-input" type="text" v-model="form.newName" maxlength="40" aria-label="新名字" @keydown.enter.prevent="submit">
    </label>
    <ul class="model-points" v-if="text.points.length"><li v-for="p in text.points" :key="p">{{ p }}</li></ul>
    <label class="op-field" v-if="op === 'handover'">補充的話（選填，會附在新夥伴的第一句話後面）
      <textarea class="set-area" rows="3" v-model="form.note" maxlength="1000" aria-label="補充的話"></textarea>
    </label>
    <p class="partner-err" v-if="st.error" role="alert">{{ st.error }}</p>
    <div class="partner-actions">
      <button class="aero-btn" type="button" @click="close">取消</button>
      <button class="aero-btn primary" type="button" @click="submit">{{ text.ok }}</button>
    </div>
  </template>
  <template v-else>
    <p class="launch-notice-body" :class="{ 'model-err': st.view && st.view.phase === 'failed' }" role="status">{{ st.view && st.view.text }}</p>
    <ol class="op-steps" v-if="st.view && st.view.steps" aria-label="接班換手的進度">
      <li v-for="s in st.view.steps" :key="s.key" :class="'op-step-' + s.state">{{ s.text }}</li>
    </ol>
    <p class="launch-notice-body" v-for="l in (st.view && st.view.extra) || []" :key="l">{{ l }}</p>
    <dl class="op-rows" v-if="st.view && st.view.rows && st.view.rows.length"><template v-for="r in st.view.rows" :key="r.label"><dt>{{ r.label }}</dt><dd>{{ r.value }}</dd></template></dl>
    <p class="launch-notice-body" v-if="st.view && st.view.rows && !st.view.rows.length">沒有更多資料。</p>
    <div class="partner-actions"><button class="aero-btn" type="button" @click="close">{{ st.view && st.view.done ? '關閉' : '先關掉（照常進行）' }}</button></div>
  </template>
</asn-dialog>`,
}
