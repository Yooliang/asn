// 冒煙探測「mtermview」（probe.mtermview）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
import { mtermBarProbeSource, mtermSwipeProbeSource } from '../smoke-term-swipe.mjs'
import { mtermviewFollowProbeSource } from '../smoke-term-follow.mjs'
import { mtermviewCursorProbeSource } from '../smoke-term-cursor.mjs'

// 看終端時輸入框要在：可見、可聚焦、在畫面內；終端區的底不超過輸入框的頂（不重疊）；不橫向溢出；切回對話也正常
export const mtermComposerProbeSource = ({ kb }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  let sw = null;
  for (let i = 0; i < 80 && !sw; i++) { sw = document.querySelector('.m-term-switch'); if (!sw) await sleep(100) }
  if (!sw) return { ok: false, why: '對話頁沒有「對話／終端」切換鈕' };
  const H = window.innerHeight, W = window.innerWidth;
  sw.click();
  let rows = '';
  for (let i = 0; i < 80 && !rows.includes('測試通過'); i++) { await sleep(100); rows = document.querySelector('.term-view-screen .xterm-rows')?.textContent || '' }
  if (!rows.includes('測試通過')) return { ok: false, why: '終端畫面沒有出現假畫面的字' };
  await sleep(300);
  const ta = document.querySelector('.m-chat .composer textarea');
  const form = document.querySelector('.m-chat .composer');
  if (!vis(ta) || !vis(form)) return { ok: false, why: '看終端時輸入框被藏起來了' };
  if (${kb ? 'true' : 'false'}) { ta.focus(); await sleep(300) }
  const check = (tag) => {
    const f = form.getBoundingClientRect(), t = ta.getBoundingClientRect();
    const term = document.querySelector('.m-chat .term-remote').getBoundingClientRect();
    if (!(f.height > 20 && t.height > 20)) return tag + '輸入框高度太小：' + Math.round(t.height);
    if (f.top < -0.5 || f.bottom > window.innerHeight + 0.5 || f.left < -0.5 || f.right > window.innerWidth + 0.5) return tag + '輸入框跑出畫面：' + [f.left, f.top, f.right, f.bottom].map(Math.round).join(',') + ' / ' + window.innerWidth + 'x' + window.innerHeight;
    if (!(term.height > 40)) return tag + '終端區被擠扁：' + Math.round(term.height);
    if (term.bottom > f.top + 0.5) return tag + '終端區蓋到輸入框：終端底 ' + Math.round(term.bottom) + ' > 輸入框頂 ' + Math.round(f.top);
    if (term.top < -0.5) return tag + '終端區頂端跑出畫面：' + Math.round(term.top);
    const s = document.querySelector('.m-chat .term-view-screen').getBoundingClientRect();
    if (s.bottom > f.top + 0.5) return tag + '終端畫面溢出到輸入框：' + Math.round(s.bottom) + ' > ' + Math.round(f.top);
    if (document.documentElement.scrollWidth > window.innerWidth + 1 || document.body.scrollWidth > window.innerWidth + 1) return tag + '整頁橫向溢出';
    if (document.documentElement.scrollHeight > window.innerHeight + 1) return tag + '整頁縱向溢出：' + document.documentElement.scrollHeight + ' > ' + window.innerHeight;
    const sr = sw.getBoundingClientRect();
    if (sr.right > window.innerWidth + 0.5 || sr.left < -0.5 || sr.bottom > window.innerHeight + 0.5) return tag + '切換鈕跑出畫面';
    return '';
  };
  let bad = check('看終端：');
  if (bad) return { ok: false, why: bad };
  ta.focus();
  if (document.activeElement !== ta) return { ok: false, why: '輸入框無法取得焦點' };
  const stopSend = e => { e.preventDefault() };
  form.addEventListener('submit', stopSend);
  const setVal = v => { ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true })) };
  setVal('你好');
  await sleep(100);
  if (ta.value !== '你好') return { ok: false, why: '輸入框打不了字' };
  const btn = form.querySelector('button[type=submit]');
  if (!btn || btn.disabled) return { ok: false, why: '打了字之後傳送鈕沒有啟用' };
  setVal('');
  form.removeEventListener('submit', stopSend);
  await sleep(100);
  bad = check('打字後：');
  if (bad) return { ok: false, why: bad };
  // 切回對話：訊息列表回來、輸入框仍在、不溢出
  sw.click();
  await sleep(500);
  if (!vis(document.querySelector('.m-chat .conv'))) return { ok: false, why: '切回對話後訊息列表沒回來' };
  if (!vis(ta)) return { ok: false, why: '切回對話後輸入框不見了' };
  const f2 = form.getBoundingClientRect();
  if (f2.bottom > window.innerHeight + 0.5 || document.documentElement.scrollWidth > window.innerWidth + 1) return { ok: false, why: '切回對話後版面跑掉' };
  // 再切到終端，讓截圖停在終端畫面
  sw.click();
  rows = '';
  for (let i = 0; i < 60 && !rows.includes('測試通過'); i++) { await sleep(100); rows = document.querySelector('.term-view-screen .xterm-rows')?.textContent || '' }
  if (${kb ? 'true' : 'false'}) ta.focus();
  await sleep(300);
  bad = check('再切到終端：');
  if (bad) return { ok: false, why: bad };
  return { ok: true, why: '' };
})()`

export const mtermviewProbeSource = ({ big, gate, stayChat, cursor, composer, kb, follow, statusLine, swipe }) => statusLine ? mtermBarProbeSource() : swipe ? mtermSwipeProbeSource() : follow ? mtermviewFollowProbeSource() : composer ? mtermComposerProbeSource({ kb }) : cursor ? mtermviewCursorProbeSource() : gate ? mtermviewGateProbeSource(gate) : `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  let sw = null;
  for (let i = 0; i < 80 && !sw; i++) { sw = document.querySelector('.m-term-switch'); if (!sw) await sleep(100) }
  if (!sw) return { ok: false, why: '對話頁沒有「對話／終端」切換鈕' };
  if (${big ? 'true' : 'false'}) {
    const els = [...document.querySelectorAll('#app *')];
    const sizes = els.map(e => parseFloat(getComputedStyle(e).fontSize) || 0);
    els.forEach((e, i) => { if (sizes[i]) e.style.fontSize = (sizes[i] * 1.3) + 'px' });
    await sleep(300);
  }
  // 擁有者 11-10：合成一顆、放在這排最後面、不做選中樣式；字寫「按了會去哪裡」（看對話時「終端」、看終端時「對話」）
  if (document.querySelectorAll('.m-term-switch').length !== 1 || sw.tagName !== 'BUTTON') return { ok: false, why: '對話／終端切換應該只有一顆按鈕' };
  const btns = [sw];
  const plain = () => {
    if (sw.hasAttribute('aria-pressed')) return '有 aria-pressed（不要選中狀態）';
    if (sw.classList.contains('on')) return '有選中樣式（.on）';
    return '';
  };
  const lastInRow = () => {
    const kids = [...sw.parentElement.children].filter(e => e.tagName === 'BUTTON' || e.classList.contains('tool-group')).filter(e => getComputedStyle(e).display !== 'none');
    return kids[kids.length - 1] === sw;
  };
  if (!sw.closest('.compose-row .toolbar')) return { ok: false, why: '切換鈕應該在下方圖示列' };
  if (!lastInRow()) return { ok: false, why: '切換鈕應該放在這排按鈕的最後面' };
  if (sw.getAttribute('aria-label') !== '終端') return { ok: false, why: '看對話時按鈕應該寫「終端」：' + sw.getAttribute('aria-label') };
  if (plain()) return { ok: false, why: '看對話時切換鈕' + plain() };
  if (${stayChat ? 'true' : 'false'}) {
    const r = sw.getBoundingClientRect();
    if (r.width < 43.5 || r.height < 43.5 || r.left < -0.5 || r.right > window.innerWidth + 0.5) return { ok: false, why: '切換鈕跑出畫面或太小' };
    if (document.documentElement.scrollWidth > window.innerWidth + 1) return { ok: false, why: '整頁橫向溢出' };
    return { ok: true, why: '' };
  }
  // 兩個圖示都要整顆在畫面內、夠大好按（電腦版的 44px 觸控下限）
  const inView = () => btns.every(b => { const r = b.getBoundingClientRect(); return r.width >= 43.5 && r.height >= 43.5 && r.left >= -0.5 && r.right <= window.innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5 });
  if (!inView()) return { ok: false, why: '切換圖示跑出畫面或太小' };
  const conv = () => document.querySelector('.m-chat .conv');
  if (!vis(conv())) return { ok: false, why: '一開始應該先顯示訊息列表' };
  sw.click();
  let bar = null;
  for (let i = 0; i < 80 && !(bar && bar.textContent.includes('正在看')); i++) { await sleep(100); bar = document.querySelector('.m-chat .typing') }   // 0.2.17：提示在最下面的狀態列
  if (!bar || !bar.textContent.includes('正在看')) return { ok: false, why: '點「終端」後沒出現「正在看」：' + (document.querySelector('.term-remote')?.textContent || '').slice(0, 80) };
  let rows = '';
  for (let i = 0; i < 60 && !rows.includes('測試通過'); i++) { await sleep(100); rows = document.querySelector('.term-view-screen .xterm-rows')?.textContent || '' }
  if (!rows.includes('測試通過')) return { ok: false, why: '終端畫面沒有出現假畫面的字：' + rows.slice(0, 60) };
  await sleep(300);
  if (vis(conv())) return { ok: false, why: '看終端時訊息列表應該收起來' };
  if (document.querySelector('.term-remote-switch')) return { ok: false, why: '不該有「打字」切換鈕（打字走下方輸入框）' };
  if (document.documentElement.scrollWidth > window.innerWidth + 1) return { ok: false, why: '整頁橫向溢出' };
  if (sw.getAttribute('aria-label') !== '對話') return { ok: false, why: '看終端時按鈕應該寫「對話」：' + sw.getAttribute('aria-label') };
  if (plain()) return { ok: false, why: '看終端時切換鈕' + plain() };
  if (!lastInRow()) return { ok: false, why: '看終端時切換鈕應該還在這排最後面' };
  // 終端至少半個螢幕高（橫向 412 高時曾被擠成 0）；「正在看」縮成一行；輸入框收起、切換圖示仍在畫面內
  const th = document.querySelector('.m-chat .term-remote').getBoundingClientRect().height;
  if (!(th > 0) || th < window.innerHeight * 0.4 - 1) return { ok: false, why: '終端高度不到螢幕的四成（輸入框回來後橫向 412 高約 46%）：' + Math.round(th) + ' / ' + window.innerHeight };
  const sh = document.querySelector('.m-chat .term-view-screen').getBoundingClientRect().height;
  if (!(sh > 0)) return { ok: false, why: '終端畫面高度是 0' };
  if (document.querySelector('.m-chat .term-remote .term-remote-bar')) return { ok: false, why: '終端上方不該再有提示條（已移到最下面的狀態列）' };
  if (!vis(document.querySelector('.m-chat .composer'))) return { ok: false, why: '看終端時輸入框應該還在（擁有者 11-10）' };
  if (!inView()) return { ok: false, why: '看終端時切換圖示跑出畫面' };
  // 切回「對話」：訊息列表回來、終端收掉、有通知那台停止；再切回「終端」讓截圖停在終端畫面
  sw.click();
  await sleep(500);
  if (!vis(conv())) return { ok: false, why: '切回「訊息」後訊息列表沒回來' };
  if (document.querySelector('.term-view-screen')) return { ok: false, why: '切回「訊息」後終端畫面還在' };
  const calls = (globalThis.__smokeCalls || []).map(c => c[0]);
  if (!calls.includes('term_view_remote_start')) return { ok: false, why: '沒呼叫 term_view_remote_start' };
  if ((globalThis.__smokeConfirms || []).length < 1) return { ok: false, why: '發起前沒有先跳本人確認' };
  if (!calls.includes('term_view_remote_stop')) return { ok: false, why: '切回訊息沒呼叫 term_view_remote_stop' };
  if (sw.getAttribute('aria-label') !== '終端') return { ok: false, why: '切回對話後按鈕應該寫「終端」' };
  sw.click();
  rows = '';
  for (let i = 0; i < 60 && !rows.includes('測試通過'); i++) { await sleep(100); rows = document.querySelector('.term-view-screen .xterm-rows')?.textContent || '' }
  if (!rows.includes('測試通過')) return { ok: false, why: '再切回「終端」後畫面沒出來' };
  await sleep(300);
  return { ok: true, why: '' };
})()`

// 本人確認沒過（PR③ 的閘門）：取消＝什麼都不送、靜默回到訊息；沒設螢幕鎖＝顯示提示、也不送。兩種都不能出現任何 start 呼叫
export const mtermviewGateProbeSource = gate => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  let sw = null;
  for (let i = 0; i < 80 && !sw; i++) { sw = document.querySelector('.m-term-switch'); if (!sw) await sleep(100) }
  if (!sw) return { ok: false, why: '對話頁沒有「對話／終端」切換鈕' };
  sw.click();
  for (let i = 0; i < 30 && (globalThis.__smokeConfirms || []).length < 1; i++) await sleep(100);
  if ((globalThis.__smokeConfirms || []).length < 1) return { ok: false, why: '點「終端」沒有先跳本人確認' };
  if (${JSON.stringify(gate)} === 'late') {
    sw.click();   // 確認還在等（1.5 秒後才回 ok）就切回訊息（這時按鈕寫「對話」）
    await sleep(2500);  // 等確認回 ok
    const late = (globalThis.__smokeCalls || []).map(c => c[0]);
    if (late.includes('term_view_remote_start')) return { ok: false, why: '已經切回訊息，晚回來的 ok 還是送了 term_view_remote_start' };
    if (!vis(document.querySelector('.m-chat .conv'))) return { ok: false, why: '切回訊息後訊息列表應該在' };
    if (document.querySelector('.term-remote')) return { ok: false, why: '切回訊息後不該有終端區' };
    return { ok: true, why: '' };
  }
  await sleep(800);
  const calls = (globalThis.__smokeCalls || []).map(c => c[0]);
  if (calls.includes('term_view_remote_start')) return { ok: false, why: '確認沒過，卻呼叫了 term_view_remote_start' };
  const conv = document.querySelector('.m-chat .conv');
  const area = document.querySelector('.term-remote');
  if (${JSON.stringify(gate)} === 'cancel') {
    if (!vis(conv)) return { ok: false, why: '取消後應該靜默回到訊息列表' };
    if (area) return { ok: false, why: '取消後不該留著終端區：' + area.textContent.slice(0, 60) };
    if (sw.getAttribute('aria-label') !== '終端') return { ok: false, why: '取消後回到對話，按鈕應該寫「終端」' };
    return { ok: true, why: '' };
  }
  const nbar = document.querySelector('.m-chat .typing');
  if (!area || !nbar || !nbar.textContent.includes('這支手機沒有設定螢幕鎖，請先設定再查看終端')) return { ok: false, why: '沒設螢幕鎖要顯示提示（在最下面的狀態列）：' + (nbar?.textContent || '').slice(0, 80) };
  if (document.querySelector('.term-view-screen .xterm')) return { ok: false, why: '沒設螢幕鎖不該開終端畫面' };
  return { ok: true, why: '' };
})()`

export default {
  key: 'mtermview',
  kind: probe => probe.statusLine ? '手機看終端狀態列檢查' : probe.swipe ? '手機看終端左右滑檢查' : '手機看終端檢查',
  source: probe => mtermviewProbeSource(probe),
}
