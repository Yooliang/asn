// 冒煙探測「系統管理員視窗的『收不到信』標記檢查」（probe.elevated）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 電腦版：標記來自本機現讀（local_windows 帶 elevated）；手機：標記來自後台名單帶的 elevated（後台支援後才會有，這裡用假後台驗畫面）。
// 兩位夥伴：admin-win（系統管理員身分）要有標記與說明，normal-win 不能有。

export const elevatedProbeSource = mode => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const sel = ${JSON.stringify(mode)} === 'phone' ? '.m-buddy' : '.buddy:not(.term-buddy)';
  const rowOf = name => [...document.querySelectorAll(sel)].find(b => vis(b) && (b.querySelector('.b-nick')?.textContent ?? '').trim() === name);
  let admin = null;
  for (let i = 0; i < 80 && !admin?.querySelector('.b-elev'); i++) { admin = rowOf('admin-win'); if (!admin?.querySelector('.b-elev')) await sleep(100) }
  if (!admin) return { ok: false, why: '名單上找不到 admin-win' };
  const badge = admin.querySelector('.b-elev');
  if (!vis(badge)) return { ok: false, why: 'admin-win 沒有「收不到信」標記' };
  if (badge.textContent.trim() !== '收不到信') return { ok: false, why: '標記文字不對：' + badge.textContent.trim() };
  const tip = badge.getAttribute('title') || '';
  if (!tip.includes('系統管理員身分開的') || !tip.includes('重開')) return { ok: false, why: '說明文字不對：' + tip };
  const a = admin.getBoundingClientRect(), b = badge.getBoundingClientRect();
  if (b.right > a.right + 1 || b.left < a.left || b.width < 20) return { ok: false, why: '標記超出列或太窄：列 ' + [a.left, a.right].map(Math.round) + '，標記 ' + [b.left, b.right].map(Math.round) };
  if (badge.scrollWidth > badge.clientWidth + 1) return { ok: false, why: '標記文字被截掉' };
  const normal = rowOf('normal-win');
  if (!normal) return { ok: false, why: '名單上找不到 normal-win' };
  if (normal.querySelector('.b-elev')) return { ok: false, why: '一般視窗不該有標記' };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const members = [{ id: 'P', name: '測試機', agents: [
  { name: 'admin-win', status: 'idle', engine: 'claude', cwd_label: 'demo', elevated: true },
  { name: 'normal-win', status: 'idle', engine: 'claude', cwd_label: 'demo' },
] }]

const desk = (name, skin) => ({ name, page: 'list.html', width: 900, height: 640, state: { signedIn: true, elevated: true, ...(skin ? { skin } : {}) }, ready: '#app.win .buddy', probe: { elevated: 'desk' }, shot: `${name}.png` })
const phone = (name, skin) => ({ name, page: 'm.html', state: { signedIn: true, mtab: 'list', elevated: true, ...(skin ? { skin } : {}) }, ready: '#app.m .m-buddy', probe: { elevated: 'phone' }, shot: `${name}.png` })

export default {
  key: 'elevated',
  kind: '系統管理員視窗「收不到信」標記檢查',
  source: probe => elevatedProbeSource(probe.elevated),
  scenarios: [desk('list-elevated'), desk('list-elevated-modern', 'modern'), phone('m-elevated'), phone('m-elevated-modern', 'modern')],
  // 電腦版：後台名單不帶標記（它不認得這個欄位），由本機現讀補上；手機：只有後台名單
  table: scenario => (scenario.state?.elevated
    ? { relay_list: { members: scenario.page === 'list.html' ? members.map(m => ({ ...m, agents: m.agents.map(({ elevated, ...a }) => a) })) : members },
        ...(scenario.page === 'list.html' ? { local_windows: [{ name: 'admin-win', status: 'idle', detail: null, context_pct: null, elevated: true }, { name: 'normal-win', status: 'idle', detail: null, context_pct: null }] } : {}) }
    : undefined),
}
