// Relay broker. Node key goes in the x-relay-key header; the sender node is decided by the key.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleNodeRoomAction, type RoomDeps, syncNodeAuto } from "../_shared/rooms.ts";
import { handleAgentInbox } from "../_shared/agent_inbox.ts";
import { expectsReplyArgs } from "../_shared/expects_reply.ts";
import { normalizeRosterAgents } from "../_shared/roster.ts";
import * as signal from "../_shared/signal.ts";
import { handleNodeLaunchAction, LAUNCH_ACTIONS, sanitizeLauncher } from "../_shared/launch.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Doorbell: broadcast carries no mail content.
// Also write the Firebase RTDB bell node b/<hash> = { at } (pointer only, see docs/relay/SIGNAL.md): devices that listen to it
// pull /updates only when it changes. No-op when IRORI_FIREBASE_DB_URL / IRORI_FIREBASE_SA are not both set; failures only log.
async function ring(topic: string) {
  try {
    const r = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ topic, event: "bell", payload: {}, private: false }] }),
    });
    if (!r.ok) console.error("bell failed", r.status, await r.text());
  } catch (e) {
    console.error("bell error", String(e));
  }
  signal.background(signal.putBell(topic));
}

const roomDeps = (): RoomDeps => ({
  rpc: async (fn, args) => await db.rpc(fn, args),
  ring,
  rosterHas: async (node, agent) => {
    const { data, error } = await db.rpc("irori_relay_roster_has", { p_node: node, p_name: agent });
    return !error && data === true;
  },
});

const b64u = (n: number) =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const optStr = (v: unknown, n: number) => (typeof v === "string" && v ? v.slice(0, n) : null);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (action === "register" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    const reissue = typeof b?.reissue === "string" && b.reissue;
    if (!b || typeof b.id !== "string" || !ID_RE.test(b.id) || (!reissue && typeof b.invite !== "string")) {
      return json(400, { error: "bad_request" });
    }
    if (!reissue && (typeof b.name !== "string" || typeof b.machine !== "string" || b.machine.length < 1 || b.machine.length > 40)) {
      return json(400, { error: "bad_request" });
    }
    const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
    const key = b64u(32);
    const bellTopic = "relay-bell-" + b64u(18);
    const ipHash = await sha256Hex("ip:" + ip);
    const { data, error } = reissue
      ? await db.rpc("irori_relay_redeem_reissue", {
        p_ip_hash: ipHash, p_code_hash: await sha256Hex(b.reissue), p_id: b.id,
        p_key_hash: await sha256Hex(key), p_bell_topic: bellTopic,
      })
      : await db.rpc("irori_relay_register", {
        p_ip_hash: ipHash,
        p_code_hash: await sha256Hex(b.invite),
        p_id: b.id,
        p_name: b.name,
        p_kind: optStr(b.kind, 20),
        p_machine: b.machine,
        p_note: optStr(b.note, 500),
        p_key_hash: await sha256Hex(key),
        p_bell_topic: bellTopic,
      });
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    if (data?.error === "rate_limited") return json(429, { error: "rate_limited" });
    if (data?.error === "id_taken") return json(409, { error: "id_taken" });
    if (data?.error === "invalid_invite") return json(403, { error: "invalid_invite" });
    if (data?.error === "bad_id_prefix") return json(403, { error: "bad_id_prefix", prefix: data.prefix });
    if (data?.error) return json(400, { error: data.error });
    return json(200, { id: data.id, key, bell_topic: data.bell_topic });
  }

  const key = req.headers.get("x-relay-key");
  if (!key) return json(401, { error: "unauthorized" });
  const { data: nodes, error: aerr } = await db.rpc("irori_relay_auth", { p_key_hash: await sha256Hex(key) });
  if (aerr) { console.error(aerr); return json(500, { error: "internal" }); }
  if (!nodes || nodes.length === 0) return json(401, { error: "unauthorized" });
  const me = nodes[0] as { id: string; bell_topic: string; role: string; tenant_id: string | null };

  if (action === "whoami" && req.method === "GET") {
    return json(200, { node: me.id, bell_topic: me.bell_topic });
  }
  if (action === "list" && req.method === "GET") {
    const { data, error } = await db.rpc("irori_relay_list", { p_tenant: me.tenant_id });
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    return json(200, { members: data });
  }
  if (action === "roster" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b || !Array.isArray(b.agents)) return json(400, { error: "bad_request" });
    const agents = normalizeRosterAgents(b.agents); // name／status／cwd_label／engine（舊版機器橋沒帶 engine ＝ null）
    const { data, error } = await db.rpc("irori_relay_roster", { p_node: me.id, p_agents: agents });
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    if (data?.error === "forbidden") return json(403, { error: "forbidden" });
    if (data?.error) return json(400, { error: data.error });
    // 機器橋把本機 launcher.json 的摘要（profile 名、cwd 白名單、每小時上限）附在名單一起回報；沒帶 launcher 欄位就不動
    if ("launcher" in b) {
      const l = sanitizeLauncher(b.launcher);
      if (l && "error" in l) return json(400, { error: "bad_request" });
      const { data: ld, error: le } = await db.rpc("irori_relay_set_launcher", { p_node: me.id, p_launcher: l });
      if (le) console.error(le);
      else if (ld?.error) console.warn("set_launcher", me.id, ld.error);
    }
    // 視窗名單更新後：符合群組「自動收入」開頭字串的視窗自動入群，消失的標為離開（不是 AI 加人，是比對 roster）
    await syncNodeAuto(roomDeps(), me.id, agents.map((a: { name: unknown }) => a.name).filter((n: unknown): n is string => typeof n === "string"));
    return json(200, { ok: true, count: data.count });
  }
  if (action === "leave" && req.method === "POST") {
    const { error } = await db.rpc("irori_relay_leave", { p_node: me.id });
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    return json(200, { ok: true });
  }
  if (action === "update" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b || typeof b.id !== "string" || !ID_RE.test(b.id)) return json(400, { error: "bad_request" });
    const { data, error } = await db.rpc("irori_relay_update", {
      p_node: me.id, p_id: b.id, p_machine: typeof b.machine === "string" ? b.machine : null,
      p_name: typeof b.name === "string" ? b.name : null,
    });
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    if (data?.error === "forbidden") return json(403, { error: "forbidden" });
    if (data?.error === "not_found") return json(404, { error: "not_found" });
    if (data?.error) return json(400, { error: data.error });
    return json(200, { ok: true });
  }
  if (action === "invite" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const code = b64u(24);
    const { data, error } = await db.rpc("irori_relay_invite", {
      p_node: me.id, p_code_hash: await sha256Hex(code), p_note: optStr(b?.note, 200),
    });
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    if (data?.error === "forbidden") return json(403, { error: "forbidden" });
    if (data?.error) return json(400, { error: data.error });
    return json(200, { invite: code, expires_at: data.expires_at, prefix: data.prefix });
  }
  if (action === "reissue" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b || typeof b.id !== "string" || !ID_RE.test(b.id)) return json(400, { error: "bad_request" });
    const code = b64u(24);
    const { data, error } = await db.rpc("irori_relay_reissue", {
      p_node: me.id, p_code_hash: await sha256Hex(code), p_id: b.id,
    });
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    if (data?.error === "forbidden") return json(403, { error: "forbidden" });
    if (data?.error === "not_found") return json(404, { error: "not_found" });
    if (data?.error) return json(400, { error: data.error });
    return json(200, { code, expires_at: data.expires_at });
  }
  // 視窗自己收信：帶 agent 參數時只看／只 ack 寄給該視窗的信（見 _shared/agent_inbox.ts）；沒帶 agent 的走下面原本的節點信箱
  if (action === "inbox" && req.method === "GET" && url.searchParams.has("agent")) {
    const r = await handleAgentInbox({ rpc: async (fn, args) => await db.rpc(fn, args) }, me, "inbox", url.searchParams.get("agent"));
    return json(r.status, r.body);
  }
  if (action === "ack" && req.method === "POST" && url.searchParams.has("agent")) {
    const b = await req.json().catch(() => null);
    const r = await handleAgentInbox({ rpc: async (fn, args) => await db.rpc(fn, args) }, me, "ack", url.searchParams.get("agent"), b);
    return json(r.status, r.body);
  }
  if (action === "inbox" && req.method === "GET") {
    const { data, error } = await db.rpc("irori_relay_inbox", { p_node: me.id });
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    return json(200, { messages: data });
  }
  if (action === "ack" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    const ids = b?.ids;
    if (!Array.isArray(ids) || ids.length > 100 || !ids.every((i: unknown) => typeof i === "string" && UUID.test(i))) {
      return json(400, { error: "bad_ids" });
    }
    const { data, error } = await db.rpc("irori_relay_ack", { p_node: me.id, p_ids: ids });
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    return json(200, { acked: data });
  }
  // 寄件人查自己寄出的信送到哪了（只回 from_node＝自己的）
  if (action === "sent_status" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    const ids = b?.ids;
    if (!Array.isArray(ids) || ids.length > 50 || !ids.every((i: unknown) => typeof i === "string" && UUID.test(i))) {
      return json(400, { error: "bad_ids" });
    }
    const { data, error } = await db.rpc("irori_relay_sent_status", { p_node: me.id, p_ids: ids });
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    return json(200, { status: data });
  }
  if (action === "send" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b || typeof b.to_node !== "string" || typeof b.body !== "string") return json(400, { error: "bad_request" });
    const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 100) : null);
    const rt = typeof b.reply_to === "string" && UUID.test(b.reply_to) ? b.reply_to : null;
    // expects_reply：寄件人明說要不要等回信（選填 boolean，給了就存；型別不對回 400）。沒給就不帶這個參數，信的欄位是 null（舊寄件工具）
    const er = expectsReplyArgs(b.expects_reply);
    if (!er) return json(400, { error: "bad_expects_reply" });
    const { data, error } = await db.rpc("irori_relay_send", {
      p_from_node: me.id, // from_node in the body is ignored on purpose
      p_from_agent: str(b.from_agent),
      p_to_node: b.to_node,
      p_to_agent: str(b.to_agent),
      p_body: b.body,
      p_reply_to: rt,
      ...er,
    });
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    if (data?.error === "rate_limited") return json(429, { error: "rate_limited" });
    if (data?.error) return json(400, { error: data.error });
    await ring(data.bell_topic);
    return json(200, { id: data.id });
  }
  // 遠端開視窗：launch／launchers 只有 owner 節點（SQL 判斷）；launch_pending／launch_result 是機器橋取待辦、回報結果
  if (action && LAUNCH_ACTIONS.has(action)) {
    const raw = req.method === "POST" ? await req.json().catch(() => null) : null;
    const params = { ...Object.fromEntries(url.searchParams), ...(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) };
    const r = await handleNodeLaunchAction({ rpc: async (fn, args) => await db.rpc(fn, args), ring }, me, action, params);
    return json(r.status, r.body);
  }
  // 群組：建群組、改置頂、加人、移人對節點金鑰一律 403（見 _shared/rooms.ts）；其餘（列表、讀、發言、讀置頂）限成員
  if (action?.startsWith("room_")) {
    const raw = req.method === "POST" ? await req.json().catch(() => null) : null;
    const params = { ...Object.fromEntries(url.searchParams), ...(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) };
    const deps = roomDeps();
    const r = await handleNodeRoomAction(deps, me, action, params);
    return json(r.status, r.body);
  }
  return json(404, { error: "not_found" });
});
