// 開新夥伴 UI 用模型清單（瀏覽器可載入；勿 import Node 模組）。
// 與 relay/shared/launcher-profiles.mjs 的 MODEL_CATALOG 保持同步（test/partner.test.mjs 會比對）。

/** @typedef {'window'|'background'} LaunchMode */

export const MODEL_CATALOG = [
  { id: 'claude', toolId: 'claude', profileId: 'claude', label: 'Claude', mode: 'window', modeLabel: '會開一個視窗', acpWhy: 'Claude 沒有內建通道，只能開成終端機視窗' },
  { id: 'codex', toolId: 'codex', profileId: 'codex', label: 'Codex', mode: 'window', modeLabel: '會開一個視窗', acpWhy: 'Codex 還沒有內建通道，只能開成終端機視窗' },
  { id: 'gemini', toolId: 'agy', profileId: 'gemini', label: 'Gemini', mode: 'background', modeLabel: '由 ASN 內建通道執行', cliWhy: '終端機版沒有外部入口，ASN 收不到信；要收發信請用內建通道' },
  { id: 'grok', toolId: 'grok', profileId: 'grok', label: 'Grok', mode: 'background', modeLabel: '由 ASN 內建通道執行', cliWhy: '終端機版沒有外部入口，ASN 收不到信；要收發信請用內建通道' },
  { id: 'pi', toolId: 'pi', profileId: 'pi', label: 'pi', mode: 'window', modeLabel: '會開一個互動視窗（只能開在前台）', foregroundOnly: true, acpWhy: 'pi 沒有內建通道，只能開成終端機視窗' },
]

/**
 * 開新夥伴的「運行」二選一：CLI（開終端機視窗）／內建通道（ACP，背景運行，沒有視窗、要先安裝對應 CLI）。
 * 模型一選，哪種運行方式可用就由目錄決定（mode: window＝CLI、background＝內建通道）；不支援的那個反灰並寫原因（cliWhy／acpWhy）。
 * 目錄上沒有的項目（自訂設定）：只認那台回報的 mode，不支援的那個用通用原因。電腦版對話框與手機第 2 頁共用。
 * 回傳 { choices: [{ key: 'cli'|'acp', label, ok, why }], selected: 'cli'|'acp' }
 */
export const RUN_LABEL = { cli: 'CLI（開終端機視窗）', acp: '內建通道（背景運行）' }
const RUN_GENERIC_WHY = '這個模型的啟動設定不支援這種運行方式'
export function runChoices(row) {
  const acp = row?.mode === 'background'
  const choices = [
    { key: 'cli', label: RUN_LABEL.cli, ok: !acp, why: acp ? (row?.cliWhy || RUN_GENERIC_WHY) : '' },
    { key: 'acp', label: RUN_LABEL.acp, ok: acp, why: acp ? '' : (row?.acpWhy || RUN_GENERIC_WHY) },
  ]
  return { choices, selected: acp ? 'acp' : 'cli' }
}

/**
 * Claude 可切換的模型（對話中途換模型用；--model 接受這些別名）。
 * family 用來和啟動參數裡的 --model 比對（別名 opus、完整名稱 claude-opus-4-5、帶 [1m] 後綴都算同一家）。
 */
export const CLAUDE_MODELS = [
  { id: 'opus', family: 'opus', label: 'Opus' },
  { id: 'sonnet', family: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', family: 'haiku', label: 'Haiku' },
]
