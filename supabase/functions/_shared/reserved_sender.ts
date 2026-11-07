// 寄件名保留字檢查（細節見私有文件，這裡只寫做法）：用戶端給的名字不能是系統保留的寄件名。
// 比對前先正規化（foldName），正規化只影響比對，不改寫入的名字。

// 比對時一律去掉：控制／格式字元、空白、組合記號、標點、符號
const IGNORED = /[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}\p{M}\p{P}\p{S}\s]/gu;

// 長得像的外國字母對照（小寫後的樣子），不求全
const CONFUSABLE: Record<string, string> = {
  "а": "a", "ɑ": "a", "α": "a", "ᴀ": "a",
  "ѕ": "s", "ꜱ": "s",
  "ν": "n", "ո": "n", "ɴ": "n", "ᴎ": "n",
};
// 簡體、日文字形的漢字折成繁體
const HAN: Record<string, string> = { "发": "發", "発": "發", "収": "收" };

/** 比對用的樣子 */
export function foldName(name: string): string {
  let s = name.normalize("NFKD").replace(IGNORED, "").toLowerCase();
  s = Array.from(s, (c) => CONFUSABLE[c] ?? HAN[c] ?? c).join("");
  return s.normalize("NFKC");
}

/**
 * 這個名字是不是系統保留的寄件名（用戶端不能用）。
 * nodeId＝呼叫端節點（金鑰決定）：`<nodeId>-收發室`（逐字）放行，因為那是這台橋自己的預設寄件名。
 */
export function isReservedSender(name: unknown, nodeId: string | null = null): boolean {
  if (typeof name !== "string" || name === "") return false;
  if (nodeId && name === `${nodeId}-收發室`) return false;
  const f = foldName(name);
  return f === "asn通知" || f.endsWith("收發室");
}

/** 寫入寄件名之前的檢查（寫入端會 slice(0, max) 再存）：超過 max 字、完整字串、真正寫入的值，任一個是保留的就不行 */
export function badSenderName(raw: unknown, nodeId: string | null = null, max = 100): boolean {
  if (typeof raw !== "string") return false;
  if (raw.length > max) return true;
  return isReservedSender(raw, nodeId) || isReservedSender(raw.slice(0, max), nodeId);
}
