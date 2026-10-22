// 首次登入引導（#166）：登入後、進名單之前，先問兩件事——帳號名稱（我的名字，所有設備共用）與這台設備的名稱。
// 純邏輯（node 與瀏覽器都能跑，不碰 Tauri）；電腦版（onboard.html）與手機版（m.html 的引導畫面）共用。
// 「引導已完成」旗標存在本機存檔 asn-onboard.json（store('onboard')），兩個版本各自的本機各記一份。
import { PLACEHOLDER_NAMES } from './mobile.mjs'

export const ONBOARD_STORE = 'onboard'
export const NAME_MAX = 40
export const STEP_ACCOUNT = 'account'
export const STEP_DEVICE = 'device'

export const TEXT = {
  title: '歡迎使用 ASN',
  accountHead: '你的名字',
  accountHint: '帳號的名字，所有設備共用，對方看到的就是它。例如「啟良」。',
  deviceHead: '這台設備的名稱',
  deviceHint: '只有這台用，例如「手機」「家用機」。預設帶這台的名稱，可以直接改。',
  next: '下一步',
  done: '完成',
  saving: '儲存中…',
  settingsNote: '之後可以在設定裡修改。',
}

/** 帳號是不是已經有名字：有字、而且不是建租戶時的預設稱呼 */
export function hasAccountName(name) {
  const n = String(name ?? '').trim()
  return n !== '' && !PLACEHOLDER_NAMES.includes(n)
}

/**
 * 要走哪幾步（依序）。空陣列＝不用引導（呼叫端把旗標設成完成）。
 *   done：本機旗標已設；accountName：後台的帳號名稱；deviceCustom：這台設備名稱是使用者自己取過的（不是預設名）
 * 帳號已有名字（可能在別台設過）就跳過第一步；舊用戶已有帳號名稱、設備也取過名字，視為已完成。
 */
export function onboardSteps({ done, accountName, deviceCustom }) {
  if (done === true) return []
  const steps = []
  if (!hasAccountName(accountName)) steps.push(STEP_ACCOUNT)
  if (deviceCustom !== true) steps.push(STEP_DEVICE)
  return steps
}

/** 名字欄位檢查：去頭尾空白、1～40 字、不含控制字元。回 { ok, name, error } */
export function checkName(raw) {
  const name = String(raw ?? '').trim()
  if (!name) return { ok: false, name, error: '名字不能是空的' }
  if ([...name].length > NAME_MAX) return { ok: false, name, error: `名字最多 ${NAME_MAX} 個字` }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return { ok: false, name, error: '名字不能含控制字元' }
  return { ok: true, name, error: '' }
}

/** 進度小字：只有一步時不顯示 */
export const stepLabel = (steps, step) => (steps.length > 1 ? `第 ${steps.indexOf(step) + 1} 步，共 ${steps.length} 步` : '')

/**
 * 登入後決定要不要引導。deps：{ store, status, accountInfo, startup }。
 * 回傳要走的步驟（空＝不用引導）。沒登入（暫時不登入）不引導；「不用引導」時會寫入旗標。
 * 取不到帳號資料（離線、後台錯誤）時不擋人：回空陣列、不設旗標，下次啟動再試。
 */
export async function planOnboarding({ store, status, accountInfo, startup }) {
  const st = await status().catch(() => null)
  if (st?.signed_in !== true) return { steps: [], accountName: '' }
  const saved = (await store.load().catch(() => null)) ?? {}
  if (saved.done === true) return { steps: [], accountName: '' }
  let info = null
  try { info = await accountInfo() } catch { return { steps: [], accountName: '', unknown: true } }
  const accountName = typeof info?.owner_name === 'string' ? info.owner_name : ''
  const steps = onboardSteps({ done: false, accountName, deviceCustom: startup.window_name_custom === true })
  if (steps.length === 0) await store.save({ ...saved, done: true }).catch(() => {})
  return { steps, accountName }
}

export const markOnboarded = async store => {
  const saved = (await store.load().catch(() => null)) ?? {}
  await store.save({ ...saved, done: true })
}
