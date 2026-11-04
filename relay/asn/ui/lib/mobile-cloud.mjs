// 手機版「雲端代理」（#756、todo-next-199）：把雲端代理加進好友名單——輸入名字、取得只顯示一次的金鑰與要貼給代理的說明、
// 看到「已上線」、已加入的清單、重發金鑰、移除。流程與電腦版（lib/cloud-invite.mjs）相同，後台指令也是同一組
// （cloud_agent_create／list／revoke，用登入憑證，憑證只在 Rust 端；沒登入就不能用），手機沒有多拿任何權限。
// 金鑰規矩：只存在這個物件的記憶體，按「完成」、離開這一頁都會丟掉；不寫 localStorage、不寫檔、不進任何記錄。
// 剪貼簿：複製金鑰後 60 秒清掉（頁面還在前景時）；按「完成」、離開這一頁、回到前景發現已經過了 60 秒也清。
// 這個檔在 node 也要能載入（測試）：Vue、剪貼簿、計時器都由呼叫端傳進來。
import { COPY_NOTE, DEFAULT_NAME, INVITE_NOTE, POLL_MS, cleanName, joined, rowsFromList } from './cloud-invite.mjs'

export { COPY_NOTE, INVITE_NOTE, DEFAULT_NAME, POLL_MS }
export const CLIP_CLEAR_MS = 60_000

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
  clipNote: '複製金鑰後 60 秒會自動清掉剪貼簿（要留在這個畫面）。',
  clipCleared: '已清掉剪貼簿。',
  empty: '還沒有邀請過雲端代理。',
  revoke: '撤銷', revokeSure: '確認撤銷',
  revokeNote: '撤銷後，這個代理的金鑰立刻失效，好友名單上也會消失。',
  revoked: '已撤銷，這個代理的金鑰立刻失效。',
  reissue: '重發金鑰',
  reissueNote: '會建立一個同名的新代理（新金鑰），舊的先留著；新的接上後再按「撤銷舊的」。',
  revokeOld: '撤銷舊的',
  revokeOldSure: '確認撤銷舊的',
  revokeOldNote: '舊的代理金鑰會立刻失效。確認新的已經接上再撤銷。',
  loading: '讀取中…',
}

const errText = e => String(e?.message ?? e ?? '').trim() || '沒有成功，請再試一次'

/**
 * deps：
 *   api       { list, create, revoke }（cloudApi）
 *   status    () → { signed_in }（authApi.status）
 *   clip      { write(text), read() }（navigator.clipboard 的包裝；read 讀不到可以丟錯）
 *   now       () → 毫秒
 *   timer     { set(fn, ms) → id, clear(id) }
 *   reactive  讓畫面追蹤狀態（測試傳 o => o）
 */
export function createMobileCloud({ api, status, clip, now = () => Date.now(), timer = { set: setTimeout, clear: clearTimeout }, reactive = o => o }) {
  const s = reactive({
    signedIn: null,        // null＝還沒問到
    rows: [], loading: false, busy: false, msg: '',
    stage: 'list',         // list｜form｜created
    name: DEFAULT_NAME, reissueOf: '',
    created: null,         // { id, name, key, invite, reissueOf } —— 只在記憶體，按「完成」就丟
    reveal: false, copiedKey: false, copiedInvite: false, clipNote: '',
    confirmId: '', confirmOld: false,
  })
  let clearTimerId = null, copiedAt = 0, copiedKeyText = ''

  const stopClearTimer = () => { if (clearTimerId != null) { timer.clear(clearTimerId); clearTimerId = null } }

  // 清剪貼簿：能讀到內容而且已經不是我們複製的金鑰（本人又複製了別的），就不去動它；讀不到（沒有權限）就清
  async function clearClipboard() {
    stopClearTimer()
    if (!copiedKeyText) return
    const mine = copiedKeyText
    copiedKeyText = ''; copiedAt = 0
    try {
      let cur = null
      try { cur = await clip.read() } catch { cur = null }
      if (cur != null && cur !== mine) return
      await clip.write('')
      s.clipNote = CLOUD_TEXT.clipCleared
    } catch { /* 清不掉就算了：畫面上已經寫明要留在這個畫面 */ }
  }

  async function load() {
    s.loading = true
    try {
      const st = await status()
      s.signedIn = st?.signed_in === true
      s.rows = s.signedIn ? rowsFromList(await api.list(), now()) : []
    } catch (e) { if (s.signedIn) s.msg = errText(e) } finally { s.loading = false }
  }

  const openForm = (reissueOf = '') => {
    s.msg = ''; s.stage = 'form'; s.reissueOf = reissueOf
    s.name = (reissueOf && s.rows.find(r => r.id === reissueOf)?.name) || DEFAULT_NAME
  }
  const cancelForm = () => { if (s.stage === 'form') { s.stage = 'list'; s.reissueOf = '' } }

  async function create() {
    if (s.busy || s.stage !== 'form') return
    const n = cleanName(s.name)
    if (!n) { s.msg = CLOUD_TEXT.nameBad; return }
    s.busy = true; s.msg = ''
    try {
      const c = await api.create(n)
      s.created = { id: c.id, name: c.name, key: c.key, invite: c.invite, reissueOf: s.reissueOf }
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
    s.created = null; s.reveal = false; s.copiedKey = false; s.copiedInvite = false; s.stage = 'list'; s.reissueOf = ''; s.confirmOld = false
    await clearClipboard()
  }
  // 離開這一頁：金鑰、表單全丟，剪貼簿也清
  async function leave() {
    s.created = null; s.reveal = false; s.copiedKey = false; s.copiedInvite = false; s.stage = 'list'; s.reissueOf = ''
    s.confirmId = ''; s.confirmOld = false; s.msg = ''
    await clearClipboard()
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
  // 重發金鑰：先建一個同名的新代理（新金鑰只顯示一次），舊的先留著；新的接上、本人按「撤銷舊的」才撤銷舊的，不會中途把代理弄丟
  const reissue = id => { if (!s.busy && s.stage === 'list') openForm(id) }
  async function revokeOld() {
    const old = s.created?.reissueOf
    if (!old || s.busy) return
    if (!s.confirmOld) { s.confirmOld = true; return }
    s.busy = true; s.msg = ''
    try {
      await api.revoke(old)
      s.created.reissueOf = ''; s.confirmOld = false; s.msg = CLOUD_TEXT.revoked
      await load()
    } catch (e) { s.msg = errText(e) } finally { s.busy = false }
  }

  const justJoined = () => !!s.created && joined(s.rows, s.created.id)
  return { state: s, load, openForm, cancelForm, create, copyKey, copyInvite, onVisible, done, leave, revoke, reissue, revokeOld, justJoined, clearClipboard }
}
