// 群組（rooms）共用邏輯：節點（AI）用的 relay 函式與帳號擁有者登入用的路徑共用，規劃見 docs/relay/GROUPS.md（早期設計）。
// 資料與權限的最後一道關在 supabase/sql/05_rooms.sql 的函式；這裡負責：解析 @點名、判定誰該回、節點動作的分派與拒絕。

// deno-lint-ignore no-explicit-any
type Json = any;
import { noteHeld, type RankInput, type RoomRank } from "./wake_rank.ts";

export const OWNER_KEY = "~owner"; // 帳號擁有者本人的成員 key（節點代號不可能含 ~）；顯示名取租戶的帳號名稱
export const WINDOW_SEP = "~";
export const MAX_MENTIONS = 8;
export const BODY_MAX = 20000;
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

// 節點（AI）不准做的動作：建群組、改置頂、加人、移人。只有帳號擁有者本人（登入身分）能做
export const OWNER_ONLY_ACTIONS = new Set(["room_create", "room_add", "room_remove", "room_pin_set"]);

// 危險操作類別（規格 2.5.1）：被別人點名的 AI 做這些之前，必須先請主持人在群組確認
export const CONFIRM_KINDS = ["data_change", "deploy", "spend", "external_send", "account_config", "other"] as const;

export type RoomMember = { key: string; name: string; role?: string; kind?: string; node_role?: string; label?: string; display_label?: string; member_kind?: string };
export type RoomMessage = {
  seq: number; from: string; from_name?: string; trust: string; body: string; mentions: string[]; at: string;
  // 第 1a 期（多租戶群組）新增，舊後台沒有
  from_kind?: string; relation?: string; from_label?: string; from_display_label?: string; from_owner_name?: string | null; is_seed?: boolean; wake_ok?: boolean;
  // 已讀人數（#224）：除發言者外、這則可見的成員中讀到這則的人數與總數；讀者這邊發的另有名單。舊後台沒有
  read_count?: number; read_total?: number; read_by?: string[]; unread_by?: string[];
  // #231：第一次算出的叫醒結果（讀者看得到的成員，依順序；略過者 hold）。舊後台沒有
  wake_info?: { key: string; label: string; rank: number; hold: boolean; fb?: boolean; limited?: boolean }[] | null;
};

export const keyOf = (node: string, agent?: string | null) => (agent ? `${node}${WINDOW_SEP}${agent}` : node);

// 從內文找 @名字，對應成員 key。名字可含空白與中文（例如「@牧陽 Aegis」），最長的名字優先；
// 英數結尾的名字後面不能再接英數（@H-主線 不會誤中 @H-主線-3 的前半）。成員可用顯示名或 key 被點名；
// 帳號擁有者（~owner）的顯示名取租戶的帳號名稱，另可用通用的「主人」被點名；舊租戶的角色節點只能用名稱或 key 被點名。最多 MAX_MENTIONS 位，不含重複
const MENTION_END = /[\s\p{P}\p{S}]/u;

export function parseMentions(body: string, members: RoomMember[], max = MAX_MENTIONS): string[] {
  const cands: { text: string; key: string }[] = [];
  // 同名的成員（例如兩位主人各有一個同名 AI）：只認完整標示（label，例如「H-主線（牧陽）」）與成員鍵，不吃只打夥伴名的點名
  const nameCount = new Map<string, number>();
  for (const m of members) nameCount.set(m.name, (nameCount.get(m.name) ?? 0) + 1);
  for (const m of members) {
    const names = new Set([m.key]);
    if (m.name && (nameCount.get(m.name) ?? 0) < 2) names.add(m.name);
    if (m.label) names.add(m.label);
    if (m.display_label) names.add(m.display_label); // 夥伴名（設備名）；舊標示 label 仍認，所以舊版用戶端打的點名照樣解析
    if (m.key === OWNER_KEY) names.add("主人"); // 顯示名來自租戶的帳號名稱（m.name）；「主人」是通用的備用叫法
    for (const n of names) if (n) cands.push({ text: n.toLowerCase(), key: m.key });
  }
  cands.sort((a, b) => b.text.length - a.text.length);
  const lower = body.toLowerCase();
  const found: string[] = [];
  for (let i = lower.indexOf("@"); i >= 0; i = lower.indexOf("@", i + 1)) {
    for (const c of cands) {
      if (!lower.startsWith(c.text, i + 1)) continue;
      // 名字必須完全相同：後面只能是結尾、空白或標點（含全形），不做子字串／前綴比對（@I-Irori 不會點到 I-Irori-2）
      const next = lower[i + 1 + c.text.length];
      if (next !== undefined && (!MENTION_END.test(next) || next === "-" || next === "_")) continue;
      if (!found.includes(c.key)) found.push(c.key);
      break;
    }
    if (found.length >= max) break;
  }
  return found.slice(0, max);
}

// 這則訊息該不該由 selfKey 這位成員回：有點名時只有被點名的回（owner 發的也一樣，點了誰就只有誰回）；
// 沒點名時，trust=owner（帳號擁有者本人）發的大家都可回；自己發的不回
// 第 1a 期補充：升級時複製的開頭紀錄（is_seed）與系統訊息一律不叫醒；被點名但超過額度或主人關掉「接受別人點名」（wake_ok=false）也不叫醒，只記未讀
export function shouldRespond(
  msg: { from: string; trust: string; mentions?: string[]; is_seed?: boolean; from_kind?: string; wake_ok?: boolean },
  selfKey: string,
): boolean {
  if (msg.from === selfKey) return false;
  if (msg.is_seed || msg.from_kind === "system") return false;
  const mentions = msg.mentions ?? [];
  if (mentions.length) return mentions.includes(selfKey) && msg.wake_ok !== false;
  return msg.trust === "owner";
}

// 同一封信同時叫醒多個 AI 時的順位（#230）：橋依順位延遲（第一順位不延遲），延遲後重看群組再決定回不回，避免搶答。
// 被叫醒的集合＝這個讀者看得到的成員裡 shouldRespond 為真的 AI（真人不占順位；wake_ok 只有讀者自己的那份知道，別人的當成可叫醒）。
// 排序用顯示標示（label，沒有就 name、key），不用成員 key：跨租戶時 key 是讀者視角的相對身分，不同讀者會排出不同順序。
// 同一封信、同一份成員名單算出的結果固定；沒被叫醒回 null
export type Wake = { rank: number; total: number; before: string[]; score?: number; hold?: true; fb?: true };
const isAiMember = (m: RoomMember) => !m.key.startsWith("~") && m.kind !== "owner" && m.kind !== "human" && m.member_kind !== "human";
const wakeSortKey = (m: RoomMember) => m.label || m.name || m.key;
type WakeMsg = { from: string; trust: string; mentions?: string[]; is_seed?: boolean; from_kind?: string; wake_ok?: boolean };
const labelCmp = (a: RoomMember, b: RoomMember) => {
  const x = wakeSortKey(a), y = wakeSortKey(b);
  return x < y ? -1 : x > y ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
};
/** 被這則訊息叫醒的 AI（含讀者自己），依固定規則（顯示標示）排序；讀者自己不在叫醒範圍回 null */
export function wokenAis(msg: WakeMsg, members: RoomMember[], selfKey: string): RoomMember[] | null {
  if (!shouldRespond(msg, selfKey)) return null;
  const woken = members.filter((m) => m.key === selfKey || (isAiMember(m) && shouldRespond({ ...msg, wake_ok: true }, m.key)));
  const uniq = [...new Map(woken.map((m) => [m.key, m])).values()];
  uniq.sort(labelCmp);
  return uniq.some((m) => m.key === selfKey) ? uniq : null;
}
/** 排序判斷的分數（以顯示標示為鍵）與門檻；有給就按分數排，沒給＝固定順位 */
export type WakeScores = { scores: Record<string, number>; min: number; exemptMentioned?: boolean };
/** 被叫醒的人依分數分成「通過」（高分在前，同分用固定規則）與「略過」（低於門檻、非明確點名） */
function splitWoken(uniq: RoomMember[], msg: WakeMsg, rank?: WakeScores, members: RoomMember[] = []): { passers: RoomMember[]; held: RoomMember[]; sc: (m: RoomMember) => number | undefined; fb: RoomMember | null } {
  if (!rank) return { passers: uniq, held: [], sc: () => undefined, fb: null };
  const sc = (m: RoomMember) => rank.scores[wakeSortKey(m)];
  const exempt = (m: RoomMember) => !!rank.exemptMentioned && (msg.mentions ?? []).includes(m.key);
  const passes = (m: RoomMember) => sc(m) === undefined || sc(m)! >= rank.min || exempt(m);
  const passers = uniq.filter(passes);
  // 分數高的在前；同分用固定規則穩定排序
  passers.sort((a, b) => (sc(b) ?? 0) - (sc(a) ?? 0) || labelCmp(a, b));
  let held = uniq.filter((m) => !passes(m));
  // 保底（#230）：真人（含 owner）發的訊息，被叫醒的人全部低於門檻時，分數最高的一位通過，免得沒人理使用者；
  // AI 發的訊息全低分維持全部略過（避免 AI 互相叫來叫去）。同分用固定規則穩定決勝
  let fb: RoomMember | null = null;
  if (!passers.length && held.length && senderIsHuman(msg, members)) {
    held = [...held].sort((a, b) => (sc(b) ?? 0) - (sc(a) ?? 0) || labelCmp(a, b));
    fb = held[0];
    passers.push(fb);
    held = held.slice(1);
  }
  return { passers, held, sc, fb };
}
// 發訊者是不是真人：先看成員名單（不是 AI 就是真人）；名單查不到（跨租戶）時只認 trust=owner；其餘保守當作 AI
function senderIsHuman(msg: WakeMsg, members: RoomMember[]): boolean {
  const s = members.find((m) => m.key === msg.from);
  if (s) return !isAiMember(s);
  return msg.from.startsWith("~") || (msg.trust === "owner" && msg.from_kind !== "ai");
}
export function wakeOrder(msg: WakeMsg, members: RoomMember[], selfKey: string, rank?: WakeScores): Wake | null {
  const uniq = wokenAis(msg, members, selfKey);
  if (!uniq) return null;
  const { passers, held, sc, fb } = splitWoken(uniq, msg, rank, members);
  const me = uniq.find((m) => m.key === selfKey)!;
  const score = sc(me);
  if (held.includes(me)) return { rank: 0, total: passers.length, before: [], score, hold: true };
  const i = passers.findIndex((m) => m.key === selfKey);
  return { rank: i + 1, total: passers.length, before: passers.slice(0, i).map(wakeSortKey), ...(score === undefined ? {} : { score }), ...(fb === me ? { fb: true as const } : {}) };
}

/** 存在訊息上的叫醒結果（#231）：key 是讀者視角的成員鍵（後台還原成真實鍵）；rank 從 1 起，被略過的 rank 為 0。只存順序與是否略過，不存內文 */
export type WakeInfoEntry = { key: string; rank: number; hold: boolean; score?: number; fb?: true; lim?: true };
export function wakeInfoOf(msg: WakeMsg, members: RoomMember[], selfKey: string, rank?: WakeScores): WakeInfoEntry[] | null {
  const uniq = wokenAis(msg, members, selfKey);
  if (!uniq) return null;
  const { passers, held, sc, fb } = splitWoken(uniq, msg, rank, members);
  const ent = (m: RoomMember, r: number, hold: boolean): WakeInfoEntry => ({ key: m.key, rank: r, hold, ...(sc(m) === undefined ? {} : { score: Math.round(sc(m)! * 100) / 100 }), ...(fb === m ? { fb: true as const } : {}) });
  return [...passers.map((m, i) => ent(m, i + 1, false)), ...held.sort(labelCmp).map((m) => ent(m, 0, true))];
}

// ── AI 發的、沒有 @ 任何人的訊息（#230）：交給排序判斷（Jev）對「發言者以外的 AI 成員」打分，≥ 門檻的才叫醒 ──
// 安全規則：判斷失敗／逾時／沒設定、輪數查詢或存入失敗，一律誰都不叫醒（不退回固定順位）；不套用全員低分的保底；
// 達輪數上限不打 Jev，wake_info 全部略過並標 lim；結果以第一次存下的 wake_info 為準。
type StoredWake = { key: string; label?: string; rank: number; hold: boolean }[];
/** 這則是不是「AI 發的、沒點名任何人」的訊息（開頭紀錄、系統訊息、真人訊息都不是） */
export function isSilentAiMsg(msg: { from: string; mentions?: string[]; is_seed?: boolean; from_kind?: string }, members: RoomMember[]): boolean {
  if ((msg.mentions ?? []).length || msg.is_seed || msg.from_kind === "system" || msg.from_kind === "human") return false;
  if (msg.from_kind === "ai") return true;
  const s = members.find((m) => m.key === msg.from);
  return !!s && isAiMember(s);
}
/** 候選：發言者以外、讀者看得到的 AI 成員（真人不列），依固定規則排序 */
export function silentCandidates(msg: { from: string }, members: RoomMember[]): RoomMember[] {
  const c = members.filter((m) => isAiMember(m) && m.key !== msg.from);
  return [...new Map(c.map((m) => [m.key, m])).values()].sort(labelCmp);
}
/** 分數 → 要存的 wake_info：≥ 門檻者依分數高到低（同分固定規則）排順位，其餘略過；沒有保底。scores 為 null＝輪數上限，全部略過並標 lim */
export function silentWakeInfo(cands: RoomMember[], scores: Record<string, number> | null, min: number): WakeInfoEntry[] {
  if (!scores) return cands.map((m) => ({ key: m.key, rank: 0, hold: true, lim: true as const }));
  const sc = (m: RoomMember) => scores[wakeSortKey(m)];
  const pass = cands.filter((m) => sc(m) >= min).sort((a, b) => sc(b) - sc(a) || labelCmp(a, b));
  const held = cands.filter((m) => !(sc(m) >= min));
  const ent = (m: RoomMember, rank: number, hold: boolean): WakeInfoEntry => ({ key: m.key, rank, hold, score: Math.round(sc(m) * 100) / 100 });
  return [...pass.map((m, i) => ent(m, i + 1, false)), ...held.map((m) => ent(m, 0, true))];
}
/** 從存下的 wake_info（讀者視角）算這位讀者的 for_me 與順位；不在名單或被略過＝不叫醒（略過者 for_me 必為 false，舊橋才不會立刻回） */
export function wakeFromStored(info: StoredWake, selfKey: string): { for_me: boolean; wake?: Wake } {
  const on = info.filter((e) => e && !e.hold && Number.isInteger(e.rank) && e.rank >= 1).sort((a, b) => a.rank - b.rank);
  const i = on.findIndex((e) => e.key === selfKey);
  if (i < 0) return { for_me: false };
  return { for_me: true, wake: { rank: i + 1, total: on.length, before: on.slice(0, i).map((e) => e.label || e.key) } };
}

export type RoomDeps = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: Json; error: unknown }>;
  ring: (topic: string) => Promise<void>;
  rosterHas: (node: string, agent: string) => Promise<boolean>;
  /** 選填：訊息寫入後、敲門鈴前呼叫（附件在這裡綁到訊息，收信端一響就看得到附件） */
  beforeRing?: (seq: number) => Promise<void>;
  /** 選填：叫醒順位的排序判斷（#230，Jev）；沒給或失敗＝固定順位 */
  rank?: RoomRank | null;
};
export type Reply = { status: number; body: Json };

const err = (status: number, error: string, extra: Json = {}): Reply => ({ status, body: { error, ...extra } });
const num = (v: unknown): number | null => (typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

// 回覆的序號：正整數（或純數字字串）才算，其餘當沒有引用
export function replySeq(v: unknown): number | null {
  const n = typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : typeof v === "number" ? v : null;
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
}

// SQL 函式回 {error: …} 時對應的 HTTP 狀態
export function statusOfError(e: string): number {
  switch (e) {
    case "rate_limited": return 429;
    case "forbidden": case "not_member": case "unknown_agent": return 403;
    case "not_found": return 404;
    case "id_taken": case "version_conflict": case "no_host": return 409;
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

// 發言（節點與帳號擁有者共用）：先查成員名單解析 @點名，再寫入，最後對每個成員節點敲門鈴
export async function postMessage(
  deps: RoomDeps, who: { node: string; agent?: string | null; owner?: boolean }, room: string, body: string, replyTo: number | null = null,
): Promise<Reply> {
  const who3 = { p_node: who.node, p_agent: who.agent ?? null, p_room: room, p_owner: Boolean(who.owner) };
  const mem = await call(deps, "asn_relay_room_members", who3);
  if (isReply(mem)) return mem;
  const mentions = parseMentions(body, mem.data.members ?? []);
  // 回覆某則訊息（#225）：有有效的序號才走回覆版（它會自動 @ 原作者並記下引用）；沒有就照舊，舊用戶端與還沒套 migration 的後台都不受影響
  const res = replyTo
    ? await call(deps, "asn_relay_room_post_reply", { ...who3, p_body: body, p_mentions: mentions, p_reply_to_seq: replyTo })
    : await call(deps, "asn_relay_room_post", { ...who3, p_body: body, p_mentions: mentions });
  if (isReply(res)) return res;
  if (deps.beforeRing) await deps.beforeRing(res.data.seq);
  await Promise.all((res.data.bell_topics ?? []).map((t: string) => deps.ring(t)));
  return { status: 200, body: { seq: res.data.seq, mentions } };
}

// 無 @ 的 AI 訊息的叫醒結果。任何一步失敗都回「不叫醒」
async function silentAiWake(
  deps: RoomDeps, node: string, agent: string | null, room: string, m: RoomMessage, members: RoomMember[], selfKey: string, before: RoomMessage[],
): Promise<{ for_me: boolean; wake?: Wake }> {
  const none = { for_me: false };
  try {
    const cands = silentCandidates(m, members);
    if (!cands.some((c) => c.key === selfKey)) return none;
    if (Array.isArray(m.wake_info)) return wakeFromStored(m.wake_info, selfKey); // 第一次存下的為準
    // 輪數上限（後台讀信時強制）：從最近一則真人發言起算，AI 叫醒了別的 AI 的訊息算一輪
    const ch = await deps.rpc("asn_relay_room_ai_chain", { p_node: node, p_agent: agent, p_room: room, p_seq: m.seq, p_owner: false });
    const count = ch.data?.count, limit = ch.data?.limit;
    if (ch.error || typeof count !== "number" || typeof limit !== "number") return none;
    let entries: WakeInfoEntry[];
    if (count >= limit) {
      entries = silentWakeInfo(cands, null, 0);
    } else {
      const rk = deps.rank;
      if (!rk) return none; // 沒開／沒設定：誰都不叫醒，也不存（開了之後下一位讀者還能算）
      const input: RankInput = {
        body: m.body,
        recent: before.map((x) => ({ from: x.from_name ?? x.from, body: x.body })),
        candidates: [...new Map(cands.map((x) => [wakeSortKey(x), { id: wakeSortKey(x), label: wakeSortKey(x) }])).values()],
      };
      const sc = await rk.score(`${room}:${m.seq}:silent:${input.candidates.map((c) => c.id).sort().join("|")}`, input);
      if (!sc) return none; // 逾時／出錯：不退回固定順位
      entries = silentWakeInfo(cands, sc, rk.cfg.min);
    }
    // 先存再決定：存不下來（舊後台、出錯）就不叫醒，免得輪數無法計算；兩人同時算時以資料庫存下的版本為準
    const res = await deps.rpc("asn_relay_room_wake_set", { p_node: node, p_agent: agent, p_room: room, p_seq: m.seq, p_info: entries });
    if (res.error || !Array.isArray(res.data?.wake_info)) return none;
    return wakeFromStored(res.data.wake_info, selfKey);
  } catch {
    return none;
  }
}

// 節點（AI）呼叫的群組動作。me 是金鑰決定的節點；params 是查詢參數與 JSON body 合併後的物件。
// 建群組、改置頂、加人、移人一律 403（只有帳號擁有者本人（登入身分）能做，連舊租戶角色節點的金鑰也一樣）
export async function handleNodeRoomAction(deps: RoomDeps, me: { id: string }, action: string, params: Json): Promise<Reply> {
  if (OWNER_ONLY_ACTIONS.has(action)) {
    return err(403, "forbidden", { detail: "建群組、改置頂、加人與移人只有使用者本人能在介面上做" });
  }
  const agent = typeof params.as_agent === "string" && params.as_agent ? params.as_agent : typeof params.from_agent === "string" && params.from_agent ? params.from_agent : null;
  if (agent && (agent.includes(WINDOW_SEP) || agent.length > 60)) return err(400, "bad_agent");
  const room = typeof params.room === "string" ? params.room : "";
  if (action !== "room_list" && action !== "room_confirm_status" && !ROOM_ID_RE.test(room)) return err(400, "bad_request");

  // 危險操作確認（規格 2.5.1）：AI 發請求、查放行。一定要指定是哪個視窗（as_agent）
  if (action === "room_confirm_request") {
    if (!agent) return err(400, "bad_agent");
    const kind = typeof params.kind === "string" ? params.kind : "";
    const summary = typeof params.summary === "string" ? params.summary : "";
    if (!(CONFIRM_KINDS as readonly string[]).includes(kind)) return err(400, "bad_kind");
    if (summary.trim().length < 1 || summary.length > 500) return err(400, "bad_request");
    const r = await call(deps, "asn_relay_group_confirm_request", { p_node: me.id, p_agent: agent, p_room: room, p_kind: kind, p_summary: summary });
    if (isReply(r)) return r;
    await Promise.all((r.data.bell_topics ?? []).map((t: string) => deps.ring(t)));
    return { status: 200, body: { id: r.data.id, short: r.data.short, seq: r.data.seq, status: r.data.status } };
  }
  if (action === "room_confirm_status") {
    if (!agent) return err(400, "bad_agent");
    const id = typeof params.id === "string" ? params.id : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return err(400, "bad_request");
    const r = await call(deps, "asn_relay_group_confirm_status", { p_node: me.id, p_agent: agent, p_id: id, p_consume: params.consume !== "0" && params.consume !== false });
    return isReply(r) ? r : { status: 200, body: r.data };
  }

  if (action === "room_list") {
    const r = await call(deps, "asn_relay_room_list", { p_node: me.id, p_owner: false });
    return isReply(r) ? r : { status: 200, body: r.data };
  }
  if (action === "room_pin_get") {
    const r = await call(deps, "asn_relay_room_pin_get", { p_node: me.id, p_agent: agent, p_room: room, p_owner: false });
    return isReply(r) ? r : { status: 200, body: r.data };
  }
  if (action === "room_read") {
    const r = await call(deps, "asn_relay_room_read", {
      p_node: me.id, p_agent: agent, p_room: room, p_since: num(params.since), p_limit: num(params.limit),
      p_owner: false, p_tail: false, p_mark: params.mark === "1" || params.mark === true ? true : null,
    });
    if (isReply(r)) return r;
    const selfKey = r.data.key as string;
    // AI 發的、沒點名任何人的訊息：for_me 先一律 false，要等成員名單與排序判斷（含輪數上限）算完才可能轉真（失敗＝誰都不叫醒）
    const silentAi = (m: RoomMessage) => m.from_kind === "ai" && !(m.mentions ?? []).length;
    let messages = (r.data.messages ?? []).map((m: RoomMessage) => ({ ...m, for_me: shouldRespond(m, selfKey) && !silentAi(m) }));
    // 順位（#230）：有 for_me 的信才查成員名單；查不到就不附（橋當作第一順位，照舊立即處理）
    if (messages.some((m: RoomMessage & { for_me: boolean }) => m.for_me || (silentAi(m) && m.from !== selfKey && !m.is_seed))) {
      const mem = await deps.rpc("asn_relay_room_members", { p_node: me.id, p_agent: agent, p_room: room, p_owner: false });
      const members: RoomMember[] | null = !mem.error && Array.isArray(mem.data?.members) ? mem.data.members : null;
      if (members) {
        const out: (RoomMessage & { for_me: boolean; wake?: Wake })[] = [];
        for (let i = 0; i < messages.length; i++) {
          const m = messages[i] as RoomMessage & { for_me: boolean };
          if (isSilentAiMsg(m, members)) {
            if (m.from === selfKey) { out.push({ ...m, for_me: false }); continue; }
            const res = await silentAiWake(deps, me.id, agent, room, m, members, selfKey, messages.slice(Math.max(0, i - 6), i));
            out.push(res.wake ? { ...m, for_me: res.for_me, wake: res.wake } : { ...m, for_me: res.for_me });
            continue;
          }
          let scores: WakeScores | undefined;
          const woken = m.for_me ? wokenAis(m, members, selfKey) : null;
          if (woken && deps.rank) {
            const rk = deps.rank;
            const exempt = (x: RoomMember) => rk.cfg.exemptMentioned && (m.mentions ?? []).includes(x.key);
            // 只剩一位且他免評就不必問；其餘都問
            if (woken.length > 1 || woken.some((x) => !exempt(x))) {
              const input: RankInput = {
                body: m.body,
                recent: messages.slice(Math.max(0, i - 6), i).map((x: RoomMessage) => ({ from: x.from_name ?? x.from, body: x.body })),
                candidates: [...new Map(woken.map((x) => [wakeSortKey(x), { id: wakeSortKey(x), label: wakeSortKey(x) }])).values()],
                mentioned: (m.mentions ?? []).map((k: string) => members.find((x) => x.key === k)).filter(Boolean).map((x: RoomMember | undefined) => wakeSortKey(x as RoomMember)),
              };
              const sc = await rk.score(`${room}:${m.seq}:${input.candidates.map((c) => c.id).sort().join("|")}`, input);
              if (sc) scores = { scores: sc, min: rk.cfg.min, exemptMentioned: rk.cfg.exemptMentioned };
            }
          }
          const wake = m.for_me ? wakeOrder(m, members, selfKey, scores) : null;
          if (wake?.hold) noteHeld(1);
          // 第一次算出叫醒結果就存在訊息上（#231）：之後所有成員讀到同一份順序；後台只在尚未有值時寫入，失敗不影響讀取
          if (woken && (m as { wake_info?: unknown }).wake_info == null) {
            const info = wakeInfoOf(m, members, selfKey, scores);
            if (info?.length) {
              try { await deps.rpc("asn_relay_room_wake_set", { p_node: me.id, p_agent: agent, p_room: room, p_seq: m.seq, p_info: info }); } catch { /* 舊後台沒有這個函式也沒關係 */ }
            }
          }
          out.push(wake ? { ...m, wake } : m);
        }
        messages = out;
      }
    }
    // reads＝讀者這邊最近發的訊息的已讀狀況（#224，舊後台沒有就不附）：原樣帶給用戶端
    return { status: 200, body: Array.isArray(r.data.reads) ? { messages, last_seq: r.data.last_seq, reads: r.data.reads } : { messages, last_seq: r.data.last_seq } };
  }
  if (action === "room_post") {
    const body = params.body;
    if (typeof body !== "string" || body.length < 1 || body.length > BODY_MAX) return err(400, "bad_body");
    // 視窗代發：視窗名要在該節點的 roster 內（SQL 也會再擋一次）
    if (agent && !(await deps.rosterHas(me.id, agent))) return err(403, "unknown_agent");
    return await postMessage(deps, { node: me.id, agent }, room, body, replySeq(params.reply_to));
  }
  return err(404, "not_found");
}

// ── 自動收入：視窗名（roster 上的名字，不含節點前綴）以群組設定的任一段開頭字串開頭就入群 ──
export const AUTO_PREFIX_MAX_LEN = 40;
export const AUTO_PREFIX_MAX_COUNT = 10;

// 驗證帳號擁有者設的開頭字串：每段 1～40 字、不可全空白、不含 ~、最多 10 段；不合格回 null。區分大小寫、不修剪、去重
export function validatePrefixes(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > AUTO_PREFIX_MAX_COUNT) return null;
  for (const p of v) {
    if (typeof p !== "string" || p.length < 1 || p.length > AUTO_PREFIX_MAX_LEN || p.trim() === "" || p.includes(WINDOW_SEP)) return null;
  }
  return [...new Set(v as string[])];
}

// 規則 × 視窗名 → 該入群的 {room, name}。一個視窗可同時符合多個群組；完整名稱「開頭」比對，不做任何其他解析
export function matchAutoJoins(rules: { room: string; prefixes: string[] }[], windows: string[]): { room: string; name: string }[] {
  const out: { room: string; name: string }[] = [];
  for (const r of rules) {
    const prefixes = (r.prefixes ?? []).filter((p) => typeof p === "string" && p !== "");
    for (const name of windows) {
      if (prefixes.some((p) => name.startsWith(p))) out.push({ room: r.room, name });
    }
  }
  return out;
}

// 套用某節點目前的視窗名單：符合的自動入群；原本自動入群、視窗已消失的標為離開（資料庫端處理）。出錯只記 log，不影響呼叫端
export async function syncNodeAuto(deps: RoomDeps, node: string, windows: string[]): Promise<void> {
  try {
    const rules = await deps.rpc("asn_relay_room_auto_rules", { p_node: node });
    if (rules.error) throw rules.error;
    const joins = matchAutoJoins(rules.data ?? [], windows);
    const res = await deps.rpc("asn_relay_room_auto_apply", { p_node: node, p_joins: joins });
    if (res.error) throw res.error;
  } catch (e) {
    console.error("auto join sync failed", node, String(e));
  }
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
