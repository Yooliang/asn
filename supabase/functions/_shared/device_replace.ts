// 換新設備時處理舊設備（#1860 H）：候選、取代、不取代三個動作。
// 跟 device_rename 一樣要節點金鑰（送請求的是哪台，me.id）加本人簽章（x-asn-user）；資料庫函式再核對兩台都是這個人的
// （見 migration 20261124210000_device_replace.sql）。
import { signedUserId } from "./owner_sign.ts";
import type { SignedDeps } from "./partners.ts";

const NODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

type Result = { status: number; body: unknown };

/** 資料庫回的錯誤碼對照狀態碼與白話（白話給用戶端顯示用；原文只進 log） */
const ERRORS: Record<string, { status: number; message: string }> = {
  not_found: { status: 404, message: "找不到這台設備，可能已經被移除。" },
  not_candidate: { status: 409, message: "這台舊設備現在不能被取代（可能剛剛又上線了，或已經處理過）。" },
  answered: { status: 409, message: "這台新設備已經處理過了。" },
  removed_full: { status: 409, message: "「已移除的設備」已達上限，請先恢復幾台再取代。" },
  bad_request: { status: 400, message: "請求內容不正確。" },
};

function rpcMissing(e: unknown): boolean {
  const o = e as { code?: unknown; message?: unknown } | null;
  if (!o) return false;
  if (o.code === "PGRST202" || o.code === "42883") return true;
  return typeof o.message === "string" && /could not find the function/i.test(o.message);
}

/** 請求本文：{ new, old }（取代）或 { new }（不取代） */
export function parseDeviceReplace(b: unknown, needOld: boolean): { new: string; old: string } | null {
  if (!b || typeof b !== "object") return null;
  const o = b as Record<string, unknown>;
  if (typeof o.new !== "string" || !NODE_RE.test(o.new)) return null;
  if (!needOld) return { new: o.new, old: "" };
  if (typeof o.old !== "string" || !NODE_RE.test(o.old) || o.old === o.new) return null;
  return { new: o.new, old: o.old };
}

async function call(
  deps: SignedDeps,
  signHeader: string | null,
  fn: string,
  args: (user: string) => Record<string, unknown>,
  ok: (d: Record<string, unknown>) => unknown,
): Promise<Result> {
  const user = await signedUserId(deps.verifyJwt, signHeader);
  if (!user) return { status: 401, body: { error: "unauthorized" } };
  const { data, error } = await deps.rpc(fn, args(user));
  if (error) {
    if (rpcMissing(error)) return { status: 404, body: { error: "not_found" } };
    console.error(fn, error);
    return { status: 500, body: { error: "internal" } };
  }
  const d = (data ?? {}) as Record<string, unknown>;
  if (typeof d.error === "string") {
    const m = ERRORS[d.error];
    if (m) return { status: m.status, body: { error: d.error, message: m.message } };
    console.error(fn, d.error);
    return { status: 400, body: { error: "bad_request", message: ERRORS.bad_request.message } };
  }
  if (d.ok !== true && !Array.isArray(d.cards)) return { status: 400, body: { error: "bad_request", message: ERRORS.bad_request.message } };
  return { status: 200, body: ok(d) };
}

export function handleDeviceReplaceCandidates(deps: SignedDeps, me: { id: string }, signHeader: string | null): Promise<Result> {
  return call(deps, signHeader, "asn_device_replace_candidates", (u) => ({ p_user: u, p_actor: me.id }), (d) => ({ cards: d.cards ?? [] }));
}

export async function handleDeviceReplace(deps: SignedDeps, me: { id: string }, signHeader: string | null, body: unknown): Promise<Result> {
  const req = parseDeviceReplace(body, true);
  if (!req) return { status: 400, body: { error: "bad_request", message: ERRORS.bad_request.message } };
  return await call(
    deps, signHeader, "asn_device_replace",
    (u) => ({ p_user: u, p_actor: me.id, p_new: req.new, p_old: req.old }),
    (d) => ({ ok: true, already: d.already === true, renamed: d.renamed === true }),
  );
}

export async function handleDeviceReplaceDismiss(deps: SignedDeps, me: { id: string }, signHeader: string | null, body: unknown): Promise<Result> {
  const req = parseDeviceReplace(body, false);
  if (!req) return { status: 400, body: { error: "bad_request", message: ERRORS.bad_request.message } };
  return await call(
    deps, signHeader, "asn_device_replace_dismiss",
    (u) => ({ p_user: u, p_actor: me.id, p_new: req.new }),
    () => ({ ok: true }),
  );
}
