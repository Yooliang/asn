// 冒煙探測「手機開新夥伴檢查」（probe.mlaunch）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const mlaunchProbeSource = ({ big, labels, selected, note }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  const want = ${JSON.stringify({ labels, selected, note })};
  const wait = async (fn, n = 80) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const plus = await wait(() => document.querySelector('.m-plus-wrap .m-icon-btn'));
  if (!plus) return { ok: false, why: '找不到名單頁的「新增」鈕' };
  plus.click();
  const item = await wait(() => [...document.querySelectorAll('.m-plus-menu button')].find(b => b.textContent.includes('開新夥伴')));
  if (!item) return { ok: false, why: '新增選單沒有「開新夥伴」' };
  item.click();
  const dev = await wait(() => [...document.querySelectorAll('.m-lch .m-opt')].find(b => b.textContent.includes('辦公室') && !b.disabled));
  if (!dev) return { ok: false, why: '第 1 步找不到可選的「辦公室」：' + (document.querySelector('.m-lch')?.innerText || '').slice(0, 120) };
  dev.click();
  await sleep(100);
  const next = [...document.querySelectorAll('.m-lch .m-btn-big')].find(b => b.textContent.includes('下一步'));
  if (!next || next.disabled) return { ok: false, why: '「下一步」不能按' };
  next.click();
  const fs = await wait(() => [...document.querySelectorAll('.m-lch fieldset')].find(f => f.querySelector('legend')?.textContent.trim() === '運行'));
  if (!fs) return { ok: false, why: '第 2 步沒有「運行」選項：' + (document.querySelector('.m-lch')?.innerText || '').slice(0, 120) };
  if (${big ? 'true' : 'false'}) {
    const els = [...document.querySelectorAll('#app *')];
    const sizes = els.map(e => parseFloat(getComputedStyle(e).fontSize) || 0);
    els.forEach((e, i) => { if (sizes[i]) e.style.fontSize = (sizes[i] * 1.3) + 'px' });
  }
  await sleep(400);
  const opts = [...fs.querySelectorAll('.m-opt')];
  const labels = opts.map(o => o.querySelector('.m-opt-t')?.textContent.trim() ?? '');
  if (labels.join('|') !== want.labels.join('|')) return { ok: false, why: '運行選項不對：' + labels.join('、') + '（應為 ' + want.labels.join('、') + '）' };
  const on = opts.filter(o => o.getAttribute('aria-pressed') === 'true').map(o => o.querySelector('.m-opt-t').textContent.trim());
  if (on.join('|') !== want.selected) return { ok: false, why: '預設選到的不對：' + on.join('、') + '（應為 ' + want.selected + '）' };
  const note = document.querySelector('.m-lch-display');
  if (!vis(note) || note.textContent.trim() !== want.note) return { ok: false, why: '沒看到前台或背景的說明：' + (note?.textContent ?? '沒有') };
  // 滑頁停下來後 pager 不留 will-change（#1565）：留著的話內頁停在轉場途中的小數位移、字偏半像素，截圖每次不一樣
  const pager = document.querySelector('.m-pager');
  if (!(await wait(() => pager && getComputedStyle(pager).willChange === 'auto', 20))) return { ok: false, why: '滑頁停下來後 pager 還留著 will-change：' + (pager ? getComputedStyle(pager).willChange : '找不到 pager') };
  fs.scrollIntoView({ block: 'start' });
  await sleep(200);
  const bad = [];
  for (const e of [...fs.querySelectorAll('.m-opt, .m-opt-t, .m-opt-why'), note]) {
    if (e.scrollWidth > e.clientWidth + 1) bad.push(e.textContent.trim().slice(0, 20));
    const r = e.getBoundingClientRect();
    if (r.left < -0.5 || r.right > window.innerWidth + 0.5) bad.push('超出畫面：' + e.textContent.trim().slice(0, 20));
  }
  if (bad.length) return { ok: false, why: '字被切或超出畫面：' + bad.join('、') };
  const de = document.documentElement;
  if (de.scrollWidth > window.innerWidth + 1 || document.body.scrollWidth > window.innerWidth + 1) return { ok: false, why: '頁面有橫向捲動：' + de.scrollWidth + ' > ' + window.innerWidth };
  const m = /#\\d+/.exec(document.querySelector('#app').innerText);
  if (m) return { ok: false, why: '畫面出現議題編號：' + m[0] };
  return { ok: true, why: '' };
})()`

export default {
  key: 'mlaunch',
  kind: '手機開新夥伴檢查',
  source: probe => mlaunchProbeSource(probe),
}
