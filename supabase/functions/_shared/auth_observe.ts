// 特權動作的通過方式記錄（#500 拆項 1：觀測）。只累加次數，不改授權、不改回應。
// 記錄的欄位只有：動作、通過方式（signed／role）、簽章狀態、呼叫端節點代號的雜湊（sha256 前 16 碼）。
// 不傳使用者 id、email、信件內容、金鑰。任何失敗只寫 console、絕不丟出去，不影響原本的回應。
import type { SigState } from "./owner_sign.ts";

export type ObserveRpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
export type ObserveVia = "signed" | "role" | "blocked";
export type ObserveSig = "absent" | "invalid" | "valid_not_owner" | "valid_owner";

async function sha16(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/** 記一筆。永不丟錯。 */
export async function recordAuth(rpc: ObserveRpc, e: { action: string; via: ObserveVia; sig: ObserveSig; node: string }): Promise<void> {
  try {
    const { error } = await rpc("asn_relay_auth_observe", {
      p_action: e.action, p_via: e.via, p_sig: e.sig, p_node_hash: await sha16(e.node),
    });
    if (error) console.warn("asn_relay_auth_observe failed", e.action, error);
  } catch (x) {
    console.warn("asn_relay_auth_observe threw", e.action, x instanceof Error ? x.message : String(x));
  }
}

/** 只有角色路徑的動作（invite、reissue、attach_sweep）：簽章狀態固定記 absent。 */
export const recordRoleOnly = (rpc: ObserveRpc, action: string, node: string): Promise<void> =>
  recordAuth(rpc, { action, via: "role", sig: "absent", node });

/** acct_list／acct_switch 成功後：簽章驗過就唯讀問一次 asn_user_owns_node，為真記 signed＋valid_owner，否則記 role＋對應狀態。 */
export async function recordAcct(
  rpc: ObserveRpc,
  e: { action: string; node: string; user: string | null; state: SigState },
): Promise<void> {
  try {
    if (e.state !== "valid" || !e.user) {
      return await recordAuth(rpc, { action: e.action, via: "role", sig: e.state === "invalid" ? "invalid" : "absent", node: e.node });
    }
    const { data, error } = await rpc("asn_user_owns_node", { p_user: e.user, p_node: e.node });
    if (error) {
      console.warn("asn_user_owns_node (observe) failed", e.action, error);
      return;
    }
    if (data === true) await recordAuth(rpc, { action: e.action, via: "signed", sig: "valid_owner", node: e.node });
    else await recordAuth(rpc, { action: e.action, via: "role", sig: "valid_not_owner", node: e.node });
  } catch (x) {
    console.warn("auth observe (acct) threw", e.action, x instanceof Error ? x.message : String(x));
  }
}

/** 旗標 ASN_REQUIRE_SIGNED_ACCT 開啟而被擋下（403）時記一筆：通過方式 blocked＋實際簽章狀態。永不丟錯（#500 拆項 3b）。 */
export function recordBlocked(
  rpc: ObserveRpc,
  e: { action: string; node: string; state: SigState; validNotOwner: boolean },
): Promise<void> {
  const sig: ObserveSig = e.validNotOwner ? "valid_not_owner" : e.state === "invalid" ? "invalid" : "absent";
  return recordAuth(rpc, { action: e.action, via: "blocked", sig, node: e.node });
}
