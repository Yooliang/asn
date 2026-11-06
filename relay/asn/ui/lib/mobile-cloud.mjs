// 手機版「雲端代理」（#756、todo-next-199）：把雲端代理加進好友名單——輸入名字、取得只顯示一次的金鑰與要貼給代理的說明、
// 看到「已上線」、已加入的清單、移除、輸入短碼核准無畫面主機。流程與電腦版（lib/cloud-invite.mjs）相同，後台指令也是同一組
// （cloud_agent_create／list／revoke／approve，用登入憑證，憑證只在 Rust 端；沒登入就不能用），手機沒有多拿任何權限。
// 沒有「重發金鑰」：電腦版也沒有，金鑰弄丟就移除後重新邀請（真正的重發排在 todo-next-200，兩個平台一起做）。
// 金鑰規矩：只存在這個物件的記憶體，按「完成」、離開這一頁都會丟掉；不寫 localStorage、不寫檔、不進任何記錄。
// 剪貼簿：複製金鑰後 60 秒清掉（頁面還在前景時）；按「完成」、離開這一頁、回到前景發現已經過了 60 秒也清。
// 讀剪貼簿在 WebView 會跳權限詢問，所以不讀：一律直接清成空白（本人 60 秒內又複製了別的，也會被清掉）。
// 這個檔在 node 也要能載入（測試）：Vue、剪貼簿、計時器都由呼叫端傳進來。
import { COPY_NOTE, DEFAULT_NAME, INVITE_NOTE, POLL_MS, cleanName, joined, rowsFromList } from './cloud-invite.mjs'

export { COPY_NOTE, INVITE_NOTE, DEFAULT_NAME, POLL_MS }
export const CLIP_CLEAR_MS = 60_000
// 金鑰還在畫面上時，這一頁切走後最多保留多久（一般內頁是 3 分鐘）：複製金鑰常要切去別的 App 或分頁；超過才丟並明講
export const CLOUD_KEY_KEEP_MS = 30 * 60_000
// 金鑰還在畫面上時要離開（含系統返回鍵）：先問一次，因為金鑰只顯示一次、不能重發
export const CLOUD_LEAVE_TEXT = { title: '金鑰還在畫面上', lead: '離開後就看不到這把金鑰，也不能重發，只能撤銷後重新邀請。要離開嗎？', leave: '離開', stay: '留下' }

export const CLOUD_TEXT = {
  title: '雲端代理',
  sub: '讓跑在雲端的 AI 代理加入好友名單',
  needLogin: '請先在「個人」登入，才能邀請雲端代理。',
  invite: '邀請雲端代理',
  nameLabel: '代理的名字',
  nameHint: '這會顯示在好友名單上，例如 小真。',
  nameBad: '請輸入代理的名字（1 到 40 個字）',
  create: '建立',
  cancel: '取消',
  created: name => `已建立「${name}」`,
  step1: '第一步：把金鑰設到代理的平台',
  step2: '第二步：把說明貼給代理',
  step3: '第三步：等代理上線',
  show: '顯示', hide: '隱藏',
  copyKey: '複製金鑰', copiedKey: '已複製金鑰',
  copyInvite: '複製給代理的說明', copiedInvite: '已複製說明',
  copyFail: '複製沒有成功，請手動選取後複製',
  waiting: '等待中…代理照說明做完、連上來後，這裡會顯示已加入。',
  joined: name => `「${name}」已加入。`,
  done: '完成（關掉後看不到金鑰）',
  clipNote: '複製金鑰後 60 秒會嘗試自動清掉剪貼簿（不保證清得掉）：貼完請回到這裡，才清得掉；清掉的是剪貼簿裡當時的內容，中間複製了別的也會被清。',
  clipCleared: '已清掉剪貼簿。',
  keyExpired: '金鑰已超過時間丟棄，請撤銷後重新邀請。',
  keyDropped: '離開了這一頁，金鑰已丟棄。還沒貼給代理的話，請撤銷後重新邀請。',
  clipFail: '沒能清掉剪貼簿，金鑰可能還在裡面。請複製別的內容蓋掉。',
  empty: '還沒有邀請過雲端代理。',
  revoke: '撤銷', revokeSure: '確認撤銷',
  revokeNote: '撤銷後，這個代理的金鑰立刻失效，好友名單上也會消失。',
  revoked: '已撤銷，這個代理的金鑰立刻失效。',
  rename: '改名', renameSave: '儲存', renamed: '已改名。',
  renameNote: '只改設備名，代理底下 bot 的名字不會變。',
  renameNeed: '請輸入設備名（1 到 40 個字）',
  lostKey: '金鑰弄丟了：把這個代理撤銷，再重新邀請一次。',
  approveBtn: '輸入短碼核准主機',
  approveTitle: '核准無畫面主機',
  approveCode: '主機上顯示的短碼',
  approveName: '主機的名字',
  approveId: '節點代號（可留空，系統自動取）',
  approveGo: '核准',
  approveNeedName: '請輸入這台主機的名字（1 到 40 個字）',
  approveNeedCode: '請輸入主機上顯示的短碼',
  approved: (name, id) => `已核准「${name}」（${id}），主機會自動拿到金鑰，不用再貼任何東西。`,
  loading: '讀取中…',
}

const errText = e => String(e?.message ?? e ?? '').trim() || '沒有成功，請再試一次'

/**
 * deps：
 *   api       { list, create, revoke, rename, approve }（cloudApi）
 *   status    () → { signed_in }（authApi.status）
 *   clip      { write(text) }（navigator.clipboard 的包裝；不讀剪貼簿）
 *   now       () → 毫秒
 *   timer     { set(fn, ms) → id, clear(id) }
 *   reactive  讓畫面追蹤狀態（測試傳 o => o）
 */
export function createMobileCloud({ api, status, clip, now = () => Date.now(), timer = { set: setTimeout, clear: clearTimeout }, reactive = o => o }) {
  const s = reactive({
    signedIn: null,        // null＝還沒問到
    rows: [], loading: false, busy: false, msg: '',
    stage: 'list',         // list｜form｜created
    name: DEFAULT_NAME,
    approveForm: false, code: '', hostName: '', hostId: '', approved: '',
    created: null,         // { id, name, key, invite } —— 只在記憶體，按「完成」就丟
    reveal: false, copiedKey: false, copiedInvite: false, clipNote: '',
    confirmId: '',
    renameId: '', renameName: '',
  })
  let clearTimerId = null, copiedAt = 0, copiedKeyText = ''
  let loadMsg = ''   // 最近一次讀取失敗留在畫面上的提示（輪詢成功後要消掉，不能一直掛著）
  let confirmedNext = false   // 下一次 leave 是本人在「要離開嗎」按了離開
  let expireNext = false   // 下一次 leave 是因為保留時間到了（要明講金鑰丟了）
  let epoch = 0   // 離開這一頁就加一：建立途中離開，回來的金鑰不保留（見 create）

  const stopClearTimer = () => { if (clearTimerId != null) { timer.clear(clearTimerId); clearTimerId = null } }

  // 清剪貼簿：不讀（讀會跳權限詢問），直接寫成空白。清不掉不能沒聲音：畫面提醒用別的內容蓋掉，並保留狀態，下次回到前景再試一次（計時器觸發的寫入不是使用者手勢，WebView 可能拒絕）
  async function clearClipboard() {
    stopClearTimer()
    if (!copiedKeyText) return
    try {
      await clip.write('')
      copiedKeyText = ''; copiedAt = 0
      s.clipNote = CLOUD_TEXT.clipCleared
    } catch { s.clipNote = CLOUD_TEXT.clipFail }
  }

  async function load() {
    s.loading = true
    try {
      const st = await status()
      s.signedIn = st?.signed_in === true
      s.rows = s.signedIn ? rowsFromList(await api.list(), now()) : []
      if (loadMsg && s.msg === loadMsg) s.msg = ''   // 上一輪讀取失敗的提示，這一輪讀成功了就消掉
      loadMsg = ''
    } catch (e) { s.msg = loadMsg = errText(e) } finally { s.loading = false }
  }

  const openForm = () => { s.msg = ''; s.stage = 'form'; s.name = DEFAULT_NAME }
  const cancelForm = () => { if (s.stage === 'form') s.stage = 'list' }

  async function create() {
    if (s.busy || s.stage !== 'form') return
    const n = cleanName(s.name)
    if (!n) { s.msg = CLOUD_TEXT.nameBad; return }
    s.busy = true; s.msg = ''
    const my = epoch
    try {
      const c = await api.create(n)
      if (my !== epoch) { s.msg = CLOUD_TEXT.lostKey; await load(); return }   // 建立途中離開了：代理已建好但金鑰不保留，撤銷後重來
      s.created = { id: c.id, name: c.name, key: c.key, invite: c.invite }
      s.stage = 'created'; s.reveal = false; s.copiedKey = false; s.copiedInvite = false; s.clipNote = ''
      await load()
    } catch (e) { s.msg = errText(e) } finally { s.busy = false }
  }

  async function copyKey() {
    if (!s.created?.key) return
    try {
      await clip.write(s.created.key)
      s.copiedKey = true; s.clipNote = ''
      copiedKeyText = s.created.key; copiedAt = now()
      stopClearTimer()
      clearTimerId = timer.set(() => { void clearClipboard() }, CLIP_CLEAR_MS)
    } catch { s.msg = CLOUD_TEXT.copyFail }
  }
  async function copyInvite() {
    if (!s.created?.invite) return
    try { await clip.write(s.created.invite); s.copiedInvite = true } catch { s.msg = CLOUD_TEXT.copyFail }
  }

  // 回到前景：複製金鑰之後已經過了 60 秒（計時器在背景可能沒跑）就清
  const onVisible = () => { if (copiedKeyText && now() - copiedAt >= CLIP_CLEAR_MS) void clearClipboard() }

  async function done() {
    s.created = null; s.reveal = false; s.copiedKey = false; s.copiedInvite = false; s.stage = 'list'
    await clearClipboard()
    if (copiedKeyText) s.msg = CLOUD_TEXT.clipFail   // 這時已離開金鑰畫面：清不掉的提示改放在清單頁
  }
  const markExpired = () => { if (s.created) expireNext = true }
  const confirmLeave = () => { if (s.created) confirmedNext = true }
  // 離開這一頁：金鑰、表單全丟，剪貼簿也清
  async function leave() {
    epoch++
    const hadKey = !!s.created
    s.created = null; s.reveal = false; s.copiedKey = false; s.copiedInvite = false; s.stage = 'list'
    s.confirmId = ''; s.renameId = ''; s.renameName = ''; s.msg = ''; s.approveForm = false; s.code = ''; s.hostName = ''; s.hostId = ''; s.approved = ''
    const expired = expireNext, confirmed = confirmedNext
    expireNext = false; confirmedNext = false
    await clearClipboard()
    // 清除之後才寫提示（上面清掉了舊提示）：保留時間到了＝明講金鑰丟了；清不掉＝提醒用別的內容蓋掉
    const parts = []
    if (expired && hadKey) parts.push(CLOUD_TEXT.keyExpired)
    else if (hadKey && !confirmed) parts.push(CLOUD_TEXT.keyDropped)   // 沒經過確認就丟掉的金鑰（任何沒有先問的離開路徑）一律明講
    if (copiedKeyText) parts.push(CLOUD_TEXT.clipFail)
    if (parts.length) s.msg = parts.join('')
  }

  async function revoke(id) {
    if (s.busy) return
    if (s.confirmId !== id) { s.confirmId = id; return }
    s.busy = true; s.msg = ''
    try {
      await api.revoke(id)
      if (s.created?.id === id) await done()
      s.confirmId = ''; s.msg = CLOUD_TEXT.revoked
      await load()
    } catch (e) { s.msg = errText(e) } finally { s.busy = false }
  }
  const openRename = id => { const r = s.rows.find(x => x.id === id); s.msg = ''; s.renameId = id; s.renameName = r?.name ?? '' }
  const cancelRename = () => { s.renameId = ''; s.renameName = '' }
  async function rename() {
    if (s.busy || !s.renameId) return
    const n = cleanName(s.renameName)
    if (!n) { s.msg = CLOUD_TEXT.renameNeed; return }
    s.busy = true; s.msg = ''
    try {
      await api.rename(s.renameId, n)
      s.renameId = ''; s.renameName = ''; s.msg = CLOUD_TEXT.renamed
      await load()
    } catch (e) { s.msg = errText(e) } finally { s.busy = false }
  }
  // 核准無畫面主機：主機上跑 asn-bridge login 會印出短碼；這裡輸入短碼、替主機取名。金鑰不經過這裡（主機自己輪詢拿）
  async function approve() {
    if (s.busy) return
    const n = cleanName(s.hostName)
    if (!n) { s.msg = CLOUD_TEXT.approveNeedName; return }
    if (!String(s.code).trim()) { s.msg = CLOUD_TEXT.approveNeedCode; return }
    s.busy = true; s.msg = ''; s.approved = ''
    try {
      const r = await api.approve(s.code, n, String(s.hostId).trim())
      s.approved = CLOUD_TEXT.approved(r?.name || n, r?.id || '')
      s.approveForm = false; s.code = ''; s.hostName = ''; s.hostId = ''
    } catch (e) { s.msg = errText(e) } finally { s.busy = false }
  }
  const openApprove = () => { s.msg = ''; s.approved = ''; s.approveForm = true }
  const cancelApprove = () => { s.approveForm = false }

  const justJoined = () => !!s.created && joined(s.rows, s.created.id)
  return { state: s, markExpired, confirmLeave, load, openForm, cancelForm, create, copyKey, copyInvite, onVisible, done, leave, revoke, openRename, cancelRename, rename, approve, openApprove, cancelApprove, justJoined, clearClipboard }
}
