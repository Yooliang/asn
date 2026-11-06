// 雲端代理設定不對（#832）：驗證代理送來的內容。
// 節點一律取自金鑰；這裡只收「設定的節點代號」一個參數。文字固定在資料庫函式，代理帶來的字不會原樣進信。
const NODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

export type NodeMismatchNotice = { configured: string };

export function parseNodeMismatchNotice(body: unknown): NodeMismatchNotice | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const c = (body as Record<string, unknown>).configured;
  if (typeof c !== "string" || !NODE_RE.test(c)) return null;
  return { configured: c };
}
