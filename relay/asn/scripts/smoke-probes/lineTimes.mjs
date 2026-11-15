// 冒煙探測「LINE 訊息時間位置檢查」（probe.lineTimes）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const lineTimesProbeSource = () => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.getClientRects().length > 0;
  let pane = null;
  for (let i = 0; i < 60 && !pane; i++) { pane = [...document.querySelectorAll('.chatpane')].find(vis) || null; if (!pane) await sleep(100) }
  if (!pane) return { ok: false, why: '找不到對話' };
  await sleep(400);
  const msgs = [...pane.querySelectorAll('.msg')].filter(m => vis(m) && m.querySelector('.l-time') && m.querySelector('.m-body'));
  if (msgs.length < 3) return { ok: false, why: '有時間的訊息不夠：' + msgs.length };
  const R = e => e.getBoundingClientRect();
  const seen = [];
  for (const m of msgs) {
    const t = R(m.querySelector('.l-time')), b = R(m.querySelector('.m-body')), box = R(m);
    const mine = m.classList.contains('mine');
    const label = (mine ? '自己' : '對方') + '「' + m.querySelector('.m-body').textContent.trim().slice(0, 8) + '」';
    if (t.top < box.top - 1 || t.bottom > box.bottom + 1) return { ok: false, why: label + '的時間不在這則訊息裡（跑到 ' + Math.round(t.left) + ',' + Math.round(t.top) + '）' };
    if (Math.abs(t.bottom - b.bottom) > 6) return { ok: false, why: label + '的時間沒貼在泡泡底部：時間底 ' + Math.round(t.bottom) + '、泡泡底 ' + Math.round(b.bottom) };
    if (mine ? !(t.right <= b.left + 1 && b.left - t.right < 24) : !(t.left >= b.right - 1 && t.left - b.right < 24)) return { ok: false, why: label + '的時間不在泡泡' + (mine ? '左' : '右') + '邊：時間 ' + Math.round(t.left) + '～' + Math.round(t.right) + '、泡泡 ' + Math.round(b.left) + '～' + Math.round(b.right) };
    const st = m.querySelector('.l-st');
    if (st && vis(st)) { const s = R(st); if (s.bottom > t.top + 1) return { ok: false, why: label + '的「' + st.textContent.trim() + '」沒有疊在時間上面' } }
    for (const o of seen) if (!(t.right <= o.left || t.left >= o.right || t.bottom <= o.top || t.top >= o.bottom)) return { ok: false, why: '兩則訊息的時間疊在一起' };
    seen.push(t);
  }
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

export default {
  key: 'lineTimes',
  kind: 'LINE 訊息時間位置檢查',
  source: () => lineTimesProbeSource(),
}
