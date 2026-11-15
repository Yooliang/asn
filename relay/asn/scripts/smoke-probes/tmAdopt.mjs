// 冒煙探測「工作管理員納入管理檢查」（probe.tmAdopt，#1557）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 「把這台電腦上開著的終端納入管理」從夥伴選單搬到「設定 → 設備 → 這台電腦 → 工作管理員」：
// 自己開的那兩列（自己開的 Claude 視窗、自己開的前景 pi）有「納入管理」，ASN 開的、終端服務、ASN 本體沒有；
// 真點擊「納入管理」打開跟以前同一個接手清單（列出候選窗格、按鈕是「接手」）。接著名單右鍵沒有「納入管理」

// 接手清單的候選窗格（假的；只拿來確認清單真的打開、內容照舊）
export const TM_ADOPT_CANDIDATES = [{ pid: 9100, pane_id: 3, started_ms: 1763000000000, profile: 'claude', tab_title: 'demo', cwd_raw: 'D:\\work', cwd_authorized: true, version_verified: true, version_note: '', already_adopted: false }]

export const tmAdoptProbeSource = () => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 400) };
  const click = async el => { el.scrollIntoView({ block: 'center' }); await sleep(150); await real({ click: at(el) }) };
  const waitFor = async (fn, n = 80) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const self = await waitFor(() => [...document.querySelectorAll('.dv-list .dv-row')].find(r => r.querySelector('.dv-tag.me')));
  if (!self) return { ok: false, why: '設備列表裡找不到「這台」' };
  await click([...self.querySelectorAll('button')].find(b => b.textContent.trim() === '帳號'));
  const entry = await waitFor(() => [...document.querySelectorAll('.dv-dev-h .dv-tasks')].find(vis));
  if (!entry) return { ok: false, why: '這台電腦的詳情頁沒有「工作管理員」入口' };
  await click(entry);
  const rows = await waitFor(() => { const r = [...document.querySelectorAll('.tm-table tbody tr')]; return r.length >= 8 ? r : null });
  if (!rows) return { ok: false, why: '工作管理員沒有列出程式' };
  const btnOf = r => [...r.querySelectorAll('button.tm-adopt')].find(vis) || null;
  const withBtn = rows.filter(btnOf);
  const src = r => r.children[6]?.textContent.trim() ?? '';
  if (withBtn.length !== 2) return { ok: false, why: '應該只有 2 列有「納入管理」，實際 ' + withBtn.length + ' 列' };
  if (!withBtn.every(r => src(r).startsWith('自己開的'))) return { ok: false, why: '「納入管理」出現在不是自己開的那一列：' + withBtn.map(src).join('、') };
  if (rows.some(r => src(r).startsWith('ASN') && btnOf(r))) return { ok: false, why: 'ASN 開的那一列不該有「納入管理」' };
  const b = btnOf(withBtn[0]);
  if (b.textContent.trim() !== '納入管理') return { ok: false, why: '按鈕字不對：' + b.textContent.trim() };
  await click(b);
  const dlg = await waitFor(() => [...document.querySelectorAll('.partner-dlg.term-list-dlg')].find(d => vis(d) && d.querySelector('#term-adopt-title')));
  if (!dlg) return { ok: false, why: '按了「納入管理」沒有打開接手清單' };
  const pick = await waitFor(() => [...dlg.querySelectorAll('button')].find(x => vis(x) && x.textContent.trim() === '接手'));
  if (!pick) return { ok: false, why: '接手清單沒有列出候選窗格（應該有一個「接手」）' };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

export default {
  key: 'tmAdopt',
  kind: '工作管理員納入管理檢查',
  source: () => tmAdoptProbeSource(),
  scenarios: [
    { name: 'list-tm-adopt', page: 'list.html', width: 1100, height: 760, state: { signedIn: true, taskmgr: true, tmAdopt: true }, ready: '#app.win .dv-set', probe: { tmAdopt: true }, shot: 'list-tm-adopt.png' },
    { name: 'list-tm-adopt-modern', page: 'list.html', width: 1100, height: 760, state: { signedIn: true, taskmgr: true, tmAdopt: true, skin: 'modern' }, ready: '#app.win .dv-set', probe: { tmAdopt: true }, shot: 'list-tm-adopt-modern.png' },
  ],
  table: scenario => (scenario.state?.tmAdopt ? { term_adopt_candidates: TM_ADOPT_CANDIDATES } : undefined),
}
