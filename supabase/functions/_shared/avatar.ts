// 設備大頭貼（relay.nodes.avatar）的格式與大小檢查。irori-relay 的 set_avatar 動作用它；
// 規則與 supabase/sql/30_node_avatar.sql、relay/asn（ui/lib/avatar.mjs、src-tauri/src/avatar.rs）一致：
//   只收 data:image/png;base64, 或 data:image/webp;base64, 開頭、base64 字元、全長 ≤ 48000 字、圖檔 ≤ 32 KB、檔頭要跟格式對得上。
// 明確的 null ＝ 移除；沒帶欄位由呼叫端擋（不猜意思）。
export const AVATAR_MAX_CHARS = 48000;
export const AVATAR_MAX_BYTES = 32 * 1024;

export type AvatarCheck =
  | { ok: true; avatar: string | null }
  | { ok: false; error: "bad_avatar_format" | "avatar_too_large" };

const PREFIX = /^data:image\/(png|webp);base64,/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// 只解前 n 個位元組（驗檔頭用）
function head(b64: string, n: number): number[] {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out: number[] = [];
  let acc = 0, bits = 0;
  for (const ch of b64) {
    acc = (acc << 6) | A.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
    if (out.length >= n) break;
  }
  return out;
}

export function checkAvatar(v: unknown): AvatarCheck {
  if (v === null) return { ok: true, avatar: null };
  if (typeof v !== "string") return { ok: false, error: "bad_avatar_format" };
  const m = PREFIX.exec(v);
  if (!m) return { ok: false, error: "bad_avatar_format" };
  if (v.length > AVATAR_MAX_CHARS) return { ok: false, error: "avatar_too_large" };
  const b64 = v.slice(m[0].length);
  if (!B64.test(b64) || b64.length % 4 === 1) return { ok: false, error: "bad_avatar_format" };
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  if (Math.floor((b64.length * 3) / 4) - pad > AVATAR_MAX_BYTES) return { ok: false, error: "avatar_too_large" };
  const h = head(b64, 12);
  const good = m[1] === "png"
    ? PNG_SIG.every((x, i) => h[i] === x)
    : h.length >= 12 && [0x52, 0x49, 0x46, 0x46].every((x, i) => h[i] === x) && [0x57, 0x45, 0x42, 0x50].every((x, i) => h[8 + i] === x);
  return good ? { ok: true, avatar: v } : { ok: false, error: "bad_avatar_format" };
}
