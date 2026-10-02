// 群組（rooms）共用邏輯：irori-relay（節點／AI 用）與 irori-api（小良哥登入、希緒）共用，規劃見 docs/relay/GROUPS.md。
// 資料與權限的最後一道關在 supabase/sql/05_rooms.sql 的函式；這裡負責：解析 @點名、判定誰該回、節點動作的分派與拒絕。

// deno-lint-ignore no-explicit-any
type Json = any;

export const OWNER_KEY = "~owner"; // 小良哥本人的成員 key（節點代號不可能含 ~）
export const WINDOW_SEP = "~";
export const MAX_MENTIONS = 8;
export const BODY_MAX = 20000;
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

// 節點（AI）不准做的動作：建群組、改置頂、加人、移人。只有小良哥經 irori-api 能做
export const OWNER_ONLY_ACTIONS = new Set(["room_create", "room_add", "room_remove", "room_pin_set"]);

export type RoomMember = { key: string; name: string; role?: string; kind?: string; node_role?: string };
export type RoomMessage = { seq: number; from: string; from_name?: string; trust: string; body: string; mentions: string[]; at: string };

export const keyOf = (node: string, agent?: string | null) => (agent ? `${node}${WINDOW_SEP}${agent}` : node);

// 從內文找 @名字，對應成員 key。名字可含空白與中文（例如「@牧陽 Aegis」），最長的名字優先；
// 英數結尾的名字後面不能再接英數（@H-主線 不會誤中 @H-主線-3 的前半）。成員可用顯示名或 key 被點名；
// owner 角色的節點（希緒）另外可用「希緒」被點名。最多 MAX_MENTIONS 位，不含重複
export function parseMentions(body: string, members: RoomMember[], max = MAX_MENTIONS): string[] {
  const cands: { text: string; key: string }[] = [];
  for (const m of members) {
    const names = new Set([m.name, m.key]);
    if (m.key === OWNER_KEY) names.add("小良哥");
    else if (m.node_role === "owner") names.add("希緒");
    for (const n of names) if (n) cands.push({ text: n.toLowerCase(), key: m.key });
  }
  cands.sort((a, b) => b.text.length - a.text.length);
  const lower = body.toLowerCase();
  const found: string[] = [];
  for (let i = lower.indexOf("@"); i >= 0; i = lower.indexOf("@", i + 1)) {
    for (const c of cands) {
      if (!lower.startsWith(c.text, i + 1)) continue;
      const next = lower[i + 1 + c.text.length];
      if (/[a-z0-9_-]$/.test(c.text) && next !== undefined && /[a-z0-9_-]/.test(next)) continue;
      if (!found.includes(c.key)) found.push(c.key);
      break;
    }
    if (found.length >= max) break;
  }
  return found.slice(0, max);
}

// 這則訊息該不該由 selfKey 這位成員回：只有「被點名」或「owner（小良哥、希緒）發的」才回，自己發的不回
export function shouldRespond(msg: { from: string; trust: string; mentions?: string[] }, selfKey: string): boolean {
  if (msg.from === selfKey) return false;
  return msg.trust === "owner" || (msg.mentions ?? []).includes(selfKey);
}

export type RoomDeps = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: Json; error: unknown }>;
  ring: (topic: string) => Promise<void>;
  rosterHas: (node: string, agent: string) => Promise<boolean>;
};
export type Reply = { status: number; body: Json };

const err = (status: number, error: string, extra: Json = {}): Reply => ({ status, body: { error, ...extra } });
const num = (v: unknown): number | null => (typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

// SQL 函式回 {error: …} 時對應的 HTTP 狀態
export function statusOfError(e: string): number {
  switch (e) {
    case "rate_limited": return 429;
    case "forbidden": case "not_member": case "unknown_agent": return 403;
    case "not_found": return 404;
    case "id_taken": case "version_conflict": return 409;
    default: return 400;
  }
}

async function call(deps: RoomDeps, fn: string, args: Record<string, unknown>): Promise<{ data: Json } | Reply> {
  const { data, error } = await deps.rpc(fn, args);
  if (error) { console.error(fn, error); return err(500, "internal"); }
  if (data?.error) return err(statusOfError(data.error), data.error, data.version !== undefined ? { version: data.version } : {});
  return { data };
}
const isReply = (r: { data: Json } | Reply): r is Reply => "status" in r;

// 發言（節點與小良哥共用）：先查成員名單解析 @點名，再寫入，最後對每個成員節點敲門鈴
export async function postMessage(
  deps: RoomDeps, who: { node: string; agent?: string | null; owner?: boolean }, room: string, body: string,
): Promise<Reply> {
  const who3 = { p_node: who.node, p_agent: who.agent ?? null, p_room: room, p_owner: Boolean(who.owner) };
  const mem = await call(deps, "irori_relay_room_members", who3);
  if (isReply(mem)) return mem;
  const mentions = parseMentions(body, mem.data.members ?? []);
  const res = await call(deps, "irori_relay_room_post", { ...who3, p_body: body, p_mentions: mentions });
  if (isReply(res)) return res;
  await Promise.all((res.data.bell_topics ?? []).map((t: string) => deps.ring(t)));
  return { status: 200, body: { seq: res.data.seq, mentions } };
}

// 節點（AI）呼叫的群組動作。me 是金鑰決定的節點；params 是查詢參數與 JSON body 合併後的物件。
// 建群組、改置頂、加人、移人一律 403（只有小良哥經 irori-api 能做，連希緒 XISU 的金鑰也一樣）
export async function handleNodeRoomAction(deps: RoomDeps, me: { id: string }, action: string, params: Json): Promise<Reply> {
  if (OWNER_ONLY_ACTIONS.has(action)) {
    return err(403, "forbidden", { detail: "建群組、改置頂、加人與移人只有小良哥本人能在介面上做" });
  }
  const agent = typeof params.as_agent === "string" && params.as_agent ? params.as_agent : typeof params.from_agent === "string" && params.from_agent ? params.from_agent : null;
  if (agent && (agent.includes(WINDOW_SEP) || agent.length > 60)) return err(400, "bad_agent");
  const room = typeof params.room === "string" ? params.room : "";
  if (action !== "room_list" && !ROOM_ID_RE.test(room)) return err(400, "bad_request");

  if (action === "room_list") {
    const r = await call(deps, "irori_relay_room_list", { p_node: me.id, p_owner: false });
    return isReply(r) ? r : { status: 200, body: r.data };
  }
  if (action === "room_pin_get") {
    const r = await call(deps, "irori_relay_room_pin_get", { p_node: me.id, p_agent: agent, p_room: room, p_owner: false });
    return isReply(r) ? r : { status: 200, body: r.data };
  }
  if (action === "room_read") {
    const r = await call(deps, "irori_relay_room_read", {
      p_node: me.id, p_agent: agent, p_room: room, p_since: num(params.since), p_limit: num(params.limit),
      p_owner: false, p_tail: false, p_mark: params.mark === "1" || params.mark === true ? true : null,
    });
    if (isReply(r)) return r;
    const selfKey = r.data.key as string;
    const messages = (r.data.messages ?? []).map((m: RoomMessage) => ({ ...m, for_me: shouldRespond(m, selfKey) }));
    return { status: 200, body: { messages, last_seq: r.data.last_seq } };
  }
  if (action === "room_post") {
    const body = params.body;
    if (typeof body !== "string" || body.length < 1 || body.length > BODY_MAX) return err(400, "bad_body");
    // 視窗代發：視窗名要在該節點的 roster 內（SQL 也會再擋一次）
    if (agent && !(await deps.rosterHas(me.id, agent))) return err(403, "unknown_agent");
    return await postMessage(deps, { node: me.id, agent }, room, body);
  }
  return err(404, "not_found");
}

// 門鈴（不帶內容）：對 Supabase Realtime 廣播 bell
export async function ringBell(supabaseUrl: string, serviceKey: string, topic: string): Promise<void> {
  try {
    const r = await fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ topic, event: "bell", payload: {}, private: false }] }),
    });
    if (!r.ok) console.error("bell failed", r.status, await r.text());
  } catch (e) {
    console.error("bell error", String(e));
  }
}
