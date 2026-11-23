// 冒煙探測「設備頁的帳號一行，點下去跳到帳號頁那張卡」（probe.daline，#2111 ⑦ #1879）。
// scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）。不帶截圖（不動 ui-shots-diff 的基準）。
// 電腦：設定「設備」→ 這台的「帳號」→ 帳號一行（標籤「正常」、沒有額度條／切換／「⋯」）→ 點它 → 到「帳號」頁、那張卡被框起來
// 手機：設定「設備」→ 點辦公室那列 →「帳號」→ 帳號一行 → 點它 → 回到列表並切到「帳號」分頁、那張卡被框起來
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
  let open;
  if (mobile) {
    const set = await wait(() => [...document.querySelectorAll('.m-row-btn')].find(b => vis(b) && b.textContent.includes('設備')));
    if (!set) return { ok: false, why: '找不到設定裡的「設備」' };
    await tap(set);
    const row = await wait(() => [...document.querySelectorAll('.m-dv-row')].find(r => vis(r) && (r.querySelector('.m-dv-rn b')?.textContent ?? '').trim() === '辦公室'));
    if (!row) return { ok: false, why: '設備列表裡找不到辦公室' };
    // 設備列只有「詳情」（#1860）：點該列的詳情，再點細部頁上的「帳號」分頁
    await tap([...row.querySelectorAll('button')].find(b => b.textContent.trim() === '詳情'));
    open = await wait(() => [...document.querySelectorAll('.m-dv-subbtn[data-sub="accounts"]')].find(vis));
  } else {
    const row = await wait(() => [...document.querySelectorAll('.dv-list .dv-row')].find(r => r.querySelector('.dv-tag.me')));
    if (!row) return { ok: false, why: '設備列表裡找不到「這台」' };
    open = [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '帳號');
  }
  if (!open) return { ok: false, why: '那一列沒有「帳號」鈕' };
  await tap(open);
  const lines = await wait(() => { const l = [...document.querySelectorAll('.asn-aline')].filter(vis); return l.length ? l : null });
  if (!lines) return { ok: false, why: '設備頁沒有帳號行' };
  const line = lines.find(l => l.getAttribute('data-aline') === 'claude|me@example.com') || lines[0];
  const key = line.getAttribute('data-aline');
  if (line.getAttribute('data-status') !== 'normal' || !line.textContent.includes('正常')) return { ok: false, why: '沒有問題的帳號應標「正常」：' + line.textContent.trim() };
  const page = document.querySelector(mobile ? '.m-dv' : '.dv-set');
  if ([...page.querySelectorAll('.dv-bars, .m-dv-bars, .dv-devbtn, .m-dv-dev, .m-dv-sw')].some(vis)) return { ok: false, why: '設備頁出現了額度條、切換或「⋯」' };
  if (line.querySelectorAll('.asn-aline-go').length !== 1) return { ok: false, why: '帳號行應只有一顆（整行）跳頁按鈕' };
  if (!mobile) {
    // 這台自己的帳號行右邊有「⋯」：選單只有一項「刪除」；點「⋯」不跳頁，點「刪除」在那一行原位確認，取消不刪
    const more = line.querySelector('.asn-more-btn');
    if (!more) return { ok: false, why: '這台的帳號行右邊沒有「⋯」' };
    await tap(more);
    const items = [...line.querySelectorAll('.asn-more-item')].filter(vis);
    if (items.length !== 1 || items[0].textContent.trim() !== '刪除' || !items[0].classList.contains('danger')) return { ok: false, why: '「⋯」選單應只有一項危險色的「刪除」：' + items.map(i => i.textContent.trim()).join('、') };
    if (document.querySelector('[data-acct-card]')) return { ok: false, why: '點「⋯」不該跳到帳號頁' };
    await tap(items[0]);
    const box = await wait(() => [...document.querySelectorAll('.asn-confirm')].find(vis));
    if (!box || !box.textContent.includes('只會從這台移除') || !line.contains(box)) return { ok: false, why: '沒有在那一行原位出現「只會從這台移除」的確認' };
    const yesBtn = [...box.querySelectorAll('button')].find(b => b.textContent.trim() === '從這台移除');
    const noBtn = [...box.querySelectorAll('button')].find(b => b.textContent.trim() === '取消');
    if (!yesBtn || !noBtn) return { ok: false, why: '確認缺「從這台移除」或「取消」' };
    await tap(noBtn);
    if ([...document.querySelectorAll('.asn-confirm')].some(vis)) return { ok: false, why: '按取消後確認沒有收起' };
    if ((globalThis.__smokeCalls || []).some(c => /claude_account_delete/.test(c[0]))) return { ok: false, why: '取消卻刪除了' };
  }
  await tap(line.querySelector('button'));
  const card = await wait(() => [...document.querySelectorAll('[data-acct-card]')].find(c => vis(c) && c.getAttribute('data-acct-card') === key));
  if (!card) return { ok: false, why: '點了帳號行，沒有跳到帳號頁那張卡（' + key + '）' };
  if (!(await wait(() => card.getAttribute('data-flash') === '1', 30))) return { ok: false, why: '帳號頁那張卡沒有被框起來' };
  if (card.getAttribute('data-status') !== 'normal') return { ok: false, why: '帳號頁那張卡的狀態與設備頁不一致：' + card.getAttribute('data-status') };
  const r = card.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight) return { ok: false, why: '那張卡沒有捲進畫面' };
  return { ok: true, why: (mobile ? '手機' : '電腦') + '：' + key + ' 標「正常」，點進帳號頁並框起那張卡' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const ME_DEVICES = { winMode: 'merged', session: { v: 1, tabs: [{ id: '@setting' }], active: { id: '@setting' }, panel: { guide: '', setting: 'devices' }, windows: [], panelWindows: [] } }

export default {
  key: 'daline',
  kind: '設備頁帳號行跳到帳號頁檢查',
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
