// 冒煙探測「讀額度的開關在『設備 → 這台』、不在帳號頁」（probe.quotaMove，#2111 ④）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 兩種情境：
//   where＝device：開「設備」→ 點本機那一列的「詳情」→ 找得到「這台讀額度」卡，有 Grok／Gemini／MiniMax 各一列，開關靠右；按 Grok 的開關會變成打開（假後台回已開）
//   where＝account：開「帳號」頁 → 找不到「這台讀額度」卡、沒有任何讀額度的開關；Grok 區段寫引導句
// 不放截圖（不進 ui-shots-diff）。

export const quotaMoveProbeSource = ({ where }) => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  const where = ${JSON.stringify(where)};
  const GUIDE = '還沒開啟額度上報。到『設備 → 這台』打開『讀 Grok 額度』，這裡就會顯示額度。';
  if (where === 'account') {
    for (let i = 0; i < 60 && !document.querySelector('.dv-acctpage .dv-my-v'); i++) await sleep(100);
    if (!document.querySelector('.dv-acctpage')) return { ok: false, why: '沒有開到帳號頁' };
    if (document.querySelector('.dv-qread')) return { ok: false, why: '帳號頁出現了「這台讀額度」' };
    const page = document.querySelector('.dv-acctpage');
    if (page.querySelector('input[type=checkbox]')) return { ok: false, why: '帳號頁還有開關' };
    if (/讀 Grok 額度|讀 Gemini 額度|讀 Claude 額外帳號|自動換新|MiniMax/.test(page.textContent.replace(GUIDE, ''))) return { ok: false, why: '帳號頁還有讀額度的字：' + page.textContent.slice(0, 80) };
    const g = [...page.querySelectorAll('.dv-guide')].find(vis);
    if (!g) return { ok: false, why: 'Grok 沒開額度上報，帳號頁卻沒有引導句' };
    if (g.textContent.trim() !== GUIDE) return { ok: false, why: '引導句寫「' + g.textContent.trim() + '」' };
    return { ok: true, why: '電腦帳號頁：沒有讀額度的開關，Grok 區段寫「' + g.textContent.trim() + '」' };
  }
  for (let i = 0; i < 60 && !document.querySelector('.dv-list .dv-row'); i++) await sleep(100);
  const rows = [...document.querySelectorAll('.dv-list .dv-row')].filter(vis);
  const self = rows.find(r => !r.querySelector('[aria-label="設備順序"]'));
  if (!self) return { ok: false, why: '設備列表裡找不到本機那一列（共 ' + rows.length + ' 列）' };
  const more = [...self.querySelectorAll('button')].find(b => b.textContent.trim() === '詳情');
  if (!more) return { ok: false, why: '本機那一列沒有「詳情」鈕' };
  more.click();
  let card = null;
  for (let i = 0; i < 60 && !card; i++) { card = [...document.querySelectorAll('.dv-qread')].find(vis) || null; if (!card) await sleep(100) }
  if (!card) return { ok: false, why: '本機的詳情裡找不到「這台讀額度」' };
  if (card.querySelector('h3').textContent.trim() !== '這台讀額度') return { ok: false, why: '標題不是「這台讀額度」：' + card.querySelector('h3').textContent };
  const names = [...card.querySelectorAll('.dv-qrow')].map(r => r.querySelector('b').textContent.trim());
  if (names.join('|') !== '讀 Grok 額度|讀 Gemini 額度|MiniMax') return { ok: false, why: '各列不對：' + names.join('|') };
  const sw = card.querySelector('[data-reader="grok"] .dv-qsw');
  const mm = card.querySelector('[data-reader="minimax"]');
  if (!sw || !mm.querySelector('.dv-qbtn') || mm.querySelector('.dv-qbtn').textContent.trim() !== '加入帳號') return { ok: false, why: '缺 Grok 開關或 MiniMax 的「加入帳號」鈕' };
  const rr = card.querySelector('[data-reader="grok"]').getBoundingClientRect(), sr = sw.getBoundingClientRect();
  if (rr.right - sr.right > 24) return { ok: false, why: '開關沒有靠右：離列右邊 ' + Math.round(rr.right - sr.right) + 'px' };
  const b0 = mm.querySelector('.dv-qbtn').getBoundingClientRect();
  if (mm.getBoundingClientRect().right - b0.right > 24) return { ok: false, why: '「加入帳號」鈕沒有靠右' };
  if (sw.checked) return { ok: false, why: '開關一開始就是開的' };
  sw.click();
  for (let i = 0; i < 40 && !sw.checked; i++) await sleep(100);
  if (!sw.checked) return { ok: false, why: '按了 Grok 的開關，沒有變成打開（既有命令沒有被呼叫或結果沒套上）' };
  if (card.getBoundingClientRect().right > innerWidth + 1) return { ok: false, why: '這一區超出視窗' };
  return { ok: true, why: '電腦設備→這台：「這台讀額度」' + names.join('、') + '，Grok 開關靠右（離列右邊 ' + Math.round(rr.right - sr.right) + 'px）、按下變成打開' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const base = { signedIn: true }
const READERS = { grok: false, agy: false, minimax: [], minimax_supported: true, status: {} }
const ME_DEVICES = { winMode: 'merged', session: { v: 1, tabs: [{ id: '@setting' }], active: { id: '@setting' }, panel: { guide: '', setting: 'devices' }, windows: [], panelWindows: [] } }

export default {
  key: 'quotaMove',
  kind: '讀額度的開關位置檢查（設備→這台有、帳號頁沒有）',
  source: probe => quotaMoveProbeSource(probe),
  scenarios: [
    { name: 'list-quota-device', page: 'list.html', state: { ...base, devicesPage: true, quotaMove: 'device' }, ready: '#app.win .dv-set', probe: { quotaMove: 'x', where: 'device' } },
    { name: 'list-quota-account', page: 'list.html', state: { ...base, devicesPage: true, roster: 'resets', quotaMove: 'account' }, ready: '#app.win .dv-my .dv-acct', probe: { quotaMove: 'x', where: 'account' } },
  ],
  table: (scenario, t) => {
    const k = scenario.state?.quotaMove
    if (!k) return undefined
    const patch = { quota_readers_get: READERS, quota_readers_set: { ...READERS, grok: true } }
    if (k === 'device') patch.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(ME_DEVICES) } }
    return patch
  },
}
