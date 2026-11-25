// 冒煙探測「對話視窗最小寬度 500 不跑版」（probe.chatMinWidth，#2303）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
//
// Windows 11 的貼齊分割版面規定視窗最小寬度要 ≤ 500 有效像素，所以獨立對話視窗（chat.html）的最小寬度降到 500（wins.rs 的 CHAT_MIN_W）。
// 這裡把視窗開成剛好 500 寬，三套外觀（Aero／現代／LINE）各檢查：
//   ① 頁面沒有橫向捲軸：document.documentElement.scrollWidth <= innerWidth
//   ② 標題列（Aero 的 .titlebar、現代／LINE 的 .mbar）、Aero 的按鈕列、輸入列：每個重要元素都在視窗內、同一排的彼此不重疊
//   ③ 名牌的字不被截掉（夥伴名字很短，不該出現省略號）、訊息區與輸入列不溢出
//   ④ 有終端的夥伴（term:true）：再按一次「終端」切過去，終端畫面、切回對話的鈕、打字框也照樣檢查一遍
// 參數：{ skin: 'line'|'modern'|'aero', term: boolean, paint? }。

export const chatMinWidthProbeSource = p => `(async () => {
  try {
  const P = ${JSON.stringify(p)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const R = e => e.getBoundingClientRect();
  const at = el => { const r = R(el); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const label = e => (e.getAttribute('aria-label') || e.title || e.textContent || '').trim().slice(0, 12) || (e.tagName + '.' + e.className);
  const W = innerWidth, H = innerHeight;
  if (W !== 500) return { ok: false, why: '視窗寬度不是 500：' + W };

  document.documentElement.setAttribute('data-skin', P.skin);
  await sleep(600);
  const snap = { friends: [{ id: 'P/demo', nick: 'demo', status: 'online', hue: 205, psm: '', kind: 'claude', node: 'P', online: true }], me: { nick: '測試機', status: 'online', psm: '' }, ui: {}, selfNode: 'P', windowName: '測試機' };
  for (const fn of ((globalThis.__smokeListeners || {})['asn:state'] || [])) fn({ event: 'asn:state', payload: snap });
  await sleep(800);

  const problems = [];
  const inside = (el, what) => {
    const r = R(el);
    if (r.left < -0.5 || r.right > W + 0.5 || r.top < -0.5 || r.bottom > H + 0.5) problems.push(what + '「' + label(el) + '」超出視窗：' + Math.round(r.left) + '～' + Math.round(r.right) + ' × ' + Math.round(r.top) + '～' + Math.round(r.bottom) + '（視窗 ' + W + '×' + H + '）');
  };
  const within = (el, box, what) => {
    const r = R(el), b = R(box);
    if (r.left < b.left - 0.5 || r.right > b.right + 0.5) problems.push(what + '「' + label(el) + '」超出它的容器：' + Math.round(r.left) + '～' + Math.round(r.right) + '／容器 ' + Math.round(b.left) + '～' + Math.round(b.right));
  };
  const noOverlap = (els, what) => {
    const rs = els.filter(vis).map(e => [e, R(e)]).filter(([, r]) => r.width > 0 && r.height > 0);
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i][1], b = rs[j][1];
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 1 && oy > 1) problems.push(what + '的「' + label(rs[i][0]) + '」和「' + label(rs[j][0]) + '」重疊了（' + Math.round(ox) + '×' + Math.round(oy) + ' px）');
    }
  };
  const noHScroll = (el, what) => { if (el.scrollWidth > el.clientWidth + 1) problems.push(what + '有橫向溢出：內容 ' + el.scrollWidth + '／可視 ' + el.clientWidth) };
  const kids = el => [...el.children].filter(vis);

  const check = async tag => {
    problems.length = 0;
    const doc = document.documentElement;
    if (doc.scrollWidth > innerWidth) problems.push('頁面出現橫向捲軸：scrollWidth ' + doc.scrollWidth + ' > ' + innerWidth);
    if (document.body.scrollWidth > innerWidth) problems.push('body 出現橫向捲軸：' + document.body.scrollWidth + ' > ' + innerWidth);

    {
      const tb = document.querySelector('.titlebar');
      if (!vis(tb)) problems.push('沒有視窗標題列 .titlebar');
      else { noOverlap(kids(tb).flatMap(e => e.classList.contains('t-btns') ? kids(e) : [e]), '視窗標題列'); for (const e of kids(tb)) inside(e, '視窗標題列的') }
    }
    const bar = document.querySelector('.mbar');
    if (P.skin !== 'aero') {
      if (!vis(bar)) problems.push('沒有對話標題列 .mbar');
      else {
        noOverlap(kids(bar).flatMap(e => e.classList.contains('mbar-acts') ? [e, ...kids(e)] : [e]).filter((e, _, all) => !(e.classList.contains('mbar-acts') && all.some(x => x !== e && e.contains(x)))), '對話標題列');
        for (const e of kids(bar)) { inside(e, '標題列的'); within(e, bar, '標題列的') }
        for (const e of bar.querySelectorAll('.mbar-acts > *, .mbar-more .mbtn, .mbar-offline .mbtn, .mbar-back')) if (vis(e)) { inside(e, '標題列按鈕'); within(e, bar, '標題列按鈕') }
        const plate = bar.querySelector('.mbar-plate');
        if (plate && vis(plate)) {
          noOverlap([plate, ...[...bar.querySelectorAll('.mbar-acts > *, .mbar-more, .mbar-offline, .mbar-back')].filter(e => !e.contains(plate))], '名牌與按鈕');
          for (const n of plate.querySelectorAll('.mbar-name, .mbar-sub')) if (vis(n)) { if (n.scrollWidth > n.clientWidth + 1) problems.push('名牌的字被截掉：「' + n.textContent.trim() + '」內容 ' + n.scrollWidth + '／可視 ' + n.clientWidth); within(n, plate, '名牌內的字') }
        }
      }
    }
    const ab = document.querySelector('.actionbar');
    if (vis(ab)) {
      noOverlap(kids(ab), '按鈕列');
      for (const e of kids(ab)) { inside(e, '按鈕列的'); within(e, ab, '按鈕列的') }
      noHScroll(ab, '按鈕列');
    }
    const tabs = document.querySelector('.tabbar');
    if (vis(tabs)) { noOverlap(kids(tabs), '分頁列'); for (const e of kids(tabs)) inside(e, '分頁列的'); noHScroll(tabs, '分頁列') }
    const msgs = document.querySelector('.msgs');
    if (vis(msgs)) { inside(msgs, '訊息區'); noHScroll(msgs, '訊息區') }
    const row = document.querySelector('.compose-row');
    if (!vis(row)) problems.push('找不到輸入列 .compose-row');
    else {
      inside(row, '輸入列'); noHScroll(row, '輸入列');
      const ctl = [...row.querySelectorAll('button, textarea, input, [contenteditable]')].filter(vis);
      for (const e of ctl) { inside(e, '輸入列的'); within(e, row, '輸入列的') }
      noOverlap(ctl, '輸入列');
      const box = row.querySelector('textarea, input[type=text], [contenteditable]');
      if (!box || !vis(box)) problems.push('輸入列找不到打字框');
      else if (R(box).width < 120) problems.push('打字框太窄：' + Math.round(R(box).width) + ' px（要 ≥ 120）');
    }
    return problems.length ? tag + '：' + problems.join('；') : '';
  };

  let bad = await check('對話畫面');
  if (bad) return { ok: false, why: bad };
  const notes = ['對話畫面'];

  if (P.term) {
    const entry = [...document.querySelectorAll('.chatpane button')].find(b => vis(b) && [b.getAttribute('aria-label'), b.title, b.textContent].some(s => (s || '').includes('終端')));
    if (!entry) return { ok: false, why: '找不到切到終端的鈕' };
    inside(entry, '切終端的鈕');
    if (problems.length) return { ok: false, why: problems.join('；') };
    globalThis.__smokeInput(JSON.stringify({ click: at(entry) }));
    await sleep(1200);
    if (!document.querySelector('.term-view-screen')) return { ok: false, why: '按了「終端」沒有進到終端畫面' };
    bad = await check('終端畫面');
    if (bad) return { ok: false, why: bad };
    const screen = document.querySelector('.term-view-screen');
    if (R(screen).width < 300) return { ok: false, why: '終端畫面太窄：' + Math.round(R(screen).width) };
    notes.push('終端畫面');
  }

  if (P.paint) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    c.style.cssText = 'position:fixed;left:0;top:0;width:' + W + 'px;height:' + H + 'px;z-index:99999;pointer-events:none';
    const g = c.getContext('2d');
    g.strokeStyle = 'rgba(230,30,30,.7)';
    for (const e of document.querySelectorAll('.mbar > *, .mbar-acts > *, .actionbar > *, .compose-row button, .compose-row textarea, .titlebar > *')) if (vis(e)) { const r = R(e); g.strokeRect(r.left + .5, r.top + .5, r.width - 1, r.height - 1) }
    document.body.appendChild(c);
  }
  return { ok: true, why: notes.join('、') + ' 在 500 寬都沒跑版' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const make = (skin, term, extra = {}) => ({
  name: `chat500-${skin}${term ? '-term' : ''}`,
  page: 'chat.html?id=P%2Fdemo', width: 500, height: 640, dpr: 1,
  state: { signedIn: true, bar: 'offline', chatMsgs: true, lineMsgs: true, ...(term ? { dtermLocal: true } : {}), skin },
  ready: '#app.win',
  probe: { chatMinWidth: { skin, term, ...extra } },
  ...(process.env.ASN_CHAT500_SHOTS ? { shot: `chat500-${skin}${term ? '-term' : ''}.png` } : {}),
})

export default {
  key: 'chatMinWidth',
  kind: '對話視窗最小寬度檢查',
  source: probe => chatMinWidthProbeSource(probe.chatMinWidth),
  scenarios: ['aero', 'modern', 'line'].flatMap(skin => [make(skin, false, { paint: !!process.env.ASN_CHAT500_SHOTS }), make(skin, true)]),
}
