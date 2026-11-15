// 冒煙探測「手機設備頁上次確認可用檢查」（probe.usableAt，#1512 C2）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 那台電腦的回報裡，某個 Claude 帳號帶了 usable_at（UTC 字串）：設備細部頁那個帳號底下出現「上次確認可用：年/月/日 時:分」（當地時間）；
// 沒帶的帳號不出現。用真的點擊。探測原始碼是字串，裡面不寫反斜線

export const USABLE_AT_SAMPLE = '2026-11-15T08:05:00Z'

export const usableAtProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 400) };
  const tap = async el => { el.scrollIntoView({ block: 'center' }); await sleep(120); await real({ click: at(el) }) };
  const wait = async (fn, n = 80) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const btn = await wait(() => [...document.querySelectorAll('.m-row-btn')].find(b => vis(b) && b.textContent.includes('設備')));
  if (!btn) return { ok: false, why: '找不到設定裡的「設備」' };
  await tap(btn);
  const row = await wait(() => [...document.querySelectorAll('.m-dv-row')].filter(vis).find(r => (r.querySelector('.m-dv-rn b')?.textContent ?? '').trim() === '辦公室'));
  if (!row) return { ok: false, why: '找不到「辦公室」' };
  await tap(row.querySelector('.m-dv-go'));
  const go = await wait(() => [...row.querySelectorAll('.m-dv-accbtn')].find(vis));
  if (!go) return { ok: false, why: '「辦公室」沒有帳號鈕' };
  await tap(go);
  const shown = await wait(() => [...document.querySelectorAll('.m-dv-usable')].filter(vis), 120);
  const lines = (shown || []).map(e => e.textContent.trim());
  const want = '上次確認可用：' + new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(${JSON.stringify(USABLE_AT_SAMPLE)})).filter(p => p.type !== 'literal').map(p => p.value).reduce((s, v, i) => s + (i === 0 ? '' : i < 3 ? '/' : i === 3 ? ' ' : ':') + v, '');
  if (lines.length !== 1) return { ok: false, why: '應該只有帶了時間的那一個帳號顯示（實際 ' + lines.length + ' 個）：' + JSON.stringify(lines) };
  if (lines[0] !== want) return { ok: false, why: '顯示的字不對：' + lines[0] + '（應該是 ' + want + '）' };
  const acct = shown[0].closest('li');
  if (!acct || !acct.textContent.includes('me@example.com')) return { ok: false, why: '時間沒有放在那個帳號底下' };
  if (document.documentElement.scrollWidth > window.innerWidth + 1) return { ok: false, why: '整頁橫向溢出' };
  return { ok: true, why: '' };
})()`

export default {
  key: 'usableAt',
  kind: '手機設備頁上次確認可用檢查',
  source: () => usableAtProbeSource(),
  scenarios: [
    { name: 'm-usable-at', page: 'm.html', state: { signedIn: true, mlayout: true, usableAt: true }, ready: '#app.m .m-row-btn', probe: { usableAt: true }, shot: 'm-usable-at.png' },
  ],
  // 辦公室（Q）回報的第二個帳號（me@example.com）帶了上次確認可用；回報時間用跑情境的當下算（太舊的回報整台會被當成過期）
  table: (scenario, t) => {
    if (!scenario.state?.usableAt) return undefined
    const list = t.android_acct_list
    const q = list?.values?.Q
    if (!q) return undefined
    const accounts = q.accounts.map(a => (a.email === 'me@example.com' ? { ...a, usable_at: USABLE_AT_SAMPLE } : a))
    const reportedAt = new Date(Math.floor((Date.now() - 5 * 60_000) / 60_000) * 60_000).toISOString()
    return { android_acct_list: { ...list, values: { ...list.values, Q: { ...q, reported_at: reportedAt, accounts } } } }
  },
}
