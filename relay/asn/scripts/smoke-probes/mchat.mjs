// 冒煙探測「手機對話頁檢查」（probe.mchat）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const mchatProbeSource = ({ mchat }) => `(async () => {
  const want = ${JSON.stringify({ lead: [], present: [], absent: [], tasks: '', menu: true, wake: false, ...mchat })};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const shown = sel => [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null);
  for (let i = 0; i < 60 && !document.querySelector('.m-chat .chatpane'); i++) await sleep(100);
  await sleep(300);
  const bars = shown('.m-chat .actionbar, .m-chat .m-abar, .m-chat .m-abar-row, .m-chat .m-abtn, .m-chat .abtn');
  if (bars.length) return { ok: false, why: '手機對話頁還有按鈕列：' + bars.map(e => e.className).join('、') };
  if (want.tasks) {
    const conn = document.querySelector('.m-chathead .m-conn')?.textContent ?? '';
    if (!conn.includes(want.tasks)) return { ok: false, why: '標頭沒有「' + want.tasks + '」：' + conn };
  }
  const dots = document.querySelector('.m-chathead .m-icon-btn[aria-label="更多操作"]');
  if (!dots) return { ok: false, why: '找不到「⋯」' };
  if (!want.menu) return { ok: true, why: '' };
  dots.click();
  let rows = [];
  for (let i = 0; i < 30; i++) { await sleep(100); rows = [...document.querySelectorAll('.m-ops-panel .m-ops-item')]; if (rows.length) break }
  const items = rows.map(b => [b.querySelector('.m-opt-t')?.textContent.trim() ?? '', b.getAttribute('aria-disabled') === 'true']);
  if (!items.length) return { ok: false, why: '「⋯」選單是空的' };
  if (JSON.stringify(items.slice(0, want.lead.length)) !== JSON.stringify(want.lead)) return { ok: false, why: '「⋯」前幾項不符：' + JSON.stringify(items) };
  const names = items.map(x => x[0]);
  const lack = want.present.filter(t => !names.includes(t));
  if (lack.length) return { ok: false, why: '「⋯」少了：' + lack.join('、') };
  const bad = items.filter(([t]) => /前台|後台/.test(t) || want.absent.includes(t));
  if (bad.length) return { ok: false, why: '「⋯」不該有：' + bad.map(x => x[0]).join('、') };
  if (want.wake) {
    rows[0].click();
    let run = null;
    for (let j = 0; j < 30 && !run; j++) { await sleep(100); run = document.querySelector('.chatpane .typing.typing-op') }
    if (!run) return { ok: false, why: '點了喚醒沒有送出（對話最下面那一行沒有進度）' };
    if (document.querySelector('.m-ops-panel')) return { ok: false, why: '喚醒送出後「⋯」選單沒有收起' };
  }
  return { ok: true, why: '' };
})()`

export default {
  key: 'mchat',
  kind: '手機對話頁檢查',
  source: probe => mchatProbeSource(probe),
}
