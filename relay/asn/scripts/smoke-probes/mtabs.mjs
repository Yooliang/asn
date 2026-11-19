// 冒煙探測「手機四個分頁檢查」（probe.mtabs）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const mtabsProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const inView = e => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.left > -2 && r.right < innerWidth + 2 };
  let tabs = [];
  for (let i = 0; i < 60 && tabs.length < 4; i++) { tabs = [...document.querySelectorAll('.m-tabs button')]; if (tabs.length < 4) await sleep(100) }
  const labels = tabs.map(b => b.textContent.trim()).join('|');
  if (labels !== '夥伴|對話|設定|通知') return { ok: false, why: '分頁的字或順序不對：' + labels };
  const tab = l => tabs.find(b => b.querySelector('span')?.textContent.trim() === l);   // 用字找分頁，不靠位置（#1429 改過順序）
  if (!tab('對話').classList.contains('on')) return { ok: false, why: '開 App 應該先在「對話」（順序改了，預設停的頁不變）' };
  // #1438（擁有者選 B）：對話分頁直接就是最後那一則，不先列清單、沒有回清單的鍵
  const sec = () => document.querySelector('section.m-pg[aria-label="對話"]');
  for (let i = 0; i < 60 && !inView(sec().querySelector('.chatpane')); i++) await sleep(100);
  if (!inView(sec().querySelector('.chatpane'))) return { ok: false, why: '對話分頁應該直接是上次那一則' };
  if (sec().querySelector('.m-chat-list, .m-buddy, .m-search')) return { ok: false, why: '對話分頁不該再列清單' };
  if (sec().querySelector('[aria-label="回對話清單"]')) return { ok: false, why: '沒有清單了，不該有回清單的鍵' };
  if (!(sec().querySelector('.m-head .m-title')?.textContent || '').includes('demo')) return { ok: false, why: '對話分頁開的不是上次那一位' };
  tab('設定').click(); await sleep(500);
  const about = [...document.querySelectorAll('section.m-pg[aria-label="設定"] .m-row-btn')].find(b => b.textContent.includes('關於'));
  if (!about) return { ok: false, why: '設定裡找不到「關於」' };
  about.click(); await sleep(600);
  const page = document.querySelector('.m-fourth');
  if (!inView(page)) return { ok: false, why: '「關於」內頁沒有出現在畫面上' };
  // #1439：「關於」有簡介、版本、連結（官網、版本紀錄、隱私權政策、使用指引）、出品；內容不撐破畫面寬度
  const aboutText = page.textContent;
  const aboutMissing = ['Agent Sync Network', '版本 ', '官網', '版本紀錄', '隱私權政策', '使用指引', 'Yooliang'].filter(w => !aboutText.includes(w));
  if (aboutMissing.length) return { ok: false, why: '「關於」少了：' + aboutMissing.join('、') };
  if (page.scrollWidth > page.clientWidth + 1) return { ok: false, why: '「關於」內容超出畫面寬度' };
  // #1429：內頁暫時佔第四格（通知那一格），分頁字換成內頁的標題、選中第四格；分頁還是四個
  let cur = [...document.querySelectorAll('.m-tabs button')];
  if (cur.length !== 4) return { ok: false, why: '內頁不該多出一個分頁' };
  const fourthLabel = () => [...document.querySelectorAll('.m-tabs button')][3]?.querySelector('span')?.textContent.trim();
  if (fourthLabel() !== '關於') return { ok: false, why: '第四格應該換成內頁「關於」，實際：' + fourthLabel() };
  if (!cur[3].classList.contains('on')) return { ok: false, why: '在內頁上分頁列應該標著第四格' };
  const pg = document.querySelector('.m-fourth').getBoundingClientRect();
  if (Math.abs(pg.left) > 2) return { ok: false, why: '內頁沒有停在畫面上（第四格）' };
  tab('夥伴').click(); await sleep(600);
  if (inView(document.querySelector('.m-fourth'))) return { ok: false, why: '切到夥伴後內頁還蓋在畫面上' };
  if (fourthLabel() !== '關於') return { ok: false, why: '離開內頁後第四格應該還是「關於」（3 分鐘內）' };
  [...document.querySelectorAll('.m-tabs button')][3].click(); await sleep(600);
  if (!inView(document.querySelector('.m-fourth'))) return { ok: false, why: '點第四格沒有回到「關於」內頁' };
  return { ok: true, why: '' };
})()`

export default {
  key: 'mtabs',
  kind: '手機四個分頁檢查',
  source: () => mtabsProbeSource(),
}
