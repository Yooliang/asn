// 冒煙探測「手機看大圖返回鍵檢查」（probe.photoBack）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

// mode＝'mouse'（滾輪、拖曳、雙擊）或 'touch'（雙指捏合、點兩下）；最後關掉再打開要回到原本大小。全部用真的輸入（__smokeInput）
// 手機看大圖按返回鍵（#1537）：看圖是蓋在對話上的一層浮層（跟離線名單同一套）。開＝記錄多一筆；系統返回鍵（history.back，實機的返回鍵就是這個）
// 只關掉看圖、留在同一個對話；用「關閉」鈕、Esc 關掉要把那一筆退掉（記錄深度回到原本），之後再按返回才照原本的行為離開對話。縮放中按返回也直接關
export const photoBackProbeSource = () => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const real = req => { globalThis.__smokeInput(JSON.stringify(req)); return sleep(400) };
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const idx = () => (window.navigation ? navigation.currentEntry.index : history.length);
  const pv = () => document.querySelector('.photo-viewer');
  const img = () => document.querySelector('.photo-viewer img.pv-img');
  const onTab = () => (document.querySelector('.m-tabs button.on') || {}).textContent;
  const chatName = () => { const e = document.querySelector('.m-chat .m-plate-name, .m-chat .m-title'); return e ? e.textContent.trim() : '' };
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.m-chat .chatpane button.photo')].find(e => e.getClientRects().length); if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '對話裡找不到照片' };
  btn.scrollIntoView({ block: 'center' }); await sleep(200);
  const base = idx(), tab0 = onTab(), name0 = chatName();
  const open = async how => {
    await real({ click: at(btn) });
    for (let i = 0; i < 40 && !(img() && img().complete && img().naturalWidth); i++) await sleep(100);
    if (!pv()) return how + '：點照片沒有打開大圖';
    if (idx() !== base + 1) return how + '：開大圖後記錄深度是 ' + idx() + '，應該多一筆（' + (base + 1) + '）';
    if (!history.state || history.state.sheet !== 'photo') return how + '：開大圖的那筆記錄不是看圖：' + JSON.stringify(history.state);
    return '';
  };
  const closed = async how => {
    for (let i = 0; i < 20 && pv(); i++) await sleep(100);
    await sleep(300);
    if (pv()) return how + '：大圖沒有關掉';
    if (idx() !== base) return how + '：記錄深度是 ' + idx() + '，應該回到 ' + base + '（殘留了一筆）';
    if (onTab() !== tab0 || !document.querySelector('.m-chat .chatpane') || chatName() !== name0) return how + '：離開了原本的對話（分頁 ' + onTab() + '、對話 ' + chatName() + '）';
    if (!history.state || history.state.sheet) return how + '：記錄還停在浮層：' + JSON.stringify(history.state);
    return '';
  };
  let bad = await open('第一次'); if (bad) return { ok: false, why: bad };
  history.back(); bad = await closed('系統返回鍵'); if (bad) return { ok: false, why: bad };
  bad = await open('按關閉前'); if (bad) return { ok: false, why: bad };
  const x = [...pv().querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '關閉');
  if (!x) return { ok: false, why: '大圖上找不到「關閉」' };
  await real({ click: at(x) }); bad = await closed('按「關閉」'); if (bad) return { ok: false, why: bad };
  bad = await open('按 Esc 前'); if (bad) return { ok: false, why: bad };
  await real({ key: 'Escape' }); bad = await closed('按 Esc'); if (bad) return { ok: false, why: bad };
  bad = await open('縮放前'); if (bad) return { ok: false, why: bad };
  const w0 = img().getBoundingClientRect().width;
  await real({ pinch: [...at(img()), 80, 200] });
  if (!(img().getBoundingClientRect().width > w0 * 1.5)) return { ok: false, why: '雙指捏合沒有放大，縮放中返回的情況沒測到' };
  history.back(); bad = await closed('縮放中按系統返回鍵'); if (bad) return { ok: false, why: bad };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

export default {
  key: 'photoBack',
  kind: '手機看大圖返回鍵檢查',
  source: () => photoBackProbeSource(),
}
