// 環境變數改名相容（ONBOARDING §5.2，第一期）：IRORI_<名> → ASN_<名>。
// 規則：新名（ASN_）優先；新名沒設（或是空字串）才讀舊名（IRORI_）；兩個都沒有就是沒設。
// 寫給子程序的環境，兩個名字都設，沒更新的舊程式照樣讀得到。只記變數名，不記值。

/** 已改名的環境變數（不含前綴）。新增一個改名時，必須加在這裡；守門測試會掃原始碼確認沒有漏。 */
export const RENAMED = [
  'RELAY_ID', 'RELAY_URL', 'RELAY_KEY', 'RELAY_ANON_KEY', 'RELAY_DEFAULT_AGENT', 'RELAY_ALLOW', 'RELAY_POLL_MS', 'RELAY_LOG',
  'MAILBOX_NAME', 'MAILBOX_MODEL', 'ROSTER_MS', 'REPLY_TIMEOUT_MS', 'LATE_KEEP_MS', 'LATE_MAX',
  'NUDGE_MS', 'BRIDGE_TICK_MS', 'FORWARD_TIMEOUT_MS', 'SELF_UPDATE_MS',
  'LAUNCH_AUTO', 'LAUNCH_NO_AUTO', 'LAUNCHER_FILE', 'LAUNCH_CONFIRM_MS', 'LAUNCH_WINDOW_STYLE',
  'LAUNCH_FILE', 'LAUNCH_ARGS', 'LAUNCH_DIR', 'LAUNCH_STYLE', 'LOCK_FILES',
  'ENGINES', 'AGENTS_FILE', 'CLAUDE_SCRIPT', 'CODEX_SCRIPT', 'CODEX_BIN',
  'CODEX_POLL_MS', 'CODEX_HEALTH_TTL_MS', 'CODEX_OUTSTANDING_MAX_MS', 'CODEX_DRAIN_WARN_MS', 'CODEX_MAX_MAIL_CHARS',
  'CODEX_LOCK_MODE', 'CODEX_ALLOW_FULL_ACCESS', 'CODEX_REPLY_NOTE', 'CODEX_SKIP_VERSION_CHECK',
  'PULL_BACKOFF_MS', 'RECV_POLL_MS', 'RECV_HEARTBEAT_MS', 'RECV_STALE_MS', 'SEND_PER_HOUR', 'INVITE', 'HOME',
  'AEGIS_URL', 'AEGIS_FROM_MEMBER', 'AEGIS_ALLOW', 'AEGIS_SELF', 'AEGIS_DEFAULT', 'AEGIS_TIMEOUT_MS', 'AEGIS_RETRY_MS',
]

/** 金鑰類：不可交給子程序。新舊名都要擋。 */
export const SECRET_NAMES = ['ASN_RELAY_KEY', 'ASN_RELAY_ANON_KEY', 'IRORI_RELAY_KEY', 'IRORI_RELAY_ANON_KEY']
const SECRET_UPPER = new Set(SECRET_NAMES)
export const isSecretEnvName = name => SECRET_UPPER.has(String(name).toUpperCase())

const filled = v => v !== undefined && v !== null && String(v).trim() !== ''

/** 新名優先、沒有才讀舊名（不記錄；組子程序環境用） */
function pick(env, name) {
  const n = env?.[`ASN_${name}`]
  if (filled(n)) return n
  const o = env?.[`IRORI_${name}`]
  return o !== undefined ? o : n
}

/**
 * 靠舊名才拿到設定的記錄（名單回報頂層的 used_legacy_env，F4 PR-2，issue #423）：
 * 只記「新名沒有值（沒設或只有空白）、退回舊名而且舊名有值」的舊名，只記名字不記值。
 * 測試可以自己建一份傳進 envGet，不碰全域的那份。
 */
export function createLegacyLog() {
  const set = new Set()
  return {
    note: name => { set.add(name) },
    /** 排序去重後的舊名（新陣列，不外洩內部集合） */
    names: () => [...set].sort(),
    clear: () => { set.clear() },
  }
}
const USED = createLegacyLog()

/** 名單回報用：這個程序啟動後靠舊名才拿到設定的環境變數舊名，排序去重；沒用到是空陣列 */
export const usedLegacyEnv = () => USED.names()
/** 測試用：清空全域記錄 */
export const resetUsedLegacyEnv = () => USED.clear()

/** 讀環境變數：envGet(process.env, 'RELAY_URL') ＝ ASN_RELAY_URL，沒有才 IRORI_RELAY_URL。退回舊名而且舊名有值時記下舊名。 */
export function envGet(env, name, log = USED) {
  if (!filled(env?.[`ASN_${name}`]) && filled(env?.[`IRORI_${name}`])) log.note(`IRORI_${name}`)
  return pick(env, name)
}

/** 給子程序的環境：已改名的變數兩個名字都設（值以新名優先）。金鑰類不補（要不要擋由呼叫端的過濾清單決定）。 */
export function withBothNames(env) {
  const out = { ...env }
  for (const name of RENAMED) {
    const v = pick(env, name)   // 交給子程序的環境不算「本程序靠舊名」，不記錄
    if (v === undefined) continue
    if (isSecretEnvName(`ASN_${name}`)) continue
    out[`ASN_${name}`] = v
    out[`IRORI_${name}`] = v
  }
  return out
}
