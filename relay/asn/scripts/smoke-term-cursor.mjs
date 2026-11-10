// #903 手機看終端：游標列／欄要對上窗格回報的位置（cursor_y、cursor_x）。
// 真的用 xterm 的緩衝區量：游標所在列、欄，和那一列文字（含中文、全形字、emoji）寬度算完的位置。
// 探測在頁面裡執行（注入的 Terminal 包一層，拿到實例）；這個檔案只產生探測原始碼，字串裡不寫反斜線
export const MTERMVIEW_CURSOR_COLS = 120
export const mtermviewCursorProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const CR = String.fromCharCode(13), LF = String.fromCharCode(10), CRLF = CR + LF;
  // 真的 WezTerm 的格數：中日韓與全形字、emoji 佔 2 格
  const wide = cp => (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || cp === 0x2705 || cp === 0x274c || cp === 0x2728;
  const wcw = s => [...s].reduce((n, c) => n + (wide(c.codePointAt(0)) ? 2 : 1), 0);
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
  await sleep(900);   // 假畫面幀（每 50ms 一幅，共 4 幅）送完
  const fire = (text, meta) => { for (const fn of ((globalThis.__smokeListeners || {})['term-view-remote-frame'] || [])) fn({ event: 'term-view-remote-frame', payload: { id: 'v1', text, meta } }) };
  // --escapes 形式：每列一個 CRLF，整份最後多一個裸換行
  const screen = rows => rows.join(CRLF) + CRLF + LF;
  const filler = (n, tag) => Array.from({ length: n }, (_, i) => tag + ' 第' + (i + 1) + '行 line ' + (i + 1));
  const COLS = ${MTERMVIEW_CURSOR_COLS};
  const cases = [];
  // prefix＝游標前面的字（輸入列）；游標要落在它的最後一個字後面
  const add = (name, { rows = 40, scroll = 0, top = 0, count = rows, cy, prefix, fill, lastFull }) => {
    const lines = filler(count, 'R');
    for (let i = 0; i < top; i++) lines[i] = '';
    lines[cy] = prefix;
    if (lastFull) lines[count - 1] = fill;
    const all = [...filler(scroll, 'SB'), ...lines];
    cases.push({ name, text: screen(all), meta: { cursor_x: wcw(prefix), cursor_y: cy, cols: COLS, rows }, prefix, cy });
  };
  const P1 = '> 幫我看一下ＡＢＣ，測試';
  const P2 = '> ok ✅ 🙂 完成';
  add('中文字後面的輸入列（中間列）', { cy: 20, prefix: P1 });
  add('最後一列', { cy: 39, prefix: P1 });
  add('第一列', { cy: 0, prefix: P1 });
  add('有 2 行捲動紀錄：最後一列', { cy: 39, scroll: 2, prefix: P1 });
  add('有 2 行捲動紀錄：中間列', { cy: 20, scroll: 2, prefix: P2 });
  add('有 2 行捲動紀錄：第一列', { cy: 0, scroll: 2, prefix: P1 });
  add('行數比 rows 少（12 行，游標在最後一行）', { count: 12, cy: 11, prefix: P1 });
  add('行數比 rows 少（21 行，中間有空列，游標在第 21 行）', { count: 21, cy: 20, prefix: P1 });
  add('最上面 3 列是空列', { cy: 20, top: 3, prefix: P1 });
  add('最後一列寫滿整列', { cy: 39, prefix: 'x'.repeat(COLS), fill: 'x'.repeat(COLS), lastFull: true });
  add('窗格 30 列（比 xterm 預設 40 列少）：最後一列', { rows: 30, cy: 29, prefix: P1 });
  add('全形與 emoji 後面（中間列）', { cy: 20, prefix: P2 });
  const out = [];
  const colOf = (line, n) => {   // 前 n 個字（碼位）在 xterm 這一列佔到第幾欄（含）
    let x = 0, seenN = 0;
    for (; x < line.length && seenN < n; x++) { const c = line.getCell(x); if (c && c.getWidth() > 0) seenN++; if (seenN === n) return x + (line.getCell(x).getWidth() || 1) }
    return -1;
  };
  for (const c of cases) {
    fire(c.text, c.meta);
    await sleep(150);
    const b = term.buffer.active;
    const line = b.getLine(b.viewportY + c.meta.cursor_y);
    const text = line ? line.translateToString(true) : '';
    const bad = [];
    if (term.rows !== c.meta.rows) bad.push('xterm 列數 ' + term.rows + ' ≠ 窗格 ' + c.meta.rows);
    if (term.cols !== c.meta.cols) bad.push('xterm 欄數 ' + term.cols + ' ≠ 窗格 ' + c.meta.cols);
    if (b.cursorY !== c.meta.cursor_y) bad.push('游標列 ' + b.cursorY + '（應 ' + c.meta.cursor_y + '，差 ' + (b.cursorY - c.meta.cursor_y) + '）');
    if (b.viewportY !== b.baseY) bad.push('畫面多捲了：viewportY ' + b.viewportY + ' baseY ' + b.baseY);
    if (b.baseY !== 0) bad.push('緩衝區有捲動 baseY=' + b.baseY);
    const pre = [...c.prefix].length;
    if (!text.startsWith(c.prefix.slice(0, 4))) bad.push('游標那一列不是輸入列：「' + text.slice(0, 18) + '」');
    else if (c.prefix.length < COLS) { const end = colOf(line, pre); if (end !== c.meta.cursor_x) bad.push('輸入列最後一個字結束在第 ' + end + ' 欄，窗格回報游標欄 ' + c.meta.cursor_x + '（差 ' + (c.meta.cursor_x - end) + '）'); if (b.cursorX !== c.meta.cursor_x) bad.push('游標欄 ' + b.cursorX + '（應 ' + c.meta.cursor_x + '）') }
    // 畫面上畫出來的游標方塊：在 .xterm-rows 第幾個子元素
    const rowsEl = [...document.querySelectorAll('.term-view-screen .xterm-rows > div')];
    const domRow = rowsEl.findIndex(r => r.querySelector('.xterm-cursor'));
    if (domRow >= 0 && domRow !== c.meta.cursor_y) bad.push('畫面上游標方塊在第 ' + domRow + ' 列（應 ' + c.meta.cursor_y + '）');
    out.push((bad.length ? '✗ ' : '✓ ') + c.name + (bad.length ? '：' + bad.join('；') : ''));
  }
  globalThis.__cursorReport = out;
  const bads = out.filter(s => s.startsWith('✗'));
  return { ok: bads.length === 0, why: LF + out.join(LF) };
})()`
