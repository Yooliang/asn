// 冒煙探測「手機通知分頁檢查」（probe.mnotice）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const mnoticeProbeSource = ({ view, big }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  const view = ${JSON.stringify(view)};
  let tabs = [];
  for (let i = 0; i < 60 && tabs.length < 4; i++) { tabs = [...document.querySelectorAll('.m-tabs button')]; if (tabs.length < 4) await sleep(100) }
  if (tabs.length !== 4) return { ok: false, why: '頁籤應該固定四個，實際 ' + tabs.length };
  for (let i = 0; i < 80 && document.querySelector('.m-banner'); i++) await sleep(100);   // 新通知的橫幅幾秒後自己消失，不要蓋住頁籤列
  await sleep(600);
  if (${big ? 'true' : 'false'}) {
    const els = [...document.querySelectorAll('#app *')];
    const sizes = els.map(e => parseFloat(getComputedStyle(e).fontSize) || 0);
    els.forEach((e, i) => { if (sizes[i]) e.style.fontSize = (sizes[i] * 1.3) + 'px' });
    await sleep(300);
  }
  const labels = tabs.map(b => b.querySelector('span')?.textContent.trim());
  if (labels.join('|') !== '夥伴|對話|設定|通知') return { ok: false, why: '四個頁籤的字不對：' + labels.join('、') };
  const tab = l => tabs.find(b => b.querySelector('span')?.textContent.trim() === l);   // 用字找分頁，不靠位置（#1429 改過順序）
  // 四個字都要完整顯示：沒被省略、沒被切、沒有橫向溢出
  const nav = document.querySelector('.m-tabs');
  if (nav.scrollWidth > nav.clientWidth + 1) return { ok: false, why: '頁籤列橫向溢出：' + nav.scrollWidth + ' > ' + nav.clientWidth };
  if (document.documentElement.scrollWidth > window.innerWidth + 1) return { ok: false, why: '整頁橫向溢出' };
  for (const b of tabs) {
    const sp = b.querySelector('span'), r = b.getBoundingClientRect();
    const rg = document.createRange(); rg.selectNodeContents(sp); const t = rg.getBoundingClientRect();
    if (t.left < r.left - 0.5 || t.right > r.right + 0.5) return { ok: false, why: '頁籤「' + sp.textContent.trim() + '」的字超出按鈕：' + Math.round(t.width) + ' > ' + Math.round(r.width) };
    if (t.bottom > r.bottom + 0.5 || t.top < r.top - 0.5) return { ok: false, why: '頁籤「' + sp.textContent.trim() + '」的字被切' };
    if (sp.scrollWidth > sp.clientWidth + 1) return { ok: false, why: '頁籤「' + sp.textContent.trim() + '」被省略號截斷' };
  }
  const dot = tab('通知').querySelector('i.red');
  if (view === 'dot') {
    if (!dot || !vis(dot)) return { ok: false, why: '通知有未讀，通知那一格卻沒有紅點' };
    if (tab('對話').querySelector('i.red')) return { ok: false, why: '對話分頁不該因為通知未讀而亮紅點' };
    const d = dot.getBoundingClientRect(), b = tab('通知').getBoundingClientRect();
    if (d.right > b.right + 0.5 || d.left < b.left - 0.5) return { ok: false, why: '紅點跑出通知那一格' };
    return { ok: true, why: '' };
  }
  if (dot) return { ok: false, why: '正在看通知，紅點應該清掉' };
  if (!tab('通知').classList.contains('on')) return { ok: false, why: '存檔停在通知，通知那一格卻沒選中' };
  const pane = document.querySelector('.m-notice');
  if (!pane || !vis(pane)) return { ok: false, why: '看不到通知分頁的內容' };
  const msgs = [...pane.querySelectorAll('.msg')].filter(vis);
  if (msgs.length < 3) return { ok: false, why: '通知訊息少於 3 則：' + msgs.length };
  const text = pane.textContent;
  for (const w of ['Claude 額度剩 18%', '正在等你確認', '設備金鑰剛換過']) if (!text.includes(w)) return { ok: false, why: '通知內容缺「' + w + '」' };
  if (pane.querySelector('textarea, .compose-row')) return { ok: false, why: '通知是唯讀，不該有輸入列' };
  if (pane.querySelector('.tool.call, .tool.icon.call')) return { ok: false, why: '通知不該有通話鈕' };
  return { ok: true, why: '' };
})()`

export default {
  key: 'mnotice',
  kind: '手機通知分頁檢查',
  source: probe => mnoticeProbeSource(probe),
}
