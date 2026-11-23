// 冒煙探測「手機設備細部頁標題列」（probe.mheadtags，#1864 一審）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 情境：360 寬、設備名很長（20 個中文字）、標題列三個標籤（種類「雲端」、離線中、已隱藏）。
// 斷言：每個標籤都是單行（沒有被擠成直排換行）、沒被壓扁；標題不超出標題列（太長要用省略號）；標籤與標題列都在視窗內。
// 假後台資料自給自足（不 import smoke-lib）。長名字的雲端節點由假後台名單給；「已隱藏」是設備被收起時才出現的標籤，
// 假後台不易造出，探測在標籤列補一個同樣 class 的標籤（只為量排版，會在失敗訊息裡註明）。
export const LONG_NAME = '一二三四五六七八九十一二三四五六七八九十'   // 20 個中文字

export const mheadtagsProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  const W = window.innerWidth;
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes('設備')) || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '找不到設定裡的「設備」' };
  btn.click(); await sleep(500);
  let row = null;
  for (let i = 0; i < 40 && !row; i++) { row = [...document.querySelectorAll('.m-dv-row')].filter(vis).find(r => (r.querySelector('.m-dv-rn b')?.textContent ?? '').includes(${JSON.stringify(LONG_NAME)})) || null; if (!row) await sleep(100) }
  if (!row) return { ok: false, why: '設備列表找不到長名字那一列' };
  [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '詳情')?.click();
  let head = null;
  for (let i = 0; i < 40 && !head; i++) { head = [...document.querySelectorAll('.m-dv-headtx')].find(vis) || null; if (!head) await sleep(100) }
  if (!head) return { ok: false, why: '沒有進到設備細部頁（找不到標題列）' };
  await sleep(300);
  // 沒有「已隱藏」就補一個同 class 的（見檔頭）
  const note = [];
  if (![...head.querySelectorAll('.m-dv-tag.hid')].length) { const t = document.createElement('span'); t.className = 'm-dv-tag hid'; t.textContent = '已隱藏'; head.appendChild(t); note.push('已隱藏標籤是探測補上的'); await sleep(100) }
  const st = head.querySelector('.m-dv-tag.on, .m-dv-tag.off');
  if (st && st.textContent.trim() !== '離線中') { st.textContent = '離線中'; st.className = 'm-dv-tag off'; note.push('離線中標籤是探測改的'); await sleep(100) }
  const R = e => e.getBoundingClientRect();
  const title = head.querySelector('.m-title');
  const tags = [...head.querySelectorAll('.m-dv-tag')];
  if (tags.length < 3) return { ok: false, why: '標題列標籤少於 3 個：' + tags.map(t => t.textContent.trim()).join('、') };
  if (!title || !title.textContent.includes(${JSON.stringify(LONG_NAME)})) return { ok: false, why: '標題不是長名字：' + (title ? title.textContent.trim() : '無') };
  const bar = head.closest('.m-head') || head, br = R(bar), hr = R(head);
  const lineH = t => parseFloat(getComputedStyle(t).lineHeight) || parseFloat(getComputedStyle(t).fontSize) * 1.3;
  for (const t of tags) {
    const r = R(t), cs = getComputedStyle(t), pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const name = t.textContent.trim();
    if (r.height > lineH(t) + pad + 1.5) return { ok: false, why: '標籤「' + name + '」換行成多行了：高 ' + Math.round(r.height) + '，單行應約 ' + Math.round(lineH(t) + pad) };
    if (t.scrollWidth > t.clientWidth + 1) return { ok: false, why: '標籤「' + name + '」被擠壓：內容寬 ' + t.scrollWidth + '／' + t.clientWidth };
    const range = document.createRange(); range.selectNodeContents(t);
    const tops = new Set([...range.getClientRects()].map(x => Math.round(x.top)));
    if (tops.size > 1) return { ok: false, why: '標籤「' + name + '」的字分成多行' };
    if (r.right > W + 0.5 || r.left < -0.5) return { ok: false, why: '標籤「' + name + '」超出視窗：' + Math.round(r.left) + '～' + Math.round(r.right) + '／' + W };
    if (r.right > hr.right + 0.5) return { ok: false, why: '標籤「' + name + '」超出標題列：' + Math.round(r.right) + '／' + Math.round(hr.right) };
  }
  const tr = R(title);
  if (tr.right > hr.right + 0.5 || tr.right > br.right + 0.5) return { ok: false, why: '標題超出標題列：' + Math.round(tr.right) + '／' + Math.round(hr.right) };
  if (title.scrollWidth <= title.clientWidth) return { ok: false, why: '20 字長名字在 360 寬沒有被截（探測的前提不成立）' };
  if (getComputedStyle(title).textOverflow !== 'ellipsis') return { ok: false, why: '標題太長時沒有用省略號' };
  for (let i = 1; i < tags.length; i++) if (R(tags[i]).left < R(tags[i - 1]).right - 0.5) return { ok: false, why: '標籤互相疊在一起' };
  return { ok: true, why: note.join('；') };
})()`

const toMinute = ms => new Date(Math.floor(ms / 60_000) * 60_000).toISOString()

export const mheadtagsTable = (t, now = Date.now()) => ({
  relay_list: { members: [
    { id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', engine: 'claude', cwd_label: 'demo' }] },
    { id: 'G', name: LONG_NAME, agents: [{ name: 'Grok正見', status: 'idle', engine: 'cloud', cwd_label: '' }] },
  ] },
  store_load: { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify({ navTab: 'me' }) } },
  android_launchers: { machines: [] },
  android_acct_roster: { now: toMinute(now), accounts: [] },
  android_acct_list: { by: 'node', values: {
    Q: { asn_online: true, reported_at: toMinute(now - 5 * 60_000), accounts: [{ vendor: 'claude', email: 'work@example.com', plan: 'claude_pro', current: true }] },
    G: { asn_online: false, reported_at: '', accounts: [] },
  }, fallback: null },
})

export default {
  key: 'mheadtags',
  kind: '手機設備細部頁標題列檢查',
  source: probe => mheadtagsProbeSource(probe),
  scenarios: [
    { name: 'm-dvhead-360-long', page: 'm.html', width: 360, state: { signedIn: true, mheadtags: true }, ready: '#app.m .m-row-btn', probe: { mheadtags: true }, shot: 'm-dvhead-360-long.png' },
  ],
  table: (scenario, t) => (scenario.state.mheadtags ? mheadtagsTable(t) : undefined),
}
