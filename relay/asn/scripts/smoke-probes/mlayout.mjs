// 冒煙探測「手機設定頁排版檢查」（probe.mlayout）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const mlayoutProbeSource = ({ tab, big }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tab = ${JSON.stringify(tab)};
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes('設備')) || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '找不到設定裡的「設備」' };
  btn.click();
  // 帳號頁的「切換到…」要先讀過各台的帳號回報（點進那台細部才讀）：逐台點進去再返回
  if (tab === 'accounts') {
    await sleep(1200);   // 設備列沒有「帳號」鈕了（#1860）：進頁面時各台的回報會自己先讀
  }
  let seg = null;
  for (let i = 0; i < 60 && !seg; i++) { seg = document.querySelector('.m-dv-segbtn[data-tab="' + tab + '"]'); if (!seg) await sleep(100) }
  if (!seg) return { ok: false, why: '找不到「' + tab + '」分頁鈕' };
  seg.click();
  await sleep(600);
  if (${big ? 'true' : 'false'}) {
    const els = [...document.querySelectorAll('#app *')];
    const sizes = els.map(e => parseFloat(getComputedStyle(e).fontSize) || 0);
    els.forEach((e, i) => { if (sizes[i]) e.style.fontSize = (sizes[i] * 1.3) + 'px' });
    await sleep(300);
  }
  const vis = e => e && e.offsetParent !== null;
  const R = e => e.getBoundingClientRect();
  const textRect = e => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect() };
  for (const b of document.querySelectorAll('.m-dv-segbtn')) {
    const t = textRect(b), r = R(b);
    if (t.bottom > r.bottom + 0.5 || t.top < r.top - 0.5) return { ok: false, why: '分頁鈕「' + b.textContent.trim() + '」的字被切' };
  }
  const foot = [...document.querySelectorAll('.m-dv-foot')].find(vis);
  if (tab === 'devices') {
    const rows = [...document.querySelectorAll('.m-dv-row')].filter(vis);
    if (rows.length < 3) return { ok: false, why: '設備列少於 3 列：' + rows.length };
    if (rows.some(r => r.querySelector('.m-dv-line') || r.textContent.includes('沒回報') || r.textContent.includes('還沒收到這台的回報'))) return { ok: false, why: '列上不該再有狀態那一行（#1499 搬到詳情；#2158 起也不再有「沒回報」）' };
    // #2158：在線剛連上、還沒讀到回報時，列上不放標籤（「讀不到帳號資料」要連續失敗才出現）；狀態寫在詳情
    if (rows.some(r => r.querySelector('.noreport'))) return { ok: false, why: '還沒讀到回報時列上不該有任何回報標籤' };
    const list = R(document.querySelector('.m-dv-list'));
    for (const row of rows) {
      const rr = R(row);
      for (const e of row.querySelectorAll('.m-dv-rn b, .m-dv-rs, .noreport')) {
        const t = textRect(e);
        if (t.bottom > rr.bottom + 0.5 || t.bottom > list.bottom + 0.5) return { ok: false, why: '「' + (row.querySelector('b')?.textContent ?? '') + '」那列的「' + e.textContent.trim() + '」被切' };
      }
    }
    const dots = rows.map(r => R(r.querySelector('.m-dv-dot')).left);
    if (Math.max(...dots) - Math.min(...dots) > 1) return { ok: false, why: '圓點沒對齊：' + dots.map(x => x.toFixed(1)).join('／') };
    if (foot) return { ok: false, why: '設備頁不該有額度註腳' };
    // #2158：還在讀回報時，詳情寫「正在讀取這台的帳號資料…」（灰字加轉圈），仍然要看得到（真的點「詳情」進去找）
    // 每一列右邊直接就有「詳情」，沒有上移／下移，也不用先點一列展開（#1860）
    if (rows.some(r => [...r.querySelectorAll('button')].some(b => /上移|下移/.test(b.getAttribute('aria-label') || b.textContent)))) return { ok: false, why: '設備列上不該再有上移／下移' };
    if (rows.some(r => !r.querySelector('.asn-btn') || r.querySelector('.asn-btn').textContent.trim() !== '詳情')) return { ok: false, why: '每一列都該直接有一顆「詳情」' };
    if (rows.some(r => r.textContent.includes('離線') && !r.textContent.includes('離線中'))) return { ok: false, why: '離線的設備該寫「離線中」' };
    const info = [...document.querySelectorAll('.m-dv-row button')].find(b => vis(b) && b.getAttribute('aria-label') === '查看「工作機」的詳情');
    if (!info) return { ok: false, why: '找不到工作機的「詳情」' };
    info.scrollIntoView({ block: 'center' }); await sleep(150);
    { const r = R(info); globalThis.__smokeInput(JSON.stringify({ click: [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] })) }
    let st = null;
    for (let i = 0; i < 30 && !st; i++) { st = [...document.querySelectorAll('.dvid-note')].find(vis) || null; if (!st) await sleep(100) }
    if (!st || !st.textContent.includes('正在讀取這台的帳號資料…') || !st.querySelector('.asn-spin')) return { ok: false, why: '工作機的詳情裡看不到「正在讀取這台的帳號資料…」與轉圈' };
    // 正向檢查：「讀取中」真的是灰字（和一般內文不同色），不是被樣式吃掉變成黑字或看不見
    if (getComputedStyle(st).color === getComputedStyle(document.body).color || getComputedStyle(st).visibility === 'hidden') return { ok: false, why: '「正在讀取這台的帳號資料…」不是灰字' };
    if (document.body.textContent.includes('沒回報')) return { ok: false, why: '畫面上不該再有「沒回報」' };
    const box = R(st.closest('.m-dv-info') || st.parentElement);
    if (R(st).right > box.right + 0.5) return { ok: false, why: '詳情裡的狀態那一行超出版面' };
  } else {
    if (!foot) return { ok: false, why: '帳號頁沒有額度註腳' };
    if (document.querySelector('.m-dv-my')?.textContent.includes('這台沒有存這個帳號')) return { ok: false, why: '還有「這台沒有存這個帳號」' };
    // 帳號卡片的設備按鈕（原本的「切換到…」按鈕併進來）：字不被切、按鈕與說明字都不超出卡片
    const devs = [...document.querySelectorAll('.m-dv-my .m-dv-dev')].filter(vis);
    if (!devs.length) return { ok: false, why: '沒有設備按鈕可以檢查' };
    for (const b of devs) if (b.scrollWidth > b.clientWidth + 1) return { ok: false, why: '「' + b.textContent.trim() + '」的字被切' };
    for (const c of [...document.querySelectorAll('.m-dv-acct')].filter(c => c.querySelector('.m-dv-dev'))) {
      const box = R(c);
      for (const e of [...c.querySelectorAll('.m-dv-dev, .m-dv-devname small')].filter(vis)) if (R(e).right > box.right + 0.5 || R(e).left < box.left - 0.5) return { ok: false, why: '「' + e.textContent.trim() + '」超出帳號卡' };
    }
  }
  return { ok: true, why: '' };
})()`

export default {
  key: 'mlayout',
  kind: '手機設定頁排版檢查',
  source: probe => mlayoutProbeSource(probe),
}
