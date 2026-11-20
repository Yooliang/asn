// 「這個節點是手機還是電腦」只有這一份判斷（#1829）：設備樹、頁籤、群組、通知寄件者、額度頁、啟動器選單、詳情標題都從這裡來。
// 後台回報的平台（launchers／machines 的 platform）優先，其次名單夥伴的種類；兩邊都沒有資料時，每個地方都退回同一個預設（電腦）。
// 平台資料是畫面層讀回來的（電腦版 remoteMachines、手機版 launchers），用 setNodePlatforms 登記一次，其他地方不必各自傳。
const PHONE_KINDS = new Set(['phone', 'mobile', 'android'])
const PHONE_PLATFORMS = new Set(['android', 'ios'])
const DESKTOP_PLATFORMS = new Set(['windows', 'macos', 'linux'])

/** 這台是不是手機：後台回報的平台優先（#652），沒有再退回名單的種類（舊版手機的平台是空的） */
export function isPhoneDevice({ platform = '', kinds = [] } = {}) {
  const p = String(platform ?? '').toLowerCase()
  if (PHONE_PLATFORMS.has(p)) return true
  if (DESKTOP_PLATFORMS.has(p)) return false   // 後台說是電腦就是電腦，不管名單的種類寫什麼
  return (kinds ?? []).some(k => PHONE_KINDS.has(String(k ?? '').toLowerCase()))
}

let known = {}, selfNode = '', selfIsPhone = false
/** 登記後台回報的平台：machines＝節點 → { platform }；self＝{ node, phone }（手機版的本機一定是手機，不等後台回報） */
export function setNodePlatforms(machines, self = {}) {
  known = machines && typeof machines === 'object' ? machines : {}
  selfNode = typeof self?.node === 'string' ? self.node : ''
  selfIsPhone = self?.phone === true
}
/** 登記過的平台（小寫）；沒有就空字串 */
export const platformOf = node => String(known[node]?.platform ?? '').toLowerCase() || (selfIsPhone && node && node === selfNode ? 'android' : '')

/** 這個節點是不是手機：平台（給了就用、沒給用登記的）加上名單裡這台夥伴的種類 */
export const isPhoneNode = (node, { platform = '', friends = [] } = {}) =>
  isPhoneDevice({ platform: platform || platformOf(node), kinds: (Array.isArray(friends) ? friends : []).filter(f => f?.node === node).map(f => f.kind) })
