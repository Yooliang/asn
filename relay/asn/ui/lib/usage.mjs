// 用量分頁：顯示文字與進度條（邏輯可單測；資料來自 Rust）。
import { authLabel } from '../../../shared/agent-tools.mjs'

export { authLabel }

export function authClass(auth) {
  switch (auth) {
    case 'logged_in': return 'st-online'
    case 'not_logged_in': return 'st-away'
    case 'not_installed': return 'st-offline'
    default: return 'st-busy'
  }
}

export function formatPercent(v) {
  if (v == null || Number.isNaN(v)) return '—'
  return `${Math.round(v)}%`
}

export function formatWindow(w) {
  const used = formatPercent(w.used_percent)
  const left = w.remaining_percent != null ? `剩 ${formatPercent(w.remaining_percent)}` : ''
  const reset = w.reset_at ? `重置 ${w.reset_at}` : ''
  return [used, left, reset, w.detail].filter(Boolean).join(' · ')
}

export function showInstall(p) {
  return p.install_available && p.auth === 'not_installed'
}

export function showLogin(p) {
  return p.login_available && p.auth === 'not_logged_in'
}

export function canRefresh(p) {
  return p.auth === 'logged_in' && p.usage_supported
}
