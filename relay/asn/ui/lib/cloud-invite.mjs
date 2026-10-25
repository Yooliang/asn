// 設定頁「帳號」分類裡的「雲端代理」區塊：邀請雲端代理、已加入的清單、撤銷。
// 自己呼叫 Rust 指令（登入憑證在 Rust 端；不經名單樞紐的設定快照），整合模式與分離視窗共用。
// 這個檔在 node 也要能載入（測試），所以 Vue 與 Tauri 只在元件 setup 裡才取用。
//
// 金鑰規矩：新金鑰只存在這個元件的記憶體（created.key），只顯示一次——按「完成」、換到別的設定分類、關掉視窗都會丟掉；
// 不寫 localStorage、不寫檔、不送進任何記錄。給代理的說明（created.invite）不含金鑰，可以放心貼給代理。
import { authApi, cloudApi } from './tauri.mjs'

export const DEFAULT_NAME = '雲端代理'
export const POLL_MS = 20000
export const KEY_ENV = 'ASN_RELAY_KEY'

// 名稱：去前後空白，1～40 字、不含控制字元；不合格回 ''
export function cleanName(raw) {
  const s = String(raw ?? '').trim()
  const n = [...s].length
  return n >= 1 && n <= 40 && !/[\u0000-\u001f\u007f-\u009f]/.test(s) ? s : ''
}

// 「多久以前」：未滿 1 分鐘、N 分鐘、N 小時、N 天
export function agoText(iso, now = Date.now()) {
  const t = Date.parse(iso ?? '')
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return '不到 1 分鐘前'
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`
  return `${Math.floor(s / 86400)} 天前`
}

// 清單的一列：從來沒上線過＝等代理上線；3 分鐘內有呼叫＝在線；其餘＝離線（最後上線時間）
export function rowView(n, now = Date.now()) {
  const name = typeof n?.name === 'string' && n.name ? n.name : DEFAULT_NAME
  if (!n?.last_seen_at) return { id: n?.id ?? '', name, state: 'waiting', status: '等代理上線', title: '代理還沒有用金鑰連上來' }
  if (n.online === true) return { id: n.id, name, state: 'online', status: '在線', title: '' }
  const ago = agoText(n.last_seen_at, now)
  return { id: n.id, name, state: 'offline', status: ago ? `離線，最後上線：${ago}` : '離線', title: '' }
}

// 後台回應 → 清單（格式不對的列丟掉）
export function rowsFromList(res, now = Date.now()) {
  return (Array.isArray(res?.nodes) ? res.nodes : []).filter(n => n && typeof n.id === 'string' && n.id).map(n => rowView(n, now))
}

// 剛建立的代理：清單裡已經有人用金鑰連上來了＝「已加入」
export const joined = (rows, id) => rows.some(r => r.id === id && r.state !== 'waiting')

export const COPY_NOTE = '金鑰只會顯示這一次，關掉就再也看不到。請貼到代理平台的「秘密環境變數」，名稱是 ' + KEY_ENV + '，不要貼進聊天。'
export const INVITE_NOTE = '這段說明沒有金鑰，只有公開資訊，可以直接貼給代理。'

export const CloudInvitePanel = {
  setup() {
    const { ref, computed, onMounted, onUnmounted } = globalThis.Vue
    const signedIn = ref(null)          // null＝還沒問到
    const rows = ref([]), busy = ref(false), msg = ref('')
    const form = ref(false), name = ref(DEFAULT_NAME)
    const created = ref(null)            // { id, name, key, invite } —— 只在記憶體，按「完成」就丟
    const reveal = ref(false), copiedKey = ref(false), copiedInvite = ref(false)
    const confirmId = ref('')
    let timer = null
    const errText = e => String(e?.message ?? e ?? '').trim() || '沒有成功，請再試一次'
    const refresh = async () => {
      try {
        const st = await authApi.status()
        signedIn.value = st?.signed_in === true
        rows.value = signedIn.value ? rowsFromList(await cloudApi.list()) : []
      } catch (e) { if (signedIn.value) msg.value = errText(e) }
    }
    const create = async () => {
      if (busy.value) return
      const n = cleanName(name.value)
      if (!n) { msg.value = '請輸入代理的名字（1 到 40 個字）'; return }
      busy.value = true; msg.value = ''
      try {
        created.value = await cloudApi.create(n)
        form.value = false; reveal.value = false; copiedKey.value = false; copiedInvite.value = false
        await refresh()
      } catch (e) { msg.value = errText(e) } finally { busy.value = false }
    }
    const copy = async (text, flag) => {
      try { await navigator.clipboard.writeText(text); flag.value = true } catch { msg.value = '複製沒有成功，請手動選取後複製' }
    }
    const copyKey = () => { if (created.value?.key) copy(created.value.key, copiedKey) }
    const copyInvite = () => { if (created.value?.invite) copy(created.value.invite, copiedInvite) }
    const done = () => { created.value = null; reveal.value = false; copiedKey.value = false; copiedInvite.value = false }
    const revoke = async id => {
      if (busy.value) return
      if (confirmId.value !== id) { confirmId.value = id; return }
      busy.value = true; msg.value = ''
      try {
        await cloudApi.revoke(id)
        if (created.value?.id === id) done()
        confirmId.value = ''
        msg.value = '已撤銷，這個代理的金鑰立刻失效。'
        await refresh()
      } catch (e) { msg.value = errText(e) } finally { busy.value = false }
    }
    // 核准無畫面主機：主機上跑 asn-bridge login 會印出短碼；這裡輸入短碼、替主機取名。金鑰不經過這裡（主機自己輪詢拿）
    const approveForm = ref(false), code = ref(''), hostName = ref(''), hostId = ref(''), approved = ref('')
    const approve = async () => {
      if (busy.value) return
      const n = cleanName(hostName.value)
      if (!n) { msg.value = '請輸入這台主機的名字（1 到 40 個字）'; return }
      if (!code.value.trim()) { msg.value = '請輸入主機上顯示的短碼'; return }
      busy.value = true; msg.value = ''; approved.value = ''
      try {
        const r = await cloudApi.approve(code.value, n, hostId.value.trim())
        approved.value = '已核准「' + (r?.name || n) + '」（' + (r?.id || '') + '），主機會自動拿到金鑰，不用再貼任何東西。'
        approveForm.value = false; code.value = ''; hostName.value = ''; hostId.value = ''
      } catch (e) { msg.value = errText(e) } finally { busy.value = false }
    }
    const justJoined = computed(() => !!created.value && joined(rows.value, created.value.id))
    onMounted(() => { refresh(); timer = setInterval(refresh, POLL_MS) })
    onUnmounted(() => { clearInterval(timer); created.value = null })
    return { signedIn, rows, busy, msg, form, name, created, reveal, copiedKey, copiedInvite, confirmId, justJoined, COPY_NOTE, INVITE_NOTE, create, copyKey, copyInvite, done, revoke, approveForm, code, hostName, hostId, approved, approve }
  },
  template: `<section class="set-card cloud-set" aria-label="雲端代理">
      <header class="vendor-h"><b>雲端代理</b><small>讓跑在雲端的 AI 代理加入 ASN</small></header>
      <small v-if="signedIn === false">請先在上面的「登入狀態」登入，才能邀請雲端代理。</small>
      <template v-else>
        <div v-if="created" class="cloud-created">
          <b>已建立「{{ created.name }}」</b>
          <p class="cloud-step">第一步：把金鑰設到代理的平台</p>
          <div class="cloud-key">
            <input class="set-code" readonly :type="reveal ? 'text' : 'password'" :value="created.key" aria-label="金鑰" autocomplete="off" spellcheck="false">
            <button class="aero-btn" type="button" @click="reveal = !reveal">{{ reveal ? '隱藏' : '顯示' }}</button>
            <button class="aero-btn" type="button" @click="copyKey">{{ copiedKey ? '已複製金鑰' : '複製金鑰' }}</button>
          </div>
          <small>{{ COPY_NOTE }}</small>
          <p class="cloud-step">第二步：把說明貼給代理</p>
          <div class="av-btns"><button class="aero-btn" type="button" @click="copyInvite">{{ copiedInvite ? '已複製說明' : '複製給代理的說明' }}</button></div>
          <small>{{ INVITE_NOTE }}</small>
          <p class="cloud-step">第三步：等代理上線</p>
          <small role="status">{{ justJoined ? '「' + created.name + '」已加入。' : '等待中…代理照說明做完、連上來後，這裡會顯示已加入。' }}</small>
          <div class="av-btns"><button class="aero-btn" type="button" @click="done">完成（關掉後看不到金鑰）</button></div>
        </div>
        <div v-else-if="form" class="cloud-form">
          <label>代理的名字
            <input class="set-sel" type="text" v-model="name" maxlength="40" aria-label="代理的名字" @keydown.enter.prevent="create">
          </label>
          <small>這會顯示在好友名單上，例如 小真。</small>
          <div class="av-btns">
            <button class="aero-btn" type="button" :disabled="busy" @click="create">建立</button>
            <button class="aero-btn" type="button" :disabled="busy" @click="form = false">取消</button>
          </div>
        </div>
        <div v-else class="av-btns"><button class="aero-btn" type="button" :disabled="busy" @click="form = true">邀請雲端代理</button></div>
        <div v-if="approveForm" class="cloud-form">
          <label>主機上顯示的短碼
            <input class="set-sel" type="text" v-model="code" maxlength="12" placeholder="ABCD-2345" aria-label="短碼" autocomplete="off" spellcheck="false" @keydown.enter.prevent="approve">
          </label>
          <label>主機的名字
            <input class="set-sel" type="text" v-model="hostName" maxlength="40" aria-label="主機的名字" @keydown.enter.prevent="approve">
          </label>
          <label>節點代號（可留空，系統自動取）
            <input class="set-sel" type="text" v-model="hostId" maxlength="32" aria-label="節點代號" autocomplete="off" spellcheck="false" @keydown.enter.prevent="approve">
          </label>
          <div class="av-btns">
            <button class="aero-btn" type="button" :disabled="busy" @click="approve">核准</button>
            <button class="aero-btn" type="button" :disabled="busy" @click="approveForm = false">取消</button>
          </div>
        </div>
        <div v-else class="av-btns"><button class="aero-btn" type="button" :disabled="busy" @click="approveForm = true; approved = ''">輸入短碼核准主機</button></div>
        <small v-if="approved" role="status">{{ approved }}</small>
        <ul class="acct-list" v-if="rows.length" aria-label="已加入的雲端代理">
          <li v-for="r in rows" :key="r.id">
            <span class="acct-txt"><span class="acct-name">{{ r.name }}<em v-if="r.state === 'online'">在線</em></span><small :title="r.title">{{ r.status }}</small></span>
            <button class="aero-btn" type="button" :disabled="busy" @click="revoke(r.id)">{{ confirmId === r.id ? '確認撤銷' : '撤銷' }}</button>
          </li>
        </ul>
        <small v-else-if="signedIn">還沒有邀請過雲端代理。</small>
        <small v-if="confirmId">撤銷後，這個代理的金鑰立刻失效，好友名單上也會消失。</small>
        <small role="status">{{ msg }}</small>
      </template>
    </section>`,
}
