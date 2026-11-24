// 回報匯流排（#2161 第 2b 段）：report（寫）與 report_get（讀）。資料庫見 migrations/20261125100000_report_bus.sql、20261125200000_report_readers_wrapper.sql。
// 節點身分只取自金鑰解出的 me.id，body 不收節點代號。這兩個動作是節點層（金鑰）動作，不需要本人簽章；網頁節點一律不准（見 web_session.ts）。
// report：Edge 先驗 kind 格式、payload 是物件、序列化大小（不合就不打資料庫）；資料庫再依登記表驗證。內容變了才敲門鈴。
// 門鈴只帶 { kind, node }（哪台哪種更新了），不帶內容；讀取一律走 report_get。門鈴在背景發（回應不等），失敗不影響 report。
// 身分：handler 只信呼叫端傳進來的 me（index.ts 先用金鑰解出節點；沒金鑰或金鑰無效在到這裡之前就回 401），所以這裡沒有 401 分支。
import type { RpcFn } from "./partners.ts";

export const REPORT_ACTIONS = new Set(["report", "report_get"]);
export const KIND_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const NODE_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** payload 序列化後的位元組上限（資料庫另有每種 kind 自己的 max_bytes） */
export const REPORT_MAX_BYTES = 65_536;
export const REPORT_GET_MAX_NODES = 50;

type Result = { status: number; body: unknown };
type Fail = { status: number; error: string; message: string };

export interface ReportDeps {
  rpc: RpcFn;
  /** 對一個門鈴頻道敲一下並帶 payload（失敗自己吞掉；這裡再包一層保險） */
  ring: (topic: string, payload?: Record<string, unknown>) => Promise<void>;
  /** 把背景工作交出去（正式環境是 signal.background）；回應先送出，門鈴在背景發 */
  background: (p: Promise<unknown>) => void;
}

const BAD: Fail = { status: 400, error: "bad_request", message: "請求內容不正確。" };
const TOO_LARGE: Fail = { status: 413, error: "too_large", message: "回報內容太大。" };

/** 資料庫拒絕原因對照狀態碼與固定白話（不回 payload 內容、不回資料庫原文） */
const REJECT: Record<string, { status: number; message: string }> = {
  rate: { status: 429, message: "回報太頻繁，請稍後再送。" },
  rate_node: { status: 429, message: "這台設備回報太頻繁，請稍後再送。" },
  not_found: { status: 422, message: "找不到這台設備，或它已停用。" },
  unknown_kind: { status: 422, message: "不認得這種回報。" },
  disabled: { status: 422, message: "這種回報目前停用。" },
  no_rule: { status: 422, message: "這種回報尚未設定格式。" },
  bad_validator: { status: 422, message: "這種回報的檢查規則有誤。" },
  validator_error: { status: 422, message: "回報內容沒有通過檢查。" },
  bad_spec: { status: 422, message: "這種回報的格式設定有誤。" },
  not_object: { status: 422, message: "回報內容必須是物件。" },
  too_large: { status: 422, message: "回報內容超過這種回報的大小上限。" },
  too_deep: { status: 422, message: "回報內容層數太深。" },
  type_mismatch: { status: 422, message: "回報內容有欄位的型別不對。" },
  unknown_field: { status: 422, message: "回報內容有不允許的欄位。" },
  missing_required: { status: 422, message: "回報內容缺少必要欄位。" },
  too_long: { status: 422, message: "回報內容有欄位太長。" },
  too_many: { status: 422, message: "回報內容有清單項目太多。" },
  out_of_range: { status: 422, message: "回報內容有數值超出範圍。" },
  bad_enum: { status: 422, message: "回報內容有欄位的值不在允許範圍。" },
  looks_like_email: { status: 422, message: "回報內容含有疑似電子郵件的文字，已拒絕。" },
  looks_like_secret: { status: 422, message: "回報內容含有疑似金鑰的文字，已拒絕。" },
};
const REJECT_FALLBACK = { status: 422, message: "回報內容沒有通過檢查。" };

const GET_ERRORS: Record<string, { status: number; message: string }> = {
  unknown_kind: { status: 404, message: "不認得這種回報。" },
  too_many_nodes: { status: 400, message: "一次最多查詢 50 台設備。" },
};

function rpcMissing(e: unknown): boolean {
  const o = e as { code?: unknown; message?: unknown } | null;
  if (!o) return false;
  if (o.code === "PGRST202" || o.code === "42883") return true;
  return typeof o.message === "string" && /could not find the function/i.test(o.message);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** report 請求本文：{ kind, payload }。多餘欄位（含任何節點代號）一律丟掉 */
export function parseReport(b: unknown): { kind: string; payload: Record<string, unknown> } | Fail {
  if (!isObj(b)) return BAD;
  if (typeof b.kind !== "string" || !KIND_RE.test(b.kind)) return BAD;
  if (!isObj(b.payload)) return BAD;
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(b.payload)).length;
  } catch {
    return BAD;
  }
  if (size > REPORT_MAX_BYTES) return TOO_LARGE;
  return { kind: b.kind, payload: b.payload };
}

/** report_get 請求本文：{ kind, nodes[] }；nodes 去重（保留第一次出現的順序）後 1～50 個、每個符合節點代號格式 */
export function parseReportGet(b: unknown): { kind: string; nodes: string[] } | Fail {
  if (!isObj(b)) return BAD;
  if (typeof b.kind !== "string" || !KIND_RE.test(b.kind)) return BAD;
  if (!Array.isArray(b.nodes) || !b.nodes.every((n) => typeof n === "string" && NODE_RE.test(n))) return BAD;
  const nodes = [...new Set(b.nodes as string[])];
  if (nodes.length < 1 || nodes.length > REPORT_GET_MAX_NODES) return BAD;
  return { kind: b.kind, nodes };
}

const failRes = (f: Fail): Result => ({ status: f.status, body: { error: f.error, message: f.message } });

/** 門鈴內容：只有哪台（node）哪種（kind）更新了，沒有回報內容 */
export function reportBellPayload(kind: string, node: string): { kind: string; node: string } {
  return { kind, node };
}

/** 資料庫回的拒絕原因轉成回應（不外洩原文；不認得的原因記 log 後回通用白話） */
export function rejectResult(d: Record<string, unknown>): Result {
  const reason = typeof d.rejected_reason === "string" ? d.rejected_reason : "";
  const m = REJECT[reason];
  if (!m) console.error("report rejected (unknown reason)", reason.slice(0, 40));
  const x = m ?? REJECT_FALLBACK;
  const error = m ? reason : "rejected";
  const body: Record<string, unknown> = { error, message: x.message };
  if (x.status === 429) {
    const n = Number(d.retry_after_seconds);
    body.retry_after_seconds = Number.isFinite(n) && n >= 1 ? Math.ceil(n) : 1;
  }
  return { status: x.status, body };
}

/** 門鈴讀者上限與分批大小：超過上限只通知前面的人（其餘靠 report_get 後援輪詢） */
export const REPORT_RING_MAX = 200;
export const REPORT_RING_BATCH = 25;

/** 背景工作：查讀者、排除寫入者自己、最多 200 個、每批 25 個（批內並行、批間序列）敲門鈴。任何例外都吞掉只記 log，不影響回應。 */
async function ringReaders(deps: ReportDeps, node: string, kind: string): Promise<void> {
  try {
    const { data, error } = await deps.rpc("asn_relay_report_readers", { p_node: node, p_kind: kind });
    if (error) { console.error("report readers", error); return; }
    const readers = isObj(data) && Array.isArray(data.readers) ? data.readers : [];
    const bells = isObj(data) && Array.isArray(data.bell_topics) ? data.bell_topics : [];
    if (readers.length !== bells.length) { console.error("report readers: 名單與頻道數量不一致", readers.length, bells.length); return; }
    const seen = new Set<string>();
    const topics: string[] = [];
    for (let i = 0; i < readers.length; i++) {
      const t = bells[i];
      // 雙保險：資料庫已排除寫入者，Edge 再排除一次
      if (readers[i] === node || typeof readers[i] !== "string" || typeof t !== "string" || t.length === 0 || seen.has(t)) continue;
      seen.add(t);
      topics.push(t);
    }
    if (topics.length > REPORT_RING_MAX) console.error("report readers 超過上限，只通知前面的", topics.length, REPORT_RING_MAX);
    const list = topics.slice(0, REPORT_RING_MAX);
    const payload = reportBellPayload(kind, node);
    for (let i = 0; i < list.length; i += REPORT_RING_BATCH) {
      await Promise.all(list.slice(i, i + REPORT_RING_BATCH).map(async (t) => {
        try { await deps.ring(t, payload); } catch (e) { console.error("report bell", String(e)); }
      }));
    }
  } catch (e) {
    console.error("report bell error", String(e));
  }
}

export async function handleReport(deps: ReportDeps, me: { id: string }, body: unknown): Promise<Result> {
  const req = parseReport(body);
  if ("error" in req) return failRes(req);
  const { data, error } = await deps.rpc("asn_relay_report", { p_node: me.id, p_kind: req.kind, p_payload: req.payload });
  if (error) {
    if (rpcMissing(error)) return { status: 404, body: { error: "not_found" } };
    console.error("asn_relay_report", error);
    return { status: 500, body: { error: "internal" } };
  }
  const d = isObj(data) ? data : {};
  if (d.ok !== true) {
    if (typeof d.rejected_reason !== "string") {
      console.error("asn_relay_report", "no ok and no reason");
      return { status: 500, body: { error: "internal" } };
    }
    return rejectResult(d);
  }
  const changed = d.changed === true;
  if (changed) deps.background(ringReaders(deps, me.id, req.kind).catch((e) => console.error("report bell error", String(e))));
  return { status: 200, body: { ok: true, changed } };
}

export async function handleReportGet(deps: Pick<ReportDeps, "rpc">, me: { id: string }, body: unknown): Promise<Result> {
  const req = parseReportGet(body);
  if ("error" in req) return failRes(req);
  const { data, error } = await deps.rpc("asn_relay_report_get", { p_caller: me.id, p_kind: req.kind, p_nodes: req.nodes });
  if (error) {
    if (rpcMissing(error)) return { status: 404, body: { error: "not_found" } };
    console.error("asn_relay_report_get", error);
    return { status: 500, body: { error: "internal" } };
  }
  const d = isObj(data) ? data : {};
  if (d.ok !== true) {
    const m = typeof d.rejected_reason === "string" ? GET_ERRORS[d.rejected_reason] : undefined;
    if (!m) { console.error("asn_relay_report_get", "unexpected"); return { status: 500, body: { error: "internal" } }; }
    return { status: m.status, body: { error: d.rejected_reason, message: m.message } };
  }
  return { status: 200, body: { ok: true, reports: Array.isArray(d.reports) ? d.reports : [] } };
}
