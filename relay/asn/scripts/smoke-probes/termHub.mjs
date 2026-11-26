// 冒煙探測「終端畫面走事件中心」（probe.termHub，#2038 PR-6）。由 smoke-registry.mjs 自動收集
// 三種：
//  keep  ：電腦版 list 頁、keep 模式，兩個分頁各開一個 TermView，各自拿到不同的 view_id。
//          對兩個 view_id 各送一幅可辨識的 term-view-frame：A 的畫面只有 A 的字、B 的只有 B 的字；
//          底層 Tauri listener（假 Tauri 的 __smokeListeners）實際數出來每種事件都只有 1 個，訂閱者（開著的 TermView）數出來是 2。
//          end 指定探測結束時停在哪個分頁，讓截圖能拍到兩邊各自的畫面。
//  chat  ：分開模式的 chat 視窗（chat.html，頂層 createWindowHub）。開一個 TermView，只對這一頁的假 Tauri 送 frame，畫出來；
//          這一頁每個事件名的底層 listener 都只有 1 個（語音和終端共用同一座 hub，沒有第二座）。
//  other ：另一個視窗（list 頁）開同樣的 TermView 但什麼都沒收到：沒有送 frame、listener 沒被呼叫、畫面是空的。
//          真的 emit_to 只送發起視窗，這裡的「沒送」就等價於「別的視窗收不到」。

// 假後台：兩位夥伴各開一個畫面，編號不同（by name）；沒有 __tvLive，所以不會自己推畫面，全由探測送
export const TERM_HUB_IDS = { demo: 11, demo2: 12, chat: 21 }
const FRAME = 'term-view-frame'

export const termHubProbeSource = ({ kind, end = 'A' }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (fn, n = 60) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const kind = ${JSON.stringify(kind)}, end = ${JSON.stringify(end)}, FRAME = ${JSON.stringify(FRAME)};
  const vis = sel => [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length > 0);
  const rowsOfScreen = s => (s.querySelector('.xterm-rows') || {}).textContent || '';
  const screens = () => [...document.querySelectorAll('.term-view-screen')];
  const lsn = evt => (globalThis.__smokeListeners || {})[evt] || [];
  const opens = () => (globalThis.__smokeCalls || []).filter(c => c[0] === 'term_view_open');
  const closes = () => (globalThis.__smokeCalls || []).filter(c => c[0] === 'term_view_close');
  const push = (evt, payload) => { for (const fn of lsn(evt).slice()) fn({ event: evt, payload }) };
  const frame = (viewId, word) => push(FRAME, { view_id: viewId, seq: 1, text: word + String.fromCharCode(13, 10) + '(' + viewId + ')', meta: { cursor_x: 2, cursor_y: 1, cols: 80, rows: 24 } });
  const counts = () => ['term-view-frame', 'term-view-closed', 'term-view-input-error'].map(e => e + '=' + lsn(e).length).join('，');
  const openTerm = async () => {
    const entry = await wait(() => vis('.chatpane .actionbar button').find(b => (b.getAttribute('aria-label') || b.textContent || '').includes('終端')));
    if (!entry) return false;
    entry.click();
    return true;
  };
  const tabs = () => [...document.querySelectorAll('.ctab')];
  const bad = why => ({ ok: false, why });

  if (kind === 'keep') {
    if (!(await openTerm())) return bad('第一個分頁的按鈕列沒有「終端」');
    if (!(await wait(() => opens().length >= 1 && screens().length >= 1))) return bad('第一個分頁開不起終端');
    if (tabs().length < 2) return bad('分頁不到兩個：' + tabs().length);
    tabs()[1].click();
    await wait(() => vis('.chatpane').length >= 1);
    if (!(await openTerm())) return bad('第二個分頁的按鈕列沒有「終端」');
    if (!(await wait(() => opens().length >= 2 && screens().length >= 2))) return bad('第二個分頁開不起終端：opens=' + opens().length + ' screens=' + screens().length);
    const o = opens().map(c => (c[1] || {}).name);
    if (o[0] !== 'demo' || o[1] !== 'demo2') return bad('兩個畫面的夥伴名不對：' + JSON.stringify(o));
    // 兩個畫面都開著、兩個 view_id 不同；這時底層 listener 還是每種事件各 1 個
    if (lsn(FRAME).length !== 1) return bad('兩個 TermView 同時開著，term-view-frame 底層監聽數應該是 1，實際是 ' + lsn(FRAME).length + '（' + counts() + '）');
    const subs = opens().length - closes().length;
    if (subs !== 2) return bad('訂閱者應該是 2 個開著的畫面，實際 ' + subs);
    // 順序：先 A 後 B，各自一幅；字不同
    frame(11, 'ALPHA-AAAA');
    frame(12, 'BRAVO-BBBB');
    // 目前停在第 2 個分頁（B 看得到）：B 只有 B 的字
    const [sa, sb] = screens();
    if (!(await wait(() => rowsOfScreen(sb).includes('BRAVO-BBBB')))) return bad('B 畫面沒有出現 B 的字：' + JSON.stringify(rowsOfScreen(sb).slice(0, 60)));
    if (rowsOfScreen(sb).includes('ALPHA-AAAA')) return bad('B 畫面出現了 A 的字（view_id 沒有分開）');
    // 切回第 1 個分頁（A 看得到）：A 只有 A 的字
    tabs()[0].click();
    if (!(await wait(() => vis('.term-view-screen').length === 1 && rowsOfScreen(sa).includes('ALPHA-AAAA')))) return bad('A 畫面沒有出現 A 的字：' + JSON.stringify(rowsOfScreen(sa).slice(0, 60)));
    if (rowsOfScreen(sa).includes('BRAVO-BBBB')) return bad('A 畫面出現了 B 的字（view_id 沒有分開）');
    // 沒人認得的 view_id：兩邊都不該動
    frame(99, 'STRAY-ZZZZ');
    await sleep(300);
    if (rowsOfScreen(sa).includes('STRAY') || rowsOfScreen(sb).includes('STRAY')) return bad('別人的 view_id 竟然畫進了畫面');
    if (lsn(FRAME).length !== 1) return bad('送完畫面後 term-view-frame 底層監聽數不是 1：' + lsn(FRAME).length);
    if (end === 'B') { tabs()[1].click(); await wait(() => vis('.term-view-screen').length === 1 && rowsOfScreen(sb).includes('BRAVO-BBBB')) }
    return { ok: true, why: '[smoke] term-view-frame 底層監聽數 = ' + lsn(FRAME).length + '，訂閱者 = ' + subs + '（' + counts() + '）；A 只有 ALPHA、B 只有 BRAVO' };
  }

  if (kind === 'chat') {
    // chat 頁自己收不到名單推送（假 Tauri 不會從 list 視窗送 asn:state），探測自己送一份最小的快照
    const friend = { id: 'P/demo', nick: 'demo', agent: 'demo', node: 'P', status: 'idle', unread: 0, psm: '', cwd_label: 'demo' };
    const snap = { friends: [friend], me: { nick: '我', status: 'online' }, selfNode: 'P', windowName: '', ui: {} };
    if (!(await wait(() => lsn('asn:state').length >= 1))) return bad('chat 頁沒有訂 asn:state');
    push('asn:state', snap);
    if (!(await openTerm())) return bad('chat 頁按鈕列沒有「終端」');
    if (!(await wait(() => opens().length >= 1 && screens().length >= 1))) return bad('chat 頁終端開不起來');
    if (lsn(FRAME).length !== 1) return bad('chat 頁 term-view-frame 底層監聽數應該是 1，實際是 ' + lsn(FRAME).length);
    frame(11, 'CHATWIN-OK');   // chat 頁的夥伴也叫 demo，假後台給的編號同 keep 情境的 A（11）
    const sc = screens()[0];
    if (!(await wait(() => rowsOfScreen(sc).includes('CHATWIN-OK')))) return bad('chat 頁畫面沒有畫出送來的字：' + JSON.stringify(rowsOfScreen(sc).slice(0, 60)));
    // 同一座 hub：每個事件名在這一頁最多 1 個底層 listener（語音若另開一座，又訂同名事件就會 2 個）
    const all = Object.entries(globalThis.__smokeListeners || {}).map(([k, v]) => [k, v.length]);
    const dup = all.filter(([, n]) => n > 1);
    if (dup.length) return bad('chat 頁有事件的底層 listener 超過 1 個：' + JSON.stringify(dup));
    return { ok: true, why: '[smoke] chat 視窗 term-view-frame 底層監聽數 = ' + lsn(FRAME).length + '，訂閱者 = ' + (opens().length - closes().length) + '；全部事件各自 ≤1：' + all.map(([k, n]) => k + '=' + n).join('，') };
  }

  // other：另一個視窗（list 頁）一樣開著終端，但這個視窗沒有收到任何 frame（真的 emit_to 不會送來）
  if (!(await openTerm())) return bad('list 頁按鈕列沒有「終端」');
  if (!(await wait(() => opens().length >= 1 && screens().length >= 1))) return bad('list 頁終端開不起來');
  let got = 0;
  const base = lsn(FRAME).slice();
  const hooked = base.map(fn => { const w = e => { got++; return fn(e) }; return w });
  const L = globalThis.__smokeListeners; L[FRAME] = hooked;
  await sleep(1500);
  const sc = screens()[0];
  if (got !== 0) return bad('這個視窗沒被送任何畫面，底層 listener 卻被呼叫了 ' + got + ' 次');
  if (rowsOfScreen(sc).trim()) return bad('這個視窗沒收到畫面，畫面卻不是空的：' + JSON.stringify(rowsOfScreen(sc).slice(0, 60)));
  if (hooked.length !== 1) return bad('list 頁 term-view-frame 底層監聽數應該是 1，實際是 ' + hooked.length);
  return { ok: true, why: '[smoke] 另一個視窗 term-view-frame 底層監聽數 = ' + hooked.length + '，收到次數 = ' + got + '，畫面是空的（等價 emit_to 只送發起視窗）' };
})()`

export default {
  key: 'termHub',
  kind: '終端畫面走事件中心檢查',
  source: probe => termHubProbeSource(probe.termHub),
  table: scenario => (scenario.probe?.termHub ? {
    // 不要自己推畫面（拿掉 __tvLive）；兩位夥伴各一個編號
    __tvLive: undefined,
    term_view_open: { by: 'name', values: { demo: TERM_HUB_IDS.demo, demo2: TERM_HUB_IDS.demo2 }, fallback: TERM_HUB_IDS.chat },
  } : undefined),
  scenarios: [
    { name: 'list-term-hub-keep', page: 'list.html', state: { signedIn: true, dtermLocal: true }, ready: '#app.win .chatpane .actionbar', probe: { termHub: { kind: 'keep', end: 'A' } }, shot: 'list-term-hub-keep-a.png' },
    { name: 'list-term-hub-keep-b', page: 'list.html', state: { signedIn: true, dtermLocal: true }, ready: '#app.win .chatpane .actionbar', probe: { termHub: { kind: 'keep', end: 'B' } }, shot: 'list-term-hub-keep-b.png' },
    { name: 'chat-term-hub', page: 'chat.html?id=P%2Fdemo', state: { signedIn: true, dtermLocal: true }, ready: '#app.win', probe: { termHub: { kind: 'chat' } }, shot: 'chat-term-hub.png' },
    { name: 'list-term-hub-other-window', page: 'list.html', state: { signedIn: true, dtermLocal: true }, ready: '#app.win .chatpane .actionbar', probe: { termHub: { kind: 'other' } }, shot: 'list-term-hub-other.png' },
  ],
}
