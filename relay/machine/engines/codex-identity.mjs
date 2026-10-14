// Codex 轉接器的「身分判定」：send／recv 從環境變數 CODEX_THREAD_ID 認出自己所在的 Codex 視窗。
// Codex 對它執行的每個 shell 指令都會注入 CODEX_THREAD_ID／CODEX_SESSION_ID（實測 0.154.0；父行程鏈在 Windows 沙盒內讀不到：
// Get-CimInstance 被擋），再對照 session_index.jsonl 的名字。沒有名字的視窗不能當寄件人／收件人（跟 Claude 一樣要先 /rename）。
// 注意：沙盒預設不給網路（CODEX_SANDBOX_NETWORK_DISABLED=1），send.mjs 在預設沙盒裡連不上仲介；見 docs/archive/CODEX-ENGINE.md。
import { codexHome, readNameIndex } from './codex-state.mjs'

// 回傳格式與 claude-identity 相同：{ chain, tableError, viaChain, viaEnv, envSocket }；命中時 viaEnv＝{ pid, name }
export function inspectCaller(env = process.env) {
  const ev = { chain: [], tableError: null, viaChain: null, viaEnv: null, envSocket: '', envThreadId: env.CODEX_THREAD_ID || '' }
  const tid = String(ev.envThreadId).toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tid)) return ev
  const name = readNameIndex(codexHome(env)).byId.get(tid) ?? ''
  ev.viaEnv = { pid: process.ppid, name, threadId: tid }
  return ev
}
