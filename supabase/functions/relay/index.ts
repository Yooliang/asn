// Relay broker. Node key goes in the x-relay-key header; the sender node is decided by the key.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleNodeRoomAction, type RoomDeps, syncNodeAuto } from "../_shared/rooms.ts";
import { handleAgentInbox } from "../_shared/agent_inbox.ts";
import { readNodeInbox } from "../_shared/inbox_exclude.ts";
import { ACCOUNT_ACTIONS, type AccountDeps, cleanDisplayName, handleAccountAction } from "../_shared/account.ts";
import { expectsReplyArgs } from "../_shared/expects_reply.ts";
import { parseSelfName } from "../_shared/node_name.ts";
import { parseAsnPresence } from "../_shared/asn_presence.ts";
import { handlePartnerList, handlePartnerSucceed, handlePartnerSync } from "../_shared/partners.ts";
import { bellTopicsOf, handleChatHistory, personArgs, sendWithPerson } from "../_shared/account_me.ts";
import { normalizeRosterAgents, rosterBellTopics } from "../_shared/roster.ts";
import { sanitizeClaudeMod } from "../_shared/claude_mod.ts";
import { checkAvatar } from "../_shared/avatar.ts";
import * as signal from "../_shared/signal.ts";
import { handleNodeLaunchAction, LAUNCH_ACTIONS, sanitizeLauncher } from "../_shared/launch.ts";
import { handleNodePartnerOpAction, PARTNER_OP_ACTIONS } from "../_shared/partner_ops.ts";
import { ACCT_ACTIONS, handleAcctAction } from "../_shared/account_switch.ts";
import { handleSecretAction, SECRET_ACTIONS } from "../_shared/secret_remote.ts";
import {
  ACTIONS as ATTACH_ACTIONS, bindAttachments, handleAttachAction, prepareAttachments, type StorageDeps, withAttachments,
  withRoomAttachments,
} from "../_shared/attachments.ts";
import { SIGN_HEADER, signedArgs, signedUserId } from "../_shared/owner_sign.ts";
import { requestReadSync } from "../_shared/read_sync.ts";
import { handleTts, TtsLimiter, ttsVoicesResponse } from "../_shared/tts.ts";

const ttsLimiter = new TtsLimiter();

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
    const { data, error } = await db.rpc("asn_relay_roster_has", { p_node: node, p_name: agent });
    return !error && data === true;
  },
});

// 附件放在私有 bucket「attachments」；只有這裡（service role）能簽上傳與下載網址
const ATTACH_BUCKET = "attachments";
const storage: StorageDeps = {
  signUpload: async (path) => {
    const { data, error } = await db.storage.from(ATTACH_BUCKET).createSignedUploadUrl(path);
    if (error || !data?.signedUrl) { console.error("signUpload", error); return null; }
    return data.signedUrl;
  },
  info: async (path) => {
    const { data, error } = await db.storage.from(ATTACH_BUCKET).info(path);
    if (error || !data) return null;
    return { size: Number(data.size), mime: String(data.contentType ?? "") };
  },
  signDownload: async (path, seconds, filename) => {
    const { data, error } = await db.storage.from(ATTACH_BUCKET).createSignedUrl(path, seconds, { download: filename });
    if (error || !data?.signedUrl) { console.error("signDownload", error); return null; }
    return data.signedUrl;
  },
  remove: async (paths) => {
    const { error } = await db.storage.from(ATTACH_BUCKET).remove(paths);
    if (error) console.error("storage remove", error);
    return !error;
  },
};
const rpc = async (fn: string, args: Record<string, unknown>) => await db.rpc(fn, args);

const b64u = (n: number) =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const optStr = (v: unknown, n: number) => (typeof v === "string" && v ? v.slice(0, n) : null);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 登入帳號的動作：用 Supabase 登入憑證（Authorization: Bearer）驗身分，不用節點金鑰（node_claim 另帶 x-relay-key 證明擁有）
const accountDeps: AccountDeps = {
  verifyJwt: async (token) => {
    const { data, error } = await db.auth.getUser(token);
    const u = data?.user;
    if (error || !u || u.is_anonymous) return null;
    const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
    return { id: u.id, email: u.email ?? null, name: cleanDisplayName(meta.full_name ?? meta.name ?? meta.user_name) };
  },
  rpc: async (fn, args) => await db.rpc(fn, args),
  sha256Hex,
  newSecrets: () => ({ key: b64u(32), bellTopic: "relay-bell-" + b64u(18) }),
};

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
      ? await db.rpc("asn_relay_redeem_reissue", {
        p_ip_hash: ipHash, p_code_hash: await sha256Hex(b.reissue), p_id: b.id,
        p_key_hash: await sha256Hex(key), p_bell_topic: bellTopic,
      })
      : await db.rpc("asn_relay_register", {
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

  // 登入帳號的動作（在節點金鑰驗證之前：身分來自登入憑證，見 _shared/account.ts）
  if (action && ACCOUNT_ACTIONS.has(action)) {
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    const raw = await req.json().catch(() => null);
    const r = await handleAccountAction(accountDeps, action, req.headers.get("authorization"), req.headers.get("x-relay-key"), raw);
    return json(r.status, r.body);
  }

  const key = req.headers.get("x-relay-key");
  if (!key) return json(401, { error: "unauthorized" });
  const { data: nodes, error: aerr } = await db.rpc("asn_relay_auth", { p_key_hash: await sha256Hex(key) });
  if (aerr) { console.error(aerr); return json(500, { error: "internal" }); }
  if (!nodes || nodes.length === 0) return json(401, { error: "unauthorized" });
  const me = nodes[0] as { id: string; bell_topic: string; role: string; tenant_id: string | null };

  // 附件：要上傳網址、確認上傳、換下載網址、清理（見 _shared/attachments.ts、docs/ATTACHMENTS.md）
  if (action && ATTACH_ACTIONS.has(action)) {
    if (action !== "attach_url" && req.method !== "POST") return json(405, { error: "method_not_allowed" });
    const raw = req.method === "POST" ? await req.json().catch(() => null) : null;
    const params = { ...Object.fromEntries(url.searchParams), ...(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) };
    const r = await handleAttachAction({ rpc, storage }, me, action, params);
    return json(r.status, r.body);
  }

  if (action === "whoami" && req.method === "GET") {
    return json(200, { node: me.id, bell_topic: me.bell_topic });
  }
  if (action === "list" && req.method === "GET") {
    const { data, error } = await db.rpc("asn_relay_list", { p_tenant: me.tenant_id });
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    return json(200, { members: data });
  }
  // 設備大頭貼：list 只帶各節點的 avatar_updated_at（不帶圖，名單輪詢流量不跟著放大）；圖用 avatar 動作按需取（限同租戶）。
  // set_avatar 只能改金鑰所屬的自己節點（p_node 一律是 me.id，body 裡不接受指定節點）；avatar 為 null＝移除。
  if (action === "set_avatar" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b || typeof b !== "object" || !("avatar" in b)) return json(400, { error: "bad_request" });
    const c = checkAvatar(b.avatar);
    if (!c.ok) return json(400, { error: c.error });
    const { data, error } = await db.rpc("asn_relay_set_avatar", { p_node: me.id, p_avatar: c.avatar });
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    if (data?.error === "forbidden") return json(403, { error: "forbidden" });
    if (data?.error === "bad_avatar") return json(400, { error: "bad_avatar_format" });
    if (data?.error) return json(400, { error: data.error });
    return json(200, { ok: true, avatar_updated_at: data.avatar_updated_at });
  }
  if (action === "avatar" && req.method === "GET") {
    const node = url.searchParams.get("node") ?? "";
    if (!ID_RE.test(node)) return json(400, { error: "bad_request" });
    const { data, error } = await db.rpc("asn_relay_get_avatar", { p_tenant: me.tenant_id, p_node: node });
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    if (data?.error === "not_found") return json(404, { error: "not_found" });
    return json(200, data);
  }
  // 念出訊息：節點金鑰驗證後轉給 Cloudflare Worker（Edge TTS，僅個人用，預設不啟用）；節點代號只取自金鑰，限長度與頻率（見 _shared/tts.ts）
  if (action === "tts_voices" && req.method === "GET") return ttsVoicesResponse({ env: (k) => Deno.env.get(k) });
  if (action === "tts" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    return await handleTts({ env: (k) => Deno.env.get(k), fetch, now: Date.now, limiter: ttsLimiter }, me.id, b);
  }
  if (action === "roster" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b || !Array.isArray(b.agents)) return json(400, { error: "bad_request" });
    const agents = normalizeRosterAgents(b.agents); // name／status／cwd_label／engine（舊版機器橋沒帶 engine ＝ null）
    const { data, error } = await db.rpc("asn_relay_roster", { p_node: me.id, p_agents: agents });
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    if (data?.error === "forbidden") return json(403, { error: "forbidden" });
    if (data?.error) return json(400, { error: data.error });
    // 名單有變（忙碌／閒置／說明）：資料庫回同帳號其他設備的門鈴（已做 2 秒頻率限制），敲一下讓它們立刻重拉名單。舊資料庫沒這個鍵＝不敲
    for (const t of rosterBellTopics(data)) await ring(t);
    // 機器橋把本機 launcher.json 的摘要（profile 名、cwd 白名單、每小時上限）附在名單一起回報；沒帶 launcher 欄位就不動
    if ("launcher" in b) {
      const l = sanitizeLauncher(b.launcher);
      if (l && "error" in l) return json(400, { error: "bad_request" });
      const { data: ld, error: le } = await db.rpc("asn_relay_set_launcher", { p_node: me.id, p_launcher: l });
      if (le) console.error(le);
      else if (ld?.error) console.warn("set_launcher", me.id, ld.error);
    }
    // 這台電腦的 Claude 外掛狀態（選填 mod；啟動檢查完與狀態變化時才帶）。格式不對或舊資料庫沒有這支函式都只記 log，不影響名單
    if ("mod" in b) {
      const cm = sanitizeClaudeMod(b.mod);
      if (cm) {
        const { data: md, error: me2 } = await db.rpc("asn_relay_set_claude_mod", { p_node: me.id, p_mod: cm });
        if (me2) console.warn("set_claude_mod", me.id, me2.message ?? me2);
        else if (md?.error) console.warn("set_claude_mod", me.id, md.error);
      }
    }
    // 視窗名單更新後：符合群組「自動收入」開頭字串的視窗自動入群，消失的標為離開（不是 AI 加人，是比對 roster）
    await syncNodeAuto(roomDeps(), me.id, agents.map((a: { name: unknown }) => a.name).filter((n: unknown): n is string => typeof n === "string"));
    return json(200, { ok: true, count: data.count });
  }
  // 節點改自己的顯示名（ASN 把視窗名寫進來；只改自己這一列的 name）
  if (action === "set_name" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    const name = parseSelfName(b?.name);
    if (name === null) return json(400, { error: "bad_request" });
    const { data, error } = await db.rpc("asn_relay_set_self_name", { p_node: me.id, p_name: name });
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    if (data?.error === "not_found") return json(404, { error: "not_found" });
    if (data?.error) return json(400, { error: data.error });
    return json(200, { ok: true });
  }
  // ASN 回報在線狀態與版本（每 60 秒一次；關閉時 status=offline＝刪掉那一列）。節點一律是金鑰所屬的 me.id
  if (action === "asn_presence" && req.method === "POST") {
    const p = parseAsnPresence(await req.json().catch(() => null));
    if (p === null) return json(400, { error: "bad_request" });
    const { data, error } = await db.rpc("asn_relay_asn_presence_set", {
      p_node: me.id, p_window: p.window_name, p_version: p.version, p_status: p.status, p_psm: p.psm,
    });
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    if (data?.error === "not_found") return json(404, { error: "not_found" });
    if (data?.error === "too_many") return json(429, { error: "too_many" });
    if (data?.error) return json(400, { error: data.error });
    // 順便回報「本人有沒有要這台更新」（遠端更新；失敗不影響在線回報）。offline 不問
    let update_requested = false;
    if (p.status !== "offline") {
      const u = await db.rpc("asn_relay_asn_update_poll", { p_node: me.id, p_version: p.version });
      if (u.error) console.error(u.error);
      else update_requested = u.data?.requested === true;
    }
    return json(200, update_requested ? { ok: true, update_requested: true } : { ok: true });
  }
  // 遠端更新的結果（ASN 取走請求後回報：ok＝例如已是最新版，false＝失敗與原因）。只動金鑰所屬的自己節點
  if (action === "asn_update_result" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b || typeof b !== "object" || typeof b.ok !== "boolean" || (b.detail != null && typeof b.detail !== "string")) return json(400, { error: "bad_request" });
    const { data, error } = await db.rpc("asn_relay_asn_update_result", { p_node: me.id, p_ok: b.ok, p_detail: b.detail ?? null });
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    if (data?.error) return json(400, { error: data.error });
    return json(200, { ok: true });
  }
  // 夥伴 ID（#109）：ASN 內建橋回報視窗名單時順便送「名字＋session」，後端判斷是哪位夥伴並回夥伴 ID。節點一律是金鑰所屬的 me.id
  if (action === "partner_sync" && req.method === "POST") {
    const r = await handlePartnerSync({ rpc }, me, await req.json().catch(() => null));
    return json(r.status, r.body);
  }
  // 夥伴 ID 第二期（#153）：指定「這是某某的接班」、列出可被接班的夥伴。都要本人簽章（x-asn-user），節點一律是金鑰所屬的 me.id
  if (action === "partner_succeed" && req.method === "POST") {
    const r = await handlePartnerSucceed({ rpc, verifyJwt: accountDeps.verifyJwt }, me, req.headers.get(SIGN_HEADER), await req.json().catch(() => null));
    return json(r.status, r.body);
  }
  if (action === "partner_list" && req.method === "POST") {
    const r = await handlePartnerList({ rpc, verifyJwt: accountDeps.verifyJwt }, me, req.headers.get(SIGN_HEADER));
    return json(r.status, r.body);
  }
  // 往來記錄（#108）：「我和某夥伴」90 天內的信，以後台為準。必須帶本人簽章（x-asn-user）：AI 視窗拿得到節點金鑰，拿不到登入憑證
  if (action === "chat_history" && req.method === "POST") {
    const r = await handleChatHistory(
      { rpc, verifyJwt: accountDeps.verifyJwt, withAttachments: async (m) => await withAttachments({ rpc }, m as never) },
      me, req.headers.get(SIGN_HEADER), await req.json().catch(() => null),
    );
    return json(r.status, r.body);
  }
  if (action === "leave" && req.method === "POST") {
    const { error } = await db.rpc("asn_relay_leave", { p_node: me.id });
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    return json(200, { ok: true });
  }
  if (action === "update" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b || typeof b.id !== "string" || !ID_RE.test(b.id)) return json(400, { error: "bad_request" });
    const { data, error } = await db.rpc("asn_relay_update", {
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
    const { data, error } = await db.rpc("asn_relay_invite", {
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
    const { data, error } = await db.rpc("asn_relay_reissue", {
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
    if (r.status === 200) (r.body as { messages: unknown }).messages = await withAttachments({ rpc }, (r.body as { messages: unknown }).messages);
    return json(r.status, r.body);
  }
  // 只看不收（asn-cli recv --peek）：唯讀，不 ack、不設 delivered_at
  if (action === "inbox_peek" && req.method === "GET") {
    const r = await handleAgentInbox({ rpc: async (fn, args) => await db.rpc(fn, args) }, me, "inbox_peek", url.searchParams.get("agent"));
    return json(r.status, r.body);
  }
  if (action === "ack" && req.method === "POST" && url.searchParams.has("agent")) {
    const b = await req.json().catch(() => null);
    const r = await handleAgentInbox({ rpc: async (fn, args) => await db.rpc(fn, args) }, me, "ack", url.searchParams.get("agent"), b);
    return json(r.status, r.body);
  }
  if (action === "inbox" && req.method === "GET") {
    const { data, error } = await readNodeInbox((fn, args) => db.rpc(fn, args), me.id, url.searchParams.get("exclude"));
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    return json(200, { messages: await withAttachments({ rpc }, data) });
  }
  if (action === "ack" && req.method === "POST") {
    const b = await req.json().catch(() => null);
    const ids = b?.ids;
    if (!Array.isArray(ids) || ids.length > 100 || !ids.every((i: unknown) => typeof i === "string" && UUID.test(i))) {
      return json(400, { error: "bad_ids" });
    }
    const { data, error } = await db.rpc("asn_relay_ack", { p_node: me.id, p_ids: ids });
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
    const { data, error } = await db.rpc("asn_relay_sent_status", { p_node: me.id, p_ids: ids });
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
    // 附件（選填 attachment_ids）：寄出前確認都是自己上傳、已確認、沒綁過的；寄出後綁到這封信，再敲門鈴（收信端一響就能看到附件）
    const att = await prepareAttachments({ rpc }, me.id, b.attachment_ids);
    if (!att.ok) return json(att.reply.status, att.reply.body);
    // 本人簽章（選填）：ASN 視窗另帶登入憑證；驗過才傳使用者 id，資料庫再核對擁有關係。沒帶或驗不過＝照舊，不擋寄送
    const signed = await signedUserId(accountDeps.verifyJwt, req.headers.get(SIGN_HEADER));
    // 以「人」寄出（#108）：新版 ASN 明說 as_person 且簽章有效，資料庫才把寄件視窗名換成人代號；沒說＝與以前完全一樣
    const { data, error } = await sendWithPerson(rpc, {
      ...signedArgs(signed),
      ...personArgs(b.as_person, signed),
      p_from_node: me.id, // from_node in the body is ignored on purpose
      p_from_agent: str(b.from_agent),
      p_to_node: b.to_node,
      p_to_agent: str(b.to_agent),
      p_body: b.body,
      p_reply_to: rt,
      ...er,
    });
    if (error) { console.error(error); return json(500, { error: "internal" }); }
    const sent = data as { id: string; bell_topic: string; error?: string };
    if (sent?.error === "rate_limited") return json(429, { error: "rate_limited" });
    if (sent?.error) return json(400, { error: sent.error });
    await bindAttachments({ rpc }, me.id, att.ids, { messageId: sent.id });
    // 回信寄給人代號時會扇出給這個帳號所有在線的 ASN，每台的門鈴都敲
    for (const t of bellTopicsOf(sent)) await ring(t);
    return json(200, { id: sent.id });
  }
  // 遠端開視窗：launch／launchers 只有 owner 節點（SQL 判斷）；launch_pending／launch_result 是機器橋取待辦、回報結果
  if (action && LAUNCH_ACTIONS.has(action)) {
    const raw = req.method === "POST" ? await req.json().catch(() => null) : null;
    const params = { ...Object.fromEntries(url.searchParams), ...(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) };
    // 本人簽章（選填）：手機與登入建立的電腦節點不是 owner 角色，靠簽章（資料庫再核對「節點與租戶都是這個人的」）證明本人；沒簽章＝與以前完全相同
    const signedLaunch = (action === "launch" || action === "launchers") ? await signedUserId(accountDeps.verifyJwt, req.headers.get(SIGN_HEADER)) : null;
    const r = await handleNodeLaunchAction({ rpc: async (fn, args) => await db.rpc(fn, args), ring }, me, action, params, signedLaunch);
    return json(r.status, r.body);
  }
  // 已讀多端同步（_shared/read_sync.ts）：要本人簽章，沒簽章 401 不打資料庫；一次寫入我這端的已讀位置並取回整個帳號的
  if (action === "read_sync") {
    const raw = req.method === "POST" ? await req.json().catch(() => null) : null;
    const signedRead = await signedUserId(accountDeps.verifyJwt, req.headers.get(SIGN_HEADER));
    const r = await requestReadSync({ rpc: async (fn, args) => await db.rpc(fn, args), ring }, me.id, raw, signedRead);
    return json(r.status, r.body);
  }
  // 遠端管理夥伴視窗（詳情、改名、切換模型、關閉、轉交）：partner_op／partner_ops 是手機下令與查進度（一定要本人簽章，沒簽章 401 不打資料庫）；
  // partner_op_pending／partner_op_result 是電腦端內建收發室取待辦、回報結果（只動得到自己節點的）
  if (action && PARTNER_OP_ACTIONS.has(action)) {
    const raw = req.method === "POST" ? await req.json().catch(() => null) : null;
    const params = { ...Object.fromEntries(url.searchParams), ...(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) };
    const signedOp = (action === "partner_op" || action === "partner_ops" || action === "partner_archive") ? await signedUserId(accountDeps.verifyJwt, req.headers.get(SIGN_HEADER)) : null;
    const r = await handleNodePartnerOpAction({ rpc: async (fn, args) => await db.rpc(fn, args), ring }, me, action, params, signedOp);
    return json(r.status, r.body);
  }
  // 遠端一次性密碼傳遞（#26 第二期，見 _shared/secret_remote.ts）：secret_request／secret_fetch 是請求端；secret_pending／secret_reply 是本人設備，一定要本人簽章（沒簽章 401 不打資料庫）。
  // 密文只轉不看：不進 log，只出現在 secret_reply 的資料庫參數與 secret_fetch 的回應。
  if (action && SECRET_ACTIONS.has(action)) {
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    const raw = await req.json().catch(() => null);
    const signedSecret = (action === "secret_pending" || action === "secret_reply") ? await signedUserId(accountDeps.verifyJwt, req.headers.get(SIGN_HEADER)) : null;
    const r = await handleSecretAction({ rpc: async (fn, args) => await db.rpc(fn, args), ring }, me, action, raw, signedSecret);
    return json(r.status, r.body);
  }
  // 遠端切換 Claude 帳號（ASN 帳號管理，見 _shared/account_switch.ts）：
  // acct_list／acct_switch／acct_switch_status 只有擁有者節點（SQL 判斷）；acct_report／acct_switch_pending／acct_switch_result 只動金鑰所屬的自己節點。權杖不經過收發室。
  if (action && ACCT_ACTIONS.has(action)) {
    const raw = req.method === "POST" ? await req.json().catch(() => null) : null;
    const params = { ...Object.fromEntries(url.searchParams), ...(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) };
    const r = await handleAcctAction({ rpc: async (fn, args) => await db.rpc(fn, args), ring }, me, action, params);
    return json(r.status, r.body);
  }
  // 群組：建群組、改置頂、加人、移人對節點金鑰一律 403（見 _shared/rooms.ts）；其餘（列表、讀、發言、讀置頂）限成員
  if (action?.startsWith("room_")) {
    const raw = req.method === "POST" ? await req.json().catch(() => null) : null;
    const params = { ...Object.fromEntries(url.searchParams), ...(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) };
    const deps = roomDeps();
    // 本人簽章（選填，只有發言用）：驗過就在寫入訊息的資料庫呼叫多帶使用者 id；其餘 room_ 動作不讀這個標頭
    if (action === "room_post") {
      const signed = await signedUserId(accountDeps.verifyJwt, req.headers.get(SIGN_HEADER));
      if (signed) {
        deps.rpc = async (fn, args) =>
          await db.rpc(fn, fn === "asn_relay_room_post" ? { ...args, ...signedArgs(signed) } : args);
      }
    }
    // 群組發言帶附件：寄出前先驗；訊息寫入後、敲門鈴前綁到這則訊息
    let attIds: string[] = [];
    if (action === "room_post") {
      const att = await prepareAttachments({ rpc }, me.id, params.attachment_ids);
      if (!att.ok) return json(att.reply.status, att.reply.body);
      attIds = att.ids;
      const roomId = typeof params.room === "string" ? params.room : "";
      if (attIds.length) deps.beforeRing = async (seq) => { await bindAttachments({ rpc }, me.id, attIds, { room: roomId, seq }); };
    }
    const r = await handleNodeRoomAction(deps, me, action, params);
    if (action === "room_read" && r.status === 200 && typeof params.room === "string") {
      r.body.messages = await withRoomAttachments({ rpc }, params.room, r.body.messages);
    }
    return json(r.status, r.body);
  }
  return json(404, { error: "not_found" });
});
