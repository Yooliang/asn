// 系統通知的共用判斷（#848）：Node 橋與雲端代理共用；規則與 relay/asn/ui/lib/notice.mjs、Rust 橋的 is_system_notice 一致，改動要一起改。
// 純函式。

export const NOTICE_SENDER = 'ASN 通知'          // 後台與橋寄系統通知的固定寄件人
export const NOTICE_KIND_PREFIX = 'notice:'      // 信件類別 kind 的前綴
export const LEGACY_NOTICE_SUFFIX = '收發室'      // 舊版寄件名結尾（「○○收發室」「<節點>-收發室」）
export const LEGACY_BODY_PREFIX = '[收發室]'      // 舊版橋寄的通知，內文開頭的標記

// 舊寄件名／內文標記的相容截止時間（毫秒，或可被 Date.parse 的 ISO 字串）。
// 之後會設成 PR-C（後台改用新寄件人與 kind）上線的日期：created_at 在這個時間以後、又沒有 notice 類別的信，
// 就算寄件名叫「ASN 通知」或結尾是「收發室」、內文以 [收發室] 開頭，也不當系統通知（這些寄件名是保留給系統通知的）。
// null＝還沒決定日期，舊規則對所有信都有效（和目前行為一致）。
export const LEGACY_NOTICE_UNTIL = null

const cutoffMs = until => {
  if (until == null) return null
  const n = typeof until === 'number' ? until : Date.parse(until)
  return Number.isFinite(n) ? n : null
}

// 舊規則對這封信是否仍有效：沒設截止＝一律有效；設了就要有 created_at 且早於截止
export function legacyApplies(mail, until = LEGACY_NOTICE_UNTIL) {
  const cut = cutoffMs(until)
  if (cut == null) return true
  const t = Date.parse(mail?.created_at)
  return Number.isFinite(t) && t < cut
}

// 寄件名保留字檢查用的正規化（和後台、Rust 端同一套；共用案例在 supabase/functions/_shared/reserved_sender_cases.json）：
// NFKD → 去掉控制／格式／空白／組合記號／標點／符號 → 轉小寫 → 長得像的外國字母與日文、簡體字形對照 → NFKC
const IGNORED = /[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}\p{M}\p{P}\p{S}\s]/gu
const FOLD_MAP = { 'а': 'a', 'ɑ': 'a', 'α': 'a', 'ᴀ': 'a', 'ѕ': 's', 'ꜱ': 's', 'ν': 'n', 'ո': 'n', 'ɴ': 'n', 'ᴎ': 'n', '发': '發', '発': '發', '収': '收' }
export const foldName = name => Array.from(String(name ?? '').normalize('NFKD').replace(IGNORED, '').toLowerCase(), c => FOLD_MAP[c] ?? c).join('').normalize('NFKC')
// 是不是保留給系統通知的寄件名：正規化後等於「asn通知」或結尾是「收發室」
export const isLegacyNoticeName = name => {
  const s = foldName(name)
  return s === foldName(NOTICE_SENDER) || s.endsWith(LEGACY_NOTICE_SUFFIX)
}
export const isNoticeKind = kind => typeof kind === 'string' && kind.startsWith(NOTICE_KIND_PREFIX)

// 這封信的寄件人是不是系統通知（不回信、不計時）：kind 是 notice:* 一定算；沒有 kind 時才退回舊的寄件名規則，
// 而且舊規則只對截止時間以前的信有效。
// sameAccount：寄件節點是不是同一個帳號的；false 的舊寄件名信是一般信。橋收到的信沒有這個資訊，所以呼叫端通常不給（＝照舊規則）
export function isSystemNotice(mail, { until = LEGACY_NOTICE_UNTIL, sameAccount = true } = {}) {
  if (!mail || typeof mail !== 'object') return false
  if (isNoticeKind(mail.kind)) return true
  if (sameAccount === false || !legacyApplies(mail, until)) return false
  return isLegacyNoticeName(mail.from_agent)
}

// 內文開頭的 [收發室] 標記（舊版橋寄的通知）：同樣只對截止時間以前的信有效
export function hasLegacyBodyPrefix(mail, { until = LEGACY_NOTICE_UNTIL, sameAccount = true } = {}) {
  if (!mail || typeof mail !== 'object' || sameAccount === false || !legacyApplies(mail, until)) return false
  return String(mail.body ?? '').trimStart().startsWith(LEGACY_BODY_PREFIX)
}

// 橋與雲端代理的名單／夥伴名驗證：這個名字是不是保留給系統通知的（不能當夥伴名）
export const isReservedPartnerName = name => isLegacyNoticeName(name)
