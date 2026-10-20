// 雲端代理入口：IRORI_* → ASN_* 相容（ONBOARDING §5.2）。程式內部只讀新名；舊名僅在入口複製到新名。
// 新名優先；新舊皆有且不同時以新名為準（可選 warn，只記變數名、不記值）。
/** @typedef {{ env: Record<string, string|undefined>, legacyNames: string[], conflictNames: string[] }} CompatResult */

/** 舊名 → 新名（含例外 IRORI_ASN_DATA → ASN_DATA） */
export const ENV_RENAME_PAIRS = [
  ['ASN_CLOUD_HOME', 'IRORI_CLOUD_HOME'],
  ['ASN_CLOUD_APP', 'IRORI_CLOUD_APP'],
  ['ASN_CLOUD_KEY_DIR', 'IRORI_CLOUD_KEY_DIR'],
  ['ASN_CLOUD_MAIL_DIR', 'IRORI_CLOUD_MAIL_DIR'],
  ['ASN_CLOUD_ROSTER_NAME', 'IRORI_CLOUD_ROSTER_NAME'],
  ['ASN_CLOUD_ROSTER_LABEL', 'IRORI_CLOUD_ROSTER_LABEL'],
  ['ASN_CLOUD_ENGINE', 'IRORI_CLOUD_ENGINE'],
  ['ASN_CLOUD_AGENTS', 'IRORI_CLOUD_AGENTS'],
  ['ASN_CLOUD_ROSTER_AUTO', 'IRORI_CLOUD_ROSTER_AUTO'],
  ['ASN_CLOUD_ROSTER_CLAUDE', 'IRORI_CLOUD_ROSTER_CLAUDE'],
  ['ASN_RELAY_ID', 'IRORI_RELAY_ID'],
  ['ASN_RELAY_URL', 'IRORI_RELAY_URL'],
  ['ASN_RELAY_KEY', 'IRORI_RELAY_KEY'],
  ['ASN_RELAY_ANON_KEY', 'IRORI_RELAY_ANON_KEY'],
  ['ASN_NODE_DIR', 'IRORI_NODE_DIR'],
  ['ASN_NODE_BIN', 'IRORI_NODE_BIN'],
  ['ASN_RELAY_ENV_FILE', 'IRORI_RELAY_ENV_FILE'],
  ['ASN_DISPATCH_STATE_DIR', 'IRORI_DISPATCH_STATE_DIR'],
  ['ASN_RECV_POLL_MS', 'IRORI_RECV_POLL_MS'],
  ['ASN_ROSTER_MS', 'IRORI_ROSTER_MS'],
  ['ASN_ROSTER_403_RETRY_MS', 'IRORI_ROSTER_403_RETRY_MS'],
  ['ASN_CLAUDE_BIN', 'IRORI_CLAUDE_BIN'],
  ['ASN_CLAUDE_SCRIPT', 'IRORI_CLAUDE_SCRIPT'],
  ['ASN_DATA', 'IRORI_ASN_DATA'],
]

/** 子程序測試／清理時要剝離的前綴（含秘密） */
export const SCRUB_ENV_PREFIXES = ['IRORI_', 'ASN_']

const trim = v => (v === undefined || v === null ? '' : String(v).trim())

/**
 * @param {NodeJS.ProcessEnv} source
 * @param {{ warn?: (msg: string) => void }} [options]
 * @returns {CompatResult}
 */
export function applyEnvCompat(source = process.env, options = {}) {
  const warn = options.warn ?? (() => {})
  const env = { ...source }
  const legacyNames = []
  const conflictNames = []
  for (const [newName, oldName] of ENV_RENAME_PAIRS) {
    const newVal = trim(env[newName])
    const oldVal = trim(env[oldName])
    if (newVal && oldVal && newVal !== oldVal) {
      conflictNames.push(newName)
      warn(`環境變數 ${newName} 與 ${oldName} 同時存在且不同，以 ${newName} 為準`)
      continue
    }
    if (!newVal && oldVal) {
      env[newName] = oldVal
      if (!legacyNames.includes(oldName)) {
        legacyNames.push(oldName)
        warn(`使用舊環境變數名：${oldName}（請改為 ${newName}）`)
      }
    }
  }
  return { env, legacyNames, conflictNames }
}

/** 平台或 shell 是否已提供節點金鑰（新名或舊名皆可；不讀檔、不印值） */
export function hasRelayKey(env = process.env) {
  const { env: e } = applyEnvCompat(env)
  return Boolean(trim(e.ASN_RELAY_KEY))
}

/** 測試用：去掉 IRORI_* 與 ASN_*，避免子程序繼承生產設定 */
export function withoutRelayEnv(base = process.env) {
  const out = {}
  for (const k of Object.keys(base)) {
    if (SCRUB_ENV_PREFIXES.some(p => k.startsWith(p))) continue
    out[k] = base[k]
  }
  return out
}
