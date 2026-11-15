// 冒煙探測「電腦版通知頁籤檢查」（probe.dnotice）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const dnoticeProbeSource = ({ dnotice }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const shown = e => { if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0 };
  const mode = ${JSON.stringify(dnotice)}, W = window.innerWidth;
  const noScroll = () => document.documentElement.scrollWidth <= W + 1 && document.body.scrollWidth <= W + 1;
  const badge = () => { const c = document.querySelector('.top-tabs .ttab-notice .rtab-count'); return c ? c.textContent.trim() : '' };
  let bell = null;
  for (let i = 0; i < 60 && badge() !== '4'; i++) await sleep(100);
  bell = document.querySelector('.top-tabs .ttab-notice');
  if (!bell) return { ok: false, why: '上方沒有「通知」分頁' };
  if (badge() !== '4') return { ok: false, why: '通知頁籤的未讀數應是 4，實際：' + (badge() || '沒有') };
  const tops = [...document.querySelectorAll('.top-tabs .ttab')].filter(shown).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  const order = tops.map(e => e.querySelector('span').textContent.trim()).join('|');
  if (order !== '夥伴|對話|設定|通知') return { ok: false, why: '上方大分頁的字或順序不對：' + order };
  if (tops[3] !== bell) return { ok: false, why: '通知應是上方最後一個分頁（和手機一樣，#1429）' };
  if (document.querySelector('.rail .rtab-notice, .rail .rtab-groups')) return { ok: false, why: '左邊直排頁籤還有通知或群組' };
  if ([...document.querySelectorAll('.content .buddy')].some(b => b.textContent.trim().startsWith('通知'))) return { ok: false, why: '名單裡還有「通知」' };
  bell.click(); await sleep(300);
  const rows = [...document.querySelectorAll('.notice-list .nt-row')];
  if (rows.length !== 4) return { ok: false, why: '通知清單應有 4 則，實際 ' + rows.length };
  const chips = [...document.querySelectorAll('.notice-list .nt-chip')].map(e => e.textContent.trim()).join('／');
  if (chips !== '全部／卡住／登入／額度／安全／其他') return { ok: false, why: '分類小籤不對：' + chips };
  const first = rows[0];
  if (!first.textContent.includes('辦公室有新的登入')) return { ok: false, why: '最新的一則不在最上面：' + first.textContent.trim().slice(0, 30) };
  if (first.querySelector('b')) return { ok: false, why: '通知內文被當成 HTML（出現 <b> 元素）' };
  if (!first.textContent.includes('<b>不認得</b>')) return { ok: false, why: '摘要沒有原樣顯示角括號' };
  if (!first.querySelector('.nt-dot')) return { ok: false, why: '未讀的通知沒有紅點' };
  if (!document.querySelector('.notice-list .nt-head') || !document.querySelector('.notice-list .nt-all')) return { ok: false, why: '找不到通知標頭或「全部標為已讀」' };
  const chip = t => [...document.querySelectorAll('.notice-list .nt-chip')].find(e => e.textContent.trim() === t);
  chip('登入').click(); await sleep(200);
  const loginRows = document.querySelectorAll('.notice-list .nt-row').length;
  if (loginRows !== 1) return { ok: false, why: '「登入」分類應只剩 1 則，實際 ' + loginRows };
  chip('全部').click(); await sleep(200);
  if (!noScroll()) return { ok: false, why: '寬 ' + W + ' 出現橫向捲動：' + document.documentElement.scrollWidth };
  document.querySelector('.notice-list .nt-row').click(); await sleep(500);
  if (mode === 'split') {
    const calls = (globalThis.__smokeCalls || []).filter(c => c[0] === 'open_chat');
    if (!calls.some(c => c[1] && c[1].id === 'notice:me')) return { ok: false, why: '分離模式點通知應打開「通知」對話視窗' };
    if (document.querySelector('.notice-pane')) return { ok: false, why: '分離模式不該有右邊的通知內容' };
    return noScroll() ? { ok: true, why: '' } : { ok: false, why: '點開後出現橫向捲動' };
  }
  const pane = document.querySelector('.notice-pane');
  if (!shown(pane)) return { ok: false, why: '右邊沒有顯示通知內容' };
  const body = pane.querySelector('.nt-body');
  if (!body || body.querySelector('b') || !body.textContent.includes('<b>不認得</b>')) return { ok: false, why: '通知內容沒有用純文字顯示' };
  if (pane.querySelector('textarea, .compose-row')) return { ok: false, why: '通知內容不該有輸入列' };
  if (document.querySelector('.chat-stack .compose-row')) return { ok: false, why: '通知被開成一般對話分頁' };
  if (badge() !== '3') return { ok: false, why: '點開一則後未讀數應剩 3，實際：' + (badge() || '沒有') };
  if (mode === 'narrow') {
    const list = document.querySelector('.shell > .list-pane');
    if (shown(list)) return { ok: false, why: '窄視窗點開通知後應只顯示右邊' };
    const back = document.querySelector('.chat-area .pane-back');
    if (!shown(back) || back.textContent.replace(/\\s+/g, '') !== '‹通知') return { ok: false, why: '返回鈕應寫「‹ 通知」，實際：' + (back ? back.textContent.trim() : '沒有') };
    back.click(); await sleep(400);
    if (!shown(list) || !document.querySelector('.notice-list')) return { ok: false, why: '按返回後應回到通知清單' };
    if (!noScroll()) return { ok: false, why: '通知清單單獨顯示時出現橫向捲動' };
    document.querySelector('.notice-list .nt-row').click(); await sleep(400);
    if (shown(list) || !shown(document.querySelector('.notice-pane'))) return { ok: false, why: '再點一次應切回右邊的通知內容' };
  }
  return noScroll() ? { ok: true, why: '' } : { ok: false, why: '點開後出現橫向捲動：' + document.documentElement.scrollWidth };
})()`

export default {
  key: 'dnotice',
  kind: '電腦版通知頁籤檢查',
  source: probe => dnoticeProbeSource(probe),
}
