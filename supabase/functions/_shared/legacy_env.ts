// F4（#423）：用戶端在名單回報（roster）頂層附 used_legacy_env＝這個節點／橋啟動時「靠舊名才拿到設定」的環境變數名字（只有名字，不含值）。
// 給 F1 舊名使用報表看哪些節點還在用 IRORI_*，決定相容層什麼時候能拿掉。
// 過濾：每個名字要符合 IRORI_ 開頭的格式、而且在舊名白名單（三邊相容對照表的聯集）裡，其他丟掉；排序去重、最多 64 個。
// 欄位不是陣列就當沒帶（不寫）；舊版用戶端不送這個欄位＝不寫，資料庫裡維持 null（＝從沒回報過）。
// 資料庫（asn_relay_set_legacy_env）會再檢查一次格式與上限；白名單只在這裡。

export const LEGACY_ENV_RE = /^IRORI_[A-Z0-9_]{1,64}$/;
export const LEGACY_ENV_MAX = 64;

// 舊名白名單＝三邊相容對照表舊名的聯集（守門測試 legacy_env_test.ts 會讀三個原始檔比對，新增改名時要一起補）：
//  - 電腦版（含 Linux 無頭版）：relay/asn/src-tauri/src/envc.rs 的 PAIRS
//  - Linux 機器橋（含 Aegis 橋）：relay/machine/env-compat.mjs 的 RENAMED（舊名＝IRORI_ 加上清單裡的名字）
//  - 雲端代理：relay/cloud-agent/env-compat.mjs 的 ENV_RENAME_PAIRS
export const LEGACY_ENV_NAMES: readonly string[] = [
  "IRORI_AEGIS_ALLOW",
  "IRORI_AEGIS_DEFAULT",
  "IRORI_AEGIS_FROM_MEMBER",
  "IRORI_AEGIS_RETRY_MS",
  "IRORI_AEGIS_SELF",
  "IRORI_AEGIS_TIMEOUT_MS",
  "IRORI_AEGIS_URL",
  "IRORI_AGENTS_FILE",
  "IRORI_ASN_CLAUDE_AUTO_MS",
  "IRORI_ASN_CLAUDE_HOME",
  "IRORI_ASN_DATA",
  "IRORI_ASN_MOCK_BIN_DIR",
  "IRORI_ASN_POLL_MS",
  "IRORI_ASN_PRESENCE_MS",
  "IRORI_ASN_ROSTER_MS",
  "IRORI_ASN_SHOT_LOGIN",
  "IRORI_ATTACH_CMD",
  "IRORI_BRIDGE_ENGINE_ONLY",
  "IRORI_BRIDGE_INBOX",
  "IRORI_BRIDGE_TICK_MS",
  "IRORI_CLAUDE_BIN",
  "IRORI_CLAUDE_SCRIPT",
  "IRORI_CLI_UNATTENDED",
  "IRORI_CLOUD_AGENTS",
  "IRORI_CLOUD_APP",
  "IRORI_CLOUD_ENGINE",
  "IRORI_CLOUD_HOME",
  "IRORI_CLOUD_KEY_DIR",
  "IRORI_CLOUD_MAIL_DIR",
  "IRORI_CLOUD_ROSTER_AUTO",
  "IRORI_CLOUD_ROSTER_CLAUDE",
  "IRORI_CLOUD_ROSTER_LABEL",
  "IRORI_CLOUD_ROSTER_NAME",
  "IRORI_CODEX_ALLOW_FULL_ACCESS",
  "IRORI_CODEX_BIN",
  "IRORI_CODEX_DRAIN_WARN_MS",
  "IRORI_CODEX_HEALTH_TTL_MS",
  "IRORI_CODEX_LOCK_MODE",
  "IRORI_CODEX_MAX_MAIL_CHARS",
  "IRORI_CODEX_OUTSTANDING_MAX_MS",
  "IRORI_CODEX_POLL_MS",
  "IRORI_CODEX_REPLY_NOTE",
  "IRORI_CODEX_SCRIPT",
  "IRORI_CODEX_SKIP_VERSION_CHECK",
  "IRORI_DISPATCH_STATE_DIR",
  "IRORI_ENGINES",
  "IRORI_FORWARD_TIMEOUT_MS",
  "IRORI_HOME",
  "IRORI_INBOX_ENGINE",
  "IRORI_INBOX_NAME",
  "IRORI_INVITE",
  "IRORI_LATE_KEEP_MS",
  "IRORI_LATE_MAX",
  "IRORI_LAUNCHER_FILE",
  "IRORI_LAUNCH_ARGS",
  "IRORI_LAUNCH_AUTO",
  "IRORI_LAUNCH_CONFIRM_MS",
  "IRORI_LAUNCH_DIR",
  "IRORI_LAUNCH_FILE",
  "IRORI_LAUNCH_NO_AUTO",
  "IRORI_LAUNCH_STYLE",
  "IRORI_LAUNCH_WINDOW_STYLE",
  "IRORI_LOCK_FILES",
  "IRORI_MAILBOX_MODEL",
  "IRORI_MAILBOX_NAME",
  "IRORI_NODE_BIN",
  "IRORI_NODE_DIR",
  "IRORI_NUDGE_MS",
  "IRORI_PULL_BACKOFF_MS",
  "IRORI_RECV_HEARTBEAT_MS",
  "IRORI_RECV_POLL_MS",
  "IRORI_RECV_STALE_MS",
  "IRORI_RELAY_ALLOW",
  "IRORI_RELAY_ANON_KEY",
  "IRORI_RELAY_DEFAULT_AGENT",
  "IRORI_RELAY_ENV_FILE",
  "IRORI_RELAY_ID",
  "IRORI_RELAY_KEY",
  "IRORI_RELAY_LOG",
  "IRORI_RELAY_POLL_MS",
  "IRORI_RELAY_URL",
  "IRORI_REPLY_TIMEOUT_MS",
  "IRORI_RESPOND",
  "IRORI_RESPOND_TOOLS",
  "IRORI_ROOM_CMD",
  "IRORI_ROOM_STAGGER_MS",
  "IRORI_ROSTER_403_RETRY_MS",
  "IRORI_ROSTER_MS",
  "IRORI_ROSTER_PROCS",
  "IRORI_SELF_UPDATE_MS",
  "IRORI_SEND_PER_HOUR",
];

const ALLOWED = new Set(LEGACY_ENV_NAMES);

// 不是陣列回 null（＝當沒帶，不寫）；是陣列就回過濾後的清單（可能是空陣列＝回報了、沒用舊名）
export function sanitizeLegacyEnv(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const keep = new Set<string>();
  for (const n of v) {
    if (typeof n === "string" && LEGACY_ENV_RE.test(n) && ALLOWED.has(n)) keep.add(n);
  }
  return [...keep].sort().slice(0, LEGACY_ENV_MAX);
}

export type LegacyEnvRpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data?: unknown; error?: unknown }>;

// relay 函式名單分支用：有帶 used_legacy_env（而且是陣列）才寫；寫入失敗（例如資料庫還沒有這支函式）只記 log，不影響名單回應
export async function applyLegacyEnv(
  rpc: LegacyEnvRpc,
  node: string,
  body: Record<string, unknown>,
  log: (...a: unknown[]) => void = (...a) => console.warn(...a),
): Promise<void> {
  if (!("used_legacy_env" in body)) return;
  const names = sanitizeLegacyEnv(body.used_legacy_env);
  if (names === null) return;
  try {
    const { data, error } = await rpc("asn_relay_set_legacy_env", { p_node: node, p_names: names });
    if (error) log("set_legacy_env", node, (error as { message?: string })?.message ?? error);
    else if ((data as { error?: unknown } | null)?.error) log("set_legacy_env", node, (data as { error: unknown }).error);
  } catch (e) {
    log("set_legacy_env", node, e instanceof Error ? e.message : e);
  }
}
