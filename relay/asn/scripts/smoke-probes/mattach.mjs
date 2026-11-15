// 冒煙探測「手機群組附件檢查」（probe.mattach）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

// 手機群組附件：群組（含有外部成員的群組）看得到「傳照片」「傳送檔案」，選一個檔案會送出 room 附件
export const mattachProbeSource = ({ mattach }) => `(async () => {
  const want = ${JSON.stringify(mattach)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const labels = () => [...document.querySelectorAll('.m-chat .toolbar>.tool')].filter(b => b.offsetParent !== null).map(b => b.getAttribute('aria-label'));
  for (let i = 0; i < 60 && !document.querySelector('.m-chat .toolbar .tool'); i++) await sleep(100);
  const got = labels().filter(l => l === '傳照片' || l === '傳送檔案');
  if (JSON.stringify(got) !== JSON.stringify(want.labels)) return { ok: false, why: '群組工具列的附件鈕不符：' + JSON.stringify(got) };
  const bad = labels().filter(l => /語音|麥克風|聽寫/.test(l || ''));
  if (want.labels.length && bad.length) return { ok: false, why: '群組不該有語音鈕：' + bad.join('、') };
  if (!want.labels.length) return { ok: true, why: '' };
  const input = document.querySelector('.m-chat .toolbar input[type=file]:not([accept="image/*"])');
  if (!input) return { ok: false, why: '找不到傳送檔案的 input' };
  const dt = new DataTransfer(); dt.items.add(new File(['hello'], 'a.txt', { type: 'text/plain' }));
  input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  let call = null;
  for (let i = 0; i < 40 && !call; i++) { await sleep(100); call = (globalThis.__smokeCalls || []).find(c => c[0] === 'relay_send_attachment') }
  if (!call) return { ok: false, why: '選了檔案沒有送出附件' };
  if (call[1]?.payload?.room !== 'g1') return { ok: false, why: '附件沒有帶群組代號：' + JSON.stringify(call[1]?.payload?.room) };
  return { ok: true, why: '' };
})()`

export default {
  key: 'mattach',
  kind: '手機群組附件檢查',
  source: probe => mattachProbeSource(probe),
}
