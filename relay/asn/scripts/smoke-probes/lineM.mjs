// 冒煙探測「LINE 手機泡泡與標題列檢查」（probe.lineM）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

// LINE 手機（#1536）：part＝'table'（一對一，含寬表格）或 'group'（群組）。全部在頁面裡量：
// 每個泡泡右緣、每個時間都在螢幕內，訊息區沒有橫向捲動；表格在泡泡裡，用手指真的滑得動；一般長句的泡泡放寬到約 80%；
// 標題列藍底、跟對話區同色、中間沒有細線；輸入列的圖片鈕在沒有滑鼠游標的裝置上點過之後不留灰色圓底
export const lineMProbeSource = part => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 350) };
  const R = e => e.getBoundingClientRect();
  let pane = null;
  for (let i = 0; i < 60 && !pane; i++) { pane = [...document.querySelectorAll('.m-chat .chatpane')].find(vis) || null; if (!pane) await sleep(100) }
  if (!pane) return { ok: false, why: '找不到對話' };
  const msgs = pane.querySelector('.msgs');
  for (let i = 0; i < 60 && msgs.querySelectorAll('.msg .m-body').length < 2; i++) await sleep(100);
  await sleep(300);
  const W = innerWidth;
  // 標題列：藍底、跟對話區同色、跟對話區之間沒有線
  const head = [...document.querySelectorAll('.m-chat .m-chathead')].find(vis);
  if (!head) return { ok: false, why: '找不到標題列' };
  const hb = getComputedStyle(head).backgroundColor, cb = getComputedStyle(pane.querySelector('.conv-main') || msgs).backgroundColor;
  if (hb !== 'rgb(169, 189, 226)' || hb !== cb) return { ok: false, why: '標題列不是藍底或跟對話區不同色：' + hb + ' ／ ' + cb };
  const pn = pane.closest('.pane') || pane;
  if (parseFloat(getComputedStyle(pn).borderTopWidth) > 0) return { ok: false, why: '標題列下面還有一條線：' + getComputedStyle(pn).borderTopWidth + ' ' + getComputedStyle(pn).borderTopColor };
  // 每個泡泡、每個時間都在螢幕內；訊息區、整頁都沒有橫向捲動
  for (const b of msgs.querySelectorAll('.msg .m-body')) if (vis(b) && (R(b).right > W + 0.5 || R(b).left < -0.5)) return { ok: false, why: '泡泡跑出螢幕：右緣 ' + Math.round(R(b).right) + ' ／ 螢幕 ' + W };
  for (const t of msgs.querySelectorAll('.msg .l-time')) if (vis(t) && (R(t).right > W + 0.5 || R(t).left < -0.5 || R(t).width < 1)) return { ok: false, why: '時間看不到：' + t.textContent + ' 在 ' + Math.round(R(t).left) + '～' + Math.round(R(t).right) };
  if (msgs.scrollWidth > msgs.clientWidth + 1) return { ok: false, why: '訊息區出現橫向捲動：' + msgs.scrollWidth + ' ／ ' + msgs.clientWidth };
  if (document.documentElement.scrollWidth > W + 1) return { ok: false, why: '整頁出現橫向捲動' };
  if (${JSON.stringify(part)} === 'head') return { ok: true, why: '' };   // 只看標題列（上面已經量過藍底、同色、沒有線）
  if (${JSON.stringify(part)} === 'table') {
    const wrap = msgs.querySelector('.md-tablewrap');
    if (!vis(wrap)) return { ok: false, why: '找不到表格' };
    if (!(wrap.scrollWidth > wrap.clientWidth + 20)) return { ok: false, why: '表格沒有比泡泡寬，測不到左右滑：' + wrap.scrollWidth + ' ／ ' + wrap.clientWidth };
    const bub = wrap.closest('.m-body');
    if (R(wrap).right > R(bub).right + 0.5) return { ok: false, why: '表格超出泡泡' };
    wrap.scrollIntoView({ block: 'center' }); await sleep(200);
    const c = at(wrap);
    await real({ gesture: [c[0] + 60, c[1], -160, 0] }, 900);
    if (!(wrap.scrollLeft > 20)) return { ok: false, why: '用手指滑表格沒有左右捲動：scrollLeft=' + wrap.scrollLeft };
    if (msgs.scrollLeft !== 0 || document.documentElement.scrollLeft !== 0) return { ok: false, why: '滑表格時整個訊息區跟著橫移' };
    // 一般長句的泡泡：泡泡本身（不含旁邊的時間）要比原本 68% 的上限明顯寬（多 30px 以上），也不超過這一列的 80%。
    // 不寫死下限比例：窄螢幕（360）時泡泡已經頂到「扣掉頭像和時間」的可用寬度，字型不同（CI 的 Linux 字型）折行點也會差一個字
    const row = [...msgs.querySelectorAll('.msg')].find(m => !m.querySelector('table') && (m.querySelector('.m-body')?.textContent || '').length > 25 && !m.classList.contains('mine'));
    if (!row) return { ok: false, why: '找不到長句的泡泡' };
    const bw = R(row.querySelector('.m-body')).width, rw = R(row).width;
    const meta = row.querySelector('.l-meta'), metaW = meta ? R(meta).width + 6 : 0, oldMax = rw * 0.68 - metaW;
    if (bw > rw * 0.8 + 1) return { ok: false, why: '長句泡泡本身超過這一列的 80%：' + Math.round(bw) + ' ／ ' + Math.round(rw) };
    if (bw < oldMax + 30) return { ok: false, why: '長句泡泡沒有比原本（68% 扣掉時間＝' + Math.round(oldMax) + 'px）明顯寬：' + Math.round(bw) + ' ／ ' + Math.round(rw) };
  }
  const main = pane.querySelector('.compose-main'), ta = main && main.querySelector('.composer textarea');
  const send = main && main.querySelector('.composer .aero-btn'), mic = main && main.querySelector('.mc-dict');
  const others = () => [...main.querySelectorAll('button')].filter(b => vis(b) && b !== mic && b !== send);
  if (${JSON.stringify(part)} === 'dict') {
    // 聽寫：真點麥克風 → 聆聽中。不出現「聆聽中…」字樣、麥克風變紅、按鈕大小不變、旁邊的東西不動
    if (!vis(mic)) return { ok: false, why: '找不到麥克風（語音輸入）' };
    const before = R(mic), place = [ta, ...others()].map(e => [e, R(e).left, R(e).width]);
    const color0 = getComputedStyle(mic).color;
    const rgb = c => c.slice(c.indexOf('(') + 1, c.indexOf(')')).split(',').map(x => Number(x.trim()));
    // 準備中（等麥克風權限）：真點麥克風，先停在準備中，麥克風淡紅
    await real({ click: at(mic) }, 400);
    if (!mic.classList.contains('busy')) return { ok: false, why: '真點麥克風沒有進入準備中' };
    const pale = getComputedStyle(mic).color, p = rgb(pale);
    if (!(p[0] > 200 && p[1] > 130 && p[1] < 200 && p[2] > 120 && p[2] < 200)) return { ok: false, why: '準備中麥克風不是淡紅：' + pale };
    if (parseFloat(getComputedStyle(mic).opacity) < 0.99) return { ok: false, why: '準備中麥克風變透明了（應該是淡紅、不是變淡）' };
    { const r = R(mic); if (Math.abs(r.width - before.width) > 0.5 || Math.abs(r.height - before.height) > 0.5) return { ok: false, why: '準備中麥克風大小變了' } }
    for (const [e, l, w] of place) if (Math.abs(R(e).left - l) > 0.5 || Math.abs(R(e).width - w) > 0.5) return { ok: false, why: '準備中旁邊的元素被擠動了：' + (e.getAttribute('aria-label') || e.className) };
    if ([...main.querySelectorAll('*')].some(e => vis(e) && e.children.length === 0 && e.textContent.includes('準備中'))) return { ok: false, why: '輸入列看得到「準備中」' };
    // 允許麥克風 → 開始聽：正紅
    globalThis.__asnCallEvent && globalThis.__asnCallEvent(JSON.stringify({ t: 'perm', granted: true }));
    await sleep(400);
    if (!mic.classList.contains('rec')) return { ok: false, why: '允許麥克風後沒有進入聆聽中' };
    const label = mic.querySelector('.dict-state');
    if (vis(label) && label.textContent.trim()) return { ok: false, why: '聆聽中還看得到字樣：' + label.textContent.trim() };
    if ([...main.querySelectorAll('*')].some(e => vis(e) && e.children.length === 0 && e.textContent.includes('聆聽中'))) return { ok: false, why: '輸入列看得到「聆聽中」' };
    const after = R(mic);
    if (Math.abs(after.width - before.width) > 0.5 || Math.abs(after.height - before.height) > 0.5) return { ok: false, why: '麥克風大小變了：' + Math.round(before.width) + ' → ' + Math.round(after.width) };
    for (const [e, l, w] of place) if (Math.abs(R(e).left - l) > 0.5 || Math.abs(R(e).width - w) > 0.5) return { ok: false, why: '聆聽中旁邊的元素被擠動了：' + (e.getAttribute('aria-label') || e.className) };
    const red = getComputedStyle(mic).color;
    if (red === color0) return { ok: false, why: '聆聽中麥克風沒有變色：' + red };
    const m = red.slice(red.indexOf('(') + 1, red.indexOf(')')).split(',').map(x => Number(x.trim()));
    if (!(m[0] > 180 && m[1] < 110 && m[2] < 110)) return { ok: false, why: '聆聽中麥克風不是紅色：' + red };
    if (red === pale) return { ok: false, why: '準備中和聆聽中的顏色一樣：' + red };
    return { ok: true, why: '' };
  }
  if (${JSON.stringify(part)} === 'send') {
    // 送出鈕最右、麥克風在它左邊；沒打字時最右邊是麥克風（真點輸入框、真打字）
    if (!vis(mic) || !ta) return { ok: false, why: '找不到麥克風或輸入框' };
    const rightmost = () => [...main.querySelectorAll('button')].filter(vis).sort((a, b) => R(b).right - R(a).right)[0];
    if (vis(send)) return { ok: false, why: '還沒打字就出現送出鈕' };
    if (rightmost() !== mic) return { ok: false, why: '沒打字時最右邊不是麥克風：' + (rightmost().getAttribute('aria-label') || rightmost().className) };
    await real({ click: at(ta) });
    await real({ text: '晚點再看' });
    if (!vis(send)) return { ok: false, why: '打了字送出鈕沒有出現' };
    if (rightmost() !== send) return { ok: false, why: '打字後最右邊不是送出鈕：' + (rightmost().getAttribute('aria-label') || rightmost().className) };
    const gap = R(send).left - R(mic).right;
    if (gap < -0.5 || gap > 12) return { ok: false, why: '麥克風不在送出鈕緊鄰的左邊：間距 ' + Math.round(gap) };
    if (getComputedStyle(send).backgroundColor === 'rgba(0, 0, 0, 0)') return { ok: false, why: '送出鈕不是綠色' };
    return { ok: true, why: '' };
  }
  // 圖片鈕：當成沒有滑鼠游標的手機，真的點一下（攔下選圖、不選檔），點完不能留下灰色圓底
  const ph = pane.querySelector('.compose-main .lc-photo');
  if (!vis(ph)) return { ok: false, why: '找不到輸入列的圖片鈕' };
  await real({ touch: true }, 100);
  globalThis.__smokeChooser = undefined;
  globalThis.__smokeInput(JSON.stringify({ choose: [...at(ph), ''] }));
  for (let i = 0; i < 60 && globalThis.__smokeChooser === undefined; i++) await sleep(100);
  if (!globalThis.__smokeChooser) return { ok: false, why: '點圖片鈕沒有打開選圖' };
  await sleep(200);
  const pbg = getComputedStyle(ph).backgroundColor, noHover = matchMedia('(hover: none)').matches;
  await real({ touch: false }, 100);
  if (!noHover) return { ok: false, why: '沒有切成觸控手機（hover 不是 none），測不到點過之後的樣子' };
  if (pbg !== 'rgba(0, 0, 0, 0)' && pbg !== 'transparent') return { ok: false, why: '點過圖片鈕之後留下灰色圓底：' + pbg };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

export default {
  key: 'lineM',
  kind: 'LINE 手機泡泡與標題列檢查',
  source: probe => lineMProbeSource(probe.lineM),
}
