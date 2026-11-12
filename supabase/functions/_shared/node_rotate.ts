// 手機換一把新的節點金鑰（0.2.17）：Edge 這一半。資料庫函式見 migrations/20261113300000_node_key_rotate.sql。
// 動作 node_rotate_key（POST，節點金鑰；用舊金鑰認證）：body { new_hash, rotation_id }。
//   節點一律取自金鑰（body 不接受指定節點）；新金鑰只有雜湊會到這裡，原文從不離開手機；雜湊不寫 log。
import { fail, HASH_RE, type Json, type Reply, UUID_RE } from "./term_request.ts";

export type NodeRotateDeps = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: Json | null; error: unknown }>;
};

export const NODE_ROTATE_ACTION = "node_rotate_key";

export async function handleNodeRotate(deps: NodeRotateDeps, me: { id: string }, params: Json): Promise<Reply> {
  const hash = params?.new_hash;
  const rid = params?.rotation_id;
  if (typeof hash !== "string" || !HASH_RE.test(hash)) return fail("bad_request");
  if (typeof rid !== "string" || !UUID_RE.test(rid)) return fail("bad_request");
  const { data, error } = await deps.rpc("asn_relay_node_rotate_key", { p_node: me.id, p_new_hash: hash, p_rotation_id: rid.toLowerCase() });
  if (error) {
    console.error("node_rotate_key failed", me.id);   // 不記 error 內容
    return { status: 500, body: { error: "internal" } };
  }
  if (typeof data?.error === "string") {
    if (data.error === "bad_request" || data.error === "not_found" || data.error === "rate_limited") return fail(data.error);
    return fail("bad_request");
  }
  return { status: 200, body: { ok: true } };
}
