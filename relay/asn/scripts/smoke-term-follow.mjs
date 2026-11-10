// 手機看終端（鍵盤開著、區域變矮）：游標那一列要看得到；使用者自己往上捲就不拉回來。
// 40 列的假畫面、游標在倒數第 2 列；探測在頁面裡執行，這個檔案只產生探測原始碼，字串裡不寫反斜線
export const mtermviewFollowProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const CR = String.fromCharCode(13), LF = String.fromCharCode(10), CRLF = CR + LF;
  const seen = (globalThis.__terms = []);
  let real = globalThis.Terminal;
  const wrap = V => class extends V { constructor(o) { super(o); seen.push(this) } };
  if (real) globalThis.Terminal = wrap(real);
  else Object.defineProperty(globalThis, 'Terminal', { configurable: true, get: () => real, set: v => { real = wrap(v) } });
  let sw = null;
  for (let i = 0; i < 80 && !sw; i++) { sw = document.querySelector('.m-term-switch'); if (!sw) await sleep(100) }
  if (!sw) return { ok: false, why: '對話頁沒有「對話／終端」切換鈕' };
  sw.click();
  for (let i = 0; i < 80 && !seen.length; i++) await sleep(100);
  const term = seen[0];
  if (!term) return { ok: false, why: '沒有拿到 xterm 實例' };
  await sleep(900);
  const ta = document.querySelector('.m-chat .composer textarea');
  if (ta) { ta.focus(); await sleep(300) }
  const fire = (n) => {
    const rows = Array.from({ length: 40 }, (_, i) => 'R' + (i + 1) + ' line ' + n);
    rows[38] = '> 輸入列 ' + n;
    const text = rows.join(CRLF) + CRLF + LF;
    for (const fn of ((globalThis.__smokeListeners || {})['term-view-remote-frame'] || [])) fn({ event: 'term-view-remote-frame', payload: { id: 'v1', text, meta: { cursor_x: 8, cursor_y: 38, cols: 120, rows: 40 } } });
  };
  const screen = () => document.querySelector('.m-chat .term-view-screen');
  const rowRect = () => { const b = term.buffer.active; return [...document.querySelectorAll('.term-view-screen .xterm-rows > div')][b.cursorY]?.getBoundingClientRect() };
  const inside = () => {
    const s = screen().getBoundingClientRect(), r = rowRect();
    if (!r) return '找不到游標那一列';
    if (r.top < s.top - 0.5 || r.bottom > s.bottom + 0.5) return '游標那一列不在可見範圍：列 ' + Math.round(r.top) + '~' + Math.round(r.bottom) + '，可見 ' + Math.round(s.top) + '~' + Math.round(s.bottom);
    return '';
  };
  const s0 = screen();
  if (!(s0.scrollHeight > s0.clientHeight + 20)) return { ok: false, why: '前提不成立：終端區沒有比可見範圍高（' + s0.scrollHeight + ' vs ' + s0.clientHeight + '）' };
  fire(1);
  await sleep(400);
  if (term.buffer.active.cursorY !== 38) return { ok: false, why: '游標列 ' + term.buffer.active.cursorY + '（應 38）' };
  let bad = inside();
  if (bad) return { ok: false, why: '來了新畫面後：' + bad + '；scrollTop ' + s0.scrollTop };
  // 使用者往上捲到頂：再來新畫面，不拉回去
  s0.scrollTop = 0;
  await sleep(200);
  fire(2);
  await sleep(400);
  if (s0.scrollTop > 4) return { ok: false, why: '使用者捲到頂之後新畫面把他拉回去：scrollTop ' + s0.scrollTop };
  // 再捲回最底：恢復跟隨
  s0.scrollTop = s0.scrollHeight;
  await sleep(200);
  fire(3);
  await sleep(400);
  bad = inside();
  if (bad) return { ok: false, why: '捲回底部之後：' + bad };
  return { ok: true, why: '' };
})()`
