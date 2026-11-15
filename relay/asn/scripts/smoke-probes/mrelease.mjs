// 冒煙探測「手機新版紅點重讀檢查」（probe.mrelease）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const mreleaseProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let tabs = [];
  for (let i = 0; i < 60 && tabs.length < 4; i++) { tabs = [...document.querySelectorAll('.m-tabs button')]; if (tabs.length < 4) await sleep(100) }
  if (tabs.length !== 4) return { ok: false, why: '頁籤應該固定四個，實際 ' + tabs.length };
  const me = () => tabs.find(b => b.querySelector('span')?.textContent.trim() === '設定');
  for (let i = 0; i < 40 && (globalThis.__smokeRelReads || 0) < 1; i++) await sleep(100);
  await sleep(400);
  if ((globalThis.__smokeRelReads || 0) !== 1) return { ok: false, why: '啟動應該讀一次版本紀錄，實際 ' + (globalThis.__smokeRelReads || 0) };
  if (me().querySelector('i.red')) return { ok: false, why: '舊清單沒有新版，「設定」不該有紅點' };
  if (typeof window.__asnFgEvent !== 'function') return { ok: false, why: '外殼的前景事件入口不見了' };
  window.__asnFgEvent(true);
  await sleep(500);
  if ((globalThis.__smokeRelReads || 0) !== 1) return { ok: false, why: '清單還沒過期，回前景不該重讀' };
  const real = Date.now; Date.now = () => real() + 31 * 60000;
  window.__asnFgEvent(true);
  let dot = null;
  for (let i = 0; i < 40 && !dot; i++) { await sleep(100); dot = me().querySelector('i.red') }
  if ((globalThis.__smokeRelReads || 0) !== 2) return { ok: false, why: '清單過期後回前景應該重讀一次，實際共 ' + (globalThis.__smokeRelReads || 0) };
  if (!dot) return { ok: false, why: '重讀到新版後，「設定」那一格沒有紅點' };
  return { ok: true, why: '' };
})()`

export default {
  key: 'mrelease',
  kind: '手機新版紅點重讀檢查',
  source: probe => mreleaseProbeSource(probe),
}
