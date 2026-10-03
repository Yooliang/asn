// 把引擎回報的錯誤字串分成「沒登入」「額度用完」兩類（名單狀態 login-required／quota 用）。
// 只拿來判斷 CLI 的錯誤訊息（result.error、stderr、JSON-RPC error），不拿來判斷模型的回覆內容。
const AUTH_RE = /(not\s+(?:logged|signed)\s*in|log\s*in\b|login\b|sign\s*in\b|authenticat|unauthenticated|unauthori[sz]ed|credentials?\b|oauth|auth(?:orization)?\s+required|invalid[_ ]grant|token\s+(?:has\s+)?(?:expired|invalid)|\b401\b|請登入|尚未登入|登入失效)/i
const QUOTA_RE = /(quota|rate.?limit|resource_?exhausted|too many requests|\b429\b|usage limit|limit exceeded|exceeded your|out of credits|額度)/i

export function classifyFailure(text) {
  const t = String(text ?? '')
  if (QUOTA_RE.test(t)) return 'quota'      // 先判額度：「Quota exceeded… check your plan and billing」不該被當成登入問題
  if (AUTH_RE.test(t)) return 'auth'
  return null
}

// 帶分類的錯誤。code：auth／quota／timeout／crash／violation／agent／stopped
export class WorkerError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'WorkerError'; this.code = code; Object.assign(this, extra) }
}
