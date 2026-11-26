// #2353 統一型號代號規則（Edge 端唯一一份）。
// 字元集與 relay/shared/test-vectors/model-id.json 的 pattern 逐字相同；另加分段檢查：以 / 切開後每一段不能是空字串、.、..。
// 不從 relay/asn/ui/lib/model-id.mjs 匯入：supabase functions deploy 只打包函式目錄。四處對照由 model_id_test.ts 讀同一份向量守門。
export const MODEL_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:/@+\\[\\]-]{0,99}$";
const MODEL_ID_RE = new RegExp(MODEL_ID_PATTERN);

export function isValidModelId(s: unknown): s is string {
  return typeof s === "string" && MODEL_ID_RE.test(s) && s.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}
