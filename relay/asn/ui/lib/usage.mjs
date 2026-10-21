// 用量分頁（暫停中）：僅 PATH 偵測與安裝／登入引導；額度待 docs/research/04-ai-usage.md 結論。
import { installStateLabel } from '../../../shared/agent-tools.mjs'

export function authLabel(row) {
  return installStateLabel(row.binary_found)
}

export function authClass(row) {
  return row.binary_found ? 'st-online' : 'st-offline'
}

export function showInstall(p) {
  return p.install_available && !p.binary_found
}

export function showLogin(p) {
  return p.login_available && p.binary_found
}
