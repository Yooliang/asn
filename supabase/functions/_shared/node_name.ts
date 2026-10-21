// 節點自己的顯示名（relay.nodes.name）：ASN 把這台設備上 ASN 的視窗名寫進來，名單帶出後別台設備的前台用它當設備顯示名。
// 規則同 ASN 視窗名（relay/asn/src-tauri/src/names.rs validate_name 的前三條）：去頭尾空白、1～40 字、不含控制字元。
// 資料庫函式 irori_relay_set_self_name 會再檢查一次（這裡先擋掉，少打一次資料庫）。
export const SELF_NAME_MAX = 40;

export function parseSelfName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const n = v.trim();
  const len = Array.from(n).length;
  if (len < 1 || len > SELF_NAME_MAX) return null;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(n)) return null;
  return n;
}
