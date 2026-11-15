// 冒煙探測「手機舊收發室列併進通知檢查」（probe.mnoticeLegacy）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

// 手機舊「○○收發室」聯絡人列不再出現在夥伴頁／對話頁、改集中在「通知」分頁（#895 驗收，重現 11-06 截圖）：
// 「30家用」節點底下本機存檔裡留著五個舊系統寄件人（沒 kind、各有信），後台另來一封新式通知（kind）與一封舊名無 kind 的信，外加兩位正常夥伴。
// view: 'list'＝存檔停在夥伴頁；'lastchat'＝最後使用的對話是某個舊收發室列（升級前的狀態），對話頁不該還開著它
export const LEGACY_SENDERS = [
  { agent: '終端服務收發室', text: '終端服務：設備 30家用 的終端已就緒。' },
  { agent: '登入通知收發室', text: '登入通知：你的帳號剛在新設備登入。' },
  { agent: '等待確認收發室', text: '等待確認：夥伴 demo 正在等你確認。' },
  { agent: '額度通知收發室', text: '額度通知：Claude 額度剩 25%。' },
  { agent: 'H-收發室', text: 'H 設備：本機服務已重新啟動。' },
]

export const mnoticeLegacyProbeSource = ({ view }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  const view = ${JSON.stringify(view)};
  const SENDERS = ${JSON.stringify(LEGACY_SENDERS.map(s => s.agent))};
  const MARKS = ${JSON.stringify([...LEGACY_SENDERS.map(s => s.text.slice(0, 8)), '設備金鑰剛換過', '舊寄件名、沒有類別'])};
  const legacyName = t => { const s = String(t || '').trim(); return s.endsWith('收發室') || s === 'ASN 通知' };
  let tabs = [];
  for (let i = 0; i < 60 && tabs.length < 4; i++) { tabs = [...document.querySelectorAll('.m-tabs button')]; if (tabs.length < 4) await sleep(100) }
  if (tabs.length !== 4) return { ok: false, why: '頁籤應該固定四個，實際 ' + tabs.length };
  const tab = l => tabs.find(b => b.querySelector('span')?.textContent.trim() === l);   // 用字找分頁，不靠位置（#1429 改過順序）
  const pg = label => document.querySelector('section.m-pg[aria-label="' + label + '"]');
  const nicks = () => [...pg('夥伴').querySelectorAll('.m-buddy .b-nick')].map(e => e.textContent.trim());
  for (let i = 0; i < 80 && !(nicks().includes('小工') && nicks().includes('alpha')); i++) await sleep(100);
  for (let i = 0; i < 80 && document.querySelector('.m-banner'); i++) await sleep(100);   // 新通知的橫幅幾秒後自己消失
  await sleep(600);
  // 1) 夥伴頁：正常夥伴在、沒有任何舊系統寄件人列
  const names = nicks();
  for (const n of ['demo', '小工', 'alpha']) if (!names.includes(n)) return { ok: false, why: '夥伴頁少了正常夥伴「' + n + '」：' + names.join('、') };
  const bad = names.filter(legacyName);
  if (bad.length) return { ok: false, why: '夥伴頁還列著系統寄件人：' + [...new Set(bad)].join('、') };
  const listText = pg('夥伴').textContent;
  for (const s of SENDERS) if (listText.includes(s)) return { ok: false, why: '夥伴頁的文字裡還出現「' + s + '」' };
  if (names.includes('通知')) return { ok: false, why: '夥伴頁不該再有「通知」列（通知有自己的分頁）：' + names.join('、') };
  // 2) 對話頁：清單與內容都沒有舊收發室的對話（列、標題、內容都不能有）
  tab('對話').click();
  await sleep(700);
  const chat = pg('對話');
  const rows = [...chat.querySelectorAll('.m-buddy .b-nick')].map(e => e.textContent.trim());
  if (rows.some(legacyName)) return { ok: false, why: '對話清單列著系統寄件人：' + rows.join('、') };
  const title = chat.querySelector('.m-head .m-title')?.textContent.trim() || '';
  if (legacyName(title)) return { ok: false, why: '對話頁開著舊系統寄件人的對話：「' + title + '」' };
  for (const s of SENDERS) if (chat.textContent.includes(s)) return { ok: false, why: '對話頁的文字裡還出現「' + s + '」' };
  for (const w of MARKS) if (chat.textContent.includes(w)) return { ok: false, why: '對話頁顯示了通知內容「' + w + '」（通知只該在通知分頁）' };
  // 3) 「通知」分頁：每位系統寄件人的信都看得到，唯讀，版面不超出畫面寬度
  tab('通知').click();
  await sleep(900);
  if (!tab('通知').classList.contains('on')) return { ok: false, why: '點通知那一格後沒有選中通知' };
  const pane = document.querySelector('.m-notice');
  if (!pane || !vis(pane)) return { ok: false, why: '看不到通知分頁的內容' };
  const text = pane.textContent;
  for (const w of MARKS) if (!text.includes(w)) return { ok: false, why: '通知裡找不到「' + w + '」' };
  if (pane.querySelector('textarea, .compose-row')) return { ok: false, why: '通知是唯讀，不該有輸入列' };
  const W = window.innerWidth;
  if (document.documentElement.scrollWidth > W + 1 || document.body.scrollWidth > W + 1) return { ok: false, why: '整頁橫向溢出：' + document.documentElement.scrollWidth + ' > ' + W };
  if (pane.scrollWidth > pane.clientWidth + 1) return { ok: false, why: '通知內容橫向溢出：' + pane.scrollWidth + ' > ' + pane.clientWidth };
  for (const e of pane.querySelectorAll('.msg, .msg *')) {
    const r = e.getBoundingClientRect();
    if (r.width > 0 && (r.right > W + 1 || r.left < -1)) return { ok: false, why: '通知內容超出畫面寬度：' + (e.className || e.tagName) + ' ' + Math.round(r.left) + '~' + Math.round(r.right) + ' / ' + W };
  }
  return { ok: true, why: '' };
})()`

export default {
  key: 'mnoticeLegacy',
  kind: '手機舊收發室列併進通知檢查',
  source: probe => mnoticeLegacyProbeSource(probe),
}
