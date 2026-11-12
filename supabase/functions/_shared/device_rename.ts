// 設備名稱統一（#1388）：本人從任一台自己的設備替任一台自己的設備改名（relay.nodes.name，所有地方顯示同一個值）。
// 要節點金鑰（送請求的是哪台，me.id）加本人簽章（x-asn-user）：節點金鑰 AI 視窗也拿得到，登入憑證只在 ASN 的 Rust 端，
// 所以 AI、信件、asn-cli 都沒辦法替人改設備名。資料庫函式 asn_device_rename 再核對兩台都是這個人的（見 migration 20261113500000）。
import { signedUserId } from "./owner_sign.ts";
import { isReservedSender } from "./reserved_sender.ts";
import type { SignedDeps } from "./partners.ts";

export const DEVICE_NAME_MAX = 40;
const NODE_RE = /^[A-Za-z0-9_-]{1,32}$/;
// 和資料庫函式 relay.device_name_ok 同一套規則（這裡先擋，少打一次資料庫；資料庫會再檢查一次）
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
const HEX8 = /(?=[a-f]{0,7}[0-9])[0-9a-f]{8}/i;
const HEX44 = /(?=[a-f\s　]{0,8}[0-9])[0-9a-f]{4}[\s　][0-9a-f]{4}/i;

/** 名字合格就回整理過的名字（去頭尾空白），不合格回 null */
export function parseDeviceName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // 去空白前先擋看不見的字元（JS 的 trim 會吃掉 BOM，資料庫的 btrim 不會；兩邊要一致）
  if (INVISIBLE.test(v)) return null;
  const n = v.trim();
  const len = Array.from(n).length;
  if (len < 1 || len > DEVICE_NAME_MAX) return null;
  if (CONTROL.test(n) || INVISIBLE.test(n) || n.includes("指紋") || HEX8.test(n) || HEX44.test(n)) return null;
  if (isReservedSender(n, null)) return null;
  return n;
}

/** 請求本文：{ node, name }，node 是要改名的那台（可以是自己） */
export function parseDeviceRename(b: unknown): { node: string; name: string } | null {
  if (!b || typeof b !== "object") return null;
  const o = b as Record<string, unknown>;
  if (typeof o.node !== "string" || !NODE_RE.test(o.node)) return null;
  const name = parseDeviceName(o.name);
  return name === null ? null : { node: o.node, name };
}

function rpcMissing(e: unknown): boolean {
  const o = e as { code?: unknown; message?: unknown } | null;
  if (!o) return false;
  if (o.code === "PGRST202" || o.code === "42883") return true;
  return typeof o.message === "string" && /could not find the function/i.test(o.message);
}

export async function handleDeviceRename(
  deps: SignedDeps,
  me: { id: string },
  signHeader: string | null,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const user = await signedUserId(deps.verifyJwt, signHeader);
  if (!user) return { status: 401, body: { error: "unauthorized" } };
  const req = parseDeviceRename(body);
  if (!req) return { status: 400, body: { error: "bad_request" } };
  const { data, error } = await deps.rpc("asn_device_rename", { p_user: user, p_actor: me.id, p_node: req.node, p_name: req.name });
  if (error) {
    if (rpcMissing(error)) return { status: 404, body: { error: "not_found" } };
    console.error("device_rename", error);
    return { status: 500, body: { error: "internal" } };
  }
  const d = data as { error?: string; ok?: boolean; name?: string; changed?: boolean } | null;
  if (d?.error === "not_found") return { status: 404, body: { error: "not_found" } };
  if (d?.error === "rate_limited") return { status: 429, body: { error: "rate_limited" } };
  if (d?.error || d?.ok !== true) return { status: 400, body: { error: d?.error ?? "bad_request" } };
  return { status: 200, body: { ok: true, name: d.name, changed: d.changed === true } };
}
