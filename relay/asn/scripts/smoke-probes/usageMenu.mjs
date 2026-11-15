// 冒煙探測「手機額度選單按鈕檢查」（probe.usageMenu，#1512 A）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 情境與假後台欄位都放在這個檔：手機權限框的列表換成額度選單那一筆（其餘沿用 mpermreq 的假後台）

// 額度用完的選單（#1512 A）：電腦端只送固定文字和兩個不花錢的選項（停下來等、在這裡等），付費選項與畫面原文都不送。
// 手機的權限框不用改：照樣跳出、只有這兩顆、按第一顆就送出那一項的編號與雜湊。字跟 claude_screen.rs 的 PHONE_USAGE_* 同一組（smoke-ui.test 核對）
export const USAGE_MENU_TEXT = '額度用完了，Claude 在問接下來要怎麼做。\n付費相關的選項（改用額度點數、加值、升級方案）只能在電腦上選。'
export const USAGE_MENU_LABELS = ['停下來，等額度恢復', '在這裡等，額度恢復後自動繼續']
export const usageMenuRows = () => [{ id: '11111111-2222-3333-4444-555555555557', node: 'Q', window_name: 'demo', prompt_text: USAGE_MENU_TEXT, complete: true, options: USAGE_MENU_LABELS.map((label, i) => ({ n: i + 1, label })), body_hash: 'd'.repeat(64), expires_at: new Date(Date.now() + 600000).toISOString() }]
export const usageMenuProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let panel = null;
  for (let i = 0; i < 80 && !panel; i++) { panel = document.querySelector('.m-ops-panel .m-perm-text')?.closest('.m-ops-panel'); if (!panel) { for (const fn of ((globalThis.__smokeListeners || {})['relay-bell'] || [])) fn({ event: 'relay-bell', payload: null }); await sleep(100) } }
  if (!panel) return { ok: false, why: '額度選單的提示框沒有跳出來' };
  await sleep(900);   // 等 ARM_MS
  const text = panel.querySelector('.m-perm-text').textContent;
  if (!text.includes('額度用完了')) return { ok: false, why: '提示框沒有顯示固定文字：' + text.slice(0, 40) };
  for (const raw of ['Switch to usage credits', 'What do you want', 'Nov 16', 'weekly limit']) if (panel.textContent.includes(raw)) return { ok: false, why: '提示框出現畫面原文：' + raw };
  if (panel.querySelector('.m-perm-warn')) return { ok: false, why: '額度選單不該有危險警告' };
  const btns = [...panel.querySelectorAll('.m-term-opt')];
  const labels = btns.map(b => b.textContent.trim());
  const want = ${JSON.stringify(USAGE_MENU_LABELS)};
  if (labels.length !== 2 || !want.every((w, i) => labels[i].includes(w))) return { ok: false, why: '按鈕應該只有「停下來等」「在這裡等」兩顆：' + JSON.stringify(labels) };
  if (btns.some(b => b.classList.contains('m-hold'))) return { ok: false, why: '這兩顆不用按住' };
  const decided = () => (globalThis.__smokeCalls || []).filter(c => c[0] === 'android_perm_req_decide');
  btns[0].click();
  for (let i = 0; i < 30 && !decided().length; i++) await sleep(100);
  const d = decided();
  if (d.length !== 1) return { ok: false, why: '按「停下來等」沒有送出（或送了 ' + d.length + ' 次）' };
  const a = d[0][1] || {};
  if (a.choiceN !== 1 || a.hash !== 'd'.repeat(64)) return { ok: false, why: '送出的選項或雜湊不對：' + JSON.stringify(a) };
  if (document.documentElement.scrollWidth > window.innerWidth + 1) return { ok: false, why: '整頁橫向溢出' };
  return { ok: true, why: '' };
})()`

export default {
  key: 'usageMenu',
  kind: '手機額度選單按鈕檢查',
  source: () => usageMenuProbeSource(),
  scenarios: [
    { name: 'm-usage-menu', page: 'm.html', state: { signedIn: true, mpermreq: true, usageMenu: true }, ready: '#app.m .m-pager .m-search', probe: { usageMenu: true }, shot: 'm-usage-menu.png' },
    { name: 'm-usage-menu-line', page: 'm.html', state: { signedIn: true, mpermreq: true, usageMenu: true, skin: 'line' }, ready: '#app.m .m-pager .m-search', probe: { usageMenu: true }, shot: 'm-usage-menu-line.png' },
  ],
  table: scenario => (scenario.state?.usageMenu ? { android_perm_req_list: { requests: usageMenuRows(), recent: [] }, android_perm_req_decide: { ok: true, status: 'decided' } } : undefined),
}
