// 電腦版「管理夥伴視窗」介面（名單右鍵、對話上方「喚醒」大按鈕共用）：查設定、送出並輪詢進度、各動作的對話框文字，以及對話框元件。
// 判斷全部用 lib/partner-ops.mjs 的 menuItems／buildOpRequest／opFormError／progressView／infoRows，這裡不另寫一套。
// 純繁體中文；不顯示節點代號與夥伴 ID。node 也要能載入（測試），所以 Vue 只在元件 setup 裡才取用。
import { AsnDialog } from './dialog.mjs'
import { machinesByNode } from './mobile-launch.mjs'
import { launchersErrorText } from './launcher-poll.mjs'
import { NO_RECORD_CODE, ACP_NEWCONV_LABEL, ADOPT_ACK, PI_ADOPT_ACK, OP_LABEL, OP_POLL_MS, OP_PROGRESS_TEXT, PI_MODEL_PICK_ERR, PI_MODEL_REMOTE_NOTE, SELF_PULL_LABEL, buildOpRequest, dialogEngine, infoRows, opErrorText, opFormError, piModelChoices, progressView, selfPullPid } from './partner-ops.mjs'
import { cleanPiModels } from './pi-models.mjs'
import { runArchive } from './archive.mjs'
import { clearRun, moveRun, runBanner, runFor, setRun } from './mobile-ops.mjs'
import { switchModelsFor } from './model-catalog.mjs'
import { createModelLoader } from './local-models.mjs'

const errText = e => String(e?.message ?? e ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || '原因不明'
// 寫進 ui.log 的原文要完整，不截斷（開發紀律三之 2）
const rawText = e => String(e?.message ?? e ?? '').trim() || '原因不明'

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
    console.info('[ASN] 夥伴操作送出失敗', op, rawText(e))   // 原文進 log，畫面只講白話
    // 後台在送出時就回 no_session（這位夥伴沒有可接回的對話紀錄）：opErrorText 已寫成白話；#1907 狀態列不放按鈕，所以不再附「開新夥伴」
    const v = failView(opErrorText(e?.message))
    if (String(e?.message ?? '').includes(NO_RECORD_CODE)) v.noRetry = true   // 沒有對話紀錄：再按一次也沒用，狀態列不接重試句
    onUpdate(v); return v
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
    // 後台回報失敗、沒確認、等太久：原文（row.detail）進 log，畫面只講白話
    if (v.done && v.phase !== 'done') console.info('[ASN] 夥伴操作失敗', op, v.phase, rawText(row?.detail ?? row?.status ?? '等太久沒有結果'))
    // 不放畫面的細節（交接檔位置、模型、提醒；#1907）寫進 ui.log，不能無聲吞掉
    if (v.done && v.log?.length) console.info('[ASN] 夥伴操作結果', op, v.log.map(rawText).join('；'))
    onUpdate(v)
    if (v.done) return v
  }
}

// 就地進度要跑的動作：一般夥伴操作走 runPartnerOp，封存／取消封存走 runArchive，兩者都回同一種 view，這樣手機的封存失敗也能「重試」。
// onArchived(r)：封存結果出來時的畫面副作用（重新拉名單、名單上方一行字），由各頁面傳入
export const makeOpRun = ({ onArchived = async () => {}, archive = runArchive } = {}) => async (api, friend, op, input, h = {}) => {
  if (op !== 'archive' && op !== 'unarchive') return runPartnerOp(api, friend, op, input, h)
  const r = await archive(api, friend, op === 'archive')
  if (!r.ok) console.info('[ASN] 封存失敗', op, r.text)
  await onArchived(r)
  const v = { phase: r.ok ? 'done' : 'failed', done: true, text: r.text }
  h.onUpdate?.(v)
  return v
}

// 夥伴操作的「就地進度」（#1800、#1907）：送出後對話框收起，進度與結果只用一行字顯示在狀態列，不放任何按鈕；成功 4 秒、「已送出還沒確認」15 秒後自己消失，
// 失敗留在原位，用白話說發生什麼、後面接「再按一次就會重試」，直到下一個操作（任何夥伴）把它蓋掉；狀態列只有一格。手機與電腦用同一份狀態形狀、同一份文字。
// 滑鼠停在狀態列上、手指按著時：hold(id) 暫停倒數，release(id) 從剩下的時間繼續。
// state＝{ runs }（電腦版傳 reactive 物件）；runs 的形狀與手機相同：{ [夥伴位址]: { op, name, view } }
export function createOpRunner({ api, state, onDone = () => {}, run = runPartnerOp, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = t => clearTimeout(t), now = Date.now } = {}) {
  const reqs = new Map()     // 夥伴位址 → 上一次送出的內容（retry 用）
  const timers = new Map()
  const due = new Map()      // 夥伴位址 → { at: 預定消失的時間, held: 被暫停時剩下的毫秒 }
  const token = new Map()    // 同一位連按時，只認最後一次
  let current = null         // 狀態列只有一格：現在顯示的是哪一位。被蓋掉的那位只是不再顯示，背景照常做完、onDone 照常跑
  const holding = new Set()  // 滑鼠／手指目前停在哪幾列上：新結果蓋掉舊結果時 mouseenter 不會再觸發，要自己記得
  const dropTimer = id => { if (timers.has(id)) { clearTimer(timers.get(id)); timers.delete(id) } due.delete(id) }
  const arm = (id, ms) => {
    if (holding.has(id)) { due.set(id, { at: now() + ms, held: ms }); return }   // 正被停著：直接進入暫停，放開才開始倒數
    due.set(id, { at: now() + ms, held: null }); timers.set(id, setTimer(() => { timers.delete(id); due.delete(id); dismiss(id) }, ms))
  }
  async function start(friend, op, input) {
    const id = friend.id
    for (const other of Object.keys(state.runs ?? {})) if (other !== id) { dropTimer(other); holding.delete(other); state.runs = clearRun(state.runs, other) }   // 任何夥伴的新操作蓋掉上一則（只清畫面，不動 token）
    current = id
    reqs.set(id, { friend, op, input: { ...input } })
    dropTimer(id)
    const mine = (token.get(id) ?? 0) + 1
    token.set(id, mine)
    const name = friend.nick || friend.agent || ''
    const put = view => { if (token.get(id) === mine && current === id) state.runs = setRun(state.runs, id, { op, name, view }) }
    put(progressView(null, { op }))
    const v = await run(api, friend, op, input, { onUpdate: put, cancelled: () => token.get(id) !== mine })
    if (token.get(id) !== mine || !v) return v
    const ms = runBanner({ view: v }).hideMs
    if (ms > 0 && current === id) arm(id, ms)
    if (v.phase === 'done') onDone({ op, view: v, friend, input })
    return v
  }
  function dismiss(id) { holding.delete(id); dropTimer(id); token.set(id, (token.get(id) ?? 0) + 1); state.runs = clearRun(state.runs, id) }
  const retry = id => { const r = reqs.get(id); return r ? start(r.friend, r.op, r.input) : Promise.resolve(null) }
  // 暫停倒數：滑鼠停在狀態列上、手指按著時。沒有在倒數的（進行中、失敗）什麼都不做
  function hold(id) {
    holding.add(id)
    const d = due.get(id)
    if (!d || d.held !== null) return
    clearTimer(timers.get(id)); timers.delete(id)
    due.set(id, { at: d.at, held: Math.max(0, d.at - now()) })
  }
  function release(id) {
    holding.delete(id)
    const d = due.get(id)
    if (!d || d.held === null) return
    arm(id, d.held)
  }
  // 改名成功：進度、重試用的內容、倒數都跟著新位址走（舊位址那格清掉），按住暫停才找得到
  function move(from, to) {
    if (from === to) return
    if (current === from) current = to
    const d = due.get(from), wasHeld = holding.has(from)
    dropTimer(from); holding.delete(from)
    if (reqs.has(from)) { reqs.set(to, reqs.get(from)); reqs.delete(from) }
    if (token.has(from)) { token.set(to, token.get(from)); token.delete(from) }
    state.runs = moveRun(state.runs, from, to)
    if (wasHeld) holding.add(to)
    if (d) arm(to, d.held ?? Math.max(0, d.at - now()))
  }
  return { start, retry, dismiss, hold, release, move, runFor: id => runFor(state.runs, id) }
}

// 狀態列元件（#1907）：夥伴操作的進度與結果，每筆只有一行字，不放任何按鈕、步驟、路徑。不擋畫面、不是對話框；
// 滑鼠停在上面時暫停自動消失的倒數，移開再繼續
export const PartnerOpStrip = {
  name: 'PartnerOpStrip',
  props: { runner: { type: Object, required: true }, runs: { type: Object, required: true }, only: { type: String, default: '' } },
  setup(props) {
    const { computed } = globalThis.Vue
    const items = computed(() => Object.entries(props.runs ?? {}).filter(([id]) => !props.only || id === props.only).map(([id, r]) => ({ id, name: r.name, b: runBanner(r) })).filter(x => x.b))
    return { items, hold: id => props.runner.hold(id), release: id => props.runner.release(id) }
  },
  template: `
<div class="op-strip" v-if="items.length" role="status">
  <div class="op-strip-row" v-for="it in items" :key="it.id" :class="'is-' + it.b.phase" @mouseenter="hold(it.id)" @mouseleave="release(it.id)">
    <span class="op-strip-tx"><b v-if="it.name">{{ it.name }}：</b>{{ it.b.text }}</span>
    <i class="op-strip-bar" v-if="!it.b.done" aria-hidden="true"></i>
  </div>
</div>`,
}

// 各動作的對話框文字（給人看；device＝設備名）。confirm＝要先確認；auto＝不用確認直接送出
/**
 * 哪一家的內建通道工作者，切換模型時要向這台電腦讀清單（#2355）：只有 Gemini（agy）、而且工作者就在這台；Grok 沒有清單（D6）＝手動輸入。
 * 回廠牌代號（給 agent_models）；不用讀回空字串。
 */
export function acpListVendor(friend, { selfNode = '', canRead = true } = {}) {
  if (!canRead || dialogEngine(friend) !== 'acp') return ''
  if (String(friend?.engine ?? '').toLowerCase() !== 'gemini') return ''
  return selfNode && friend?.node === selfNode ? 'gemini' : ''
}

/**
 * 內建通道工作者「切換模型」的清單：list 是向本機讀到的（modelState 的 models，#2355）；沒有（grok、別台、讀不到）＝空陣列＝手動輸入。
 * selected：目前的模型在清單裡就選它，否則第一個。回 { models, selected }
 */
export function acpSwitchChoices(friend, { list = [] } = {}) {
  if (dialogEngine(friend) !== 'acp') return { models: [], selected: '' }
  const models = Array.isArray(list) ? list : []
  const cur = String(friend?.model ?? '')
  return { models, selected: models.some(m => m.id === cur) ? cur : (models[0]?.id ?? '') }
}

export function opDialogText(op, name, device = '', engine = 'claude', { hasList = false } = {}) {
  const where = device ? `在「${device}」上的` : ''
  const title = { info: `${name} 的詳情`, rename: '改名', close: '關閉視窗', handover: '換班接手', resume: '喚醒', restart: '重開', remove: '移除' }[op] ?? OP_LABEL[op] ?? ''
  switch (op) {
    case 'model': if (engine === 'acp') return {
      title, lead: hasList ? `要把「${name}」${where}內建通道的工作者換成哪個模型？` : `要把「${name}」${where}內建通道的工作者換成哪個模型？請輸入模型代號，例如 grok-4.6 或 gemini-3.8-flash-high。`, ok: '切換', auto: false, placeholder: '例如 grok-4.6',
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
    case 'handover': if (engine === 'self_pull') return {
      title: SELF_PULL_LABEL, lead: `要把${where}「${name}」這個 agy 接進收發室嗎？請給它一個名字。`, ok: SELF_PULL_LABEL, auto: false,
      points: ['接進來後，在這個 agy 裡跑 asn-cli 就能用這個名字寄信、收信', '別人寄給它的信不會自動送進去，要它自己收；寄件人會收到「對方要自己收信，可能比較晚看到」', '關掉這個 agy 就不算了，下次開要再接一次'],
    }
    if (engine === 'pi_adopt') return {
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
      points: ['先請它把手上的子代理做完，再把交接寫到一個檔案（最多等 3 小時，做完才往下走，不用再按任何東西；等到上限還沒寫完就不換班，舊視窗不會被自動關掉）', '寫完才關掉它的視窗；真的卡住不想等，可以從選單按「關閉視窗」', '用同一個名字開一個新的，新夥伴會先讀交接檔和前任最後的對話紀錄，接著把工作做下去'],
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
    selfNode: { type: String, default: '' },   // 這台電腦的節點：「接進收發室」只能接自己這台的視窗
    taken: { type: Array, default: () => [] },  // 名單上這台電腦已經用掉的名字（視窗、pi、夥伴紀錄）：「接進收發室」撞名檢查
  },
  emits: ['close', 'done', 'launch-new', 'run'],
  setup(props, { emit }) {
    const { ref, reactive, computed, onMounted, onBeforeUnmount } = globalThis.Vue
    const name = props.friend.agent || props.friend.nick
    // 內建通道（Gemini）的型號清單向這台電腦讀（#2355）；別台的工作者、或沒有清單的（Grok）退回輸入框
    const acpVendor = props.op === 'model' ? acpListVendor(props.friend, { selfNode: props.selfNode, canRead: typeof props.api?.agentModels === 'function' }) : ''
    const acpView = reactive({ models: [], note: '', canRetry: false })
    const acpModels = computed(() => acpView.models)
    const text = computed(() => opDialogText(props.op, name, props.friend.device, dialogEngine(props.friend), { hasList: acpView.models.length > 0 }))
    const form = reactive({ newName: name, note: '', ack: false, model: '' })
    const acpLoader = acpVendor ? createModelLoader({
      fetch: a => props.api.agentModels(a), vendorLabel: v => (v === 'gemini' ? 'Gemini' : v),
      onChange: (_v, view) => {
        Object.assign(acpView, { models: view.models, note: view.note, canRetry: view.canRetry && !view.loading })
        if (view.models.length && !view.models.some(m => m.id === form.model)) form.model = acpSwitchChoices(props.friend, { list: view.models }).selected
      },
    }) : null
    const reloadAcp = () => { if (acpLoader) void acpLoader.load(acpVendor, { force: true }) }
    const st = reactive({ phase: 'form', error: '', busy: false, view: null })
    // pi 切換模型的下拉選單：查得到清單才用（null＝還在查或查不到，畫輸入框）
    const isPiModel = props.op === 'model' && dialogEngine(props.friend) === 'pi'
    const pi = reactive({ groups: null, loading: isPiModel && Boolean(props.piModels) })
    const piNote = computed(() => (isPiModel && !pi.loading && !pi.groups ? PI_MODEL_REMOTE_NOTE : ''))
    async function loadPiModels() {
      try {
        const c = piModelChoices(switchModelsFor('pi', { piModels: cleanPiModels(await props.piModels()) }), props.friend.model)
        if (c.groups.length) { pi.groups = c.groups; form.model = c.selected }
      } catch (e) { console.info('[ASN] 查 pi 模型清單失敗，改用輸入框', e?.message ?? e) }
      pi.loading = false
    }
    let closed = false
    const isSelfPull = props.op === 'handover' && dialogEngine(props.friend) === 'self_pull'
    // 接進收發室：不走後台的管理動作，直接請這台電腦核對程序與名字、寫登記
    async function submitSelfPull() {
      if (props.selfNode && props.friend.node !== props.selfNode) { st.error = '只能在那台電腦的 ASN 上接進收發室'; return }
      const pid = selfPullPid(props.friend)
      const newName = String(form.newName ?? '').trim()
      if (!pid) { st.error = '看不出這個 agy 是哪一個程序，請重新整理名單再試'; return }
      if (!newName) { st.error = '請給它一個名字'; return }
      st.error = ''; st.busy = true
      try {
        const r = await props.api.selfWindowRegister({ pid, name: newName, taken: props.taken.map(String) })
        st.phase = 'progress'
        st.view = { phase: 'done', done: true, text: `已接進收發室，名字是「${r?.name ?? newName}」。在那個 agy 裡跑 asn-cli 就能寄信、收信。` }
        emit('done', { op: props.op, view: st.view })
      } catch (e) { st.error = String(e?.message ?? e) || '接不進來，請稍後再試' }
      st.busy = false
    }
    async function submit() {
      if (st.busy) return
      if (isSelfPull) { await submitSelfPull(); return }
      if (pi.groups && !pi.groups.some(g => g.options.some(o => o.value === form.model))) { st.error = PI_MODEL_PICK_ERR; return }
      if (acpView.models.length && !acpView.models.some(m => m.id === form.model)) { st.error = '請從清單選一個模型'; return }
      const err = opFormError(props.friend, props.op, form, props.item)
      if (err) { st.error = err; return }
      // 查詳情要在這裡把結果列出來；其他動作送出就收起對話框，進度由畫面上的提示列就地顯示（#1800）
      if (props.op !== 'info') { st.error = ''; closed = true; emit('run', { op: props.op, input: { newName: form.newName, model: form.model, note: form.note, ack: form.ack } }); emit('close'); return }
      st.error = ''; st.busy = true; st.phase = 'progress'
      st.view = progressView(null, { op: props.op })
      const v = await runPartnerOp(props.api, props.friend, props.op, form, { onUpdate: x => { if (!closed) st.view = x }, cancelled: () => closed })
      st.busy = false
      if (v?.phase === 'done') emit('done', { op: props.op, view: v, newName: form.newName })
    }
    function close() { closed = true; emit('close') }
    // 喚醒找不到對話紀錄時：關掉這個對話框，請畫面開「開新夥伴」（用原夥伴所在的電腦）
    function launchNew() { closed = true; emit('launch-new', { node: props.friend.node }) }
    onMounted(() => {
      if (isSelfPull) {
        form.newName = ''
        Promise.resolve(props.api.selfWindowDefault?.(props.taken.map(String))).then(n => { if (typeof n === 'string' && !form.newName) form.newName = n }).catch(e => console.info('[ASN] 查預設名字失敗', e?.message ?? e))
      }
      if (text.value.auto) void submit()
      if (pi.loading) void loadPiModels()
      if (acpLoader) void acpLoader.load(acpVendor)
    })
    onBeforeUnmount(() => { closed = true; acpLoader?.reset() })
    return { text, form, st, submit, close, T: OP_PROGRESS_TEXT, launchNew, name, pi, piNote, acpModels, acpView, reloadAcp, isSelfPull }
  },
  template: `
<asn-dialog :title="text.title" @close="close">
  <template v-if="st.phase === 'form'">
    <p class="launch-notice-body">{{ text.lead }}</p>
    <label class="op-field" v-if="isSelfPull">名字
      <input class="set-input" type="text" v-model="form.newName" maxlength="60" aria-label="接進收發室的名字" @keydown.enter.prevent="submit">
    </label>
    <label class="op-field" v-if="op === 'rename'">新名字
      <input class="set-input" type="text" v-model="form.newName" maxlength="40" aria-label="新名字" @keydown.enter.prevent="submit">
    </label>
    <label class="op-field" v-if="op === 'model' && acpView.models.length">模型
      <select class="set-sel" v-model="form.model" aria-label="模型">
        <option v-for="m in acpModels" :key="m.id" :value="m.id">{{ m.label }}</option>
      </select>
    </label>
    <label class="op-field" v-else-if="op === 'model' && pi.groups">模型
      <select class="set-sel" v-model="form.model" aria-label="模型">
        <optgroup v-for="g in pi.groups" :key="g.provider" :label="g.provider"><option v-for="o in g.options" :key="o.value" :value="o.value">{{ o.label }}</option></optgroup>
      </select>
    </label>
    <p class="launch-notice-body" v-else-if="op === 'model' && pi.loading">正在查這台 pi 能用的模型…</p>
    <label class="op-field" v-else-if="op === 'model'">模型
      <input class="set-input" type="text" v-model="form.model" maxlength="101" autocomplete="off" autocapitalize="off" spellcheck="false" :placeholder="text.placeholder || '例如 anthropic/claude-sonnet-5'" aria-label="模型" @keydown.enter.prevent="submit">
    </label>
    <small class="partner-hint" v-if="piNote">{{ piNote }}</small>
    <small class="partner-hint" v-if="op === 'model' && acpView.note" role="status" aria-label="型號清單狀況">{{ acpView.note }}
      <button type="button" class="aero-btn" v-if="acpView.canRetry" @click="reloadAcp">重新讀取</button></small>
    <ul class="model-points" v-if="text.points.length"><li v-for="p in text.points" :key="p">{{ p }}</li></ul>
    <label class="op-field" v-if="text.ack"><input type="checkbox" v-model="form.ack" aria-label="確認接手前要先關掉終端機"> {{ text.ack }}</label>
    <label class="op-field" v-if="op === 'handover' && !text.ack && !isSelfPull">補充的話（選填，會附在新夥伴的第一句話後面）
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
    <div class="partner-actions">
      <button class="aero-btn primary" type="button" v-if="st.view && st.view.action && st.view.action.kind === 'launch-new'" @click="launchNew">{{ T.launchNew }}</button>
      <button class="aero-btn primary" type="button" v-if="st.view && st.view.phase === 'failed'" @click="submit">{{ T.retry }}</button>
      <button class="aero-btn" type="button" @click="close">{{ T.close }}</button>
    </div>
  </template>
</asn-dialog>`,
}
