// 冒煙探測「結果提示」（probe.resultToast，#2425 PR-3）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 不走真的右鍵、長按，直接把五處真實會出現的那句結果字推出來，截圖看位置與字級：
//   - 新版：呼叫共用的 showResult(kind, text)，畫面上要有 .asn-toast，種類與字都對
//   - 舊版（改前基準用，沒有 showResult）：把當時那個提示的 ref 直接設上值，讓舊樣子出現
//       電腦封存 → 名單的 archiveNote；電腦釘選滿 → pinNote；對話視窗功能列 → ActionBar 的 archiveNote；
//       手機封存 → m.js 的 archiveNote；手機釘選滿 → m.js 的 toast（舊的 m-toast）
// 字句都是 archive.mjs／chat-pins.mjs 真的會回的那幾句（改字要一起改）。

const ARCHIVED = '已封存，這位夥伴不會再出現在名單上；它再寄信來或重新上線就會自動回來。'
const PIN_FULL = '最多只能釘選 50 個對話，請先取消一些再釘選。'

// old.set＝舊的 ref 名稱；old.has＝認那個元件用的另一個名稱（setup 回傳裡一定有），避免設到名字相同的別的元件
const CASES = {
  'desk-archive': { kind: 'ok', text: ARCHIVED, at: 'list', old: { set: 'archiveNote', has: 'envNotice' }, sel: '.archive-note' },
  'desk-pin-full': { kind: 'fail', text: PIN_FULL, at: 'list', old: { set: 'pinNote', has: 'isChatPinned', tab: '對話' }, sel: '.pin-note' },
  'chat-archive': { kind: 'ok', text: ARCHIVED, at: 'chat', old: { set: 'archiveNote', has: 'pickOps' }, sel: '.ab-note' },
  // 二審補的情境（改前沒有對應畫面，只在新版量）：整合模式兩個對話分頁、目前在第二個；對話區改看終端（含貼上確認列、打字中的狀態列）
  'chat-two': { kind: 'ok', text: ARCHIVED, at: 'chat', prelude: 'two', inside: '.msgs', edge: 'bottom' },
  'term-watch': { kind: 'ok', text: ARCHIVED, at: 'chat', prelude: 'watch', inside: '.term-view-screen', edge: 'top' },
  'term-paste': { kind: 'ok', text: ARCHIVED, at: 'chat', prelude: 'paste', inside: '.term-view-screen', edge: 'top' },
  'term-typing': { kind: 'ok', text: ARCHIVED, at: 'chat', prelude: 'typing', inside: '.term-view-screen', edge: 'top' },
  // #2452：終端「已結束觀看」——整塊終端區（.term-view）當對話錨點，貼下緣；它在輸入區上面，「重新看」在最下面的狀態列，所以不蓋到
  'term-ended': { kind: 'ok', text: ARCHIVED, at: 'chat', prelude: 'ended', inside: '.term-view', edge: 'bottom' },
  'phone-archive': { kind: 'ok', text: ARCHIVED, old: { set: 'archiveNote', has: 'setArchived' }, sel: '.m-archive-note' },
  'phone-pin-full': { kind: 'fail', text: PIN_FULL, old: { set: 'toast', has: 'leaveAsk' }, sel: '.m-toast' },
}

export const resultToastProbeSource = mode => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const c = ${JSON.stringify(CASES[mode])};
  if (!c) return { ok: false, why: '不認得的情境 ${mode}' };
  let kit = null;
  try { kit = await import(new URL('./lib/ui-kit.mjs', document.baseURI).href) } catch (e) { kit = null }
  const wait = async (fn, n = 80) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const visAll = sel => [...document.querySelectorAll(sel)].filter(vis);
  const NL = String.fromCharCode(10);
  if (kit && typeof kit.showResult === 'function') {
    // 先把畫面弄到該情境要的狀態（二審補的情境：整合模式兩個對話分頁、對話區改看終端、終端上有貼上確認列／打字中的狀態列）
    if (c.prelude === 'two') {
      const tabs = await wait(() => { const t = [...document.querySelectorAll('.ctab')]; return t.length >= 2 ? t : null });
      if (!tabs) return { ok: false, why: '整合模式的對話分頁不到兩個' };
      tabs[1].click();
      await sleep(600);
      const ms = [...document.querySelectorAll('.msgs')];
      if (ms.length < 2) return { ok: false, why: '兩個分頁的訊息區沒有各一個（只有 ' + ms.length + ' 個），測不到「第一個藏起來」' };
      if (vis(ms[0]) || !vis(ms[1])) return { ok: false, why: '目前要在第二個分頁：第一個訊息區該藏起來、第二個該看得到' };
    } else if (c.prelude === 'ended') {
      // #2452：看完終端畫面 → 切到另一個分頁、超過寬限 → 切回來，停在「已結束觀看」（畫面本體藏起來，訊息區也藏著；「重新看」在視窗最下面的狀態列）。寬限（5 分鐘）縮成 0.4 秒，只換掉這個長度的計時
      const real = globalThis.setTimeout;
      globalThis.setTimeout = (fn, ms, ...a) => real(fn, ms === 300000 ? 400 : ms, ...a);
      const entry = await wait(() => visAll('.chatpane .actionbar button').find(b => (b.getAttribute('aria-label') || b.textContent || '').includes('終端')));
      if (!entry) return { ok: false, why: '按鈕列沒有「終端」' };
      entry.click();
      if (!(await wait(() => (visAll('.term-view-screen .xterm-rows')[0] || {}).textContent?.includes('測試通過')))) return { ok: false, why: '終端畫面沒有出現假畫面的字' };
      const tabs = [...document.querySelectorAll('.ctab')];
      if (tabs.length < 2) return { ok: false, why: '分頁不到兩個' };
      tabs[1].click();
      if (!(await wait(() => visAll('.term-view-screen').length === 0))) return { ok: false, why: '切到第二個分頁後，第一個分頁的終端還看得到' };
      await sleep(1500);
      tabs[0].click();
      const bar = () => (visAll('.chatpane .typing')[0] || {}).textContent || '';
      if (!(await wait(() => bar().includes('已結束觀看')))) return { ok: false, why: '切回來狀態列沒有「已結束觀看」：' + bar().slice(0, 60) };
      if (visAll('.msgs').length || visAll('.term-view-screen').length) return { ok: false, why: '已結束時訊息區與終端畫面都該藏著（這個情境要測的狀態）' };
      if (!visAll('.chatpane .typing button').some(b => b.textContent.trim() === '重新看')) return { ok: false, why: '狀態列沒有「重新看」' };
    } else if (c.prelude) {
      const entry = await wait(() => visAll('.chatpane .actionbar button').find(b => (b.getAttribute('aria-label') || b.textContent || '').includes('終端')));
      if (!entry) return { ok: false, why: '按鈕列沒有「終端」' };
      entry.click();
      if (!(await wait(() => (visAll('.term-view-screen .xterm-rows')[0] || {}).textContent?.includes('測試通過')))) return { ok: false, why: '終端畫面沒有出現假畫面的字' };
      if (c.prelude === 'paste' || c.prelude === 'typing') {
        const ta = visAll('.chatpane .compose-row textarea')[0];
        const go = ta && ta.closest('form').querySelector('button[type=submit]');
        if (!ta || !go) return { ok: false, why: '找不到下方的輸入框或送出鈕' };
        ta.value = c.prelude === 'paste' ? 'echo a' + NL + 'echo b' : 'ls';
        ta.dispatchEvent(new Event('input'));
        await sleep(50);
        go.click();
        if (c.prelude === 'paste' && !(await wait(() => visAll('.term-remote-input .term-view-ask button').length >= 2))) return { ok: false, why: '多行沒有先出現貼上確認列' };
        if (c.prelude === 'typing' && !(await wait(() => (visAll('.chatpane .typing')[0] || {}).textContent?.includes('打字：')))) return { ok: false, why: '送出後沒有出現打字中的狀態列' };
      }
    }
    kit.showResult(c.kind, c.text, c.at ? { at: c.at } : undefined);
    await sleep(300);
    const t = document.querySelector('.asn-toast');
    if (!vis(t)) return { ok: false, why: '沒有出現結果提示' };
    if (!t.classList.contains('k-' + c.kind)) return { ok: false, why: '種類不對：' + t.className };
    if ((t.querySelector('.asn-toast-text')?.textContent || '') !== c.text) return { ok: false, why: '字不對' };
    // 電腦版（asn真 二審原則）：提示不准蓋住控制項——按鈕、輸入框、下拉選單、分頁、功能列、搜尋框、輸入區；訊息、名單列這類內容列可以短暫被蓋。手機維持底部，不在這裡量
    if (c.at) {
      const tr = t.getBoundingClientRect();
      const hit = r => r.width > 0 && r.height > 0 && r.left < tr.right && r.right > tr.left && r.top < tr.bottom && r.bottom > tr.top;
      const bad = [];
      // 只檢查「控制項」（畫面規範〈四之一〉D：按鈕、輸入框、下拉選單、分頁、功能列、搜尋框）；訊息、名單列這類內容列可以短暫被蓋，不在檢查範圍
      // 終端類畫面再加：打字中的狀態列、貼上確認列、游標所在的那一格（xterm 的 DOM 繪製才有 .xterm-cursor；用畫布畫的量不到，只靠「貼在畫面上緣」的設計）
      const sel = 'button, input, textarea, select, a[href], [role="tab"], [role="button"], .actionbar, .top-tabs, .tabbar, .compose-row, .composer, .search, .typing, .term-remote-bar, .term-view-ask, .xterm-cursor';
      for (const e of document.querySelectorAll(sel)) {
        if (t.contains(e) || !vis(e)) continue;
        if (hit(e.getBoundingClientRect())) bad.push((e.className && String(e.className).split(' ')[0]) || e.tagName.toLowerCase());
      }
      if (bad.length) return { ok: false, why: '提示蓋到了控制項：' + [...new Set(bad)].join('、') };
      // 位置要在指定的錨點裡：訊息區（貼下緣）、終端畫面（貼上緣）；選錯錨點（例如藏起來的那個）會落在別處
      if (c.inside) {
        const box = visAll(c.inside)[0];
        if (!box) return { ok: false, why: '找不到看得到的 ' + c.inside };
        const b = box.getBoundingClientRect();
        if (tr.left < b.left - 1 || tr.right > b.right + 1) return { ok: false, why: '提示的左右跑出 ' + c.inside + '：提示 ' + Math.round(tr.left) + '～' + Math.round(tr.right) + '，錨點 ' + Math.round(b.left) + '～' + Math.round(b.right) };
        if (c.edge === 'top' ? (tr.top < b.top - 1 || tr.top > b.top + 40) : (tr.bottom > b.bottom + 1 || tr.bottom < b.bottom - 40)) return { ok: false, why: '提示沒有貼在 ' + c.inside + (c.edge === 'top' ? ' 的上緣' : ' 的下緣') + '：提示 ' + Math.round(tr.top) + '～' + Math.round(tr.bottom) + '，錨點 ' + Math.round(b.top) + '～' + Math.round(b.bottom) };
      }
    }
    return { ok: true, why: '' };
  }
  // 舊版：把舊的 ref 設上值（二審補的情境改前沒有對應畫面，不比）
  if (!c.old) return { ok: true, why: '' };
  // 正式版沒有 __vueParentComponent：從容器的根 vnode 往下走，找 setup 回傳裡同時有 set 與 has 的那個元件
  const find = (vn, depth) => {
    if (!vn || depth > 60) return null;
    const comp = vn.component;
    if (comp) {
      const st = comp.setupState;
      if (st && c.old.set in st && c.old.has in st) return comp;
      const r = find(comp.subTree, depth + 1);
      if (r) return r;
    }
    if (Array.isArray(vn.children)) for (const ch of vn.children) { const r = find(ch, depth + 1); if (r) return r }
    return null;
  };
  const root = document.querySelector('#app')?._vnode;
  if (!root) return { ok: false, why: '找不到 Vue 根' };
  const target = find(root, 0);
  if (!target) return { ok: false, why: '找不到有 ' + c.old.set + ' 的元件' };
  if (c.old.tab) {   // 舊的 pin-note 只在「對話」分頁的名單上方
    const t = [...document.querySelectorAll('.top-tabs .ttab')].find(e => (e.textContent || '').trim() === c.old.tab);
    if (t) { t.click(); await sleep(300) }
  }
  target.setupState[c.old.set] = c.text;
  await sleep(250);
  const old = [...document.querySelectorAll(c.sel)].find(vis);
  return old ? { ok: true, why: '' } : { ok: false, why: '舊的提示沒有出現：' + c.sel };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const deskBar = (name, mode) => ({ name, page: 'list.html', width: 900, height: 640, state: { signedIn: true, bar: 'claude' }, ready: '#app.win .actionbar', probe: { resultToast: mode }, shot: `${name}.png` })
const deskTerm = (name, mode, width, tabs) => ({ name, page: 'list.html', width, height: 640, state: { signedIn: true, dterm: true, ...(tabs ? { dtermTabs: true } : {}) }, ready: '#app.win .chatpane .actionbar', probe: { resultToast: mode }, shot: `${name}.png` })
const phone = (name, mode) => ({ name, page: 'm.html', state: { signedIn: true, munread: true, mtab: 'list' }, ready: '#app.m .m-unread', probe: { resultToast: mode }, shot: `${name}.png` })

export default {
  key: 'resultToast',
  kind: '結果提示檢查',
  source: probe => resultToastProbeSource(probe.resultToast),
  scenarios: [
    deskBar('list-result-archive', 'desk-archive'), deskBar('list-result-pin-full', 'desk-pin-full'), deskBar('list-result-chat-archive', 'chat-archive'),
    phone('m-result-archive', 'phone-archive'), phone('m-result-pin-full', 'phone-pin-full'),
    deskTerm('list-result-chat-two', 'chat-two', 900, true), deskTerm('list-result-chat-two-narrow', 'chat-two', 500, true),
    deskTerm('list-result-term-ended-narrow', 'term-ended', 500, true), deskTerm('list-result-term-ended', 'term-ended', 900, true),
    deskTerm('list-result-term-watch', 'term-watch', 900), deskTerm('list-result-term-paste', 'term-paste', 900), deskTerm('list-result-term-typing', 'term-typing', 900),
  ],
}
