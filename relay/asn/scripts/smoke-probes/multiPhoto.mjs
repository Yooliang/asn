// 冒煙探測「一次選多張檢查」（probe.multiPhoto）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

// 一次選多張（#1497）：在傳照片的選檔欄位一次選三張（中間那張壞掉）→ 依序送出兩張、壞的那張說明沒傳出，另外兩張不受影響
export const multiPhotoProbeSource = () => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let input = null;
  for (let i = 0; i < 60 && !input; i++) { input = [...document.querySelectorAll('.chatpane input[type="file"][accept="image/*"]')].find(e => e.closest('.chatpane').getClientRects().length) || null; if (!input) await sleep(100) }
  if (!input) return { ok: false, why: '找不到傳照片的選檔欄位' };
  if (!input.multiple) return { ok: false, why: '傳照片的選檔欄位不能多選' };
  input.setAttribute('data-smoke-pick', '1');
  globalThis.__smokeCalls = [];
  globalThis.__smokeInput(JSON.stringify({ files: ['.chatpane input[data-smoke-pick="1"]', 'ok1.png', 'bad.png', 'ok2.png'] }));
  const sends = () => (globalThis.__smokeCalls || []).filter(c => c[0] === 'relay_send_attachment');
  let txt = '';
  for (let i = 0; i < 100; i++) { txt = [...document.querySelectorAll('.chatpane')].map(e => e.textContent).join(' '); if (/張已傳出/.test(txt)) break; await sleep(100) }
  const n = sends().length;
  if (n !== 2) return { ok: false, why: '應該送出 2 張，實際 ' + n + ' 張' };
  const names = sends().map(c => c[1] && c[1].payload && c[1].payload.name);
  if (names[0] !== 'ok1.webp' || names[1] !== 'ok2.webp') return { ok: false, why: '送出的順序不對：' + names.join('、') };
  if (!/2 張已傳出，1 張沒有傳出：bad\\.png/.test(txt)) return { ok: false, why: '送完沒有說明哪一張沒傳出：' + txt.slice(0, 120) };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

export default {
  key: 'multiPhoto',
  kind: '一次選多張檢查',
  source: () => multiPhotoProbeSource(),
}
