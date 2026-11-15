// 冒煙探測「手機對話分頁空白提示檢查」（probe.mchatEmpty）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const mchatEmptyProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const sec = () => document.querySelector('section.m-pg[aria-label="對話"]');
  for (let i = 0; i < 60 && !sec()?.querySelector('.empty-list'); i++) await sleep(100);
  const t = sec()?.querySelector('.empty-list')?.textContent.trim() || '';
  if (t !== '從夥伴分頁點一位開始對話') return { ok: false, why: '沒有最後一則時的提示不對：' + t };
  if (sec().querySelector('.m-buddy, .m-chat-list, .chatpane')) return { ok: false, why: '沒有最後一則時不該有清單或對話' };
  return { ok: true, why: '' };
})()`

export default {
  key: 'mchatEmpty',
  kind: '手機對話分頁空白提示檢查',
  source: () => mchatEmptyProbeSource(),
}
