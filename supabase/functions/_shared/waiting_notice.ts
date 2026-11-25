// 夥伴卡在要人處理的框上太久（todo-next-162）：驗證收發室送來的內容。
// 節點一律取自金鑰；這裡只收視窗名、種類、選擇框的問題和選項。
const KINDS = new Set(["permission", "input", "other", "login", "forward_stuck", "forward_stuck_manual", "stuck_prompt", "handoff_wait"]);
// 收發室轉交連續被擋（#2146 ③）：detail 只收固定的原因代號、tool 只收次數（1～2 位數字），不收任何自由文字
const STUCK_REASONS = new Set(["frame", "no_id", "missing_fields", "recipient_conflict", "wrong_to", "head_mismatch", "not_in_flight", "record_unreadable"]);
const WINDOW_MAX = 60;
const DETAIL_MAX = 600;
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

// deno-lint-ignore no-control-regex
const KEEP_NEWLINE_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

export type WaitingNotice = { window: string; kind: string; detail: string | null; tool: string | null };

export function parseWaitingNotice(body: unknown): WaitingNotice | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.window !== "string" || typeof b.kind !== "string" || !KINDS.has(b.kind)) return null;
  const window = b.window.replace(CONTROL, "").trim();
  if (!window || [...window].length > WINDOW_MAX) return null;
  if (b.detail !== undefined && b.detail !== null && typeof b.detail !== "string") return null;
  // 內容只有選擇框才收：權限框與 hook 框就算送來也丟掉，不讓指令內容進後台
  if (b.kind === "forward_stuck" || b.kind === "forward_stuck_manual") {
    const reason = typeof b.detail === "string" && STUCK_REASONS.has(b.detail) ? b.detail : null;
    const count = typeof b.tool === "string" && /^[0-9]{1,2}$/.test(b.tool) ? b.tool : null;
    return { window, kind: b.kind, detail: reason, tool: count };
  }
  // 換班接手等前任的子代理太久（#1908）：detail＝已等分鐘（1～4 位數字）、tool＝子代理件數（1～3 位數字），都只收純數字
  if (b.kind === "handoff_wait") {
    const minutes = typeof b.detail === "string" && /^[0-9]{1,4}$/.test(b.detail) ? b.detail : null;
    const agents = typeof b.tool === "string" && /^[0-9]{1,3}$/.test(b.tool) ? b.tool : null;
    return { window, kind: b.kind, detail: minutes, tool: agents };
  }
  // 卡在確認框超過 5 分鐘（#2256）：電腦端擷取的那一段畫面，換行留著、其他控制字元換成空白，最多 600 字；工具名不收
  if (b.kind === "stuck_prompt") {
    const shot = typeof b.detail === "string" ? b.detail.replace(KEEP_NEWLINE_CONTROL, " ").trim() : "";
    return { window, kind: b.kind, detail: shot ? [...shot].slice(0, DETAIL_MAX).join("") : null, tool: null };
  }
  const raw = b.kind === "input" && typeof b.detail === "string" ? b.detail.replace(CONTROL, " ").trim() : "";
  const detail = raw ? [...raw].slice(0, DETAIL_MAX).join("") : null;
  // 工具名只有權限框才收，而且只收一般字元
  const tool = b.kind === "permission" && typeof b.tool === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(b.tool) ? b.tool : null;
  return { window, kind: b.kind, detail, tool };
}
