// 冒煙探測「LINE 電腦版名單與輸入區檢查」（probe.lineDesk）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

// LINE 電腦版（#1527）：真點擊走一遍——沒有設備頁籤欄、自己的卡片在名單最上面（點大頭貼出選單）、收合／展開分組、點夥伴開對話、
// 對話區只有訊息區一條直向捲動、沒有橫向捲動、用輸入框上方的按鈕區送出表情和圖片。mode＝'wide'（900）或 'narrow'（500，開對話會換成只顯示對話）
export const lineDeskProbeSource = mode => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async req => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(350) };
  const R = e => e.getBoundingClientRect();
  const hscroll = () => document.documentElement.scrollWidth > innerWidth + 1;
  // 窄視窗一開始停在對話，先按標題列的「返回名單」
  const back = [...document.querySelectorAll('.mbar-back')].find(vis);
  if (back) await real({ click: at(back) });
  if (vis(document.querySelector('.rail'))) return { ok: false, why: '還有左邊的設備頁籤欄' };
  const me = document.querySelector('.list-pane > .me'), search = document.querySelector('.content .search');
  if (!vis(me) || !vis(search)) return { ok: false, why: '找不到自己的卡片或搜尋框' };
  if (R(me).bottom > R(search).top + 1) return { ok: false, why: '自己的卡片要在名單最上面' };
  // 點自己的大頭貼＝換大頭貼（打開選圖），跟原本一樣；這裡只攔下選檔對話框、不選檔
  globalThis.__smokeChooser = undefined;
  globalThis.__smokeInput(JSON.stringify({ choose: [...at(me.querySelector('.me-dp')), ''] }));
  for (let i = 0; i < 60 && globalThis.__smokeChooser === undefined; i++) await sleep(100);
  if (!globalThis.__smokeChooser) return { ok: false, why: '點自己的大頭貼沒有打開換大頭貼的選圖' };
  const head = [...document.querySelectorAll('.list .g-head')].find(vis);
  if (!head) return { ok: false, why: '名單沒有分組標題' };
  if (!/[(（][0-9]/.test(head.textContent)) return { ok: false, why: '分組標題沒有人數：' + head.textContent.trim() };
  const ul = head.nextElementSibling;
  if (!vis(ul)) return { ok: false, why: '分組一開始就是收合的' };
  await real({ click: at(head) });
  if (vis(ul)) return { ok: false, why: '點分組標題沒有收合' };
  await real({ click: at(head) });
  if (!vis(ul)) return { ok: false, why: '再點一次沒有展開' };
  const buddy = [...ul.querySelectorAll('.buddy')].find(vis);
  if (!buddy) return { ok: false, why: '分組裡沒有夥伴' };
  await real({ click: at(buddy) });
  let ta = null;
  for (let i = 0; i < 40 && !ta; i++) { ta = [...document.querySelectorAll('.compose-main.lc-row textarea')].find(vis) || null; if (!ta) await sleep(100) }
  if (!ta) return { ok: false, why: '點夥伴沒有打開對話（或輸入列不是按鈕區版）' };
  await sleep(300);
  const pane = ta.closest('.chatpane'), main = ta.closest('.compose-main'), row = main.querySelector(':scope > .toolbar'), msgs = pane.querySelector('.msgs');
  if (hscroll()) return { ok: false, why: '視窗出現橫向捲動' };
  if (msgs.scrollWidth > msgs.clientWidth + 1) return { ok: false, why: '對話區出現橫向捲動' };
  if (getComputedStyle(msgs).overflowY !== 'auto') return { ok: false, why: '訊息區不是直向捲動' };
  for (const el of [pane.querySelector('.conv'), pane.querySelector('.conv-main')]) if (['auto', 'scroll'].includes(getComputedStyle(el).overflowY) || ['auto', 'scroll'].includes(getComputedStyle(el).overflowX)) return { ok: false, why: '訊息區外層也會捲動（' + el.className + '）' };
  const tool = name => [...row.querySelectorAll('.tool')].find(b => vis(b) && b.getAttribute('aria-label') === name);
  const emo = tool('表情符號');
  if (!emo) return { ok: false, why: '按鈕區沒有表情鈕' };
  await real({ click: at(emo) });
  const pk = [...row.querySelectorAll('.picker')].find(vis);
  if (!pk) return { ok: false, why: '按表情鈕沒有出現表情選單' };
  const first = pk.querySelector('button'), code = first.getAttribute('title');
  await real({ click: at(first) });
  if (!ta.value.includes(code)) return { ok: false, why: '點了表情沒有放進輸入框' };
  globalThis.__smokeCalls = [];
  if (document.activeElement !== ta) await real({ click: at(ta) });
  await real({ key: 'Enter' });
  const sent = (globalThis.__smokeCalls || []).filter(c => c[0] === 'relay_send');
  if (sent.length !== 1 || !JSON.stringify(sent[0][1]).includes(JSON.stringify(code).slice(1, -1))) return { ok: false, why: '表情沒有送出' };
  const ph = tool('傳照片');
  if (!ph) return { ok: false, why: '按鈕區沒有圖片鈕' };
  globalThis.__smokeChooser = undefined;
  globalThis.__smokeInput(JSON.stringify({ choose: [...at(ph), 'ok1.png'] }));
  for (let i = 0; i < 60 && globalThis.__smokeChooser === undefined; i++) await sleep(100);
  if (!globalThis.__smokeChooser) return { ok: false, why: '按圖片鈕沒有打開選檔' };
  let up = [];
  for (let i = 0; i < 60; i++) { up = (globalThis.__smokeCalls || []).filter(c => c[0] === 'relay_send_attachment'); if (up.length) break; await sleep(100) }
  if (up.length !== 1) return { ok: false, why: '選了圖片沒有送出' };
  await sleep(300);
  if (hscroll()) return { ok: false, why: '送出後視窗出現橫向捲動' };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

export default {
  key: 'lineDesk',
  kind: 'LINE 電腦版名單與輸入區檢查',
  source: probe => lineDeskProbeSource(probe.lineDesk),
}
