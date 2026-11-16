// 冒煙探測「視窗開著、還沒進到對話的夥伴」顯示檢查（probe.awaiting，#1635）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 名單上是「僅顯示」條目（kind＝process、receivable＝false、說明是固定句）：新版畫面要顯示夥伴名與「等你按確認」，
// 不能顯示成可寄信的線上，也不能出現條目的內部名字；一般視窗照舊。

export const awaitingProbeSource = mode => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const sel = ${JSON.stringify(mode)} === 'phone' ? '.m-buddy' : '.buddy:not(.term-buddy)';
  const rowOf = name => [...document.querySelectorAll(sel)].find(b => vis(b) && (b.querySelector('.b-nick')?.textContent ?? '').trim() === name);
  let row = null;
  for (let i = 0; i < 80 && !row; i++) { row = rowOf('小乙'); if (!row) await sleep(100) }
  if (!row) return { ok: false, why: '名單上找不到「小乙」（等確認的夥伴要用夥伴名顯示）' };
  const note = (row.querySelector('.b-st')?.textContent ?? '').trim();
  if (!note.includes('等你按確認')) return { ok: false, why: '狀態字不對：' + note };
  if (row.textContent.includes('#502') || row.textContent.includes('僅顯示')) return { ok: false, why: '不該露出條目的內部名字或「僅顯示」：' + row.textContent.trim() };
  const normal = rowOf('normal-win');
  if (!normal) return { ok: false, why: '名單上找不到 normal-win' };
  if ((normal.querySelector('.b-st')?.textContent ?? '').includes('等你按確認')) return { ok: false, why: '一般視窗不該有等確認的字' };
  const a = row.getBoundingClientRect(), b = row.querySelector('.b-st').getBoundingClientRect();
  if (b.right > a.right + 1 || b.left < a.left) return { ok: false, why: '狀態字超出列' };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const members = [{ id: 'P', name: '測試機', agents: [
  { name: 'claude · 小乙 #502', status: 'running', engine: 'claude', cwd_label: '', kind: 'process', receivable: false, detail: '視窗開著，但在等你按確認' },
  { name: 'normal-win', status: 'idle', engine: 'claude', cwd_label: 'demo' },
] }]

const desk = (name, skin) => ({ name, page: 'list.html', width: 900, height: 640, state: { signedIn: true, awaiting: true, ...(skin ? { skin } : {}) }, ready: '#app.win .buddy', probe: { awaiting: 'desk' }, shot: `${name}.png` })
const phone = (name, skin) => ({ name, page: 'm.html', state: { signedIn: true, mtab: 'list', awaiting: true, ...(skin ? { skin } : {}) }, ready: '#app.m .m-buddy', probe: { awaiting: 'phone' }, shot: `${name}.png` })

export default {
  key: 'awaiting',
  kind: '等你按確認的夥伴顯示檢查',
  source: probe => awaitingProbeSource(probe.awaiting),
  scenarios: [desk('list-awaiting'), phone('m-awaiting')],
  table: scenario => (scenario.state?.awaiting ? { relay_list: { members } } : undefined),
}
