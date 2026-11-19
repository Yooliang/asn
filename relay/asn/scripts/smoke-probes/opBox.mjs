// 冒煙探測「還留框的夥伴操作進度，右下角按鈕只寫『關閉』」（probe.opBox，#1800 擁有者補充）。
// 查詳情會在框裡列結果，所以框留著：進行中的框，右下角按鈕要寫「關閉」，不能是「不查了」或帶括號的說明。
// 後台假資料：partner_ops 一直 pending（還在查）。
export const opBoxProbeSource = ({ mode }) => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const phone = ${JSON.stringify(mode)} === 'phone';
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const find = async (sel, text, n = 60) => { for (let i = 0; i < n; i++) { const el = [...document.querySelectorAll(sel)].find(e => vis(e) && (!text || e.textContent.includes(text))); if (el) return el; await sleep(100) } return null };
  const opener = await find(phone ? '.m-head-more, .m-plate' : '.actionbar .abtn[aria-label="管理"], .mbtn[data-slot="more"]');
  if (!opener) return { ok: false, why: '找不到管理夥伴的入口' };
  opener.click();
  const item = await find(phone ? '.m-ops-item:not(.off)' : '.ab-ops button:not(.off)', '詳情');
  if (!item) return { ok: false, why: '管理選單裡找不到能按的「詳情」' };
  item.click();
  const bar = await find(phone ? '.m-ops .m-bar' : '.dlg .partner-actions');   // 進度框出現了（手機是進度條、電腦是按鈕列）
  if (!bar) return { ok: false, why: '查詳情後沒有看到進度框' };
  const btn = await find(phone ? '.m-ops .m-ops-cancel' : '.dlg .partner-actions button:last-child');
  if (!btn) return { ok: false, why: '查詳情的框沒有右下角的按鈕' };
  const label = btn.textContent.trim();
  if (label !== '關閉') return { ok: false, why: '右下角按鈕只能寫「關閉」，現在是：' + label };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const SKINS = [['', 'aero'], ['modern', 'modern'], ['line', 'line']]
const scenarios = []
for (const [skin, label] of SKINS) {
  const s = skin ? { skin } : {}
  scenarios.push(
    { name: `list-opbox-${label}`, page: 'list.html', width: 900, height: 640, state: { signedIn: true, partnerTab: true, opBox: true, ...s }, ready: '#app.win .actionbar', probe: { opBox: { mode: 'desk' } }, shot: `list-opbox-${label}.png` },
    { name: `m-opbox-${label}`, page: 'm.html', state: { signedIn: true, mbar: 'claude', chatMsgs: true, opBox: true, ...s }, ready: '#app.m .m-chat .chatpane', probe: { opBox: { mode: 'phone' } }, shot: `m-opbox-${label}.png` },
  )
}

export default {
  key: 'opBox',
  kind: '夥伴操作進度框的按鈕檢查',
  source: probe => opBoxProbeSource(probe.opBox),
  scenarios,
  table: scenario => {
    if (!scenario.state?.opBox) return undefined
    const row = { id: 'op-1', status: 'pending' }
    return {
      relay_launchers: { machines: [{ node: 'P', online: true, launcher: { profiles: [{ id: 'claude' }], cwd_allow: [] } }] },
      android_launchers: { machines: [{ node: 'Q', online: true, launcher: { profiles: [{ id: 'claude' }], cwd_allow: [] } }] },
      relay_partner_op: { id: 'op-1' }, android_partner_op: { id: 'op-1' },
      relay_partner_ops: { ops: [row] }, android_partner_ops: { ops: [row] },
    }
  },
}
