// 開新夥伴 UI 用模型清單（瀏覽器可載入；勿 import Node 模組）。
// 與 relay/shared/launcher-profiles.mjs 的 MODEL_CATALOG 保持同步（test/partner.test.mjs 會比對）。

/** @typedef {'window'|'background'} LaunchMode */

export const MODEL_CATALOG = [
  { id: 'claude', toolId: 'claude', profileId: 'claude', label: 'Claude', mode: 'window', modeLabel: '會開一個視窗' },
  { id: 'codex', toolId: 'codex', profileId: 'codex', label: 'Codex', mode: 'window', modeLabel: '會開一個視窗' },
  { id: 'gemini', toolId: 'agy', profileId: 'gemini', label: 'Gemini', mode: 'background', modeLabel: '在背景執行' },
  { id: 'grok', toolId: 'grok', profileId: 'grok', label: 'Grok', mode: 'background', modeLabel: '在背景執行' },
  { id: 'pi', toolId: 'pi', profileId: 'pi', label: 'pi', mode: 'window', modeLabel: '會開一個視窗' },
]
