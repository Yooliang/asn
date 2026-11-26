// 冒煙探測「手機開新夥伴檢查」（probe.mlaunch，#2354 改寫）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 第 2 步：廠牌卡只寫名稱，右邊同一行放短標示（無終端畫面、尚未安裝、尚未登入）；尚未安裝的反灰、點了選不起來；沒有「運行」，也沒有「前台或背景」的說明；按鈕寫「開始」

export const mlaunchProbeSource = ({ big, cards, selected }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  const want = ${JSON.stringify({ cards, selected })};
  const wait = async (fn, n = 80) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const txt = e => (e ? e.textContent.replace(/\\s+/g, ' ').trim() : '');
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
  const fs = await wait(() => [...document.querySelectorAll('.m-lch fieldset')].find(f => f.querySelector('legend')?.textContent.trim() === '廠牌'));
  if (!fs) return { ok: false, why: '第 2 步沒有「廠牌」：' + (document.querySelector('.m-lch')?.innerText || '').slice(0, 120) };
  // 沒有「運行」：不是 fieldset、也不是畫面上任何一個字；「前台或背景」的說明元素也不存在（明寫「應不存在」，不是找不到就略過）
  if ([...document.querySelectorAll('.m-lch fieldset legend')].some(l => txt(l) === '運行')) return { ok: false, why: '第 2 步還有「運行」選項' };
  if (document.querySelector('.m-lch-display')) return { ok: false, why: '第 2 步還有「前台或背景」的說明' };
  if (txt(document.querySelector('.m-lch')).includes('運行')) return { ok: false, why: '第 2 步畫面上還寫著「運行」：' + txt(document.querySelector('.m-lch')).slice(0, 160) };
  // 欄位順序跟電腦版第 3 頁一樣：名字 → 工作資料夾 → 第一句話
  const fieldOrder = [...document.querySelectorAll('.m-lch .m-field')].map(l => txt(l).slice(0, 5));
  const idx = w => fieldOrder.findIndex(t => t.startsWith(w));
  if (idx('名字') < 0 || !(idx('名字') < idx('工作資料夾') && idx('工作資料夾') < idx('第一句話'))) return { ok: false, why: '欄位順序不對：' + fieldOrder.join('、') + '（應為 名字、工作資料夾、第一句話）' };
  if (${big ? 'true' : 'false'}) {
    const els = [...document.querySelectorAll('#app *')];
    const sizes = els.map(e => parseFloat(getComputedStyle(e).fontSize) || 0);
    els.forEach((e, i) => { if (sizes[i]) e.style.fontSize = (sizes[i] * 1.3) + 'px' });
  }
  await sleep(400);
  const opts = [...fs.querySelectorAll('.m-opt')];
  const got = opts.map(o => txt(o.querySelector('.m-opt-t')) + '/' + txt(o.querySelector('.m-opt-tag')) + '/' + (o.disabled ? '灰' : '可'));
  if (got.join('|') !== want.cards.join('|')) return { ok: false, why: '廠牌卡與標示不對：' + got.join('、') + '（應為 ' + want.cards.join('、') + '）' };
  const on = () => opts.filter(o => o.getAttribute('aria-pressed') === 'true').map(o => txt(o.querySelector('.m-opt-t')));
  if (on().join('|') !== want.selected) return { ok: false, why: '預設選到的不對：' + on().join('、') + '（應為 ' + want.selected + '）' };
  // 標示在卡片右邊、跟名稱同一行
  for (const o of opts) {
    const tag = o.querySelector('.m-opt-tag'); if (!tag) continue;
    const a = o.querySelector('.m-opt-t').getBoundingClientRect(), b = tag.getBoundingClientRect(), box = o.getBoundingClientRect();
    if (Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) > 10) return { ok: false, why: '標示跟名稱不在同一行：' + txt(o) };
    if (b.left < a.right - 0.5 || b.right > box.right + 0.5) return { ok: false, why: '標示不在卡片右邊：' + txt(o) };
  }
  // 反灰的點了也不會被選；點 Gemini 會選起來，再點回 Claude
  for (const o of opts.filter(x => x.disabled)) { o.click(); await sleep(60) }
  if (on().join('|') !== want.selected) return { ok: false, why: '點反灰的卡片之後選取變了：' + on().join('、') };
  opts[1].click(); await sleep(100);
  if (on().join('|') !== 'Gemini') return { ok: false, why: '點 Gemini 沒有選起來：' + on().join('、') };
  opts[0].click(); await sleep(100);
  if (on().join('|') !== want.selected) return { ok: false, why: '點回 Claude 沒有選起來：' + on().join('、') };
  const go = [...document.querySelectorAll('.m-lch .m-btn-big')].find(b => b.textContent.includes('開始') || b.textContent.includes('開啟'));
  if (!go || txt(go) !== '開始') return { ok: false, why: '送出鈕應該寫「開始」：' + txt(go) };
  // 滑頁停下來後 pager 不留 will-change（#1565）：留著的話內頁停在轉場途中的小數位移、字偏半像素，截圖每次不一樣
  const pager = document.querySelector('.m-pager');
  if (!(await wait(() => pager && getComputedStyle(pager).willChange === 'auto', 20))) return { ok: false, why: '滑頁停下來後 pager 還留著 will-change：' + (pager ? getComputedStyle(pager).willChange : '找不到 pager') };
  fs.scrollIntoView({ block: 'start' });
  await sleep(200);
  const bad = [];
  for (const e of [...fs.querySelectorAll('.m-opt, .m-opt-t, .m-opt-tag')]) {
    // 失敗時帶上實際量到的寬度，才分得出是 1px 的字型度量誤差還是真的溢出
    if (e.scrollWidth > e.clientWidth + 1) bad.push(e.textContent.trim().slice(0, 20) + '（' + e.tagName.toLowerCase() + '.' + e.className + ' 內容寬 ' + e.scrollWidth + '、可視寬 ' + e.clientWidth + '）');
    const r = e.getBoundingClientRect();
    if (r.left < -0.5 || r.right > window.innerWidth + 0.5) bad.push('超出畫面：' + e.textContent.trim().slice(0, 20) + '（右緣 ' + r.right.toFixed(1) + '、視窗寬 ' + window.innerWidth + '）');
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
