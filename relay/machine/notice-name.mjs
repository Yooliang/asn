// 收發室自己說話的系統通知（沒有 fromAgent）會和別台設備的通知收在「通知」對話裡，
// 所以內文第一行前面加「<這台的設備名>：」。代夥伴寄的信（有 fromAgent）不加。（Rust 橋同規則：core/notice_name.rs）
// 設備名一律用後台的節點名稱（名單 list 的 members[].name），和畫面標頭「通知 · <設備名>」同一個來源；
// 還沒拿到、或後台這台沒取名字＝不加前綴（畫面標頭已有「未命名設備」）。不退回電腦名稱。
const MAX_CHARS = 40
export const REFRESH_MS = 10 * 60_000   // 名單裡的設備名多久重查一次；查失敗也隔這麼久才再試

/** 清掉控制字元、去頭尾空白、截到 40 字；清完是空的＝'' */
export function cleanDevice(name) {
  return Array.from(String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()).slice(0, MAX_CHARS).join('').trim()
}

/** 從 list 回應找自己節點的設備名；找不到＝'' */
export function ownDeviceName(list, node) {
  const m = Array.isArray(list?.members) ? list.members.find(x => x?.id === node) : null
  return cleanDevice(m?.name)
}

export function withNoticePrefix(body, fromAgent, device) {
  const d = cleanDevice(device)
  if (fromAgent || !d) return body
  const p = `${d}：`
  return String(body).startsWith(p) ? body : `${p}${body}`
}

/** 設備名快取：getList() 取名單（會 throw 就保留上次的名字）；now 可注入 */
export function createDeviceNameCache({ getList, node, log = () => {}, now = Date.now, refreshMs = REFRESH_MS }) {
  let name = '', at = 0
  return async function deviceName() {
    if (at && now() - at < refreshMs) return name
    try { name = ownDeviceName(await getList(), node) } catch (e) { log(`device name lookup failed: ${e.message}`) }
    at = now()
    return name
  }
}
