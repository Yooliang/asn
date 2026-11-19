// 設備名稱的改法（電腦版、手機版共用，#1803）：全 repo 只有「設備頁改名」這一條路改設備名稱——
// 名字存在後台（relay.nodes.name），本機視窗名由 Rust 在改名成功後跟著換，不再有第二個輸入欄、第二個存檔。
// 這個檔案只放「怎麼叫 Rust」與改名後怎麼就地更新畫面，純函式／注入 invoke，node 與瀏覽器都能跑。
import { applyRename } from './rename.mjs'

/** 改名要叫的 Rust 命令：手機是 android_known_rename、電腦是 device_rename（兩個命令都送後台並替本機視窗名跟上） */
export const renameCommandOf = phone => (phone === true ? 'android_known_rename' : 'device_rename')

/** 啟動對齊後要對使用者說的話（本機名字被換成後台那一份時） */
export const alignNote = name => `這台的名字已統一為設備頁設定的「${name}」，要改請到設備頁。`

/** 替任一台設備改名；成功回 Rust 的結果（{ ok, name, changed, self_renamed?, window_name? }），失敗丟 Error（訊息是給人看的中文） */
export async function renameDevice(invoke, { node, name, phone = false }) {
  try {
    return await invoke(renameCommandOf(phone), { node, name: String(name ?? '').trim() })
  } catch (e) {
    throw new Error(String(e?.message ?? e ?? '') || '改名沒有成功，請稍後再試')
  }
}

/** 改的是這台自己、Rust 也把本機視窗名換了：畫面（info、核心、我的暱稱）就地更新，不重載頁面。回有沒有套用 */
export function followSelfRename(ctx, r) {
  if (r?.self_renamed === true && typeof r.window_name === 'string' && r.window_name) { applyRename(ctx, r.window_name); return true }
  return false
}

/**
 * 啟動後、第一次讀到名單時，請 Rust 把本機視窗名和後台設備名對齊一次（以後台為準）。
 * 本機名字被換掉（adopted）就就地更新畫面並用 notify 說一句話；其餘情況（沒差、補送、稍後）不打擾。任何失敗都不影響其他功能
 */
export async function alignDeviceName(invoke, ctx, notify = () => {}) {
  let r
  try { r = await invoke('device_name_align') } catch (e) { console.info('[ASN] 對齊設備名沒成功', String(e?.message ?? e ?? '')); return null }
  if (r?.state === 'adopted' && typeof r.name === 'string' && r.name) { applyRename(ctx, r.name); notify(alignNote(r.name)) }
  return r
}
