// 冒煙探測「對話視窗的提示橫幅」（probe.chatNotes，#2425 PR-2）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 已停止的夥伴：
//   - 內建通道的工作者（管理選單的「重開」能按）：warn 橫幅，右邊有「重開」鈕
//   - 一般視窗（「重開」不能按）：info 橫幅，沒有鈕，字寫「要恢復請在夥伴管理按重開」
// 「要重新登入」的橫幅沒有情境：介面狀態從來不會是 login-required（roster.statusOf 把不認得的狀態都當線上），
// 這條路在介面上走不到，要有情境得硬塞假狀態，不是真路徑，所以不做（見 PR 說明）。

export const chatNotesProbeSource = mode => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const want = ${JSON.stringify(mode)};
  const find = () => [...document.querySelectorAll('.conv-main .asn-note-banner')].find(vis) || null;
  let note = null;
  for (let i = 0; i < 80 && !note; i++) { note = find(); if (!note) await sleep(100) }
  if (!note) return { ok: false, why: '對話上方沒有已停止的橫幅' };
  const text = (note.textContent || '').replace(/\\s+/g, ' ');
  if (!text.includes('已停止，寄來的信不會處理')) return { ok: false, why: '橫幅字不對：' + text };
  const btn = note.querySelector('button');
  if (want === 'restart') {
    if (!note.classList.contains('asn-note-warn')) return { ok: false, why: '能重開時要是 warn 橫幅' };
    if (!btn || (btn.textContent || '').trim() !== '重開') return { ok: false, why: 'warn 橫幅要有「重開」鈕' };
  } else {
    if (!note.classList.contains('asn-note-info')) return { ok: false, why: '不能重開時要是 info 橫幅' };
    if (btn) return { ok: false, why: 'info 橫幅不該有鈕' };
    if (!text.includes('夥伴管理按「重開」')) return { ok: false, why: '沒寫怎麼恢復：' + text };
  }
  if (document.querySelector('.conv-main .warn')) return { ok: false, why: '舊的黃條還在' };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const members = acp => [{ id: 'P', agents: [{ name: 'demo', status: 'stopped', cwd_label: 'demo', ...(acp ? { engine: 'gemini' } : {}) }] }]

const desk = (name, bar, mode) => ({ name, page: 'list.html', width: 900, height: 640, state: { signedIn: true, bar, chatNote: mode }, ready: '#app.win .actionbar', probe: { chatNotes: mode }, shot: `${name}.png` })

export default {
  key: 'chatNotes',
  kind: '對話視窗提示橫幅檢查',
  source: probe => chatNotesProbeSource(probe.chatNotes),
  scenarios: [desk('list-chat-stopped-restart', 'acp', 'restart'), desk('list-chat-stopped-info', 'claude', 'info')],
  table: scenario => (scenario.state?.chatNote ? { relay_list: { members: members(scenario.state.chatNote === 'restart') } } : undefined),
}
