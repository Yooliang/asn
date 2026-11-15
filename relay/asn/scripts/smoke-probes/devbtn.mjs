// 冒煙探測「帳號設備按鈕檢查」（probe.devbtn）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const devbtnProbeSource = ({ devbtn, open = '' }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  const mobile = ${JSON.stringify(devbtn)} === 'mobile', open = ${JSON.stringify(open)};
  if (open) {
    let row = null;
    for (let i = 0; i < 60 && !row; i++) { row = [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes(open)) || null; if (!row) await sleep(100) }
    if (!row) return { ok: false, why: '找不到「' + open + '」' };
    row.click();
  }
  const sel = mobile ? '.m-dv-my .m-dv-dev' : '.dv-my .dv-devbtn';
  let btns = [];
  for (let i = 0; i < 60; i++) { btns = [...document.querySelectorAll(sel)].filter(vis); if (btns.some(b => b.classList.contains('on'))) break; await sleep(100) }
  const on = btns.filter(b => b.classList.contains('on'));
  for (const b of btns) { const t = b.textContent.trim(); const bad = ['✓', '使用中', '（這台）'].find(w => t.includes(w)); if (bad) return { ok: false, why: '設備按鈕「' + t + '」不該有「' + bad + '」，只寫設備名' } }
  if (!on.length) return { ok: false, why: '沒有使用中的設備按鈕（共 ' + btns.length + ' 顆）' };
  for (const b of on) {
    const t = b.textContent.trim();
    if (b.getAttribute('aria-pressed') !== 'true') return { ok: false, why: '「' + t + '」不是選中的樣子（aria-pressed）' };
    if (b.disabled) return { ok: false, why: '使用中的「' + t + '」被停用了' };
    const rgb = (getComputedStyle(b).backgroundColor.match(/[0-9]+/g) || []).map(Number);
    if (!(rgb[0] > 200 && rgb[1] > 170 && rgb[2] < 140)) return { ok: false, why: '使用中的「' + t + '」不是黃色：' + getComputedStyle(b).backgroundColor };
  }
  const box = document.querySelector(mobile ? '.m-dv-my' : '.dv-my');
  if (box.textContent.includes('用在：')) return { ok: false, why: '還有「用在：」那一行' };
  // 卡片與裡面的東西都不超出窗格（窄的時候額度條原本會把卡片撐出去）：卡片在「我的帳號」區內、卡片裡看得到的元素都在卡片內
  const area = box.getBoundingClientRect();
  for (const c of [...box.querySelectorAll(mobile ? '.m-dv-acct' : '.dv-acct')].filter(vis)) {
    const k = c.getBoundingClientRect(), who = c.querySelector(mobile ? '.m-dv-mail' : '.dv-mail')?.textContent.trim() ?? '';
    if (k.right > area.right + 0.5 || k.left < area.left - 0.5) return { ok: false, why: who + ' 的帳號卡超出窗格' };
    for (const e of [...c.querySelectorAll('*')].filter(vis)) { const r = e.getBoundingClientRect(); if (r.width && (r.right > k.right + 0.5 || r.left < k.left - 0.5)) return { ok: false, why: who + ' 的「' + (e.textContent.trim().slice(0, 20) || e.className) + '」超出帳號卡' } }
  }
  if ([...box.querySelectorAll('button')].some(b => vis(b) && b.textContent.includes('切換到'))) return { ok: false, why: '還有「切換到…」按鈕' };
  for (const b of btns) {
    const c = b.closest(mobile ? '.m-dv-acct' : '.dv-acct');
    const r = b.getBoundingClientRect(), k = c.getBoundingClientRect();
    if (r.right > k.right + 0.5 || r.left < k.left - 0.5) return { ok: false, why: '「' + b.textContent.trim() + '」超出帳號卡' };
    if (b.scrollWidth > b.clientWidth + 1) return { ok: false, why: '「' + b.textContent.trim() + '」的字被切' };
  }
  if (!mobile) {
    // 開放查詢是卡片右上 tag 列（和方案、使用中同一排）的標示，不在下方按鈕列
    for (const c of [...box.querySelectorAll('.dv-acct')].filter(vis)) {
      const tag = c.querySelector('.dv-side .dv-shared'), row = c.querySelector('.dv-share');
      if (row && row.textContent.includes('開放查詢')) return { ok: false, why: '「開放查詢」還在下方按鈕列' };
      if (!tag) continue;
      if (tag.textContent.trim() !== '開放查詢') return { ok: false, why: '開放查詢 tag 的字不對：' + tag.textContent.trim() };
      const tr = tag.getBoundingClientRect(), k = c.getBoundingClientRect(), q = c.querySelector('.dv-quota').getBoundingClientRect();
      if (tr.bottom > q.top + 0.5) return { ok: false, why: '開放查詢 tag 不在卡片上方的 tag 列' };
      if (tr.right > k.right + 0.5) return { ok: false, why: '開放查詢 tag 超出卡片' };
    }
    if (![...box.querySelectorAll('.dv-side .dv-shared')].some(vis)) return { ok: false, why: '情境資料有開放分享的帳號，卻沒有看到「開放查詢」tag' };
  }
  const before = (globalThis.__smokeCalls || []).length;
  on[0].click();
  await sleep(600);
  const sw = (globalThis.__smokeCalls || []).slice(before).map(c => c[0]).filter(c => /switch/i.test(c));
  if (sw.length) return { ok: false, why: '按使用中的按鈕發出了切換：' + sw.join('、') };
  if (document.querySelector('.m-sheet.open, .acct-confirm, [role="alertdialog"]')) return { ok: false, why: '按使用中的按鈕跳出了確認畫面' };
  return { ok: true, why: '' };
})()`

export default {
  key: 'devbtn',
  kind: '帳號設備按鈕檢查',
  source: probe => devbtnProbeSource(probe),
}
