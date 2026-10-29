// 電腦版「管理夥伴視窗」介面（名單右鍵、對話上方「喚醒」大按鈕共用）：查設定、送出並輪詢進度、各動作的對話框文字，以及對話框元件。
// 判斷全部用 lib/partner-ops.mjs 的 menuItems／buildOpRequest／opFormError／progressView／infoRows，這裡不另寫一套。
// 純繁體中文；不顯示節點代號與夥伴 ID。node 也要能載入（測試），所以 Vue 只在元件 setup 裡才取用。
import { AsnDialog } from './dialog.mjs'
import { machinesByNode } from './mobile-launch.mjs'
import { launchersErrorText } from './launcher-poll.mjs'
import { ACP_NEWCONV_LABEL, ADOPT_ACK, PI_ADOPT_ACK, OP_LABEL, OP_POLL_MS, PI_MODEL_PICK_ERR, PI_MODEL_REMOTE_NOTE, buildOpRequest, dialogEngine, infoRows, opErrorText, opFormError, piModelChoices, progressView } from './partner-ops.mjs'
import { cleanPiModels } from './pi-models.mjs'

const errText = e => String(e?.message ?? e ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || '原因不明'

// 查「能不能管理」要用的設定：有沒有登入、各台電腦在線與否與開放與否。查不到的一律當沒查到（loaded:false → 反灰並說明）
export async function loadOpsContext(api) {
  const out = { machines: {}, loaded: false, signedIn: null, checking: false, authError: '', loadError: '' }
  // 查詢失敗不能當成「沒登入」：登入狀態維持未知（null），並記下真正的原因
  try {
    const st = await api.authStatus?.()
    if (st && typeof st.signed_in === 'boolean') out.signedIn = st.signed_in
    else out.authError = '沒有收到回應'
  } catch (e) { out.authError = errText(e) }
  // 查不到的原因只寫使用者能做什麼（#380：不在畫面秀「HTTP 403」）；原文進 console
  try { out.machines = machinesByNode(await api.launchers()); out.loaded = true } catch (e) { console.info('[ASN] 查電腦設定失敗', errText(e)); out.loadError = launchersErrorText(e) }
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
    if (op === 'info' && row?.status === 'ok') v.rows = infoRows(row.result, friend)
    onUpdate(v)
    if (v.done) return v
  }
}

// 各動作的對話框文字（給人看；device＝設備名）。confirm＝要先確認；auto＝不用確認直接送出
export function opDialogText(op, name, device = '', engine = 'claude') {
  const where = device ? `在「${device}」上的` : ''
  const title = { info: `${name} 的詳情`, rename: '改名', close: '關閉視窗', handover: '換班接手', resume: '喚醒', restart: '重開', remove: '移除' }[op] ?? OP_LABEL[op] ?? ''
  switch (op) {
    case 'model': if (engine === 'acp') return {
      title, lead: `要把「${name}」${where}內建通道的工作者換成哪個模型？請輸入模型代號，例如 grok-4.6 或 gemini-3.8-flash-high。`, ok: '切換', auto: false, placeholder: '例如 grok-4.6',
      points: ['只能選這個工作者列得出來的模型；不在清單裡會被拒絕，並列出可以選的', 'Grok 直接換，不會重開；Gemini 會帶同一段對話短暫重開（幾秒）', '工作者正在處理信件時不能換，等它做完再試', '選好的會記下來，重開 ASN 也照新的模型'],
    }
    return {
      title, lead: `要把「${name}」${where}視窗的模型換成哪一個？可以只寫模型，或寫「提供者/模型」，例如 anthropic/claude-sonnet-5。`, ok: '切換', auto: false,
      points: ['只換這個視窗目前用的模型，視窗不會關，對話保留', 'pi 正在工作時會先排隊，做完這一輪就換'],
    }
    case 'rename': return {
      title, lead: `要把「${name}」改成什麼名字？名字只能用英數、連字號、中文，1～40 字，不能以連字號開頭。`, ok: '改名', auto: false,
      points: engine === 'pi' ? ['視窗不會關，對話保留；pi 重開、接回同一段對話後名字還在', 'pi 正在工作時會先排隊，做完這一輪就改', '要新版的 pi ASN 擴充；舊的會請你先更新']
        : engine === 'acp' ? ['對話保留，工作者會短暫重開（幾秒）', '寄給舊名字的信，7 天內會轉給新名字', '正在處理信件時不能改，等它做完再試', '寫在這台電腦 agents.json 裡的工作者不能從這裡改名，要到電腦上改設定檔'] : [],
    }
    case 'close': if (engine === 'acp') return { title: '關閉', lead: `要關閉「${name}」${where}內建通道的工作者嗎？會結束它的程序，這次不再收信，名單上暫時看不到；不會改設定檔，重啟 ASN 後會恢復。`, points: [], ok: '關閉', auto: false }
      return { title, lead: `關掉「${name}」${where}視窗？對話記錄會留著。`, points: [], ok: '關閉視窗', auto: false }
    case 'remove': return {
      title, lead: `要移除「${name}」${where}內建通道的工作者嗎？`, ok: '移除', auto: false, danger: true,
      points: ['會結束它的程序，從名單和 ASN 的名冊刪掉，重開 ASN 也不會回來', '它的對話會清掉，記下的模型也一起刪掉', '工作資料夾裡的檔案留著，不會刪', '寫在這台電腦 agents.json 裡的工作者不能從這裡移除，要到電腦上改設定檔'],
    }
    case 'restart': return { title, lead: `要重開「${name}」${where}內建通道的工作者嗎？會先結束它的程序，再由 ASN 重新啟動，對話會保留。`, points: [], ok: '重開', auto: false }
    case 'handover': if (engine === 'pi_adopt') return {
      title: '接手', lead: `要讓 ASN 接手${where}「${name}」這個 pi 的對話嗎？之後可以從名單收信、改名、切換模型。`, ok: '接手', auto: false, ack: PI_ADOPT_ACK, danger: true,
      points: ['會先關掉原本的 pi（終端機留著），再用同一段對話開一個由 ASN 管理的 pi。原本的 pi 如果正在回覆，這一輪會中斷', 'ASN 會找出這個 pi 正在用的那一段對話；找不到或不只一段就不會接手，什麼都不關', '剛開還沒講過話的 pi 找不到對話，請先在 pi 裡講一句再試', '新的 pi 名字是「pi-資料夾名」，接手後可以再改名', '如果新的沒開起來，對話檔還在，結果會附上手動接回的指令'],
    }
    if (engine === 'adopt') return {
      title: '接手', lead: `要讓 ASN 的 Grok 工作者接手${where}「${name}」的對話嗎？`, ok: '接手', auto: false, ack: ADOPT_ACK,
      points: ['ASN 會找出這個 grok 正在用的那一段對話，找不到或不只一段就不會接手，並告訴你原因', '另外開一個專屬的 Grok 工作者載入同一段對話，之後寄給它的信會接在這段對話後面，回覆照一般工作者寄回', '接手後請先關掉終端機那個 grok，兩邊同時用同一段對話可能互相覆蓋', 'ASN 不會替你關掉終端機裡的 grok'],
    }
    return engine === 'acp' ? {
      title: ACP_NEWCONV_LABEL, lead: `要替「${name}」${where}內建通道的工作者開新對話嗎？`, ok: ACP_NEWCONV_LABEL, auto: false,
      points: ['清掉目前的對話，結束它的程序，由 ASN 重新啟動；它不會記得之前聊過的內容', '這類夥伴不會請前任寫交接，所以新對話會帶入收發室替它記的往來記錄當前情（最近的一段）', '第一句會是接班說明，請它先向寄件人確認進度', '對話壞掉、一直報錯時可以用這個救回來'],
    } : {
      title, lead: `要讓「${name}」${where}視窗換班接手嗎？`, ok: '開始換手', auto: false,
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
    // 這台電腦自己的 pi 模型清單（async () => pi_models 的回應）。只有這個 pi 視窗在本機時才給；沒給＝退回輸入框（#443）
    piModels: { type: Function, default: null },
  },
  emits: ['close', 'done'],
  setup(props, { emit }) {
    const { ref, reactive, computed, onMounted, onBeforeUnmount } = globalThis.Vue
    const name = props.friend.agent || props.friend.nick
    const text = computed(() => opDialogText(props.op, name, props.friend.device, dialogEngine(props.friend)))
    const form = reactive({ newName: name, note: '', ack: false, model: '' })
    const st = reactive({ phase: 'form', error: '', busy: false, view: null })
    // pi 切換模型的下拉選單：查得到清單才用（null＝還在查或查不到，畫輸入框）
    const isPiModel = props.op === 'model' && dialogEngine(props.friend) === 'pi'
    const pi = reactive({ groups: null, loading: isPiModel && Boolean(props.piModels) })
    const piNote = computed(() => (isPiModel && !pi.loading && !pi.groups ? PI_MODEL_REMOTE_NOTE : ''))
    async function loadPiModels() {
      try {
        const c = piModelChoices(cleanPiModels(await props.piModels()), props.friend.model)
        if (c.groups.length) { pi.groups = c.groups; form.model = c.selected }
      } catch (e) { console.info('[ASN] 查 pi 模型清單失敗，改用輸入框', e?.message ?? e) }
      pi.loading = false
    }
    let closed = false
    async function submit() {
      if (st.busy) return
      if (pi.groups && !pi.groups.some(g => g.options.some(o => o.value === form.model))) { st.error = PI_MODEL_PICK_ERR; return }
      const err = opFormError(props.friend, props.op, form, props.item)
      if (err) { st.error = err; return }
      st.error = ''; st.busy = true; st.phase = 'progress'
      st.view = progressView(null, { op: props.op })
      const v = await runPartnerOp(props.api, props.friend, props.op, form, { onUpdate: x => { if (!closed) st.view = x }, cancelled: () => closed })
      st.busy = false
      if (v?.phase === 'done') emit('done', { op: props.op, view: v })
    }
    function close() { closed = true; emit('close') }
    onMounted(() => {
      if (text.value.auto) void submit()
      if (pi.loading) void loadPiModels()
    })
    onBeforeUnmount(() => { closed = true })
    return { text, form, st, submit, close, name, pi, piNote }
  },
  template: `
<asn-dialog :title="text.title" @close="close">
  <template v-if="st.phase === 'form'">
    <p class="launch-notice-body">{{ text.lead }}</p>
    <label class="op-field" v-if="op === 'rename'">新名字
      <input class="set-input" type="text" v-model="form.newName" maxlength="40" aria-label="新名字" @keydown.enter.prevent="submit">
    </label>
    <label class="op-field" v-if="op === 'model' && pi.groups">模型
      <select class="set-sel" v-model="form.model" aria-label="模型">
        <optgroup v-for="g in pi.groups" :key="g.provider" :label="g.provider"><option v-for="o in g.options" :key="o.value" :value="o.value">{{ o.label }}</option></optgroup>
      </select>
    </label>
    <p class="launch-notice-body" v-else-if="op === 'model' && pi.loading">正在查這台 pi 能用的模型…</p>
    <label class="op-field" v-else-if="op === 'model'">模型
      <input class="set-input" type="text" v-model="form.model" maxlength="101" autocomplete="off" autocapitalize="off" spellcheck="false" :placeholder="text.placeholder || '例如 anthropic/claude-sonnet-5'" aria-label="模型" @keydown.enter.prevent="submit">
    </label>
    <small class="partner-hint" v-if="piNote">{{ piNote }}</small>
    <ul class="model-points" v-if="text.points.length"><li v-for="p in text.points" :key="p">{{ p }}</li></ul>
    <label class="op-field" v-if="text.ack"><input type="checkbox" v-model="form.ack" aria-label="確認接手前要先關掉終端機"> {{ text.ack }}</label>
    <label class="op-field" v-if="op === 'handover' && !text.ack">補充的話（選填，會附在新夥伴的第一句話後面）
      <textarea class="set-area" rows="3" v-model="form.note" maxlength="1000" aria-label="補充的話"></textarea>
    </label>
    <p class="partner-err" v-if="st.error" role="alert">{{ st.error }}</p>
    <div class="partner-actions">
      <button class="aero-btn" type="button" @click="close">取消</button>
      <button class="aero-btn" :class="text.danger ? 'danger' : 'primary'" type="button" @click="submit">{{ text.ok }}</button>
    </div>
  </template>
  <template v-else>
    <p class="launch-notice-body" :class="{ 'model-err': st.view && st.view.phase === 'failed' }" role="status">{{ st.view && st.view.text }}</p>
    <ol class="op-steps" v-if="st.view && st.view.steps" aria-label="換班接手的進度">
      <li v-for="s in st.view.steps" :key="s.key" :class="'op-step-' + s.state">{{ s.text }}</li>
    </ol>
    <p class="launch-notice-body" v-for="l in (st.view && st.view.extra) || []" :key="l">{{ l }}</p>
    <dl class="op-rows" v-if="st.view && st.view.rows && st.view.rows.length"><template v-for="r in st.view.rows" :key="r.label"><dt>{{ r.label }}</dt><dd>{{ r.value }}</dd></template></dl>
    <p class="launch-notice-body" v-if="st.view && st.view.rows && !st.view.rows.length">沒有更多資料。</p>
    <div class="partner-actions"><button class="aero-btn" type="button" @click="close">{{ st.view && st.view.done ? '關閉' : '先關掉（照常進行）' }}</button></div>
  </template>
</asn-dialog>`,
}
