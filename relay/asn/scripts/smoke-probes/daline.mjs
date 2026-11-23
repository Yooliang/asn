// 冒煙探測「設備詳情沒有帳號，允許別台切換帳號在連線安全」（probe.daline，#1860 PR-C；原本檢查 #2111 ⑦ 的設備頁帳號行）。
// scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）。不帶截圖（不動 ui-shots-diff 的基準）。
// 電腦：設定「設備」→ 這台的「詳情」：沒有「帳號」分頁、沒有帳號行；「連線安全」裡有「允許別台設備替這台切換帳號」，勾選能點
// 手機：設定「設備」→ 辦公室的「詳情」：沒有「帳號」分頁、沒有帳號行
// 帳號只在設定的「帳號」頁；帳號頁卡片與重新登入由 reloginrow、relogin、drelogin 探針各自檢查。
// 全部用真的點擊（__smokeInput）。探測原始碼是字串，裡面不寫反斜線

export const dalineProbeSource = ({ daline }) => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 400) };
  const tap = async el => { el.scrollIntoView({ block: 'center' }); await sleep(150); await real({ click: at(el) }) };
  const wait = async (fn, n = 80) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const mobile = ${JSON.stringify(daline)} === 'mobile';
  let page;
  if (mobile) {
    const set = await wait(() => [...document.querySelectorAll('.m-row-btn')].find(b => vis(b) && b.textContent.includes('設備')));
    if (!set) return { ok: false, why: '找不到設定裡的「設備」' };
    await tap(set);
    const row = await wait(() => [...document.querySelectorAll('.m-dv-row')].find(r => vis(r) && (r.querySelector('.m-dv-rn b')?.textContent ?? '').trim() === '辦公室'));
    if (!row) return { ok: false, why: '設備列表裡找不到辦公室' };
    await tap([...row.querySelectorAll('button')].find(b => b.textContent.trim() === '詳情'));
    page = await wait(() => [...document.querySelectorAll('.m-dv-info')].find(vis));
    if (!page) return { ok: false, why: '點了詳情，沒有進到詳情內容' };
    if ([...document.querySelectorAll('.m-dv-subbtn, [data-sub]')].some(vis)) return { ok: false, why: '手機詳情不該再有「詳情｜帳號」分頁' };
    if ([...document.querySelectorAll('.asn-aline, .m-dv-vendor')].some(vis)) return { ok: false, why: '手機詳情不該再有帳號行或廠商卡片' };
    return { ok: true, why: '手機：詳情只有詳情，沒有帳號分頁、帳號行' };
  }
  // 本機那一列：第一列、沒有排序把手（畫面上不寫「這台」）；列上只有「詳情」
  const row = await wait(() => [...document.querySelectorAll('.dv-list .dv-row')].find(r => !r.querySelector('.dv-grip')));
  if (!row) return { ok: false, why: '設備列表裡找不到本機那一列' };
  await tap([...row.querySelectorAll('button')].find(b => b.textContent.trim() === '詳情'));
  page = await wait(() => [...document.querySelectorAll('.dv-dev')].find(vis));
  if (!page) return { ok: false, why: '點了詳情，沒有進到詳情頁' };
  if ([...page.querySelectorAll('.dv-tabs button')].some(b => b.textContent.trim() === '帳號')) return { ok: false, why: '電腦詳情不該再有「帳號」分頁' };
  if ([...page.querySelectorAll('.asn-aline, .dv-vendors, .dv-accts')].some(vis)) return { ok: false, why: '電腦詳情不該再有帳號行或廠商卡片' };
  const safety = await wait(() => [...page.querySelectorAll('.set-card')].find(c => vis(c) && c.querySelector('.set-h')?.textContent.trim() === '連線安全'));
  if (!safety) return { ok: false, why: '詳情裡沒有「連線安全」' };
  const label = [...safety.querySelectorAll('label.chk')].find(l => l.textContent.includes('允許別台設備替這台切換帳號'));
  if (!label) return { ok: false, why: '「連線安全」裡沒有「允許別台設備替這台切換帳號」：' + safety.textContent.trim().slice(0, 120) };
  const box = label.querySelector('input[type=checkbox]');
  if (!box || box.disabled) return { ok: false, why: '「允許別台設備替這台切換帳號」的勾選不能按' };
  const before = box.checked;
  await tap(box);
  if (!(await wait(() => box.checked !== before, 30))) return { ok: false, why: '點了「允許別台設備替這台切換帳號」，勾選沒有變' };
  await tap(box);   // 還原
  return { ok: true, why: '電腦：詳情沒有帳號分頁，「允許別台設備替這台切換帳號」在連線安全' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const ME_DEVICES = { winMode: 'merged', session: { v: 1, tabs: [{ id: '@setting' }], active: { id: '@setting' }, panel: { guide: '', setting: 'devices' }, windows: [], panelWindows: [] } }

export default {
  key: 'daline',
  kind: '設備詳情沒有帳號、允許切換在連線安全檢查',
  source: probe => dalineProbeSource(probe),
  scenarios: [
    { name: 'list-device-aline', page: 'list.html', state: { signedIn: true, roster: 'resets', localAcct: true, daline: 'desktop' }, ready: '#app.win .dv-set', probe: { daline: 'desktop' } },
    { name: 'm-device-aline', page: 'm.html', state: { signedIn: true, mnoself: 'android', daline: 'mobile' }, ready: '#app.m .m-row-btn', probe: { daline: 'mobile' } },
  ],
  table: (scenario, t) => {
    const k = scenario.state?.daline
    if (k === 'desktop') return { store_load: { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(ME_DEVICES) } } }
    if (k === 'mobile') {
      const at = new Date().toISOString().slice(0, 16) + ':00.000Z'
      return { android_acct_list: { by: 'node', values: { Q: { asn_online: true, reported_at: at, accounts: [{ vendor: 'claude', email: 'me@example.com', plan: 'claude_max', current: true }] } }, fallback: null } }
    }
    return undefined
  },
}
