// 冒煙探測「卡在第一次問的畫面：離線也給終端入口＋小字」（probe.stuckTerm，#1632）。由 smoke-registry.mjs 自動收集
// 'trust'：夥伴離線、讀畫面標 trust、在共用終端服務裡 → 上排有「終端」、下方有小字；'none'：離線沒有標記 → 照舊沒有「終端」也沒有小字
import { LTERM_NODE } from '../smoke-desk-term.mjs'

const MEMBERS = [{ id: LTERM_NODE, name: '測試機', agents: [{ name: 'demo', status: 'idle', online: false, cwd_label: 'demo' }] }]

export default {
  key: 'stuckTerm',
  kind: '卡住夥伴的終端入口檢查',
  source: probe => `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const wait = async (fn, n = 40) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
    const vis = sel => [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length > 0);
    const term = () => vis('.chatpane .actionbar button').find(b => (b.getAttribute('aria-label') || b.textContent || '').includes('終端'));
    const note = () => vis('.term-stuck-note')[0];
    if (${JSON.stringify(probe.stuckTerm)} === 'trust') {
      if (!(await wait(term))) return { ok: false, why: '離線但卡在信任資料夾：按鈕列沒有「終端」' };
      const n = await wait(note);
      if (!n) return { ok: false, why: '沒有那行小字' };
      if (!n.textContent.includes('打開終端') || !n.textContent.includes('Yes, I trust this folder')) return { ok: false, why: '小字內容不對：' + n.textContent };
      return { ok: true };
    }
    await sleep(2500);
    if (term()) return { ok: false, why: '離線、沒有卡住的標記，不該有「終端」' };
    if (note()) return { ok: false, why: '沒有卡住的標記，不該有小字' };
    return { ok: true };
  })()`,
  table: scenario => (scenario.probe?.stuckTerm ? {
    relay_list: { members: MEMBERS },
    partner_notices: scenario.probe.stuckTerm === 'trust' ? [{ name: 'demo', code: 'trust' }] : [],
  } : undefined),
  scenarios: [
    { name: 'list-term-stuck-trust', page: 'list.html', state: { signedIn: true, dtermLocal: true }, ready: '#app.win .chatpane .actionbar', probe: { stuckTerm: 'trust' }, shot: 'list-term-stuck-trust-1100.png' },
    { name: 'list-term-stuck-none', page: 'list.html', state: { signedIn: true, dtermLocal: true }, ready: '#app.win .chatpane .actionbar', probe: { stuckTerm: 'none' }, shot: 'list-term-stuck-none-1100.png' },
  ],
}
