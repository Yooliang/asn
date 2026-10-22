// 附件（傳照片）共用邏輯：格式檢查、上傳／確認／下載動作、寄信前後的附件處理、回信件時附帶附件資訊。
// 設計見 docs/ATTACHMENTS.md；資料與權限的最後一道關在 supabase/migrations/20261020000500_attachments.sql。
// Edge Function 只負責接線：把 Supabase Storage 包成 StorageDeps 傳進來，這裡就能不連網路單元測試。

// deno-lint-ignore no-explicit-any
type Json = any;

export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: Json; error: unknown }>;
export type StorageDeps = {
  /** 一次性上傳網址（PUT 位元組）；失敗回 null */
  signUpload(path: string): Promise<string | null>;
  /** 物件實際大小與型別；還沒上傳回 null */
  info(path: string): Promise<{ size: number; mime: string } | null>;
  /** 短效下載網址；失敗回 null */
  signDownload(path: string, seconds: number, filename: string): Promise<string | null>;
  /** 從 Storage 刪檔；成功（含檔案本來就不在）回 true */
  remove(paths: string[]): Promise<boolean>;
};
export type AttachDeps = { rpc: Rpc; storage: StorageDeps };
export type Reply = { status: number; body: Json };

// 一般檔案的白名單：副檔名 → 型別。可執行檔、腳本、安裝檔一律不在裡面。
// 要加新型別：這裡加一列，並更新 migration 的 bucket allowed_mime_types 與表的 mime check。
export const FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
// 型別白名單：照片只收 webp（ASN 在本機轉好）、5 MB；檔案收 FILE_TYPES、25 MB，不壓縮、不轉檔。
export const ATTACH_KINDS: Record<string, { mimes: string[]; maxBytes: number }> = {
  image: { mimes: ["image/webp"], maxBytes: 5 * 1024 * 1024 },
  file: { mimes: Object.values(FILE_TYPES), maxBytes: 25 * 1024 * 1024 },
};
export const QUOTA_BYTES = 500 * 1024 * 1024; // 每台設備未過期附件合計
export const QUOTA_COUNT = 300;
export const MAX_PER_MESSAGE = 4;
export const DOWNLOAD_TTL_SECONDS = 300;
export const THUMB_MAX_CHARS = 12000;
export const NAME_MAX = 80;
export const ACTIONS = new Set(["attach_init", "attach_commit", "attach_url", "attach_sweep"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THUMB_PREFIX = /^data:image\/webp;base64,/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

const err = (status: number, error: string, extra: Json = {}): Reply => ({ status, body: { error, ...extra } });

// 檔名來自寄件人，視為外部資料：去掉控制字元、換行、括號與引號、路徑符號與 shell 會當特殊字元的符號，空白收成一個，至多 80 字
export function cleanName(v: unknown, fallback = "photo.webp"): string {
  const s = typeof v === "string" ? v : "";
  const out = s
    .replace(new RegExp("[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]", "g"), " ")
    .replace(/[〔〕［］【】「」『』()（）\[\]{}<>《》`'"“”‘’\\/|:*?;&$%!#^~=,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "") // 不要以點開頭（隱藏檔、..）
    .slice(0, NAME_MAX)
    .trim();
  return out || fallback;
}

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

// 縮圖：null／沒給＝沒有；有就要是 webp 的 data URL、base64 字元、檔頭是 RIFF....WEBP、全長 ≤ 12000
export function checkThumb(v: unknown): { ok: true; thumb: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, thumb: null };
  if (typeof v !== "string" || v.length > THUMB_MAX_CHARS) return { ok: false };
  const m = THUMB_PREFIX.exec(v);
  if (!m) return { ok: false };
  const b64 = v.slice(m[0].length);
  if (!B64.test(b64) || b64.length % 4 === 1) return { ok: false };
  let head = "";
  try { head = atob(b64.slice(0, 16)); } catch { return { ok: false }; } // 前 12 位元組
  const ok = head.slice(0, 4) === "RIFF" && head.slice(8, 12) === "WEBP";
  return ok ? { ok: true, thumb: v } : { ok: false };
}

export type InitValue = {
  kind: string; mime: string; name: string; bytes: number; width: number | null; height: number | null;
  thumb: string | null; sha256: string | null;
};
export type InitCheck = { ok: true; value: InitValue } | { ok: false; error: string };

const dim = (v: unknown): number | null | "bad" =>
  v === undefined || v === null ? null : typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 20000 ? v : "bad";

export function checkAttachInit(b: unknown): InitCheck {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, error: "bad_request" };
  const o = b as Record<string, unknown>;
  const kind = typeof o.kind === "string" ? o.kind : "";
  const rule = Object.prototype.hasOwnProperty.call(ATTACH_KINDS, kind) ? ATTACH_KINDS[kind] : null;
  if (!rule) return { ok: false, error: "unsupported_type" };
  const mime = typeof o.mime === "string" ? o.mime : "";
  if (!rule.mimes.includes(mime)) return { ok: false, error: "unsupported_type" };
  const bytes = o.bytes;
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 1) return { ok: false, error: "bad_request" };
  if (bytes > rule.maxBytes) return { ok: false, error: "file_too_large" };
  const w = dim(o.width), h = dim(o.height);
  if (w === "bad" || h === "bad") return { ok: false, error: "bad_request" };
  const t = checkThumb(o.thumb);
  if (!t.ok) return { ok: false, error: "bad_thumb" };
  const name = cleanName(o.name, kind === "file" ? "file" : "photo.webp");
  if (kind === "file") {
    // 檔案：沒有縮圖與尺寸；檔名的副檔名要在白名單內且跟型別對得上（不能把 .exe 標成 pdf 之外的型別混進來）
    if (t.thumb !== null || w !== null || h !== null) return { ok: false, error: "bad_request" };
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
    if (FILE_TYPES[ext] !== mime || !Object.prototype.hasOwnProperty.call(FILE_TYPES, ext)) return { ok: false, error: "unsupported_type" };
  }
  let sha256: string | null = null;
  if (o.sha256 !== undefined && o.sha256 !== null) {
    if (typeof o.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(o.sha256)) return { ok: false, error: "bad_request" };
    sha256 = o.sha256;
  }
  return { ok: true, value: { kind, mime, name, bytes, width: w, height: h, thumb: t.thumb, sha256 } };
}

// 寄信的 attachment_ids：沒給＝[]；給了要是 1～4 個不重複 uuid 的陣列，否則回 null（呼叫端回 400）
export function parseAttachmentIds(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_PER_MESSAGE) return null;
  if (!v.every(isUuid)) return null;
  const ids = v.map((x) => (x as string).toLowerCase());
  return new Set(ids).size === ids.length ? ids : null;
}

const mimeBase = (m: string) => m.split(";")[0].trim().toLowerCase();

// 回給用戶端看的縮圖資訊 → 一律只放白名單欄位
export type AttachmentInfo = {
  id: string; kind: string; name: string; mime: string; bytes: number; width: number | null; height: number | null;
  thumb: string | null; expires_at: string; expired: boolean;
};
const publicInfo = (a: Json): AttachmentInfo => ({
  id: a.id, kind: a.kind, name: a.name, mime: a.mime, bytes: a.bytes, width: a.width ?? null, height: a.height ?? null,
  thumb: a.thumb ?? null, expires_at: a.expires_at, expired: a.expired === true,
});

/** 清理過期與放棄的上傳：向 Storage 真的刪檔，成功才記 removed_at。回處理筆數。 */
export async function sweepExpired(deps: AttachDeps, limit = 50): Promise<number> {
  const { data, error } = await deps.rpc("asn_relay_attach_sweep", { p_limit: limit });
  if (error) { console.error("attach_sweep", error); return 0; }
  const rows = (Array.isArray(data) ? data : []) as { id: string; path: string }[];
  if (!rows.length) return 0;
  const ok = await deps.storage.remove(rows.map((r) => r.path));
  if (!ok) return 0;
  const { error: e2 } = await deps.rpc("asn_relay_attach_swept", { p_ids: rows.map((r) => r.id) });
  if (e2) { console.error("attach_swept", e2); return 0; }
  return rows.length;
}

export async function handleAttachAction(
  deps: AttachDeps, me: { id: string; role?: string }, action: string, params: Json,
): Promise<Reply> {
  switch (action) {
    case "attach_init": {
      const c = checkAttachInit(params);
      if (!c.ok) return err(c.error === "file_too_large" ? 413 : 400, c.error);
      const v = c.value;
      const { data, error } = await deps.rpc("asn_relay_attach_init", {
        p_node: me.id, p_kind: v.kind, p_mime: v.mime, p_name: v.name, p_bytes: v.bytes, p_width: v.width, p_height: v.height,
        p_thumb: v.thumb, p_sha256: v.sha256, p_quota_bytes: QUOTA_BYTES, p_quota_count: QUOTA_COUNT,
      });
      if (error) { console.error(action, error); return err(500, "internal"); }
      if (data?.error === "rate_limited") return err(429, "rate_limited");
      if (data?.error === "quota_exceeded") return err(413, "quota_exceeded", { used_bytes: data.used_bytes, used_count: data.used_count, quota_bytes: QUOTA_BYTES, quota_count: QUOTA_COUNT });
      if (data?.error === "forbidden") return err(403, "forbidden");
      if (data?.error) return err(400, data.error);
      const url = await deps.storage.signUpload(data.path);
      if (!url) return err(500, "storage_unavailable");
      await sweepExpired(deps, 20); // 順手清過期檔案（失敗不影響這次）
      return { status: 200, body: { id: data.id, upload_url: url, expires_in: 7200, expires_at: data.expires_at, max_bytes: ATTACH_KINDS[v.kind].maxBytes } };
    }
    case "attach_commit": {
      if (!isUuid(params?.id)) return err(400, "bad_request");
      const peek = await deps.rpc("asn_relay_attach_commit", { p_node: me.id, p_id: params.id, p_bytes: null, p_mime: null });
      if (peek.error) { console.error(action, peek.error); return err(500, "internal"); }
      if (peek.data?.error === "not_found") return err(404, "not_found");
      if (peek.data?.status === "ready") return { status: 200, body: { ok: true, id: params.id } };
      const path = peek.data?.path as string;
      const info = await deps.storage.info(path);
      if (!info) return err(409, "not_uploaded");
      const { data, error } = await deps.rpc("asn_relay_attach_commit", { p_node: me.id, p_id: params.id, p_bytes: info.size, p_mime: mimeBase(info.mime) });
      if (error) { console.error(action, error); return err(500, "internal"); }
      if (data?.error === "size_mismatch") {
        await deps.storage.remove([path]); // 大小或型別跟申報的不符：刪檔、作廢
        return err(400, "size_mismatch");
      }
      if (data?.error === "expired") return err(410, "expired");
      if (data?.error === "not_found") return err(404, "not_found");
      if (data?.error) return err(400, data.error);
      return { status: 200, body: { ok: true, id: params.id } };
    }
    case "attach_url": {
      if (!isUuid(params?.id)) return err(400, "bad_request");
      const { data, error } = await deps.rpc("asn_relay_attach_access", { p_node: me.id, p_id: params.id });
      if (error) { console.error(action, error); return err(500, "internal"); }
      if (data?.error === "not_found") return err(404, "not_found");
      if (data?.error === "expired") return err(410, "expired");
      if (data?.error) return err(400, data.error);
      const url = await deps.storage.signDownload(data.path, DOWNLOAD_TTL_SECONDS, data.name);
      if (!url) return err(500, "storage_unavailable");
      return { status: 200, body: { url, expires_in: DOWNLOAD_TTL_SECONDS, name: data.name, mime: data.mime, bytes: data.bytes } };
    }
    case "attach_sweep": {
      if (me.role !== "owner") return err(403, "forbidden");
      const n = await sweepExpired(deps, 200);
      return { status: 200, body: { removed: n } };
    }
  }
  return err(404, "not_found");
}

/** 寄信前：檢查這些附件都是自己的、ready、沒綁過。沒附件回 {ok:true, ids:[]}。 */
export async function prepareAttachments(
  deps: { rpc: Rpc }, nodeId: string, raw: unknown,
): Promise<{ ok: true; ids: string[] } | { ok: false; reply: Reply }> {
  const ids = parseAttachmentIds(raw);
  if (ids === null) return { ok: false, reply: err(400, "bad_attachment_ids") };
  if (!ids.length) return { ok: true, ids };
  const { data, error } = await deps.rpc("asn_relay_attach_claim", { p_node: nodeId, p_ids: ids });
  if (error) { console.error("attach_claim", error); return { ok: false, reply: err(500, "internal") }; }
  if (data?.error) return { ok: false, reply: err(400, "bad_attachment") };
  return { ok: true, ids };
}

/** 寄出後：把附件綁到那封信（messageId）或群組訊息（room＋seq）。失敗只記 log（信已寄出）。回綁到幾個。 */
export async function bindAttachments(
  deps: { rpc: Rpc }, nodeId: string, ids: string[], target: { messageId: string } | { room: string; seq: number },
): Promise<number> {
  if (!ids.length) return 0;
  const room = "room" in target;
  const { data, error } = await deps.rpc("asn_relay_attach_bind", {
    p_node: nodeId, p_ids: ids, p_message_id: room ? null : target.messageId, p_room: room ? target.room : null, p_seq: room ? target.seq : null,
  });
  if (error) { console.error("attach_bind", error); return 0; }
  return typeof data?.bound === "number" ? data.bound : 0;
}

/** 回一對一信件時附帶 attachments（沒有附件的信不加這個欄位）。查詢失敗就原樣回，不擋收信。 */
export async function withAttachments(deps: { rpc: Rpc }, messages: Json): Promise<Json> {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const ids = messages.map((m) => m?.id).filter(isUuid);
  if (!ids.length) return messages;
  const { data, error } = await deps.rpc("asn_relay_attach_for", { p_message_ids: ids, p_room: null, p_seqs: null });
  if (error || !Array.isArray(data)) { if (error) console.error("attach_for", error); return messages; }
  const by = new Map<string, AttachmentInfo[]>();
  for (const a of data) if (a?.message_id) by.set(a.message_id, [...(by.get(a.message_id) ?? []), publicInfo(a)]);
  return messages.map((m) => (by.has(m?.id) ? { ...m, attachments: by.get(m.id) } : m));
}

/** 回群組訊息時附帶 attachments（依群組內序號）。 */
export async function withRoomAttachments(deps: { rpc: Rpc }, room: string, messages: Json): Promise<Json> {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const seqs = messages.map((m) => m?.seq).filter((s) => typeof s === "number");
  if (!seqs.length) return messages;
  const { data, error } = await deps.rpc("asn_relay_attach_for", { p_message_ids: null, p_room: room, p_seqs: seqs });
  if (error || !Array.isArray(data)) { if (error) console.error("attach_for", error); return messages; }
  const by = new Map<number, AttachmentInfo[]>();
  for (const a of data) if (typeof a?.room_seq === "number") by.set(a.room_seq, [...(by.get(a.room_seq) ?? []), publicInfo(a)]);
  return messages.map((m) => (by.has(m?.seq) ? { ...m, attachments: by.get(m.seq) } : m));
}
