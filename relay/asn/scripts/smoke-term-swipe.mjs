// 手機看終端的兩項檢查（0.2.17）。探測在頁面裡執行，這個檔案只產生探測原始碼，字串裡不寫反斜線。
// bar：提示（等那台電腦回應、正在看）在最下面的狀態列，終端上方沒有那一條。
// swipe：從終端區內水平拖動不換分頁、不攔截（終端自己捲）；從終端區外拖動照舊換分頁。

const COMMON = `
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let sw = null;
  for (let i = 0; i < 80 && !sw; i++) { sw = document.querySelector('.m-term-switch'); if (!sw) await sleep(100) }
  if (!sw) return { ok: false, why: '對話頁沒有「對話／終端」切換鈕' };
  sw.click();
  let rows = '';
  for (let i = 0; i < 80 && !rows.includes('測試通過'); i++) { await sleep(100); rows = document.querySelector('.term-view-screen .xterm-rows')?.textContent || '' }
  if (!rows.includes('測試通過')) return { ok: false, why: '終端畫面沒有出現假畫面的字' };
  await sleep(400);
`

export const mtermBarProbeSource = () => `(async () => {${COMMON}
  const bar = document.querySelector('.m-chat .typing');
  if (!bar) return { ok: false, why: '沒有最下面的狀態列' };
  if (!bar.textContent.includes('正在看')) return { ok: false, why: '狀態列沒有「正在看」：' + bar.textContent.slice(0, 60) };
  if (!bar.classList.contains('typing-remote')) return { ok: false, why: '狀態列沒有套用看終端的樣式（typing-remote）：' + bar.className };
  const top = document.querySelector('.m-chat .term-remote');
  if (!top) return { ok: false, why: '沒有終端區' };
  const extra = top.querySelector('.term-remote-bar, .term-view-ask, .term-view-lost');
  if (extra) return { ok: false, why: '終端上方還有提示那一條：' + extra.className + ' ' + extra.textContent.slice(0, 40) };
  const t = top.getBoundingClientRect(), b = bar.getBoundingClientRect();
  if (b.top < t.bottom - 0.5) return { ok: false, why: '狀態列應該在終端下方：狀態列頂 ' + Math.round(b.top) + ' < 終端底 ' + Math.round(t.bottom) };
  if (b.bottom > window.innerHeight + 0.5 || b.left < -0.5 || b.right > window.innerWidth + 0.5) return { ok: false, why: '狀態列跑出畫面' };
  const screen = document.querySelector('.m-chat .term-view-screen').getBoundingClientRect();
  if (Math.abs(screen.top - t.top) > 4) return { ok: false, why: '終端畫面頂端應該貼著終端區頂端（上方沒有提示條）：' + Math.round(screen.top) + ' vs ' + Math.round(t.top) };
  if (document.documentElement.scrollWidth > window.innerWidth + 1) return { ok: false, why: '整頁橫向溢出' };
  return { ok: true, why: '' };
})()`

export const mtermSwipeProbeSource = () => `(async () => {${COMMON}
  const W = window.innerWidth;
  const tabNow = () => document.querySelector('.m-tabs [role=tab][aria-selected=true]')?.textContent.trim() || '';
  const wrap = document.querySelector('.m-pager-wrap');
  const pager = document.querySelector('.m-pager');
  const mk = (type, el, x, y) => {
    const t = new Touch({ identifier: 7, target: el, clientX: x, clientY: y });
    const end = type === 'touchend' || type === 'touchcancel';
    return new TouchEvent(type, { bubbles: true, cancelable: true, touches: end ? [] : [t], targetTouches: end ? [] : [t], changedTouches: [t] });
  };
  // 在 el 上從 x0 水平拖到 x1（分幾段 move）；回傳每段 touchmove 有沒有被攔截（preventDefault）、拖到一半整排有沒有跟著動
  const drag = async (el, x0, x1) => {
    const y = Math.round(el.getBoundingClientRect().top + Math.min(el.getBoundingClientRect().height / 2, 60));
    el.dispatchEvent(mk('touchstart', el, x0, y));
    let prevented = false, moved = false;
    for (let i = 1; i <= 6; i++) {
      const ev = mk('touchmove', el, x0 + (x1 - x0) * i / 6, y);
      el.dispatchEvent(ev);
      if (ev.defaultPrevented) prevented = true;
      await sleep(16);
    }
    if (pager && /translate3d\\(calc\\([^)]*\\) \\+ -?[1-9]/.test(pager.style.transform)) moved = true;
    el.dispatchEvent(mk('touchend', el, x1, y));
    await sleep(500);
    return { prevented, moved };
  };
  const screen = document.querySelector('.m-chat .term-view-screen');
  const inner = document.querySelector('.m-chat .term-view-screen .xterm-screen') || screen;
  if (!screen || !inner) return { ok: false, why: '沒有終端畫面' };
  const startTab = tabNow();
  const x0 = Math.round(W * 0.8), x1 = Math.round(W * 0.2);
  // 一、起點在終端區內：往左、往右都不換分頁、不攔截、整排不跟著動
  for (const [name, el] of [['終端畫面', screen], ['xterm 內層', inner]]) {
    for (const [a, b] of [[x0, x1], [x1, x0]]) {
      const r = await drag(el, a, b);
      if (r.prevented) return { ok: false, why: '在' + name + '水平拖動被攔截了（終端沒辦法自己捲）' };
      if (r.moved) return { ok: false, why: '在' + name + '水平拖動時整排分頁跟著動' };
      if (tabNow() !== startTab) return { ok: false, why: '在' + name + '水平拖動換了分頁：' + startTab + ' → ' + tabNow() };
    }
  }
  // 二、起點在終端區外（下方狀態列）：照舊往左拖會換到下一個分頁（確認沒把整個手勢弄壞）
  const out = document.querySelector('.m-chat .typing');
  if (!out) return { ok: false, why: '沒有終端區外的狀態列可以拖' };
  const r2 = await drag(out, x0, x1);
  if (tabNow() === startTab) return { ok: false, why: '在終端區外水平拖動沒有換分頁（手勢壞了）：' + (r2.prevented ? '有攔截' : '沒攔截') };
  return { ok: true, why: '終端內不換頁（終端' + (screen.scrollWidth > screen.clientWidth + 1 ? '有' : '沒有') + '橫向可捲內容）、終端外換頁：' + startTab + ' → ' + tabNow() };
})()`
