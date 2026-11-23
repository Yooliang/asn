// 這台讀額度與查詢代碼（todo-next-193；#2111 ④ 起讀額度的開關在「設備 → 這台」）。設定頁的狀態與動作；純邏輯，node 測試可直接載入。
// MiniMax key 只經過這裡交給 Rust 存進憑證管理員，不留在狀態裡，也不進設定頁快照。
// 查詢代碼只在開的當下回一次：放在狀態裡顯示，使用者關掉或換一筆就清掉，之後讀不回來。

import { quotaShareErrorText } from './plain-errors.mjs'
import { makeQuotaReadersApi } from './tauri.mjs'

export const QUOTA_TEXT = {
  title: '這台讀額度',
  accountsTitle: '帳號',
  grok: '讀 Grok 額度',
  grokNote: '用這台電腦的 Grok 登入讀取。',
  agy: '讀 Gemini 額度',
  agyShort: '要開著 Gemini 視窗才會更新。',
  extra: '讀 Claude 額外帳號',
  extraShort: '讀另外登入的帳號，平常的登入不動。',
  extraDirs: n => `找到 ${n} 個帳號。`,
  refreshOn: '打開自動換新',
  refreshConfirm: '確認打開',
  refreshOff: '關閉自動換新',
  refreshActive: '自動換新已打開。',
  refreshNote: '額外帳號的登入約 8 小時到期。打開後，快到期時會自動換新。',
  refreshWarn: '同一個帳號只能有一個程式在換新，否則會被登出；其他程式在換的話，請先停掉再打開。',
  refreshRisk: '這是非公開的登入方式，可能隨時失效，也可能不符合服務條款；失效時要重新登入。',
  refreshStopped: '換新失敗就不會再試，請重新登入該帳號，或關閉後再打開。',
  minimax: 'MiniMax',
  minimaxNote: 'key 只存在這台電腦，存好後不會再顯示。最多 2 個帳號。',
  minimaxUnsupported: '只能在 Windows 電腦設定。',
  minimaxOpen: '加入帳號',
  minimaxCount: n => `已存 ${n} 個帳號。`,
  minimaxEmail: '帳號 email',
  minimaxKey: 'key',
  minimaxAdd: '加入',
  minimaxRemove: '移除',
  minimaxConfirmRemove: '確認移除',
  minimaxNoKey: '找不到 key，請移除後重新加入',
  // 長說明收進可展開的「說明」
  more: '說明',
  share: '產生查詢代碼',
  shareAgain: '重新產生查詢代碼',   // 帳號卡「⋯」選單的項目（動作說法，#2111 ⑥）
  shareConfirmAgain: '重新產生查詢代碼',   // 原位確認的同意鈕
  shareCancel: '取消',
  shareRevoke: '撤銷代碼',
  shareConfirmRevoke: '撤銷代碼',
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
  revoked: '已撤銷，這組代碼不能再查了。',
}

const EMPTY = { grok: false, agy: false, minimax: [], minimaxSupported: false, status: { grok: '', agy: '' }, extra: false, extraRefresh: false, extraDirs: [] }

/** Rust 回的設定 → 畫面資料。形狀不對就當全關，不會顯示成已開。 */
export function normalizeReaders(v) {
  if (!v || typeof v !== 'object') return { ...EMPTY }
  const failures = v.status && typeof v.status === 'object' ? v.status : {}
  const text = x => (typeof x === 'string' ? x : '')
  const failOf = email => (failures.minimax && typeof failures.minimax === 'object' ? text(failures.minimax[email]) : '')
  return {
    grok: v.grok === true,
    agy: v.agy === true,
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

/**
 * 帳號頁的引導句（#2111 ④）：這台沒開額度上報時，帳號卡改寫這一句，指到開關所在的「設備 → 這台」。
 * 目前只有 Grok 有可開的讀取開關（Gemini 的開關先藏起來，所以不指路）；沒開才有句子，開了回空字串。
 */
export const QUOTA_GUIDE_VENDORS = { grok: 'Grok' }
export const quotaGuide = name => `還沒開啟額度上報。到『設備 → 這台』打開『讀 ${name} 額度』，這裡就會顯示額度。`
export function quotaGuideFor(vendor, readers) {
  const name = QUOTA_GUIDE_VENDORS[vendor]
  if (!name || !readers) return ''
  return readers[vendor] === true ? '' : quotaGuide(name)
}

/**
 * 設定 → 帳號 要畫哪些服務區段。my＝帳號清單（可能還沒有）；readers＝額度讀取器。
 * 有帳號的服務照原本的順序；Grok 沒開額度上報時就算還沒有帳號，也補一個空區段，引導句才有地方寫。
 */
export function vendorSections(my, readers) {
  const out = [...(my?.vendors ?? [])]
  for (const key of Object.keys(QUOTA_GUIDE_VENDORS)) {
    if (quotaGuideFor(key, readers) && !out.some(v => v.key === key)) out.push({ key, label: QUOTA_GUIDE_VENDORS[key], accounts: [] })
  }
  return out
}

/** 帳號卡「⋯」選單的項目（電腦；手機沒有查詢代碼功能所以不放）：沒有代碼＝產生；已有代碼＝重新產生＋撤銷（撤銷用危險色）。刪除帳號走另一頁的既有流程，不放在這裡 */
export const accountMenuItems = shared => (shared === true
  ? [{ key: 'share', label: QUOTA_TEXT.shareAgain }, { key: 'unshare', label: QUOTA_TEXT.shareRevoke, danger: true }]
  : [{ key: 'share', label: QUOTA_TEXT.share }])

/** 這張卡正在等原位確認的是哪一個動作（重新產生／撤銷）：null＝沒有；yes 鈕與警語都從這裡來 */
export function shareConfirmOf(confirm, key) {
  if (confirm === `again\n${key}`) return { op: 'quota-share', text: QUOTA_TEXT.shareAgainWarn, yes: QUOTA_TEXT.shareConfirmAgain, danger: false }
  if (confirm === `revoke\n${key}`) return { op: 'quota-unshare', text: QUOTA_TEXT.shareRevokeWarn, yes: QUOTA_TEXT.shareConfirmRevoke, danger: true }
  return null
}

export function createQuotaReaders({ invoke, reactive = x => x, onShareChanged = () => {}, clipboard = t => globalThis.navigator.clipboard.writeText(t), log = (...a) => console.info(...a) }) {
  const api = makeQuotaReadersApi(invoke)   // 指令名與參數形狀都在 lib/tauri.mjs 的出口（#2106 ⑬）
  // msg＝讀額度設定（開關、MiniMax、自動換新）的訊息，只在「設備 → 這台 → 這台讀額度」顯示；
  // shareMsg＝查詢代碼（產生、撤銷、複製）的訊息 { key, text }，顯示在帳號頁那張帳號卡上。兩邊各寫各的，不共用一個欄位
  const s = reactive({ ...EMPTY, busy: false, msg: '', shareMsg: null, code: null, copied: false, confirm: '' })
  const apply = v => { Object.assign(s, normalizeReaders(v)) }
  const fail = (text, e) => { s.msg = text; log('[額度來源]', typeof e === 'string' ? e : e?.message ?? String(e)) }
  // 查詢代碼的失敗：白話寫在那張帳號卡上（shareMsg），原文進 log
  const shareFailed = (key, text, e) => { s.shareMsg = { key, text }; log('[額度來源]', typeof e === 'string' ? e : e?.message ?? String(e)) }
  const run = async (failText, work) => {
    if (s.busy) return false
    s.busy = true; s.msg = ''
    try { await work(); return true } catch (e) { fail(failText, e); return false } finally { s.busy = false }
  }
  const load = async () => { try { apply(await api.get()) } catch (e) { log('[額度來源]', e) } }
  const setSource = (source, on) => run(QUOTA_TEXT.failGeneric, async () => apply(await api.set(source, on === true)))
  const addMinimax = async ({ email, key } = {}) => {
    const mail = String(email ?? '').trim()
    const k = String(key ?? '').trim()
    if (!mail || !k) { s.msg = QUOTA_TEXT.failInput; return false }
    if (s.minimax.length >= 2 && !s.minimax.some(m => m.email === mail.toLowerCase())) { s.msg = QUOTA_TEXT.failFull; return false }
    const ok = await run(QUOTA_TEXT.failGeneric, async () => apply(await api.minimaxAdd(mail, k)))
    if (ok) s.msg = QUOTA_TEXT.added
    return ok
  }
  // 按兩次才生效的動作（移除、重新產生、撤銷）：第一次只把按鈕變成確認
  const confirmed = id => { if (s.confirm === id) { s.confirm = ''; return true } s.confirm = id; s.msg = ''; s.shareMsg = null; return false }
  const removeMinimax = async email => {
    if (!confirmed(`minimax\n${email}`)) return false
    const ok = await run(QUOTA_TEXT.failGeneric, async () => apply(await api.minimaxRemove(email)))
    if (ok) s.msg = QUOTA_TEXT.removed
    return ok
  }
  // 打開自動換新要按兩次；關閉不用
  const setRefresh = async on => {
    if (on === true && !confirmed('refresh')) return false
    s.confirm = ''
    return setSource('extra_claude_refresh', on === true)
  }
  const shareFail = e => quotaShareErrorText(e, QUOTA_TEXT)
  const share = async ({ vendor, account, shared } = {}) => {
    if (shared && !confirmed(`again\n${shareKey(vendor, account)}`)) return false
    s.code = null; s.copied = false
    if (s.busy) return false
    const key = shareKey(vendor, account)
    s.busy = true; s.msg = ''; s.shareMsg = null
    try {
      const r = await api.shareCreate(vendor, account)
      if (typeof r?.code !== 'string' || !r.code) throw new Error('沒有回傳代碼')
      s.code = { key: shareKey(vendor, account), value: r.code }
      onShareChanged()
      return true
    } catch (e) { shareFailed(key, shareFail(e), e); return false } finally { s.busy = false }
  }
  const unshare = async ({ vendor, account } = {}) => {
    if (!confirmed(`revoke\n${shareKey(vendor, account)}`)) return false
    if (s.busy) return false
    const key = shareKey(vendor, account)
    s.busy = true; s.msg = ''; s.shareMsg = null
    try {
      await api.shareRevoke(vendor, account)
      if (s.code?.key === key) s.code = null
      s.shareMsg = { key, text: QUOTA_TEXT.revoked }
      onShareChanged()
      return true
    } catch (e) { shareFailed(key, shareFail(e), e); return false } finally { s.busy = false }
  }
  const copyCode = async () => {
    if (!s.code) return
    try { await clipboard(s.code.value); s.copied = true } catch (e) { shareFailed(s.code.key, QUOTA_TEXT.copyFail, e) }
  }
  const cancelConfirm = () => { s.confirm = '' }
  const closeCode = () => { s.code = null; s.copied = false }
  return { state: s, load, setSource, setRefresh, addMinimax, removeMinimax, share, unshare, copyCode, closeCode, cancelConfirm }
}

/** 設定頁快照：沒有 key，只有帳號與有沒有存。 */
export function quotaReadersView(s) {
  return {
    grok: s.grok, agy: s.agy, minimax: s.minimax, minimaxSupported: s.minimaxSupported, status: s.status,
    extra: s.extra, extraRefresh: s.extraRefresh, extraDirs: s.extraDirs,
    busy: s.busy, msg: s.msg, shareMsg: s.shareMsg, code: s.code, copied: s.copied, confirm: s.confirm,
  }
}
