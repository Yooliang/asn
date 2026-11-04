// 夥伴卡在要人處理的框上太久（todo-next-162）：驗證收發室送來的內容。
// 節點一律取自金鑰；這裡只收視窗名、種類、選擇框的問題和選項。
const KINDS = new Set(["permission", "input", "other"]);
const WINDOW_MAX = 60;
const DETAIL_MAX = 600;
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

export type WaitingNotice = { window: string; kind: string; detail: string | null };

export function parseWaitingNotice(body: unknown): WaitingNotice | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.window !== "string" || typeof b.kind !== "string" || !KINDS.has(b.kind)) return null;
  const window = b.window.replace(CONTROL, "").trim();
  if (!window || [...window].length > WINDOW_MAX) return null;
  if (b.detail !== undefined && b.detail !== null && typeof b.detail !== "string") return null;
  // 內容只有選擇框才收：權限框與 hook 框就算送來也丟掉，不讓指令內容進後台
  const raw = b.kind === "input" && typeof b.detail === "string" ? b.detail.replace(CONTROL, " ").trim() : "";
  const detail = raw ? [...raw].slice(0, DETAIL_MAX).join("") : null;
  return { window, kind: b.kind, detail };
}
