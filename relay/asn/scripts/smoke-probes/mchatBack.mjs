// 冒煙探測「手機對話返回鈕檢查」（probe.mchatBack）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const mchatBackProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const sec = () => document.querySelector('section.m-pg.m-chat');
  let back = null;
  for (let i = 0; i < 60 && !back; i++) { back = sec()?.querySelector('.m-chathead .m-back'); if (!back || back.offsetParent === null) { back = null; await sleep(100) } }
  if (!back) return { ok: false, why: '對話頂端左邊沒有「返回」鈕' };
  if (!/夥伴/.test(back.getAttribute('aria-label') || '')) return { ok: false, why: '返回鈕的說明要寫回夥伴：' + back.getAttribute('aria-label') };
  const head = back.closest('.m-chathead');
  const b = back.getBoundingClientRect(), h = head.getBoundingClientRect();
  if (b.left > h.left + h.width / 3) return { ok: false, why: '返回鈕要在頂端左邊' };
  const plate = head.querySelector('.m-plate');
  if (plate && plate.offsetParent !== null) {
    const p = plate.getBoundingClientRect();
    if (Math.abs((p.left + p.right) / 2 - (h.left + h.right) / 2) > 4) return { ok: false, why: '名牌沒有置中：差 ' + Math.round((p.left + p.right) / 2 - (h.left + h.right) / 2) + 'px' };
    if (b.right > p.left) return { ok: false, why: '返回鈕和名牌重疊' };
  } else {
    const pic = head.querySelector('.m-pic');
    if (pic && b.right > pic.getBoundingClientRect().left + 1) return { ok: false, why: '返回鈕和頭像重疊' };
  }
  if (document.documentElement.scrollWidth > innerWidth + 1) return { ok: false, why: '出現橫向捲動' };
  const before = history.length;
  back.click();
  let on = '';
  for (let i = 0; i < 40 && on !== '夥伴'; i++) { await sleep(100); on = document.querySelector('.m-tabs button.on span')?.textContent.trim() || '' }
  if (on !== '夥伴') return { ok: false, why: '按返回沒有切到夥伴分頁，現在是 ' + on };
  if (!document.querySelector('section.m-pg[aria-label="夥伴"] .m-buddy')) return { ok: false, why: '夥伴分頁沒有內容' };
  return { ok: true, why: '' };
})()`

export default {
  key: 'mchatBack',
  kind: '手機對話返回鈕檢查',
  source: () => mchatBackProbeSource(),
}
