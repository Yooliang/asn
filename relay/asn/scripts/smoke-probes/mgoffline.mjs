// 冒煙探測「手機群組離線人數檢查」（probe.mgoffline）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const mgofflineProbeSource = ({ mgoffline }) => `(async () => {
  const want = ${JSON.stringify(mgoffline)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = sel => [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null);
  const rows = () => [...document.querySelectorAll('.m-offline-menu li')].map(e => e.textContent.trim());
  const esc = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  for (let i = 0; i < 40 && !document.querySelector('.m-chathead .m-plate'); i++) await sleep(100);
  try { await document.fonts.ready } catch (e) {}
  let btn = vis('.m-plate-head .m-offline-btn')[0] || null;
  for (let i = 0; i < 60 && !btn && !want.none; i++) { await sleep(100); btn = vis('.m-plate-head .m-offline-btn')[0] || null }
  if (want.center) {
    const pl = document.querySelector('.m-plate-head .m-plate'), hd = document.querySelector('.m-plate-head');
    if (!pl || !hd) return { ok: false, why: '找不到名牌或名牌頭' };
    const p = pl.getBoundingClientRect(), m = hd.getBoundingClientRect(), diff = (p.left + p.right) / 2 - (m.left + m.right) / 2;
    const wnat = (el) => { const o = el.style.width; el.style.width = 'max-content'; const w = el.getBoundingClientRect().width; el.style.width = o; return w };
    const nat = wnat(pl), wdiff = p.width - nat;
    window.__cm = '名牌中心差 ' + diff + '、名牌寬 ' + p.width + '／內容寬 ' + nat;
    console.info('[center-m]', JSON.stringify({ plateCenter: (p.left + p.right) / 2, headCenter: (m.left + m.right) / 2, diff, width: p.width, natural: nat, wdiff }));
    if (Math.abs(diff) > 4) return { ok: false, why: '名牌沒有置中：名牌中心 ' + (p.left + p.right) / 2 + '、名牌頭中心 ' + (m.left + m.right) / 2 + '、差 ' + diff };
    if (wdiff > 2) return { ok: false, why: '名牌被撐寬：寬 ' + p.width + '、內容需要 ' + nat + '、多出 ' + wdiff };
  }
  if (want.none) return btn ? { ok: false, why: '不該出現「離線」按鈕，卻看得到' } : { ok: true, why: window.__cm || '' };
  if (!btn) return { ok: false, why: '現代外觀的群組名牌頭沒有「N 人離線」' };
  if (btn.textContent.trim() !== want.label) return { ok: false, why: '按鈕文字不符：' + btn.textContent.trim() };
  if (!/離線/.test(btn.getAttribute('aria-label') || '')) return { ok: false, why: '按鈕沒有 aria-label' };
  if (want.fit) {
    // 字型還沒載好時量出來的寬度都不準：每 100ms 量一次、最多 6 秒，這一輪的條件全部成立才往下（#1955）
    const pl = document.querySelector('.m-plate-head .m-plate');
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
    if (want.ell && !ell) return { ok: false, why: '長名字沒有出現省略號' };
    window.__cm = '按鈕左緣 ' + b.left + '／名牌右緣 ' + p.right + '／省略號 ' + ell;
    console.info('[fit-m]', JSON.stringify({ btnLeft: b.left, plateRight: p.right, btnRight: b.right, vw: innerWidth, ell }));
  }
  const idx = () => (window.navigation ? navigation.currentEntry.index : history.length);
  const onTab = () => (document.querySelector('.m-tabs button.on') || {}).textContent;
  const tab0 = onTab(), base = idx();
  btn.click(); await sleep(250);
  if (JSON.stringify(rows()) !== JSON.stringify(want.names)) return { ok: false, why: '離線名單不符：' + JSON.stringify(rows()) };
  // 名單是蓋在對話上的一層浮層（和「⋯」選單同一套）：開＝記錄多一層，退掉＝回到原深度，各種關法都不能殘留（#1466）。
  // 實機的返回鍵＝瀏覽器上一頁（history.back()），對話分頁是記錄的底，所以不能靠自己丟 popstate 事件
  const closed = async (how) => {
    await sleep(350);
    if (rows().length) return how + '：名單沒有收起';
    if (idx() !== base) return how + '：記錄深度是 ' + idx() + '，應該回到 ' + base + '（殘留了一筆）';
    if (onTab() !== tab0 || !document.querySelector('.m-chat .chatpane')) return how + '：離開了對話頁';
    return '';
  };
  const open = async (how) => {
    btn.click(); await sleep(300);
    if (!rows().length) return how + '：名單沒打開';
    if (idx() !== base + 1) return how + '：開名單後記錄深度是 ' + idx() + '，應該多一層（' + (base + 1) + '）';
    return '';
  };
  let bad = '';
  if (idx() !== base + 1) return { ok: false, why: '開名單後記錄深度是 ' + idx() + '，應該多一層（' + (base + 1) + '）' };
  esc(); bad = await closed('Esc'); if (bad) return { ok: false, why: bad };
  bad = await open('點外面前'); if (bad) return { ok: false, why: bad };
  const back = document.querySelector('.m-head-offline .m-plus-back');
  if (!back) return { ok: false, why: '點外面：找不到背板' };
  back.click(); bad = await closed('點外面'); if (bad) return { ok: false, why: bad };
  bad = await open('再按一次按鈕前'); if (bad) return { ok: false, why: bad };
  btn.click(); bad = await closed('再按一次按鈕'); if (bad) return { ok: false, why: bad };
  bad = await open('返回鍵前'); if (bad) return { ok: false, why: bad };
  history.back(); bad = await closed('系統返回鍵（history.back）'); if (bad) return { ok: false, why: bad };
  // 名單開著時分頁列要點得到：點另一個分頁＝名單收起（退掉那一筆）並切過去；之後返回鍵回到對話頁，不殘留名單
  bad = await open('分頁前'); if (bad) return { ok: false, why: bad };
  const other = [...document.querySelectorAll('.m-tabs button')].find(b => !b.classList.contains('on'));
  if (!other) return { ok: false, why: '找不到其他分頁' };
  const r = other.getBoundingClientRect(), hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
  if (!hit || !other.contains(hit)) return { ok: false, why: '名單開著時分頁列被蓋住：點到 ' + (hit ? hit.className || hit.tagName : '無') };
  other.click(); await sleep(600);
  if (rows().length) return { ok: false, why: '點分頁後名單沒有收起' };
  if (onTab() === tab0) return { ok: false, why: '名單開著點分頁，沒有切過去' };
  if (idx() !== base + 1) return { ok: false, why: '點分頁後記錄深度是 ' + idx() + '，應該是 ' + (base + 1) + '（切走一層，名單那筆不能殘留）' };
  history.back(); await sleep(500);
  if (idx() !== base || onTab() !== tab0 || rows().length) return { ok: false, why: '切走再按返回鍵：沒有回到原本的對話頁（深度 ' + idx() + '）' };
  return { ok: true, why: window.__cm || '' };
})()`

export default {
  key: 'mgoffline',
  kind: '手機群組離線人數檢查',
  source: probe => mgofflineProbeSource(probe),
}
