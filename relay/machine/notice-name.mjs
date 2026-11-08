// 收發室自己說話的系統通知（沒有 fromAgent）會和別台設備的通知收在「通知」對話裡，
// 所以內文第一行前面加「<這台的設備名>：」。代夥伴寄的信（有 fromAgent）不加。（Rust 橋同規則：core/notice_name.rs）
export const UNNAMED_DEVICE = '未命名設備'
const MAX_CHARS = 40

/** 清掉控制字元、去頭尾空白、截到 40 字；清完是空的就用「未命名設備」 */
export function noticeDevice(name) {
  const clean = Array.from(String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()).slice(0, MAX_CHARS).join('').trim()
  return clean || UNNAMED_DEVICE
}

export const noticePrefix = name => `${noticeDevice(name)}：`

export function withNoticePrefix(body, fromAgent, device) {
  if (fromAgent) return body
  const p = noticePrefix(device)
  return String(body).startsWith(p) ? body : `${p}${body}`
}
