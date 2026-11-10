// 電腦版看別台電腦夥伴的終端：狀態文字在視窗最下面的狀態列（不在終端上方），黑色畫面和下面的訊息框等寬、四周留同一組間距。
// 探測在頁面裡執行；這個檔案只產生探測原始碼，字串裡不寫反斜線。
// kind：'watch'＝只能看；'typing'＝再按「打字」進到可以打字（狀態列要用醒目的紅色警示）
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
