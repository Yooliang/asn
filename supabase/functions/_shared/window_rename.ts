// 視窗改名（#229）：用戶端明說「舊名→新名」，後台把同節點在群組裡的成員記錄一併改名（資料庫 asn_relay_window_rename）。
// 不靠名字猜測：只認用戶端明確帶來的 from／to。節點代號只取自金鑰，這裡不收。
// 格式同視窗名：去頭尾空白、1～60 字、不含控制字元與成員鍵分隔符「~」；舊名＝新名或任一壞值＝null。
export const RENAME_NAME_MAX = 60;

export type WindowRename = { from: string; to: string };

function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const n = v.trim();
  const len = Array.from(n).length;
  if (len < 1 || len > RENAME_NAME_MAX) return null;
  if (/[\u0000-\u001f\u007f-\u009f~]/.test(n)) return null;
  return n;
}

export function parseWindowRename(from: unknown, to: unknown): WindowRename | null {
  const f = clean(from), t = clean(to);
  if (f === null || t === null || f === t) return null;
  return { from: f, to: t };
}

/** 名單回報裡每個視窗可選帶 renamed_from（改名前的名字）：取出有效的改名，最多 20 筆，重複的只留一筆 */
export function renamesFromRoster(agents: Array<Record<string, unknown>>): WindowRename[] {
  const out: WindowRename[] = [];
  const seen = new Set<string>();
  for (const a of agents) {
    const r = parseWindowRename(a?.renamed_from, a?.name);
    if (!r) continue;
    const k = r.from + "\u0000" + r.to;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
    if (out.length >= 20) break;
  }
  return out;
}
