// 推播（#797 PR②）：手機註冊權杖的兩個動作，和「寄給本人」「夥伴在等你」之後決定推給誰、送 FCM。
// 資料庫函式見 migrations/20261109100000_push_tokens.sql（PR①）和 20261109110000_push_recipient.sql。
//   push_register／push_unregister：節點金鑰（手機本人那台）；權杖只交給資料庫，不回傳、不寫 log。
//   notifyPush：收件人（p_user）只從伺服器端取：寄信結果裡的信編號、或金鑰所屬的節點；**不接受用戶端的任何參數**。
// 推播失敗一律不影響寄信：呼叫端用 background 跑，這裡自己吞掉所有例外。
import { fail, type Json, type Reply } from "./term_request.ts";
import type { Fcm } from "./push_fcm.ts";

export type PushDeps = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: Json | null; error: unknown }>;
  /** 沒設秘密就是 null：安靜不送，連「要推誰」都不問（問了會吃掉同一台 60 秒的名額） */
  fcm: Fcm | null;
};

export const PUSH_ACTIONS = new Set(["push_register", "push_unregister"]);
// 和資料庫的檢查一致：只看長度與字元集，不信任內容
const TOKEN_RE = /^[A-Za-z0-9_:-]{32,1024}$/;

export async function handlePushAction(deps: Pick<PushDeps, "rpc">, me: { id: string }, action: string, params: Json): Promise<Reply> {
  if (action === "push_register") {
    const t = params?.token;
    if (typeof t !== "string" || !TOKEN_RE.test(t)) return fail("bad_request");
    const { data, error } = await deps.rpc("asn_relay_push_register", { p_node: me.id, p_token: t });
    if (error) {
      console.error("push_register failed", me.id);   // 不記 error 內容（可能帶權杖）
      return fail("internal");
    }
    if (typeof data?.error === "string") return fail(data.error);
    return { status: 200, body: { ok: true } };
  }
  if (action === "push_unregister") {
    const { error } = await deps.rpc("asn_relay_push_unregister", { p_node: me.id });
    if (error) {
      console.error("push_unregister failed", me.id);
      return fail("internal");
    }
    return { status: 200, body: { ok: true } };
  }
  return fail("not_found");
}

export type PushKind = "owner_mail" | "waiting";

/** 收件人：寄給本人＝剛寄出的那封信上記的收件人；夥伴在等你＝金鑰所屬節點的擁有者 */
async function recipient(deps: PushDeps, kind: PushKind, nodeId: string, messageId: string | null): Promise<string | null> {
  const r = kind === "owner_mail"
    ? (messageId ? await deps.rpc("asn_relay_push_recipient_mail", { p_node: nodeId, p_message_id: messageId }) : null)
    : await deps.rpc("asn_relay_push_recipient_node", { p_node: nodeId });
  if (!r || r.error) return null;
  const u = r.data?.user;
  return typeof u === "string" && /^[0-9a-f-]{36}$/i.test(u) ? u : null;
}

/**
 * 寄信（或等待通知）寄出之後呼叫。**永遠不丟例外、不影響呼叫端。**
 * 同一輪的處理：每台一則；404／UNREGISTERED 刪權杖；400 只有同一輪裡至少有一台成功才算「這個權杖壞」，
 * 全部 400 就是我們送的內容有問題，**一個權杖都不刪**，記一筆就停手（不重試）。
 */
export async function notifyPush(deps: PushDeps, kind: PushKind, nodeId: string, messageId: string | null): Promise<void> {
  try {
    if (!deps.fcm) return;
    const user = await recipient(deps, kind, nodeId, messageId);
    if (!user) return;
    const { data, error } = await deps.rpc("asn_relay_push_targets", { p_user: user, p_kind: kind });
    if (error || typeof data?.error === "string") {
      console.warn("push targets failed", kind);
      return;
    }
    const targets: { node: string; token: string }[] = (Array.isArray(data?.targets) ? data!.targets : [])
      .filter((t: Json) => typeof t?.node === "string" && typeof t?.token === "string");
    if (targets.length === 0) return;
    const results = await Promise.all(targets.map(async (t) => ({ t, r: await deps.fcm!.send(t.token) })));
    const ok = results.filter((x) => x.r.status >= 200 && x.r.status < 300).length;
    const bad400 = results.filter((x) => x.r.status === 400);
    if (bad400.length === results.length) {
      console.warn("push all_400", kind, results.length);   // 全部 400：我們寫錯，不刪權杖、不重試
      return;
    }
    for (const { t, r } of results) {
      const bad = r.invalid || (r.status === 400 && ok > 0);
      if (!bad) {
        if (!(r.status >= 200 && r.status < 300)) console.warn("push send status", r.status, t.node);
        continue;
      }
      console.warn("push token_invalid", r.status, t.node);
      await deps.rpc("asn_relay_push_invalid", { p_node: t.node, p_token: t.token });
    }
  } catch (_e) {
    console.warn("push notify error", kind);   // 例外內容不記
  }
}
