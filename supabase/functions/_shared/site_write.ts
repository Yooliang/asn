// 官網內容第二期（#400）：團隊節點寫入官網的發版記錄、小會議記錄、藍圖與待辦項目（資料庫見 migrations/20261027200000_site_write.sql）。
// 三個動作都用節點金鑰認證，節點一律是金鑰所屬的 me.id（body 不接受指定節點）；能不能寫由資料庫的名單（relay.site_writers，以租戶為單位）決定。
//   site_meeting_add：依 held_at 新增一場會議；同一時間已有＝整筆覆寫。
//   site_release_upsert：依 version 新增或更新一版；更新時只改有帶的欄位。
//   site_item_upsert：依 item_key 新增或更新藍圖／待辦項目；更新時只改有帶的欄位。
// 這裡先做一層格式檢查（不查資料庫，壞資料不打資料庫），規則與資料庫一致；資料庫還會再檢查一次並查名單、欄位是否存在、頻率上限。
// 頁面是公開的且只用極小標記（**粗體**、`程式碼`、#123），所以不收 HTML 標籤、電子郵件、本機路徑與金鑰樣式。
// deno-lint-ignore no-explicit-any
type Json = any;
import type { LaunchDeps, Reply } from "./launch.ts";

export const SITE_ACTIONS = new Set(["site_meeting_add", "site_release_upsert", "site_item_upsert"]);

const RPC: Record<string, string> = {
  site_meeting_add: "asn_relay_site_meeting_add",
  site_release_upsert: "asn_relay_site_release_upsert",
  site_item_upsert: "asn_relay_site_item_upsert",
};
const ARG: Record<string, string> = { site_meeting_add: "p_meeting", site_release_upsert: "p_release", site_item_upsert: "p_item" };

const STATUS: Record<string, number> = { not_allowed: 403, rate_limited: 429, internal: 500 };
const TEXT: Record<string, string> = {
  not_allowed: "這個節點不能寫官網內容（帳號不在官網寫入名單，請專案負責人把帳號加進名單）",
  bad_request: "資料格式不對",
  unsafe_content: "內容不能放上公開頁面：不收 HTML 標籤、電子郵件、本機路徑或金鑰（只用 **粗體**、`程式碼`、#123）",
  bad_lane: "藍圖／待辦沒有這個欄位（section 與 lane 要是已存在的組合）",
  missing_fields: "新的一筆缺少必填欄位",
  rate_limited: "寫入太頻繁，請稍後再試（每個帳號每小時最多 120 次）",
  internal: "伺服器發生錯誤",
};
const FIELD: Record<string, string> = {
  held_at: "會議時間", attendees: "出席", progress: "進度", decisions: "決議", assignments: "分派", improvements: "改善意見",
  version: "版本", released_on: "發版日期", items: "更新說明", platforms: "發佈平台", commit_sha: "commit", notes: "補充說明",
  item_key: "項目代號", section: "區塊", lane: "欄位", title: "標題", body: "內文", refs: "議題編號", status: "狀態", sort_order: "排序",
};

type Err = { error: string; field?: string };
const fail = (e: Err): Reply => {
  const base = TEXT[e.error] ?? "操作失敗";
  const detail = e.field ? `${base}（${FIELD[e.field] ?? e.field}）` : base;
  return { status: STATUS[e.error] ?? 400, body: e.field ? { error: e.error, field: e.field, detail } : { error: e.error, detail } };
};

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HELD_AT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ITEM_KEY = /^[a-z0-9][a-z0-9-]{0,60}$/;
const LANE = /^[a-z][a-z0-9-]{0,30}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const SECTIONS = ["roadmap", "todo"];
const STATUSES = ["released", "doing", "planned", "decide"];
// deno-lint-ignore no-control-regex
const CONTROL = /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const UNSAFE = [
  /<\s*\/?\s*[A-Za-z!?]/, // HTML 標籤
  /[A-Za-z0-9_.+-]+@[A-Za-z0-9_-]+\.[A-Za-z0-9_.]+/, // 電子郵件
  /[A-Za-z]:\\|\/home\/|\/Users\/|~\/\./, // 本機路徑
  /eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|service_role/, // 金鑰樣式
];

// 一段公開文字：'ok'、'bad'（空白、太長、控制字元）、'unsafe'（不能公開）。長度以字元（code point）算，與資料庫 char_length 一致
export function checkText(v: unknown, max: number): "ok" | "bad" | "unsafe" {
  if (typeof v !== "string" || v.trim() === "" || [...v].length > max || CONTROL.test(v) || v.includes("\0")) return "bad";
  return UNSAFE.some((re) => re.test(v)) ? "unsafe" : "ok";
}

function textArray(v: unknown, min: number, max: number, len: number, field: string): Err | null {
  if (!Array.isArray(v) || v.length < min || v.length > max) return { error: "bad_request", field };
  for (const s of v) {
    const c = checkText(s, len);
    if (c === "unsafe") return { error: "unsafe_content", field };
    if (c !== "ok") return { error: "bad_request", field };
  }
  return null;
}

const isObj = (b: unknown): b is Record<string, unknown> => !!b && typeof b === "object" && !Array.isArray(b);
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const blank = (v: unknown) => v === null || v === "";

function validDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => has(o, k)).map((k) => [k, o[k]]));

export const MEETING_FIELDS = ["attendees", "progress", "decisions", "assignments", "improvements"] as const;

export function parseMeeting(b: Json): { data: Json } | Err {
  if (!isObj(b)) return { error: "bad_request" };
  const at = b.held_at;
  if (typeof at !== "string" || at.length > 40 || !HELD_AT.test(at) || Number.isNaN(Date.parse(at.replace(" ", "T")))) {
    return { error: "bad_request", field: "held_at" };
  }
  for (const f of MEETING_FIELDS) {
    const e = textArray(b[f], 1, 30, 2000, f);
    if (e) return e;
  }
  return { data: pick(b, ["held_at", ...MEETING_FIELDS]) };
}

export function parseRelease(b: Json): { data: Json } | Err {
  if (!isObj(b)) return { error: "bad_request" };
  if (typeof b.version !== "string" || !VERSION.test(b.version)) return { error: "bad_request", field: "version" };
  if (has(b, "released_on") && (typeof b.released_on !== "string" || !DATE.test(b.released_on) || !validDate(b.released_on))) {
    return { error: "bad_request", field: "released_on" };
  }
  if (has(b, "items")) {
    const e = textArray(b.items, 1, 30, 1000, "items");
    if (e) return e;
  }
  if (has(b, "platforms") && b.platforms !== null) {
    const e = textArray(b.platforms, 0, 10, 20, "platforms");
    if (e) return e;
  }
  if (has(b, "commit_sha") && !blank(b.commit_sha) && (typeof b.commit_sha !== "string" || !COMMIT.test(b.commit_sha))) {
    return { error: "bad_request", field: "commit_sha" };
  }
  if (has(b, "notes") && !blank(b.notes)) {
    const c = checkText(b.notes, 2000);
    if (c !== "ok") return { error: c === "unsafe" ? "unsafe_content" : "bad_request", field: "notes" };
  }
  return { data: pick(b, ["version", "released_on", "items", "platforms", "commit_sha", "notes"]) };
}

export function parseItem(b: Json): { data: Json } | Err {
  if (!isObj(b)) return { error: "bad_request" };
  if (typeof b.item_key !== "string" || !ITEM_KEY.test(b.item_key)) return { error: "bad_request", field: "item_key" };
  if (has(b, "section") !== has(b, "lane")) return { error: "bad_request", field: has(b, "section") ? "lane" : "section" };
  if (has(b, "section")) {
    if (typeof b.section !== "string" || !SECTIONS.includes(b.section)) return { error: "bad_request", field: "section" };
    if (typeof b.lane !== "string" || !LANE.test(b.lane)) return { error: "bad_request", field: "lane" };
  }
  if (has(b, "title") && !blank(b.title)) {
    const c = checkText(b.title, 80);
    if (c === "unsafe") return { error: "unsafe_content", field: "title" };
    if (c !== "ok" || (b.title as string).includes("\n")) return { error: "bad_request", field: "title" };
  }
  if (has(b, "body")) {
    const c = checkText(b.body, 4000);
    if (c !== "ok") return { error: c === "unsafe" ? "unsafe_content" : "bad_request", field: "body" };
  }
  if (has(b, "refs")) {
    const r = b.refs;
    if (!Array.isArray(r) || r.length > 30 || !r.every((n) => Number.isSafeInteger(n) && n > 0 && n < 1e9)) return { error: "bad_request", field: "refs" };
  }
  if (has(b, "status") && (typeof b.status !== "string" || !STATUSES.includes(b.status))) return { error: "bad_request", field: "status" };
  if (has(b, "version") && !blank(b.version) && (typeof b.version !== "string" || !VERSION.test(b.version))) {
    return { error: "bad_request", field: "version" };
  }
  if (has(b, "sort_order") && !(Number.isSafeInteger(b.sort_order) && (b.sort_order as number) >= 0 && (b.sort_order as number) <= 1_000_000)) {
    return { error: "bad_request", field: "sort_order" };
  }
  return { data: pick(b, ["item_key", "section", "lane", "title", "body", "refs", "status", "version", "sort_order"]) };
}

const PARSE: Record<string, (b: Json) => { data: Json } | Err> = {
  site_meeting_add: parseMeeting,
  site_release_upsert: parseRelease,
  site_item_upsert: parseItem,
};

export async function handleSiteAction(deps: Pick<LaunchDeps, "rpc">, me: { id: string }, action: string, body: Json): Promise<Reply> {
  const parse = PARSE[action];
  if (!parse) return fail({ error: "bad_request" });
  const p = parse(body);
  if ("error" in p) return fail(p);
  const { data, error } = await deps.rpc(RPC[action], { p_node: me.id, [ARG[action]]: p.data });
  if (error) {
    console.error(RPC[action], error);
    return fail({ error: "internal" });
  }
  if (isObj(data) && typeof data.error === "string") return fail({ error: data.error, field: typeof data.field === "string" ? data.field : undefined });
  if (!isObj(data) || data.ok !== true) return fail({ error: "internal" });
  return { status: 200, body: data };
}
