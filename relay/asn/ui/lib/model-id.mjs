// 模型代號的統一格式（#2353 R3）：英數開頭（不會被當成旗標）、其後只收 . _ : / @ + [ ] -、最多 100 字。
// 與 Rust（src-tauri/src/agent_tools/models）、pi 的 SAFE（pi-models.mjs）同一條；
// 向量在 relay/shared/test-vectors/model-id.json，Rust 與 test/model-id.test.mjs 讀同一份。第②階段 SQL 與 Edge Function 也要抄這條。
export const MODEL_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:/@+\\[\\]-]{0,99}$'
const MODEL_ID_RE = new RegExp(MODEL_ID_PATTERN)

/** 這個字串能不能當模型代號 */
export function isValidModelId(s) {
  return typeof s === 'string' && MODEL_ID_RE.test(s)
}
