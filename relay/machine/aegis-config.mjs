// Aegis 轉接橋的設定（從環境變數讀）。新名 ASN_AEGIS_* 優先，舊名 IRORI_AEGIS_* 照認（env-compat 規則）；
// 與 Rust 版 relay/asn/src-tauri/src/bridge/engines/aegis.rs 的 AegisCfg::from_env 行為一致，
// 共用向量在 relay/shared/test-vectors/aegis-bridge.json 的 env_config。
import { envGet } from './env-compat.mjs'

/** 讀 Aegis 橋設定；空字串視為沒設（用預設值）。回傳新物件，不改 env。 */
export function aegisConfig(env) {
  return {
    url: (envGet(env, 'AEGIS_URL') || 'http://127.0.0.1:8899').replace(/\/+$/, ''),
    fromMember: envGet(env, 'AEGIS_FROM_MEMBER') || 'xi-xu',
    allow: (envGet(env, 'AEGIS_ALLOW') || '').split(',').map(s => s.trim()).filter(Boolean),
    selfMember: (envGet(env, 'AEGIS_SELF') || 'xi-xu').trim(),   // 轉接橋自己的成員：不列進名單、也不能被問
    defaultMember: (envGet(env, 'AEGIS_DEFAULT') || 'aegis').trim(),   // 沒有 to_agent 的信交給它（要在白名單內）
    askTimeoutMs: Number(envGet(env, 'AEGIS_TIMEOUT_MS') || 300_000),
    retryMs: Number(envGet(env, 'AEGIS_RETRY_MS') || 60_000),
  }
}
