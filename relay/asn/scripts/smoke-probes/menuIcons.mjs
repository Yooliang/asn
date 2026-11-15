// 冒煙探測「選單圖示檢查」（probe.menuIcons）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const menuIconsProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const mobile = !!document.querySelector('#app.m');
  let opener = null;
  for (let i = 0; i < 60 && !opener; i++) { opener = document.querySelector(mobile ? '.m-chathead .m-plate:not(:disabled)' : '.mbar-more .mbtn'); if (!opener || opener.offsetParent === null) { opener = null; await sleep(100) } }
  if (!opener) return { ok: false, why: mobile ? '找不到名牌（點了開「⋯」）' : '找不到「更多」鈕' };
  if (!opener.querySelector('svg.lic') && !mobile) return { ok: false, why: '「更多」鈕沒有用線條的三個點' };
  opener.click();
  let rows = [];
  for (let i = 0; i < 40 && !rows.length; i++) { await sleep(100); rows = [...document.querySelectorAll(mobile ? '.m-ops-panel .m-ops-item' : '.more-menu [role="menuitem"]')] }
  if (!rows.length) return { ok: false, why: '選單沒有打開' };
  const bad = rows.filter(b => { const ic = b.querySelector(':scope > svg.lic'); return !ic || getComputedStyle(ic).display === 'none' });
  if (bad.length) return { ok: false, why: '這幾項沒有圖示：' + bad.map(b => b.textContent.trim().slice(0, 12)).join('、') };
  const rm = rows.find(b => /移除/.test(b.textContent));
  if (rm && getComputedStyle(rm.querySelector('svg.lic')).color !== 'rgb(179, 38, 30)') return { ok: false, why: '「移除」的圖示應該是紅色：' + getComputedStyle(rm.querySelector('svg.lic')).color };
  return { ok: true, why: '' };
})()`

export default {
  key: 'menuIcons',
  kind: '選單圖示檢查',
  source: () => menuIconsProbeSource(),
}
