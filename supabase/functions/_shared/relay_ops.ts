// 仲介動作的「直接呼叫」版（多使用者第一期，設計見 docs/MULTI-USER.md 2.4）：
// irori-api 手上有 service role，可以直接呼叫 public.irori_relay_* 資料庫函式，身分是這個租戶的角色節點（希緒）——
// 不必再繞一圈 HTTP 打 irori-relay、也不需要保管角色節點的金鑰（它根本沒有金鑰）。
// 動作的名稱、參數、回應格式與 irori-relay 的 HTTP 動作一致（whoami、list、inbox、ack、sent_status、send、invite、reissue、update），
// 所以 irori-api/relay.ts 的呼叫端不用關心走的是哪一條路。租戶一律由呼叫端（登入者的帳號）決定，不接受任何來自 body 的租戶或節點。

import { expectsReplyArgs } from "./expects_reply.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: Json; error: unknown }>;
export type OpsDeps = { rpc: Rpc; ring: (topic: string) => Promise<void> };
export type OpResult = { status: number; body: Json };

export const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const optStr = (v: unknown, n: number) => (typeof v === "string" && v ? v.slice(0, n) : null);
const str100 = (v: unknown) => (typeof v === "string" ? v.slice(0, 100) : null);

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const b64u = (n: number) =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const ok = (body: Json): OpResult => ({ status: 200, body });
const err = (status: number, error: string, extra: Json = {}): OpResult => ({ status, body: { error, ...extra } });
const internal = (fn: string, e: unknown): OpResult => {
  console.error(fn, e);
  return err(500, "internal");
};

export type Actor = { tenant: string; node: string };

// 租戶與角色節點：呼叫端（relay.ts）已經從登入者的帳號查好
export async function nodeAction(deps: OpsDeps, who: Actor, action: string, body: Json = {}): Promise<OpResult> {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  switch (action) {
    case "whoami": {
      const { data, error } = await deps.rpc("irori_relay_whoami", { p_tenant: who.tenant });
      if (error) return internal(action, error);
      return data ? ok({ node: data.node, bell_topic: data.bell_topic }) : err(401, "unauthorized");
    }
    case "list": {
      const { data, error } = await deps.rpc("irori_relay_list", { p_tenant: who.tenant });
      return error ? internal(action, error) : ok({ members: data ?? [] });
    }
    case "inbox": {
      const { data, error } = await deps.rpc("irori_relay_inbox", { p_node: who.node });
      return error ? internal(action, error) : ok({ messages: data ?? [] });
    }
    case "ack": {
      const ids = b.ids;
      if (!Array.isArray(ids) || ids.length > 100 || !ids.every((i: unknown) => typeof i === "string" && UUID_RE.test(i))) return err(400, "bad_ids");
      const { data, error } = await deps.rpc("irori_relay_ack", { p_node: who.node, p_ids: ids });
      return error ? internal(action, error) : ok({ acked: data });
    }
    case "sent_status": {
      const ids = b.ids;
      if (!Array.isArray(ids) || ids.length > 50 || !ids.every((i: unknown) => typeof i === "string" && UUID_RE.test(i))) return err(400, "bad_ids");
      const { data, error } = await deps.rpc("irori_relay_sent_status", { p_node: who.node, p_ids: ids });
      return error ? internal(action, error) : ok({ status: data });
    }
    case "send": {
      if (typeof b.to_node !== "string" || typeof b.body !== "string") return err(400, "bad_request");
      const rt = typeof b.reply_to === "string" && UUID_RE.test(b.reply_to) ? b.reply_to : null;
      const er = expectsReplyArgs(b.expects_reply); // 寄件人明說要不要等回信（選填 boolean）；型別不對回 400
      if (!er) return err(400, "bad_expects_reply");
      const { data, error } = await deps.rpc("irori_relay_send", {
        p_from_node: who.node, // body 裡的 from_node 一律忽略
        p_from_agent: str100(b.from_agent), p_to_node: b.to_node, p_to_agent: str100(b.to_agent), p_body: b.body, p_reply_to: rt, ...er,
      });
      if (error) return internal(action, error);
      if (data?.error === "rate_limited") return err(429, "rate_limited");
      if (data?.error) return err(400, data.error);
      await deps.ring(data.bell_topic);
      return ok({ id: data.id });
    }
    case "invite": {
      const code = b64u(24);
      const { data, error } = await deps.rpc("irori_relay_invite", { p_node: who.node, p_code_hash: await sha256Hex(code), p_note: optStr(b.note, 200) });
      if (error) return internal(action, error);
      if (data?.error === "forbidden") return err(403, "forbidden");
      if (data?.error) return err(400, data.error);
      return ok({ invite: code, expires_at: data.expires_at, prefix: data.prefix });
    }
    case "reissue": {
      if (typeof b.id !== "string" || !ID_RE.test(b.id)) return err(400, "bad_request");
      const code = b64u(24);
      const { data, error } = await deps.rpc("irori_relay_reissue", { p_node: who.node, p_code_hash: await sha256Hex(code), p_id: b.id });
      if (error) return internal(action, error);
      if (data?.error === "forbidden") return err(403, "forbidden");
      if (data?.error === "not_found") return err(404, "not_found");
      if (data?.error) return err(400, data.error);
      return ok({ code, expires_at: data.expires_at });
    }
    case "update": {
      if (typeof b.id !== "string" || !ID_RE.test(b.id)) return err(400, "bad_request");
      const { data, error } = await deps.rpc("irori_relay_update", {
        p_node: who.node, p_id: b.id, p_machine: typeof b.machine === "string" ? b.machine : null, p_name: typeof b.name === "string" ? b.name : null,
      });
      if (error) return internal(action, error);
      if (data?.error === "forbidden") return err(403, "forbidden");
      if (data?.error === "not_found") return err(404, "not_found");
      if (data?.error) return err(400, data.error);
      return ok({ ok: true });
    }
  }
  return err(404, "not_found");
}
