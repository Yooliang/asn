// 冒煙探測「電腦版四個大分頁檢查」（probe.dtabs）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const dtabsProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const shown = e => { if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0 };
  const tops = () => [...document.querySelectorAll('.top-tabs .ttab')];
  for (let i = 0; i < 60 && tops().length < 4; i++) await sleep(100);
  const t = tops(), byLabel = l => t.find(e => e.querySelector('span').textContent.trim() === l);
  const order = t.map(e => e.querySelector('span').textContent.trim()).join('|');
  if (order !== '夥伴|對話|設定|通知') return { ok: false, why: '上方大分頁的字或順序不對：' + order };
  if (!byLabel('夥伴').classList.contains('on')) return { ok: false, why: '開窗應該停在「夥伴」' };
  const rail = document.querySelector('.rail');
  if (!shown(rail)) return { ok: false, why: '夥伴分頁沒有左邊的設備頁籤' };
  if (rail.querySelector('.rtab-notice, .rtab-groups, [aria-label="設定"], [aria-label="指引"]')) return { ok: false, why: '左邊直排頁籤還有通知、群組、指引或齒輪' };
  const devOn = rail.querySelector('.rtab.on');
  const devKey = devOn ? devOn.getAttribute('aria-label') : '';
  if (!devKey) return { ok: false, why: '夥伴分頁沒有選中的設備頁籤' };
  byLabel('對話').click(); await sleep(300);
  if (document.querySelector('.rail')) return { ok: false, why: '對話分頁不該有左邊的設備頁籤' };
  const chats = document.querySelector('.chat-list');
  if (!shown(chats)) return { ok: false, why: '對話分頁沒有顯示對話清單' };
  // 建立／加入群組只留在「＋」選單裡（#1531）：搜尋框下面不再有重複的兩顆鈕
  if (chats.querySelector('.gl-actions') || [...chats.querySelectorAll('button')].some(b => /^(建立|加入)群組$/.test(b.textContent.trim()))) return { ok: false, why: '對話分頁搜尋框下面還有建立／加入群組鈕' };
  byLabel('設定').click(); await sleep(300);
  const entry = document.querySelector('.cat-list .guide-entry');
  if (!shown(entry) || !entry.textContent.includes('使用指引')) return { ok: false, why: '設定清單最後沒有「使用指引」' };
  entry.click(); await sleep(300);
  if (!byLabel('設定').classList.contains('on')) return { ok: false, why: '使用指引應該算在「設定」底下' };
  const back = document.querySelector('.guide-list .guide-back');
  if (!shown(back) || !document.querySelector('.guide-list .guide-item')) return { ok: false, why: '使用指引沒有篇目或沒有「‹ 設定」' };
  back.click(); await sleep(300);
  if (!shown(document.querySelector('.cat-list'))) return { ok: false, why: '按「‹ 設定」沒有回到設定清單' };
  byLabel('夥伴').click(); await sleep(300);
  const again = document.querySelector('.rail .rtab.on');
  if (!again || again.getAttribute('aria-label') !== devKey) return { ok: false, why: '點夥伴沒有回到剛才的設備頁籤' };
  if (document.documentElement.scrollWidth > innerWidth + 1) return { ok: false, why: '視窗出現橫向捲動' };
  return { ok: true, why: '' };
})()`

export default {
  key: 'dtabs',
  kind: '電腦版四個大分頁檢查',
  source: () => dtabsProbeSource(),
}
