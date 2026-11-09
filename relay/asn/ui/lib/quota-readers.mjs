// 額度來源與查詢代碼（todo-next-193）。設定頁的狀態與動作；純邏輯，node 測試可直接載入。
// MiniMax key 只經過這裡交給 Rust 存進憑證管理員，不留在狀態裡，也不進設定頁快照。
// 查詢代碼只在開的當下回一次：放在狀態裡顯示，使用者關掉或換一筆就清掉，之後讀不回來。

export const QUOTA_TEXT = {
  title: '額度來源',
  note: '都是關的。打開後，這台電腦每 10 分鐘讀一次額度，只把數字送出去。',
  grok: '讀 Grok 額度',
  grokNote: '用這台電腦的 Grok 登入讀取。',
  agy: '讀 Gemini 額度',
  agyNote: '不用開 Gemini 視窗也能更新。帳號依上次開視窗判斷；在別處切換帳號後，請開一次 Gemini 視窗。',
  agyShort: '不用開 Gemini 視窗也能更新。',
  agyAccount: a => `目前算在 ${a} 名下。`,
  agyNoAccount: '還沒開過 Gemini 視窗，開一次才知道是哪個帳號。',
  extra: '讀 Claude 額外帳號',
  extraNote: '讀你另外登入在專用資料夾的帳號，平常使用的登入不會動到。',
  extraShort: '讀另外登入的帳號，平常的登入不動。',
  extraDirs: n => `找到 ${n} 個帳號。`,
  refreshOn: '打開自動換新',
  refreshConfirm: '確認打開',
  refreshOff: '關閉自動換新',
  refreshActive: '自動換新已打開。',
  refreshNote: '額外帳號的登入約 8 小時到期。打開後，快到期時會自動換新。',
  refreshWarn: '同一個帳號只能有一個程式在換新，否則會被登出。如果還有其他程式在換，請先停掉再打開。',
  refreshRisk: '這項使用非公開的登入方式，可能隨時失效，也可能不符合服務條款；失效時會顯示要重新登入。',
  refreshStopped: '換新失敗就不會再試，請重新登入該帳號，或關閉後再打開。',
  minimax: 'MiniMax',
  minimaxNote: 'key 只存在這台電腦，存好後不會再顯示。最多 2 個帳號。',
  minimaxUnsupported: 'MiniMax 目前只有 Windows 電腦能設定。',
  minimaxEmail: '帳號 email',
  minimaxKey: 'key',
  minimaxAdd: '加入',
  minimaxRemove: '移除',
  minimaxConfirmRemove: '確認移除',
  minimaxNoKey: '找不到 key，請移除後重新加入',
  // 開關搬進各服務區段後（設定 → 帳號）：每個開關只管這台電腦；長說明收進可展開的「說明」
  thisPc: '只影響這台電腦。',
  more: '說明',
  share: '產生查詢代碼',
  shareAgain: '重新產生',
  shareConfirmAgain: '確認重新產生',
  shareRevoke: '撤銷代碼',
  shareConfirmRevoke: '確認撤銷',
  shareOn: '開放查詢',
  shareAgainWarn: '舊代碼會立刻失效，用舊代碼的服務要換新的。',
  shareRevokeWarn: '撤銷後，用這組代碼的服務就查不到了。',
  codeTitle: '查詢代碼',
  codeOnce: '只顯示這一次，請先複製。遺失了只能重新產生，舊的會失效。拿到代碼的人可以查這個帳號的額度數字，查不到 email。',
  copy: '複製',
  copied: '已複製',
  copyFail: '複製沒有成功，請手動選取後複製',
  close: '我存好了',
  added: '已加入，下一分鐘內開始讀取。',
  removed: '已移除。',
  failGeneric: '沒有成功，請稍後再試。',
  failInput: '請確認 email 與 key 都填了。',
  failFull: '最多 2 個帳號，請先移除一個。',
  failShare: '現在無法變更查詢代碼，請稍後再試。',
  failLogin: '要先登入才能變更查詢代碼。',
}

const EMPTY = { grok: false, agy: false, agyAccount: '', minimax: [], minimaxSupported: false, status: { grok: '', agy: '' }, extra: false, extraRefresh: false, extraDirs: [] }

/** Rust 回的設定 → 畫面資料。形狀不對就當全關，不會顯示成已開。 */
export function normalizeReaders(v) {
  if (!v || typeof v !== 'object') return { ...EMPTY }
  const failures = v.status && typeof v.status === 'object' ? v.status : {}
  const text = x => (typeof x === 'string' ? x : '')
  const failOf = email => (failures.minimax && typeof failures.minimax === 'object' ? text(failures.minimax[email]) : '')
  return {
    grok: v.grok === true,
    agy: v.agy === true,
    agyAccount: text(v.agy_account),
    minimaxSupported: v.minimax_supported === true,
    minimax: (Array.isArray(v.minimax) ? v.minimax : [])
      .filter(m => m && typeof m.email === 'string')
      .map(m => ({ email: m.email, hasKey: m.has_key === true, status: failOf(m.email) })),
    status: { grok: text(failures.grok), agy: text(failures.agy) },
    extra: v.extra_claude === true,
    extraRefresh: v.extra_claude === true && v.extra_claude_refresh === true,
    extraDirs: (Array.isArray(v.extra_claude_dirs) ? v.extra_claude_dirs : []).filter(d => d && typeof d.name === 'string').map(d => ({ name: d.name, status: text(d.status) })),
  }
}

export const shareKey = (vendor, account) => `${vendor}\n${account}`

/** 額度開關所在的服務（區段鍵與名稱）：還沒有帳號也要有區段，開關才有地方放 */
const TOGGLE_VENDORS = [['claude', 'Claude'], ['gemini', 'Gemini'], ['grok', 'Grok'], ['minimax', 'MiniMax']]

/**
 * 設定 → 帳號 要畫哪些服務區段。my＝帳號清單（可能還沒有）；readers＝額度來源；hook＝Claude 狀態列額度（還沒查到是 null）。
 * 有帳號的服務照原本的順序；額度開關所在的服務就算還沒有帳號，也補一個空區段（只有標題列的開關與說明）。
 */
export function vendorSections(my, readers, hook) {
  const out = [...(my?.vendors ?? [])]
  const need = new Set()
  if (readers) for (const k of ['gemini', 'grok', 'minimax']) need.add(k)
  if (hook || (readers?.extraDirs ?? []).length) need.add('claude')
  for (const [key, label] of TOGGLE_VENDORS) {
    if (need.has(key) && !out.some(v => v.key === key)) out.push({ key, label, accounts: [] })
  }
  return out
}

export function createQuotaReaders({ invoke, reactive = x => x, onShareChanged = () => {}, clipboard = t => globalThis.navigator.clipboard.writeText(t), log = (...a) => console.info(...a) }) {
  const s = reactive({ ...EMPTY, busy: false, msg: '', code: null, copied: false, confirm: '' })
  const apply = v => { Object.assign(s, normalizeReaders(v)) }
  const fail = (text, e) => { s.msg = text; log('[額度來源]', typeof e === 'string' ? e : e?.message ?? String(e)) }
  const run = async (failText, work) => {
    if (s.busy) return false
    s.busy = true; s.msg = ''
    try { await work(); return true } catch (e) { fail(failText, e); return false } finally { s.busy = false }
  }
  const load = async () => { try { apply(await invoke('quota_readers_get')) } catch (e) { log('[額度來源]', e) } }
  const setSource = (source, on) => run(QUOTA_TEXT.failGeneric, async () => apply(await invoke('quota_readers_set', { source, on: on === true })))
  const addMinimax = async ({ email, key } = {}) => {
    const mail = String(email ?? '').trim()
    const k = String(key ?? '').trim()
    if (!mail || !k) { s.msg = QUOTA_TEXT.failInput; return false }
    if (s.minimax.length >= 2 && !s.minimax.some(m => m.email === mail.toLowerCase())) { s.msg = QUOTA_TEXT.failFull; return false }
    const ok = await run(QUOTA_TEXT.failGeneric, async () => apply(await invoke('quota_minimax_add', { email: mail, key: k })))
    if (ok) s.msg = QUOTA_TEXT.added
    return ok
  }
  // 按兩次才生效的動作（移除、重新產生、撤銷）：第一次只把按鈕變成確認
  const confirmed = id => { if (s.confirm === id) { s.confirm = ''; return true } s.confirm = id; s.msg = ''; return false }
  const removeMinimax = async email => {
    if (!confirmed(`minimax\n${email}`)) return false
    const ok = await run(QUOTA_TEXT.failGeneric, async () => apply(await invoke('quota_minimax_remove', { email })))
    if (ok) s.msg = QUOTA_TEXT.removed
    return ok
  }
  // 打開自動換新要按兩次；關閉不用
  const setRefresh = async on => {
    if (on === true && !confirmed('refresh')) return false
    s.confirm = ''
    return setSource('extra_claude_refresh', on === true)
  }
  const shareFail = e => (/尚未登入/.test(typeof e === 'string' ? e : e?.message ?? '') ? QUOTA_TEXT.failLogin : QUOTA_TEXT.failShare)
  const share = async ({ vendor, account, shared } = {}) => {
    if (shared && !confirmed(`again\n${shareKey(vendor, account)}`)) return false
    s.code = null; s.copied = false
    if (s.busy) return false
    s.busy = true; s.msg = ''
    try {
      const r = await invoke('quota_share_create', { vendor, account })
      if (typeof r?.code !== 'string' || !r.code) throw new Error('沒有回傳代碼')
      s.code = { key: shareKey(vendor, account), value: r.code }
      onShareChanged()
      return true
    } catch (e) { fail(shareFail(e), e); return false } finally { s.busy = false }
  }
  const unshare = async ({ vendor, account } = {}) => {
    if (!confirmed(`revoke\n${shareKey(vendor, account)}`)) return false
    if (s.busy) return false
    s.busy = true; s.msg = ''
    try {
      await invoke('quota_share_revoke', { vendor, account })
      if (s.code?.key === shareKey(vendor, account)) s.code = null
      onShareChanged()
      return true
    } catch (e) { fail(shareFail(e), e); return false } finally { s.busy = false }
  }
  const copyCode = async () => {
    if (!s.code) return
    try { await clipboard(s.code.value); s.copied = true } catch (e) { fail(QUOTA_TEXT.copyFail, e) }
  }
  const closeCode = () => { s.code = null; s.copied = false }
  return { state: s, load, setSource, setRefresh, addMinimax, removeMinimax, share, unshare, copyCode, closeCode }
}

/** 設定頁快照：沒有 key，只有帳號與有沒有存。 */
export function quotaReadersView(s) {
  return {
    grok: s.grok, agy: s.agy, agyAccount: s.agyAccount, minimax: s.minimax, minimaxSupported: s.minimaxSupported, status: s.status,
    extra: s.extra, extraRefresh: s.extraRefresh, extraDirs: s.extraDirs,
    busy: s.busy, msg: s.msg, code: s.code, copied: s.copied, confirm: s.confirm,
  }
}
