// 電腦版看別台電腦夥伴的終端：狀態文字在視窗最下面的狀態列（不在終端上方），黑色畫面和下面的訊息框等寬、四周留同一組間距。
// 探測在頁面裡執行；這個檔案只產生探測原始碼，字串裡不寫反斜線。
// kind：'watch'＝只能看；'typing'＝再按「打字」進到可以打字（狀態列要用醒目的紅色警示）
import { TERM_GRACE_MS } from '../ui/lib/term-grace.mjs'
export const DTERM_PROBES = {
  watch: { dterm: { kind: 'watch' } },
  typing: { dterm: { kind: 'typing' } },
}
export const DTERM_NODE = 'Q'
export const DTERM_MEMBERS = [{ id: DTERM_NODE, name: '辦公室', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }] }]
export const DTERM_ME = { winMode: 'merged', session: { v: 1, tabs: [{ id: DTERM_NODE + '/demo' }], active: { id: DTERM_NODE + '/demo' }, panel: { guide: '', setting: '' }, windows: [], panelWindows: [] } }

export const dtermProbeSource = ({ kind }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (fn, n = 80) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const kind = ${JSON.stringify(kind)};
  const entry = await wait(() => [...document.querySelectorAll('.actionbar button')].find(b => (b.getAttribute('aria-label') || b.textContent || '').includes('終端')));
  if (!entry) return { ok: false, why: '按鈕列沒有「終端」' };
  entry.click();
  const rowsOf = () => document.querySelector('.term-view-screen .xterm-rows')?.textContent || '';
  if (!(await wait(() => rowsOf().includes('測試通過')))) return { ok: false, why: '終端畫面沒有出現假畫面的字：' + rowsOf().slice(0, 40) };
  if (kind === 'typing') {
    const sw = await wait(() => document.querySelector('.term-remote-switch button'));
    if (!sw) return { ok: false, why: '終端上方的「打字」按鈕不見了' };
    sw.click();
    if (!(await wait(() => document.querySelector('.typing')?.textContent.includes('打字：')))) return { ok: false, why: '按「打字」後狀態列沒出現打字中：' + (document.querySelector('.typing')?.textContent || '').slice(0, 60) };
    if (!(await wait(() => rowsOf().includes('測試通過')))) return { ok: false, why: '打字的終端畫面沒有出現假畫面的字' };
    // 同時有語音提示：按麥克風（假的語音引擎已就緒、瀏覽器沒有麥克風，會留下一句提示）。打字中的警示與「結束打字」不能被語音提示蓋掉
    const mic = document.querySelector('.chatpane .compose-row .tool.mic');
    if (!mic) return { ok: false, why: '找不到麥克風按鈕' };
    mic.click();
    const extra = await wait(() => document.querySelector('.chatpane .typing .typing-extra'), 60);
    if (!extra) return { ok: false, why: '按麥克風後狀態列沒有語音提示（要和打字中並列）：' + (document.querySelector('.typing')?.textContent || '').slice(0, 60) };
  } else if (!(await wait(() => document.querySelector('.typing')?.textContent.includes('正在看')))) {
    return { ok: false, why: '狀態列沒有「正在看」：' + (document.querySelector('.typing')?.textContent || '（沒有狀態列）').slice(0, 60) };
  }
  await sleep(400);
  const bar = document.querySelector('.chatpane .typing');
  const screen = document.querySelector('.term-view-screen');
  const view = screen.closest('.term-view');
  const msgBox = document.querySelector('.chatpane .compose-row .compose-main');
  const pane = document.querySelector('.chatpane-main');
  if (!bar || !msgBox || !pane) return { ok: false, why: '找不到狀態列、訊息框或對話區' };
  // (a) 終端上方沒有「正在看／正在打字」那一條
  if (document.querySelector('.term-remote-bar') || document.querySelector('.term-remote-typing')) return { ok: false, why: '終端上方還有狀態那一條（term-remote-bar）' };
  const above = [...view.querySelectorAll('p')].find(p => /正在看|正在「/.test(p.textContent));
  if (above) return { ok: false, why: '終端區裡還有狀態文字：' + above.textContent.slice(0, 40) };
  // (b) 狀態列的文字（在視窗最下面，在訊息框的下方）
  const text = bar.textContent.trim();
  if (bar.getBoundingClientRect().top < msgBox.getBoundingClientRect().bottom - 1) return { ok: false, why: '狀態列沒有在訊息框下面' };
  if (kind === 'watch' && !/正在看「.+」上「.+」的畫面/.test(text)) return { ok: false, why: '狀態列沒有「正在看「…」上「…」的畫面」：' + text.slice(0, 60) };
  if (kind === 'typing') {
    if (!/正在「.+」上「.+」打字/.test(text)) return { ok: false, why: '狀態列沒有打字中的文字：' + text.slice(0, 60) };
    if (!bar.classList.contains('typing-danger')) return { ok: false, why: '打字中的狀態列沒有醒目樣式（typing-danger）：' + bar.className };
    const cs = getComputedStyle(bar);
    if (cs.backgroundColor !== 'rgb(122, 13, 13)' || cs.color !== 'rgb(255, 255, 255)') return { ok: false, why: '打字中的狀態列不是深紅底白字：' + cs.backgroundColor + ' / ' + cs.color };
    if (![...bar.querySelectorAll('button')].some(b => b.textContent.includes('結束打字'))) return { ok: false, why: '打字中的狀態列沒有「結束打字」' };
  }
  // 窄視窗也不能把狀態文字截掉
  if (bar.scrollWidth > bar.clientWidth + 1) return { ok: false, why: '狀態列的文字被截掉：' + bar.scrollWidth + ' > ' + bar.clientWidth };
  // (c) 黑色畫面的左右和訊息框對齊，四周的間距都一樣（上＝和上一個元件、下＝和訊息框、左右＝和對話區邊緣）
  const S = screen.getBoundingClientRect(), M = msgBox.getBoundingClientRect(), P = pane.getBoundingClientRect();
  const prevEl = view.previousElementSibling;
  const prevBottom = prevEl ? prevEl.getBoundingClientRect().bottom : P.top;
  if (Math.abs(S.left - M.left) > 1 || Math.abs(S.right - M.right) > 1) return { ok: false, why: '黑色畫面和訊息框沒有左右對齊：畫面 ' + [S.left, S.right].map(Math.round).join('~') + '、訊息框 ' + [M.left, M.right].map(Math.round).join('~') };
  const side = S.left - P.left, top = S.top - prevBottom, bottom = M.top - S.bottom;
  const gaps = '左 ' + side.toFixed(1) + '、上 ' + top.toFixed(1) + '、下 ' + bottom.toFixed(1) + '、右 ' + (P.right - S.right).toFixed(1);
  if (!(side > 0 && top > 0 && bottom > 0 && P.right - S.right > 0)) return { ok: false, why: '黑色畫面四周沒有間距：' + gaps };
  if (Math.abs(top - side) > 1 || Math.abs(bottom - side) > 1 || Math.abs((P.right - S.right) - side) > 1) return { ok: false, why: '黑色畫面四周的間距不一致（要和訊息框一樣）：' + gaps };
  // (d) 沒有橫向溢出
  if (document.documentElement.scrollWidth > window.innerWidth + 1 || document.body.scrollWidth > window.innerWidth + 1) return { ok: false, why: '整頁橫向溢出：' + document.documentElement.scrollWidth + ' > ' + window.innerWidth };
  if (pane.scrollWidth > pane.clientWidth + 1 || view.scrollWidth > view.clientWidth + 1) return { ok: false, why: '對話區橫向溢出：對話區 ' + pane.scrollWidth + '/' + pane.clientWidth + '、終端區 ' + view.scrollWidth + '/' + view.clientWidth };
  // (e) 終端上方的「打字」按鈕還在（只能看時是唯一的遠端打字入口；打字中則已經換成狀態列）
  if (kind === 'watch') {
    const sw = document.querySelector('.term-remote-switch button');
    if (!sw || sw.textContent.trim() !== '打字') return { ok: false, why: '終端上方的「打字」按鈕不見了' };
  }
  return { ok: true, why: '' };
})()`

// ---- 切分頁再切回來（電腦版）：終端要還在、有內容、不重新請求同意；離開超過寬限要在到期當下結束；打字要馬上結束 ----
export const DTERM_MEMBERS2 = [{ id: DTERM_NODE, name: '辦公室', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }, { name: 'demo2', status: 'idle', cwd_label: 'demo2' }] }]
export const DTERM_ME2 = { winMode: 'merged', session: { v: 1, tabs: [{ id: DTERM_NODE + '/demo' }, { id: DTERM_NODE + '/demo2' }], active: { id: DTERM_NODE + '/demo' }, panel: { guide: '', setting: '' }, windows: [], panelWindows: [] } }
// switchback：開終端 → 切到第二個分頁 → 切回；expired：離開超過寬限；typeaway：打字中離開
export const DTERM_TAB_PROBES = {
  switchback: { dtermTab: { kind: 'switchback' } },
  expired: { dtermTab: { kind: 'expired' } },
  typeaway: { dtermTab: { kind: 'typeaway' } },
}

export const dtermTabProbeSource = ({ kind }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (fn, n = 60) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const kind = ${JSON.stringify(kind)};
  // 寬限（${TERM_GRACE_MS} 毫秒）在探測裡縮短：只換掉這個長度的計時，其他計時照舊
  if (kind === 'expired') { const real = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...a) => real(fn, ms === ${TERM_GRACE_MS} ? 400 : ms, ...a) }
  const calls = name => (globalThis.__smokeCalls || []).filter(c => c[0] === name).length;
  const vis = sel => [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length > 0);
  const rowsOf = () => (vis('.term-view-screen .xterm-rows')[0] || {}).textContent || '';
  const barOf = () => (vis('.chatpane .typing')[0] || {}).textContent || '';
  const tabs = () => [...document.querySelectorAll('.ctab')];
  const entry = await wait(() => vis('.chatpane .actionbar button').find(b => (b.getAttribute('aria-label') || b.textContent || '').includes('終端')));
  if (!entry) return { ok: false, why: '按鈕列沒有「終端」' };
  entry.click();
  if (!(await wait(() => rowsOf().includes('測試通過')))) return { ok: false, why: '終端畫面沒有出現假畫面的字：' + rowsOf().slice(0, 40) };
  if (tabs().length < 2) return { ok: false, why: '分頁不到兩個：' + tabs().length };
  if (kind === 'typeaway') {
    const sw = await wait(() => vis('.term-remote-switch button')[0]);
    if (!sw) return { ok: false, why: '終端上方的「打字」按鈕不見了' };
    sw.click();
    if (!(await wait(() => barOf().includes('打字：')))) return { ok: false, why: '按「打字」後狀態列沒出現打字中：' + barOf().slice(0, 60) };
  }
  const starts = calls('term_view_remote_start'), stops = calls('term_view_remote_stop');
  tabs()[1].click();
  if (!(await wait(() => vis('.term-view-screen').length === 0))) return { ok: false, why: '切到第二個分頁後，第一個分頁的終端還看得到' };
  await sleep(kind === 'expired' ? 1500 : 500);
  if (kind === 'switchback' && calls('term_view_remote_stop') !== stops) return { ok: false, why: '離開分頁就結束了觀看（寬限內不該結束），stop 被呼叫了' };
  if (kind === 'expired' && calls('term_view_remote_stop') !== stops + 1) return { ok: false, why: '離開超過寬限，到期當下就該呼叫 stop（不能等切回來）：stop 次數 ' + stops + ' → ' + calls('term_view_remote_stop') };
  if (kind === 'typeaway' && calls('term_view_remote_stop') !== stops + 1) return { ok: false, why: '打字中離開分頁，打字通道要馬上結束：stop 次數 ' + stops + ' → ' + calls('term_view_remote_stop') };
  tabs()[0].click();
  if (kind === 'typeaway') {
    if (!(await wait(() => barOf().includes('已結束打字')))) return { ok: false, why: '切回來狀態列沒有「已結束打字」：' + barOf().slice(0, 60) };
    const again = vis('.chatpane .typing button').find(b => b.textContent.trim() === '重新看');
    if (!again) return { ok: false, why: '狀態列沒有「重新看」按鈕' };
    await sleep(800);
    if (calls('term_view_remote_start') !== starts) return { ok: false, why: '切回來自動重新發起了（要等本人按「重新看」）：start 次數 ' + starts + ' → ' + calls('term_view_remote_start') };
    if (barOf().includes('打字：') || vis('.term-remote-input').length) return { ok: false, why: '切回來還殘留打字：' + barOf().slice(0, 60) };
    again.click();
    if (!(await wait(() => calls('term_view_remote_start') === starts + 1))) return { ok: false, why: '按「重新看」沒有發起' };
  }
  if (kind === 'expired') {
    if (!(await wait(() => barOf().includes('已結束觀看（離開超過 5 分鐘）')))) return { ok: false, why: '切回來狀態列沒有「已結束觀看（離開超過 5 分鐘）」：' + barOf().slice(0, 60) };
    const again = vis('.chatpane .typing button').find(b => b.textContent.trim() === '重新看');
    if (!again) return { ok: false, why: '狀態列沒有「重新看」按鈕' };
    again.click();
    if (!(await wait(() => calls('term_view_remote_start') === starts + 1))) return { ok: false, why: '按「重新看」沒有重新發起' };
  }
  if (!(await wait(() => rowsOf().includes('測試通過')))) return { ok: false, why: '切回來後終端不見了或沒有內容：' + rowsOf().slice(0, 40) };
  const sc = vis('.term-view-screen .xterm-screen')[0];
  if (!sc || sc.clientWidth < 50) return { ok: false, why: '切回來後終端畫面寬度是 0（沒有重新排版）' };
  if (!(await wait(() => barOf().includes('正在看')))) return { ok: false, why: '切回來後狀態列沒有「正在看」：' + barOf().slice(0, 60) };
  if (kind === 'switchback' && calls('term_view_remote_start') !== starts) return { ok: false, why: '切回來又重新請求了一次（start 次數 ' + starts + ' → ' + calls('term_view_remote_start') + '）' };
  return { ok: true, why: '' };
})()`

// ---- 本機終端：分頁隱藏時暫停讀取（term_view_set），切回來補讀一幅再恢復 ----
// 假後台（smoke-lib 的 injectSource）會依 paused 停推假畫面、恢復時補推一幅，並記下推了幾幅（__smokeTv.sent）
export const LTERM_NODE = 'P'   // 假 Tauri 的 startup_info 裡這台的節點代號：夥伴在這台，才走本機看終端
export const LTERM_MEMBERS = [{ id: LTERM_NODE, name: '測試機', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }, { name: 'demo2', status: 'idle', cwd_label: 'demo2' }] }]
export const LTERM_ME = { winMode: 'merged', session: { v: 1, tabs: [{ id: LTERM_NODE + '/demo' }, { id: LTERM_NODE + '/demo2' }], active: { id: LTERM_NODE + '/demo' }, panel: { guide: '', setting: '' }, windows: [], panelWindows: [] } }
export const LTERM_PROBES = { pause: { ltermPause: true } }

export const ltermPauseProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (fn, n = 60) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const sent = () => (globalThis.__smokeTv || {}).sent || 0;
  const sets = paused => (globalThis.__smokeCalls || []).filter(c => c[0] === 'term_view_set' && c[1] && c[1].paused === paused).length;
  const vis = sel => [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length > 0);
  const rowsOf = () => (vis('.term-view-screen .xterm-rows')[0] || {}).textContent || '';
  const tabs = () => [...document.querySelectorAll('.ctab')];
  const entry = await wait(() => vis('.chatpane .actionbar button').find(b => (b.getAttribute('aria-label') || b.textContent || '').includes('終端')));
  if (!entry) return { ok: false, why: '按鈕列沒有「終端」' };
  entry.click();
  if (!(await wait(() => rowsOf().includes('測試通過') && sent() >= 3))) return { ok: false, why: '本機終端畫面沒有出現假畫面的字，或沒有持續收到畫面：' + rowsOf().slice(0, 40) + ' / 已推 ' + sent() };
  if (tabs().length < 2) return { ok: false, why: '分頁不到兩個：' + tabs().length };
  tabs()[1].click();
  if (!(await wait(() => vis('.term-view-screen').length === 0))) return { ok: false, why: '切走後第一個分頁的終端還看得到' };
  await sleep(400);
  if (!(await wait(() => sets(true) >= 1, 20))) return { ok: false, why: '分頁隱藏時沒有呼叫 term_view_set(paused=true)' };
  const hiddenFrom = sent();
  await sleep(1500);
  if (sent() !== hiddenFrom) return { ok: false, why: '分頁隱藏期間後台還在推畫面：' + hiddenFrom + ' → ' + sent() };
  if (sets(false) !== 0) return { ok: false, why: '還沒切回來就呼叫了 term_view_set(paused=false)' };
  tabs()[0].click();
  if (!(await wait(() => sent() > hiddenFrom, 30))) return { ok: false, why: '切回來沒有補到最新的一幅（' + hiddenFrom + ' → ' + sent() + '）' };
  if (sets(false) < 1) return { ok: false, why: '切回來沒有呼叫 term_view_set(paused=false)' };
  const resumed = sent();
  await sleep(1000);
  if (sent() < resumed + 3) return { ok: false, why: '切回來之後沒有恢復持續推畫面：' + resumed + ' → ' + sent() };
  if (!rowsOf().includes('測試通過')) return { ok: false, why: '切回來後終端沒有內容：' + rowsOf().slice(0, 40) };
  const sc = vis('.term-view-screen .xterm-screen')[0];
  if (!sc || sc.clientWidth < 50) return { ok: false, why: '切回來後終端畫面寬度是 0' };
  return { ok: true, why: '' };
})()`
