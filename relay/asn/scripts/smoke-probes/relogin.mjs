// 冒煙探測「手機重新登入 Claude 檢查」（probe.relogin，#1512 C）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 那台電腦回報 Claude 登入失效時，設備細部頁的 Claude 區出現「重新登入 Claude」（安裝入口的總開關關著也有）；
// 按了只進確認（確認字寫明「那台沒看到失效就不會動現有的登入」），按「確認重新登入」才送出要求（同一個 setup_remote_request，只帶那台的節點）。
// 另一台沒回報失效的：沒有這顆。全部用真的點擊。探測原始碼是字串，裡面不寫反斜線

export const reloginProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 400) };
  const tap = async el => { el.scrollIntoView({ block: 'center' }); await sleep(120); await real({ click: at(el) }) };
  const wait = async (fn, n = 60) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const sent = () => (globalThis.__smokeCalls || []).filter(c => c[0] === 'setup_remote_request');
  const btn = await wait(() => [...document.querySelectorAll('.m-row-btn')].find(b => vis(b) && b.textContent.includes('設備')));
  if (!btn) return { ok: false, why: '找不到設定裡的「設備」' };
  await tap(btn);
  const openDevice = async name => {
    const row = await wait(() => [...document.querySelectorAll('.m-dv-row')].filter(vis).find(r => (r.querySelector('.m-dv-rn b')?.textContent ?? '').trim() === name));
    if (!row) return false;
    await tap(row.querySelector('.m-dv-go'));
    const go = await wait(() => [...row.querySelectorAll('.m-dv-accbtn')].find(vis));
    if (!go) return false;
    await tap(go);
    return !!(await wait(() => [...document.querySelectorAll('.m-dv-vendor')].some(vis)));
  };
  if (!(await openDevice('辦公室'))) return { ok: false, why: '打不開「辦公室」的細部頁' };
  const relogin = await wait(() => [...document.querySelectorAll('.m-dv-relogin')].find(vis), 200);   // 帳號回報讀回來才有入口：全套並行跑時比較慢，多等一點
  if (!relogin) return { ok: false, why: '那台回報 Claude 登入失效，細部頁卻沒有「重新登入 Claude」' };
  if (relogin.textContent.trim() !== '重新登入 Claude') return { ok: false, why: '按鈕的字不對：' + relogin.textContent };
  if ([...document.querySelectorAll('.m-dv-setup .m-btn')].filter(vis).some(b => b.textContent.includes('安裝並登入'))) return { ok: false, why: '安裝入口的總開關關著，不該出現「從手機安裝並登入」' };
  await tap(relogin);
  const dlg = await wait(() => [...document.querySelectorAll('.m-dv-confirm')].find(vis));
  if (!dlg) return { ok: false, why: '按了沒有進確認' };
  if (sent().length) return { ok: false, why: '按鈕不能直接送出，要先確認' };
  if (!dlg.textContent.includes('重新登入 Claude 嗎') || !dlg.textContent.includes('不會動現有的登入') || !dlg.textContent.includes('允許從手機替這台安裝並登入')) return { ok: false, why: '確認字沒寫清楚：' + dlg.textContent.slice(0, 80) };
  const yes = [...dlg.querySelectorAll('.m-btn')].find(b => b.textContent.trim() === '確認重新登入');
  if (!yes) return { ok: false, why: '找不到「確認重新登入」' };
  await tap(yes);
  if (!(await wait(() => sent().length === 1))) return { ok: false, why: '按了確認沒有送出要求（或送了不只一次）：' + sent().length };
  const args = sent()[0][1] || {};
  if (JSON.stringify(Object.keys(args).sort()) !== JSON.stringify(['node']) || args.node !== 'Q') return { ok: false, why: '要求只帶那台的節點，不帶別的（例如「失效」）：' + JSON.stringify(args) };
  if (document.documentElement.scrollWidth > window.innerWidth + 1) return { ok: false, why: '整頁橫向溢出' };
  return { ok: true, why: '' };
})()`

export default {
  key: 'relogin',
  kind: '手機重新登入 Claude 檢查',
  source: () => reloginProbeSource(),
  scenarios: [
    { name: 'm-relogin', page: 'm.html', state: { signedIn: true, mlayout: true, relogin: true }, ready: '#app.m .m-row-btn', probe: { relogin: true }, shot: 'm-relogin.png' },
  ],
  // 辦公室（Q）回報目前的 Claude 帳號登入失效；送出要求與查狀態都只記下來
  table: (scenario, t) => {
    if (!scenario.state?.relogin) return undefined
    const list = t.android_acct_list
    const q = list?.values?.Q
    if (!q) return undefined
    const accounts = q.accounts.map(a => (a.vendor === 'claude' && a.current ? { ...a, login_failed: true } : a))
    // 回報時間用跑這個情境的當下算（全套跑完要二十幾分鐘，載入時算的時間到這裡已經過舊，入口照規則就不給）
    const reportedAt = new Date(Math.floor((Date.now() - 5 * 60_000) / 60_000) * 60_000).toISOString()
    return { android_acct_list: { ...list, values: { ...list.values, Q: { ...q, reported_at: reportedAt, accounts } } }, setup_remote_request: { ok: true }, setup_remote_status: { nodes: [] } }
  },
}
