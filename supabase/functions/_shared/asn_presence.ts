// ASN 回報在線狀態與版本（relay 的 asn_presence 動作）。節點取自金鑰（me.id），body 不收節點。
// 規則同資料庫函式 irori_relay_asn_presence_set（這裡先擋掉，少打一次資料庫）：
// 視窗名同 ASN 視窗名（去頭尾空白、1～40 字、不含控制字元）；版本 x.y.z（可接 -預發布）；狀態白名單；個人訊息 ≤ 80 字、可空。
// offline＝ASN 關閉時的最後一次回報，後端刪掉那一列。
import { parseSelfName } from "./node_name.ts";

export const PSM_MAX = 80;
export const VERSION_RE = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(-[0-9A-Za-z.]{1,16})?$/;
export const STATUSES = ["online", "away", "busy", "offline"] as const;
export type AsnStatus = (typeof STATUSES)[number];

export interface AsnPresence {
  window_name: string;
  version: string;
  status: AsnStatus;
  psm: string | null;
}

export function parseAsnPresence(b: unknown): AsnPresence | null {
  if (!b || typeof b !== "object") return null;
  const o = b as Record<string, unknown>;
  const window_name = parseSelfName(o.window_name);
  if (window_name === null) return null;
  if (typeof o.version !== "string" || !VERSION_RE.test(o.version)) return null;
  if (typeof o.status !== "string" || !(STATUSES as readonly string[]).includes(o.status)) return null;
  let psm: string | null = null;
  if (o.psm !== undefined && o.psm !== null) {
    if (typeof o.psm !== "string") return null;
    const t = o.psm.trim();
    if (Array.from(t).length > PSM_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(t)) return null;
    psm = t === "" ? null : t;
  }
  return { window_name, version: o.version, status: o.status as AsnStatus, psm };
}
