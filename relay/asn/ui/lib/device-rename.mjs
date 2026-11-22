// 設備名稱的改法（電腦版、手機版共用，#1803）：全 repo 只有「設備頁改名」這一條路改設備名稱——
// 名字存在後台（relay.nodes.name），本機視窗名由 Rust 在改名成功後跟著換，不再有第二個輸入欄、第二個存檔。
// 這個檔案只放「怎麼叫 Rust」與改名後怎麼就地更新畫面，純函式／注入 invoke，node 與瀏覽器都能跑。
import { applyRename } from './rename.mjs'
import { displayDeviceName } from './device-known.mjs'
import { makeDeviceNameApi, renameCommandOf } from './tauri.mjs'
export { renameCommandOf }   // 命令名的對照放在出口（tauri.mjs），這裡照舊匯出

/** 啟動對齊後要對使用者說的話（本機名字被換成後台那一份時） */
export const alignNote = name => `這台的名字已統一為設備頁設定的「${name}」，要改請到設備頁。`

/** 名字在後台已經改好、但這台的寄信名字被規則擋下沒換成：說原因、說結果、說怎麼辦（不能靜默） */
export const windowRenameFailedNote = (name, reason) => `名字已在設備頁改成「${name}」，但這台寄信時用的名字沒有換成功：${reason}。別台設備看到的是新名字；要讓寄信的名字也一致，請改用別的名字再試一次。`

/** 啟動對齊時想換成後台的名字、卻被本機規則擋下 */
export const alignFailedNote = (name, reason) => `設備頁設定的名字是「${name}」，但這台寄信時用的名字沒有換成功：${reason}。請到設備頁改用別的名字。`

/** 首次引導時連不上後台：名字先存在本機，連上後自動套用 */
export const PENDING_NOTE = '目前連不上後台，名字先存在這台，連上後會自動套用。'
export const PENDING_KEY = 'pendingDeviceName'
/** 存待送名字當下，這台的本機名字（＝後台當時記的名字）。補送時後台名字和它不同，就是之後有人改過名（#1839） */
export const PENDING_BASE_KEY = 'pendingDeviceNameBase'

/** 設備頁改名成功後清掉本機待送的名字，補送就不會把新名字蓋回舊的（#1839，第一道）。清不掉只記 log，不影響改名結果 */
export async function clearPendingDeviceName(store, log = console.info) {
  if (!store) return false
  try {
    const saved = (await store.load()) ?? {}
    if (!(PENDING_KEY in saved) && !(PENDING_BASE_KEY in saved)) return false
    const { [PENDING_KEY]: _a, [PENDING_BASE_KEY]: _b, ...rest } = saved
    await store.save(rest)
    return true
  } catch (e) { log('[ASN] 清掉待送的設備名沒成功', String(e?.message ?? e ?? '')); return false }
}

/** 替任一台設備改名；成功回 Rust 的結果（{ ok, name, changed, self_renamed?, window_name?, window_rename_failed? }），失敗丟 Error（訊息是給人看的中文） */
export async function renameDevice(invoke, { node, name, phone = false }) {
  try {
    return await makeDeviceNameApi(invoke).rename(phone, node, String(name ?? '').trim())
  } catch (e) {
    throw new Error(String(e?.message ?? e ?? '') || '改名沒有成功，請稍後再試')
  }
}

/** 設備頁改名的入口（電腦、手機共用）：改名成功就清掉本機待送的名字（#1839）。store 是首次引導的存檔 */
export async function renameDeviceFromPage(invoke, store, args, log = console.info) {
  const r = await renameDevice(invoke, args)
  await clearPendingDeviceName(store, log)
  return r
}

/**
 * 改的是這台自己、Rust 也把本機視窗名換了：畫面（info、核心、我的暱稱）就地更新，不重載頁面。回有沒有套用。
 * 後台已改好、本機視窗名被規則擋下（window_rename_failed）：用 notify 把原因說出來，並寫進 ui.log
 */
export function followSelfRename(ctx, r, notify = () => {}, log = console.info) {
  if (typeof r?.window_rename_failed === 'string' && r.window_rename_failed) {
    const text = windowRenameFailedNote(String(r.name ?? ''), r.window_rename_failed)
    log('[ASN] 設備改名：後台已改、本機寄信名字沒換成', r.window_rename_failed)
    notify(text)
    return false
  }
  if (r?.self_renamed === true && typeof r.window_name === 'string' && r.window_name) { applyRename(ctx, r.window_name); return true }
  return false
}

/**
 * 啟動後、第一次讀到名單時，請 Rust 把本機視窗名和後台設備名對齊一次（以後台為準）。
 * 本機名字被換掉（adopted）就就地更新畫面並用 notify 說一句話；換不成（failed）把原因說出來；其餘情況（沒差、補送、稍後）不打擾。
 * 任何失敗都不影響其他功能
 */
export async function alignDeviceName(invoke, ctx, notify = () => {}, log = console.info) {
  let r
  try { r = await makeDeviceNameApi(invoke).align() } catch (e) { log('[ASN] 對齊設備名沒成功', String(e?.message ?? e ?? '')); return null }
  if (r?.state === 'adopted' && typeof r.name === 'string' && r.name) { applyRename(ctx, r.name); notify(alignNote(r.name)) }
  else if (r?.state === 'failed') {
    log('[ASN] 對齊設備名：本機寄信名字沒換成', String(r.reason ?? ''))
    notify(alignFailedNote(String(r.name ?? ''), String(r.reason ?? '') || '名字不符合規則'))
  }
  return r
}

/**
 * 首次引導存設備名稱：先送後台（和設備頁同一條）；連不上、沒登入等失敗就先存在本機（引導的存檔 store），畫面說「連上後會自動套用」，
 * 引導不會卡住。回 { deferred: true, note } 或 Rust 的結果。名字不合規則這類「改了也不會成功」的錯誤（後台 bad_request）照舊丟錯讓人改
 */
export async function setDeviceNameOnboard(invoke, store, { node, name, phone = false, base = '' }) {
  let r
  try {
    r = await renameDevice(invoke, { node, name, phone })
  } catch (e) {
    if (/不合規則|不能|保留|1～40/.test(String(e.message))) throw e
    const saved = (await store.load().catch(() => null)) ?? {}
    await store.save({ ...saved, [PENDING_KEY]: String(name).trim(), ...(base ? { [PENDING_BASE_KEY]: String(base) } : {}) })
    return { deferred: true, note: PENDING_NOTE }
  }
  // 後台改好了、本機寄信名字被規則擋下：不讓引導往下走，說原因請本人換個名字（再送一次就會一起換）
  if (typeof r?.window_rename_failed === 'string' && r.window_rename_failed) throw new Error(windowRenameFailedNote(String(r.name ?? name), r.window_rename_failed))
  return r
}

/**
 * 啟動時補送首次引導存在本機的名字（連上之後）。成功或名字已不需要就清掉；還是送不出去就留著下次再試。
 * 第二道防線（#1839）：補送前先看後台目前記的名字，和存待送名字當下的不同，代表之後有人改過名（例如在別台設備改），就不送、清掉待送的名字、寫 log
 */
export async function syncPendingDeviceName(invoke, store, ctx, { node, phone = false, notify = () => {}, log = console.info } = {}) {
  const saved = (await store.load().catch(() => null)) ?? {}
  const name = typeof saved[PENDING_KEY] === 'string' ? saved[PENDING_KEY] : ''
  if (!name) return null
  const { [PENDING_KEY]: _gone, [PENDING_BASE_KEY]: base0, ...rest } = saved
  const base = typeof base0 === 'string' && base0 ? base0 : String(ctx?.info?.window_name ?? '')
  const backend = displayDeviceName(ctx?.core?.nodeNames?.[node])
  if (backend && base && backend !== base && backend !== name) {
    log('[ASN] 不補送首次引導的設備名：後台的名字已被改過', `後台「${backend}」、當初「${base}」、待送「${name}」`)
    await store.save(rest).catch(() => { /* 待送名字清不掉：下次啟動會再比對一次（後台名字還是被改過就還是不送） */ })
    return null
  }
  try {
    const r = await renameDevice(invoke, { node, name, phone })
    await store.save(rest).catch(() => { /* 名字已送出；清不掉待送的，下次補送時會因後台名字相同而略過 */ })
    followSelfRename(ctx, r, notify, log)
    return r
  } catch (e) {
    log('[ASN] 補送首次引導的設備名還是沒成功，下次再試', String(e?.message ?? e))
    return null
  }
}
