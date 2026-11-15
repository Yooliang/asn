// 冒煙探測「電腦版名單頂端精簡檢查」（probe.listTrim）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

// 電腦版四個大分頁（0.2.18）：名單上方「夥伴／對話／設定／通知」（#1429 改順序），和手機同樣的字與順序；開窗停在夥伴（本機那台），左邊直排的設備頁籤只在夥伴裡、
// 不再有通知、群組、指引、齒輪；對話分頁最上面有建立／加入群組；設定最後一列是使用指引，點進去有「‹ 設定」回來；點夥伴回到剛才的設備頁籤
// 電腦版名單頂端精簡（#1531）：①「夥伴」的放大鏡在搜尋框裡面，真點它游標要進搜尋框（原本獨立那顆的功能）；
// ②「對話」搜尋框下面沒有建立／加入群組鈕，真點「＋」選單裡的「建立群組…」「加入群組…」各自打開對應的視窗。LINE 外觀框內放大鏡是底圖，不放按鈕
export const listTrimProbeSource = probe => `(async () => {
  try {
  const line = ${JSON.stringify(probe.listTrim === 'line')};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async req => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(350) };
  const R = e => e.getBoundingClientRect();
  const tab = l => [...document.querySelectorAll('.top-tabs .ttab')].find(e => (e.querySelector('span') && e.querySelector('span').textContent.trim() === l) || (e.getAttribute('aria-label') || '').startsWith(l));
  await sleep(300);
  const input = document.querySelector('.content .search-box input[aria-label="搜尋聯絡人"]');
  if (!vis(input)) return { ok: false, why: '夥伴分頁找不到搜尋框' };
  if ([...document.querySelectorAll('.content .search > .search-ic')].some(vis)) return { ok: false, why: '搜尋框右邊還有一顆獨立的放大鏡' };
  const mag = document.querySelector('.content .search-box .search-in');
  if (line) {
    if (vis(mag)) return { ok: false, why: 'LINE 外觀不該另外放放大鏡鈕（框內左側是底圖）' };
  } else {
    if (!vis(mag)) return { ok: false, why: '搜尋框裡沒有放大鏡' };
    const a = R(input), b = R(mag);
    if (b.left < a.left || b.right > a.right || b.top < a.top || b.bottom > a.bottom) return { ok: false, why: '放大鏡不在搜尋框裡：框 ' + [a.left, a.top, a.right, a.bottom].map(Math.round) + '，放大鏡 ' + [b.left, b.top, b.right, b.bottom].map(Math.round) };
    if (a.right - b.right > 8) return { ok: false, why: '放大鏡沒有靠框的右側：差 ' + Math.round(a.right - b.right) + 'px' };
    input.blur(); await sleep(100);
    if (document.activeElement === input) return { ok: false, why: '測試前搜尋框不該有游標' };
    await real({ click: at(mag) });
    if (document.activeElement !== input) return { ok: false, why: '點框內的放大鏡，游標沒有進搜尋框（現在在 ' + (document.activeElement && (document.activeElement.className || document.activeElement.tagName)) + '）' };
    await real({ text: 'zz' });
    if (input.value !== 'zz') return { ok: false, why: '點放大鏡後打字沒有進搜尋框：' + JSON.stringify(input.value) };
    input.value = ''; input.dispatchEvent(new Event('input'));
  }
  await real({ click: at(tab('對話')) });
  const chats = document.querySelector('.chat-list');
  if (!vis(chats)) return { ok: false, why: '對話分頁沒有顯示' };
  if (chats.querySelector('.gl-actions') || [...chats.querySelectorAll('button')].some(b => /^(建立|加入)群組$/.test(b.textContent.trim()))) return { ok: false, why: '對話分頁搜尋框下面還有建立／加入群組鈕' };
  for (const [item, want] of [['建立群組…', '建立'], ['加入群組…', '加入']]) {
    const plus = [...document.querySelectorAll('.chat-list .search-plus, .me .plus-btn')].find(vis);
    if (!plus) return { ok: false, why: '找不到「＋」' };
    await real({ click: at(plus) });
    const menu = document.querySelector('.launch-picker');
    if (!vis(menu)) return { ok: false, why: '點「＋」沒有打開選單' };
    const btn = [...menu.querySelectorAll('button')].find(b => b.textContent.trim() === item);
    if (!vis(btn)) return { ok: false, why: '「＋」選單裡沒有「' + item + '」' };
    const hit = document.elementFromPoint(...at(btn));
    if (hit !== btn && !btn.contains(hit)) return { ok: false, why: '「' + item + '」被別的東西蓋住：' + (hit && (hit.className || hit.tagName)) + ' @' + at(btn) };
    await real({ click: at(btn) });
    for (let i = 0; i < 20 && !vis(document.querySelector('.gs-panel')); i++) await sleep(100);
    const panel = document.querySelector('.gs-panel');
    const title = panel && panel.querySelector('.gs-title') ? panel.querySelector('.gs-title').textContent.trim() : '';
    if (!vis(panel) || !title.includes(want)) return { ok: false, why: '點「' + item + '」沒有打開對應的視窗：' + JSON.stringify(title) };
    if (vis(document.querySelector('.launch-picker'))) return { ok: false, why: '選了「' + item + '」選單沒有收起' };
    await real({ click: at(panel.querySelector('.gs-x')) });
    if (vis(document.querySelector('.gs-panel'))) return { ok: false, why: '關不掉「' + item + '」的視窗' };
  }
  await real({ click: at(tab('夥伴')) });
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

export default {
  key: 'listTrim',
  kind: '電腦版名單頂端精簡檢查',
  source: probe => listTrimProbeSource(probe),
}
