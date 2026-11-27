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
  if (kit && typeof kit.showResult === 'function') {
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
      const sel = 'button, input, textarea, select, a[href], [role="tab"], [role="button"], .actionbar, .top-tabs, .tabbar, .compose-row, .composer, .search';
      for (const e of document.querySelectorAll(sel)) {
        if (t.contains(e) || !vis(e)) continue;
        if (hit(e.getBoundingClientRect())) bad.push((e.className && String(e.className).split(' ')[0]) || e.tagName.toLowerCase());
      }
      if (bad.length) return { ok: false, why: '提示蓋到了控制項：' + [...new Set(bad)].join('、') };
    }
    return { ok: true, why: '' };
  }
  // 舊版：把舊的 ref 設上值
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
const phone = (name, mode) => ({ name, page: 'm.html', state: { signedIn: true, munread: true, mtab: 'list' }, ready: '#app.m .m-unread', probe: { resultToast: mode }, shot: `${name}.png` })

export default {
  key: 'resultToast',
  kind: '結果提示檢查',
  source: probe => resultToastProbeSource(probe.resultToast),
  scenarios: [
    deskBar('list-result-archive', 'desk-archive'), deskBar('list-result-pin-full', 'desk-pin-full'), deskBar('list-result-chat-archive', 'chat-archive'),
    phone('m-result-archive', 'phone-archive'), phone('m-result-pin-full', 'phone-pin-full'),
  ],
}
