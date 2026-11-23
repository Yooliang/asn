// 冒煙探測「手機不能切到本機檢查」（probe.mnoself）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const mnoselfProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes('設備')) || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '找不到設定裡的「設備」' };
  btn.click(); await sleep(500);
  const rows = () => [...document.querySelectorAll('.m-dv-row')].filter(vis);
  const n = rows().length;
  if (n < 3) return { ok: false, why: '設備列少於 3 列：' + n };
  let sawSelf = false;
  for (let i = 0; i < n; i++) {
    const row = rows()[i];
    const name = row?.textContent ?? '';
    [...(row?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === '詳情')?.click(); await sleep(300);   // 詳情 → 帳號分頁（#1860）
    const go = document.querySelector('.m-dv-subbtn[data-sub="accounts"]');
    if (!go) continue;
    go.click(); await sleep(500);
    if (name.includes('運作中')) {   // 本機那一列只寫「運作中」
      sawSelf = true;
      if ([...document.querySelectorAll('.m-dv-sw')].some(vis)) return { ok: false, why: '「這支手機」的細部頁出現切換鈕' };
    }
    const back = [...document.querySelectorAll('.m-icon-btn[aria-label="返回"]')].find(vis);
    if (back) { back.click(); await sleep(400) }
  }
  if (!sawSelf) return { ok: false, why: '設備列表沒有「這支手機」' };
  let seg = null;
  for (let i = 0; i < 60 && !seg; i++) { seg = document.querySelector('.m-dv-segbtn[data-tab="accounts"]'); if (!seg) await sleep(100) }
  if (!seg) return { ok: false, why: '找不到「帳號」分頁鈕' };
  seg.click(); await sleep(600);
  const devs = [...document.querySelectorAll('.m-dv-my .m-dv-devrow')].filter(vis);
  const names = devs.map(b => b.textContent.trim()).join('、') || '（沒有按鈕）';
  const btnOf = r => r.querySelector('.m-dv-dev');
  if (devs.some(b => (b.textContent.includes('這支手機') || b.textContent.includes('測試機')) && btnOf(b).classList.contains('switch') && !btnOf(b).disabled)) return { ok: false, why: '帳號頁可以把帳號切到這支手機：' + names };
  if (!devs.some(b => b.textContent.includes('辦公室') && btnOf(b).classList.contains('switch') && !btnOf(b).disabled)) return { ok: false, why: '別台電腦的切換鈕不見了：' + names };
  return { ok: true, why: '' };
})()`

export default {
  key: 'mnoself',
  kind: '手機不能切到本機檢查',
  source: probe => mnoselfProbeSource(probe),
}
