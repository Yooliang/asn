// 冒煙探測「放大鈕提示」（probe.snapTip，#2300）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
//
// LINE／現代外觀的放大鈕上蓋了一塊蓋板（Rust 子視窗），網頁收不到那一塊的滑鼠，title 不會跳出來。
// 前端改成收到 asn:snap-max 的 hover 後自己畫提示。這裡在頁面裡直接推 hover／down／leave 事件（冒煙沒有蓋板），確認：
//   ① hover 後等一下才出現（不是立刻）；文字依視窗狀態：沒最大化「最大化」、已最大化「還原」
//   ② 出現在放大鈕正下方（鈕下緣之下、水平上與鈕有重疊）、整個在視窗內
//   ③ leave、down 都會收掉；hover 等待期間就 leave 不會出現
// 參數：{ skin, maximized, keep? }。keep＝驗完留著提示不收，給截圖用（設 ASN_SNAPTIP_SHOTS=1 才會存圖）。
// 注意：不能用固定毫秒的睡眠（test/no-fixed-sleep-994），一律輪詢條件。

export const snapTipProbeSource = p => `(async () => {
  try {
  const P = ${JSON.stringify(p)};
  const tick = () => new Promise(r => setTimeout(r, 25));
  const until = async (cond, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await tick() } return cond() };
  const hold = async (cond, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (!cond()) return false; await tick() } return true };   // 整段時間都要成立
  const emit = name => { for (const fn of ((globalThis.__smokeListeners || {})['asn:snap-max'] || [])) fn({ event: 'asn:snap-max', payload: name }) };
  const tip = () => document.querySelector('.snap-tip');
  const btn = document.querySelector('.t-btns .tb[data-snap-max]');
  if (!btn) return { ok: false, why: '找不到放大鈕' };
  const b = btn.getBoundingClientRect();
  if (b.width <= 0 || b.height <= 0) return { ok: false, why: '放大鈕被藏起來了' };
  if (!((globalThis.__smokeListeners || {})['asn:snap-max'] || []).length) return { ok: false, why: '沒有聽 asn:snap-max，hover 不會有提示' };
  globalThis.__smokeMaximized = P.maximized === true;
  const want = P.maximized ? '還原' : '最大化';

  // ① 等延遲：幾十毫秒內不能出現
  emit('hover');
  if (!(await hold(() => !tip(), 250))) return { ok: false, why: 'hover 之後立刻就出現，沒有等延遲' };
  if (!(await until(() => !!tip(), 3000))) return { ok: false, why: 'hover 之後等了很久提示還是沒出現' };
  const t = tip(), r = t.getBoundingClientRect();
  if (t.textContent.trim() !== want) return { ok: false, why: '提示文字不對：要「' + want + '」，實際「' + t.textContent.trim() + '」' };
  // ② 位置
  if (r.top < b.bottom - 0.5) return { ok: false, why: '提示沒有在鈕下方：提示上緣 ' + r.top + '，鈕下緣 ' + b.bottom };
  if (r.top - b.bottom > 20) return { ok: false, why: '提示離鈕太遠：' + (r.top - b.bottom) + ' px' };
  if (r.right < b.left || r.left > b.right) return { ok: false, why: '提示在水平上跟放大鈕對不上' };
  if (r.left < 0 || r.top < 0 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) return { ok: false, why: '提示超出視窗：' + [r.left, r.top, r.right, r.bottom].map(Math.round) + ' / ' + innerWidth + '×' + innerHeight };
  if (getComputedStyle(t).pointerEvents !== 'none') return { ok: false, why: '提示會吃滑鼠' };
  const where = '提示「' + want + '」在鈕下 ' + Math.round(r.top - b.bottom) + 'px、左 ' + Math.round(r.left) + '／右 ' + Math.round(innerWidth - r.right);
  if (P.keep) return { ok: true, why: where + '（保留給截圖）' };

  // ③ 收掉
  emit('leave');
  if (tip()) return { ok: false, why: 'leave 之後提示還在' };
  emit('hover');
  if (!(await until(() => !!tip(), 3000))) return { ok: false, why: '第二次 hover 沒有出現' };
  emit('down');
  if (tip()) return { ok: false, why: 'down 之後提示還在' };
  emit('leave');
  emit('hover'); emit('leave');   // 等待期間就離開
  if (!(await hold(() => !tip(), 900))) return { ok: false, why: '等待期間 leave 了，提示還是冒出來' };
  return { ok: true, why: where };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const make = (skin, win, maximized, extra = {}) => {
  const w = win === 'list'
    ? { page: 'list.html', width: 900, state: skin === 'line' ? { signedIn: true, partnerTab: true, lineMsgs: true, skin } : { signedIn: true, bar: 'offline', chatMsgs: true, skin }, ready: skin === 'line' ? '#app.win .chat-area .compose-main' : '#app.win .actionbar' }
    : { page: 'chat.html?id=P%2Fdemo', width: 500, state: { signedIn: true, bar: 'offline', chatMsgs: true, lineMsgs: true, skin }, ready: '#app.win' }
  return {
    name: `snaptip-${skin}-${win}-${maximized ? 'max' : 'norm'}`,
    page: w.page, width: w.width, height: 640, dpr: 1.25,
    state: w.state, ready: w.ready,
    probe: { snapTip: { skin, maximized, ...extra } },
    ...(extra.keep && process.env.ASN_SNAPTIP_SHOTS ? { shot: `snaptip-${skin}-${win}-${maximized ? 'max' : 'norm'}.png` } : {}),
  }
}

const SCENARIOS = ['line', 'modern'].flatMap(skin => [
  make(skin, 'list', false), make(skin, 'list', true), make(skin, 'chat', false),
  make(skin, 'list', false, { keep: true }), make(skin, 'chat', true, { keep: true }),
].map((s, i) => (i >= 3 ? { ...s, name: s.name + '-keep' } : s)))

export default {
  key: 'snapTip',
  kind: '放大鈕提示',
  source: probe => snapTipProbeSource(probe.snapTip),
  scenarios: SCENARIOS,
}
