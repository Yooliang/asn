// 冒煙探測「手機夥伴頁未讀檢查」（probe.munread）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const munreadProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let tabs = [];
  for (let i = 0; i < 60 && tabs.length < 4; i++) { tabs = [...document.querySelectorAll('.m-tabs button')]; if (tabs.length < 4) await sleep(100) }
  const tab = l => tabs.find(b => b.querySelector('span')?.textContent.trim() === l);
  const grp = () => document.querySelector('section.m-pg[aria-label="夥伴"] .m-unread');
  const rows = () => [...(grp()?.querySelectorAll('li .m-buddy') || [])].map(b => [b.querySelector('.b-nick')?.textContent.trim(), b.querySelector('.unread')?.textContent.trim()]);
  for (let i = 0; i < 80 && rows().length < 2; i++) await sleep(100);
  if (!grp()) return { ok: false, why: '夥伴頁最上面沒有「未讀」' };
  const head = grp().querySelector('.m-ghead')?.textContent.replace(/\\s+/g, '') || '';
  if (!head.includes('未讀（2）')) return { ok: false, why: '「未讀」的標題不對：' + head };
  if (JSON.stringify(rows()) !== JSON.stringify([['小工', '1'], ['demo', '2']])) return { ok: false, why: '「未讀」的順序或數字不對（要最新的在前）：' + JSON.stringify(rows()) };
  const first = document.querySelector('section.m-pg[aria-label="夥伴"] .m-group');
  if (first !== grp()) return { ok: false, why: '「未讀」要在夥伴頁最上面' };
  if (!tab('夥伴').querySelector('i.red')) return { ok: false, why: '有未讀，「夥伴」分頁卻沒有紅點' };
  if (tab('對話').querySelector('i.red')) return { ok: false, why: '「對話」分頁不該有紅點（#1429）' };
  grp().querySelector('li .m-buddy').click(); await sleep(800);
  const chat = document.querySelector('section.m-pg[aria-label="對話"]');
  if (!tab('對話').classList.contains('on')) return { ok: false, why: '點了沒有切到對話分頁' };
  if (!(chat.querySelector('.m-head .m-title')?.textContent || '').includes('小工')) return { ok: false, why: '對話分頁沒有直接開那一位' };
  tab('夥伴').click(); await sleep(800);
  if (JSON.stringify(rows()) !== JSON.stringify([['demo', '2']])) return { ok: false, why: '讀完的那一列要離開「未讀」：' + JSON.stringify(rows()) };
  if (!tab('夥伴').querySelector('i.red')) return { ok: false, why: '還有 demo 沒讀，紅點要留著' };
  // #1442：夥伴頁有搜尋字時藏起「未讀」，紅點照舊；清掉搜尋字再出現
  const box = document.querySelector('section.m-pg[aria-label="夥伴"] .m-search input');
  if (!box) return { ok: false, why: '夥伴頁沒有搜尋框' };
  box.value = 'demo'; box.dispatchEvent(new Event('input', { bubbles: true })); await sleep(300);
  if (grp()) return { ok: false, why: '有搜尋字時「未讀」應該藏起來' };
  if (!tab('夥伴').querySelector('i.red')) return { ok: false, why: '搜尋時紅點不該消失' };
  box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); await sleep(300);
  if (!grp()) return { ok: false, why: '清掉搜尋字後「未讀」要回來' };
  return { ok: true, why: '' };
})()`

export default {
  key: 'munread',
  kind: '手機夥伴頁未讀檢查',
  source: () => munreadProbeSource(),
}
