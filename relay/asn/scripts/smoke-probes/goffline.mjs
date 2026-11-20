// 冒煙探測「電腦群組離線人數檢查」（probe.goffline）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const gofflineProbeSource = ({ goffline }) => `(async () => {
  const want = ${JSON.stringify(goffline)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = sel => [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null || getComputedStyle(e).position === 'fixed');
  const rows = () => [...document.querySelectorAll('.offline-menu .menu-note')].map(e => e.textContent.trim());
  const esc = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  let btn = null;
  for (let i = 0; i < 30 && !btn; i++) { btn = vis(".mbar .mbtn-offline")[0] || null; if (!btn) await sleep(100) }
  if (want.center) {
    const pl = document.querySelector('.mbar .mbar-plate'), bar = document.querySelector('.mbar');
    if (!pl || !bar) return { ok: false, why: '找不到名牌或標題列' };
    const p = pl.getBoundingClientRect(), m = bar.getBoundingClientRect(), diff = (p.left + p.right) / 2 - (m.left + m.right) / 2;
    const wnat = (el) => { const o = el.style.width; el.style.width = 'max-content'; const w = el.getBoundingClientRect().width; el.style.width = o; return w };
    const nat = wnat(pl), wdiff = p.width - nat;
    window.__center = { plateCenter: (p.left + p.right) / 2, barCenter: (m.left + m.right) / 2, diff, width: p.width, natural: nat, wdiff };
    if (wdiff > 2) return { ok: false, why: '名牌被撐寬：寬 ' + p.width + '、內容需要 ' + nat + '、多出 ' + wdiff };
    if (Math.abs(diff) > 4) return { ok: false, why: '名牌沒有置中：名牌中心 ' + (p.left + p.right) / 2 + '、標題列中心 ' + (m.left + m.right) / 2 + '、差 ' + diff };
  }
  if (want.none) return btn ? { ok: false, why: '不該出現「離線」按鈕，卻看得到' } : { ok: true, why: window.__center ? '名牌中心差 ' + window.__center.diff + '、名牌寬 ' + window.__center.width + '／內容寬 ' + window.__center.natural : '' };
  if (!btn) return { ok: false, why: '現代外觀的群組頂端沒有「N 人離線」' };
  if (btn.textContent.trim() !== want.label) return { ok: false, why: '按鈕文字不符：' + btn.textContent.trim() };
  if (!/離線/.test(btn.getAttribute('aria-label') || '')) return { ok: false, why: '按鈕沒有 aria-label' };
  if (want.fit) {
    // 字型還沒載好時量出來的寬度都不準：先等字型，再每 100ms 量一次、最多 6 秒，這一輪的條件全部成立才往下（#1955）
    try { await document.fonts.ready } catch (e) {}
    const pl = document.querySelector('.mbar .mbar-plate');
    let b = btn.getBoundingClientRect(), p = pl && pl.getBoundingClientRect(), ell = false;
    const measure = () => {
      b = btn.getBoundingClientRect(); p = pl && pl.getBoundingClientRect();
      ell = !!pl && [pl, ...pl.querySelectorAll('*')].some(e => e.scrollWidth > e.clientWidth + 0.5 && getComputedStyle(e).textOverflow === 'ellipsis');
      return !!p && b.left >= p.right - 0.5 && b.right <= innerWidth + 0.5 && b.left >= 0 && (!want.ell || ell);
    };
    for (let i = 0; i < 60 && !measure(); i++) await sleep(100);
    if (!p) return { ok: false, why: '找不到名牌' };
    if (b.left < p.right - 0.5) return { ok: false, why: '離線按鈕蓋到名牌：按鈕左緣 ' + b.left + ' < 名牌右緣 ' + p.right };
    if (b.right > innerWidth + 0.5 || b.left < 0) return { ok: false, why: '離線按鈕超出視窗：' + b.left + '~' + b.right + ' / ' + innerWidth };
    if (want.ell && !ell) return { ok: false, why: '長名字沒有出現省略號（名牌寬 ' + p.width + '、視窗 ' + innerWidth + '、按鈕左 ' + b.left + '、名牌右 ' + p.right + '）' };
    window.__note = '按鈕左緣 ' + b.left + '／名牌右緣 ' + p.right + '／省略號 ' + ell;
    window.__fit = { btnLeft: b.left, plateRight: p.right, btnRight: b.right, vw: innerWidth, ell };
  }
  btn.click(); await sleep(250);
  if (JSON.stringify(rows()) !== JSON.stringify(want.names)) return { ok: false, why: '離線名單不符：' + JSON.stringify(rows()) };
  if (btn.getAttribute('aria-expanded') !== 'true') return { ok: false, why: '打開後 aria-expanded 不是 true' };
  esc(); await sleep(200);
  if (rows().length) return { ok: false, why: 'Esc 關不掉名單' };
  btn.click(); await sleep(250);
  if (!rows().length) return { ok: false, why: '第二次點不開名單' };
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await sleep(200);
  if (rows().length) return { ok: false, why: '點外面關不掉名單' };
  return { ok: true, why: window.__note || (window.__center ? '名牌中心差 ' + window.__center.diff + '、名牌寬 ' + window.__center.width + '／內容寬 ' + window.__center.natural : '') };
})()`

export default {
  key: 'goffline',
  kind: '電腦群組離線人數檢查',
  source: probe => gofflineProbeSource(probe),
}
