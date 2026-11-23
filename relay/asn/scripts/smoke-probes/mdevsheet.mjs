// 冒煙探測「手機設備詳情排版檢查」（probe.mdevsheet）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const mdevsheetProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  const W = window.innerWidth;
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes('設備')) || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '找不到設定裡的「設備」' };
  btn.click(); await sleep(500);
  let opened = false;
  for (const row of [...document.querySelectorAll('.m-dv-row')].filter(vis)) {
    if ((row.textContent ?? '').includes('這支手機')) continue;
    [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '詳情')?.click(); await sleep(300);   // 詳情 → 帳號分頁（#1860）
    const go = document.querySelector('.m-dv-subbtn[data-sub="accounts"]');
    if (!go) continue;
    go.click(); await sleep(600);
    if ([...document.querySelectorAll('.m-dv-vendor')].some(vis)) { opened = true; break }
    const back = [...document.querySelectorAll('.m-icon-btn[aria-label="返回"]')].find(vis);
    if (back) { back.click(); await sleep(400) }
  }
  if (!opened) return { ok: false, why: '找不到有廠商卡片的電腦細部頁' };
  const R = e => e.getBoundingClientRect();
  const head = [...document.querySelectorAll('.m-dv .m-dv-dh')].find(vis);
  const sec = head && head.parentElement;
  if (!sec) return { ok: false, why: '找不到設備詳情區塊' };
  const sr = R(sec);
  if (sr.left < -0.5 || sr.right > W + 0.5) return { ok: false, why: '詳情區塊超出視窗：' + Math.round(sr.left) + '～' + Math.round(sr.right) + '（視窗寬 ' + W + '）' };
  if (document.documentElement.scrollWidth > W + 1) return { ok: false, why: '頁面出現橫向捲動：' + document.documentElement.scrollWidth + '（視窗寬 ' + W + '）' };
  if (sec.scrollWidth > sec.clientWidth + 1) return { ok: false, why: '詳情區塊內容被水平切掉：' + sec.scrollWidth + '／' + sec.clientWidth };
  const cards = [...document.querySelectorAll('.m-dv-vendor')].filter(vis);
  for (const c of cards) {
    const r = R(c), name = c.querySelector('b')?.textContent.trim() ?? '';
    if (r.left < sr.left - 0.5 || r.right > sr.right + 0.5) return { ok: false, why: '「' + name + '」卡片超出詳情區塊：' + Math.round(r.left) + '～' + Math.round(r.right) + '，區塊 ' + Math.round(sr.left) + '～' + Math.round(sr.right) };
    if (r.right > W + 0.5) return { ok: false, why: '「' + name + '」卡片右邊超出視窗：' + Math.round(r.right) + '／' + W };
    if (c.scrollWidth > c.clientWidth + 1) return { ok: false, why: '「' + name + '」卡片內容被水平切掉' };
    const hit = document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + 20, window.innerHeight - 1));
    if (r.top + 20 < window.innerHeight && r.top + 20 > 0 && hit && !c.contains(hit)) return { ok: false, why: '「' + name + '」卡片上面蓋著別的東西：' + (hit.className || hit.tagName) };
  }
  const close = [...document.querySelectorAll('.m-dv .m-ops-cancel')].find(b => vis(b) && b.textContent.includes('關閉'));
  const foot = [...document.querySelectorAll('.m-dv .m-dv-foot')].find(vis);
  const hit = (r, a, b) => !(a.right <= b.left + 0.5 || a.left >= b.right - 0.5 || a.bottom <= b.top + 0.5 || a.top >= b.bottom - 0.5);
  for (const [label, e] of [['關閉鈕', close], ['額度註腳', foot]]) {
    if (!e) continue;
    const r = R(e);
    for (const c of cards) if (hit(r, r, R(c))) return { ok: false, why: label + '與「' + (c.querySelector('b')?.textContent.trim() ?? '') + '」卡片互疊' };
    if (hit(r, r, sr)) return { ok: false, why: label + '壓在詳情區塊上' };
    if (r.right > W + 0.5 || r.left < -0.5) return { ok: false, why: label + '超出視窗' };
  }
  if (close) {
    close.scrollIntoView({ block: 'center' }); await sleep(200);
    const r = R(close), top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top || !close.contains(top)) return { ok: false, why: '關閉鈕中心點到的不是它：' + (top ? (top.className || top.tagName) : '無') };
  }
  return { ok: true, why: '' };
})()`

export default {
  key: 'mdevsheet',
  kind: '手機設備詳情排版檢查',
  source: probe => mdevsheetProbeSource(probe),
}
