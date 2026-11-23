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
  const sel = mobile ? '.m-dv-my .m-dv-devrow .m-dv-dev' : '.dv-my .dv-devrow .dv-devbtn';
  let btns = [];
  for (let i = 0; i < 60; i++) { btns = [...document.querySelectorAll(sel)].filter(vis); if (btns.some(b => (b.classList.contains('current') || b.classList.contains('st-current')))) break; await sleep(100) }
  const on = btns.filter(b => (b.classList.contains('current') || b.classList.contains('st-current')));
  const WORDS = ['使用中', '切換', '切換中…', '不能切換', '離線中'];
  for (const b of btns) { const t = b.textContent.trim(); if (!WORDS.includes(t)) return { ok: false, why: '設備鈕上的字「' + t + '」不在固定的五種裡' } }
  // #2111 ②：同一張卡裡所有鈕同尺寸（電腦 92×28、手機 100×40）、同一欄靠右（右緣一致、貼近卡片右邊）
  const W = mobile ? 100 : 92, H = mobile ? 40 : 28;
  for (const c of [...document.querySelectorAll(mobile ? '.m-dv-my .m-dv-acct' : '.dv-my .dv-acct')].filter(vis)) {
    const cbtns = [...c.querySelectorAll(mobile ? '.m-dv-dev' : '.dv-devbtn')].filter(vis);
    if (!cbtns.length) continue;
    const k = c.getBoundingClientRect();
    for (const b of cbtns) {
      const r = b.getBoundingClientRect();
      if (Math.abs(r.width - W) > 0.6 || Math.abs(r.height - H) > 0.6) return { ok: false, why: '「' + b.textContent.trim() + '」鈕尺寸 ' + Math.round(r.width) + '×' + Math.round(r.height) + '，應為 ' + W + '×' + H };
      if (Math.abs(r.right - cbtns[0].getBoundingClientRect().right) > 0.6) return { ok: false, why: '設備鈕沒有在同一欄（右緣不一致）' };
      if (k.right - r.right > 24) return { ok: false, why: '設備鈕沒有靠右（離卡片右緣 ' + Math.round(k.right - r.right) + 'px）' };
    }
  }
  if (!on.length) return { ok: false, why: '沒有使用中的設備按鈕（共 ' + btns.length + ' 顆）' };
  for (const b of on) {
    const t = b.textContent.trim();
    if (!b.disabled) return { ok: false, why: '使用中的「' + t + '」應該不能按' };
    const rgb = (getComputedStyle(b).backgroundColor.match(/[0-9]+/g) || []).map(Number);
    if (!(rgb[0] < 140 && rgb[1] < 140 && rgb[2] < 150)) return { ok: false, why: '使用中的「' + t + '」不是深灰底：' + getComputedStyle(b).backgroundColor };
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
  // #2111 ⑥：帳號頁沒有「我的帳號」標題；時間不加括號；電腦卡片右上角的「⋯」選單可開合、項目可按，卡片上沒有獨立的產生／撤銷鈕
  if ([...box.querySelectorAll(mobile ? '.m-dv-my-h' : '.dv-my-h')].some(vis)) return { ok: false, why: '帳號頁還有「我的帳號」那行標題' };
  if (/（\d+ (分鐘|小時|天)前）/.test(box.textContent)) return { ok: false, why: '時間還加了括號' };
  if (!mobile) {
    if ([...box.querySelectorAll('.dv-share')].some(vis)) return { ok: false, why: '卡片上還有獨立的產生／撤銷鈕' };
    const more = [...box.querySelectorAll('.dv-acct .asn-more-btn')].filter(vis);
    if (!more.length) return { ok: false, why: '帳號卡右上角沒有「⋯」' };
    const m = more[0], card = m.closest('.dv-acct');
    m.click(); await sleep(200);
    const items = [...card.querySelectorAll('.asn-more-item')].filter(vis);
    const names = items.map(i => i.textContent.trim());
    if (!items.length || !names.some(t => t === '產生查詢代碼' || t === '重新產生查詢代碼')) return { ok: false, why: '「⋯」選單沒有產生查詢代碼：' + names.join('、') };
    if (items.some(i => i.disabled)) return { ok: false, why: '「⋯」選單的項目不能按' };
    m.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(200);
    if ([...card.querySelectorAll('.asn-more-item')].some(vis)) return { ok: false, why: '按 Esc 後「⋯」選單沒有收起' };
    m.click(); await sleep(200);
    const back = card.querySelector('.asn-more-back'); if (!back) return { ok: false, why: '選單展開後沒有點外面收起的底層' };
    back.click(); await sleep(200);
    if ([...card.querySelectorAll('.asn-more-item')].some(vis)) return { ok: false, why: '點外面後「⋯」選單沒有收起' };
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
