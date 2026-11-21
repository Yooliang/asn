// 冒煙探測「夥伴操作進度就地顯示」（probe.opProgress，#1800）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 對一位在線的夥伴按「關閉視窗」→ 確認：對話框要立刻收起、進度顯示在畫面上（電腦＝功能列下方的提示列、手機＝對話頁頂端），
// 進行中沒有任何擋畫面的框、也沒有只有一顆「先關掉」的按鈕；成功顯示結果；失敗用白話說明，不放按鈕（#1907，留著直到下一個操作蓋掉）。
// 後台假資料：partner_op 回一個 id；partner_ops 依情境一直 pending（進行中）、回 ok（成功）、回 failed（失敗）。

export const opProgressProbeSource = ({ mode, want }) => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const phone = ${JSON.stringify(mode)} === 'phone', want = ${JSON.stringify(want)};
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const find = async (sel, text, n = 60) => { for (let i = 0; i < n; i++) { const el = [...document.querySelectorAll(sel)].find(e => vis(e) && (!text || e.textContent.includes(text))); if (el) return el; await sleep(100) } return null };
  const blocker = () => phone ? document.querySelector('.m-ops, .gs-back') : document.querySelector('.dlg-back');
  const boxSel = phone ? '.m-ops-run' : '.op-strip-row';
  // 一、打開「管理」→「關閉視窗」→ 確認
  const opener = await find(phone ? '.m-head-more, .m-plate' : '.actionbar .abtn[aria-label="管理"], .mbtn[data-slot="more"]');
  if (!opener) return { ok: false, why: '找不到管理夥伴的入口' };
  opener.click();
  const item = await find(phone ? '.m-ops-item:not(.off)' : '.ab-ops button:not(.off)', '關閉視窗');
  if (!item) return { ok: false, why: '管理選單裡找不到能按的「關閉視窗」' };
  item.click();
  const ok = await find(phone ? '.m-ops-panel .m-btn-big' : '.dlg .partner-actions button:last-child');
  if (!ok) return { ok: false, why: '找不到確認鈕' };
  ok.click();
  // 二、送出後擋畫面的框一定要收起來（不管進行中、成功或失敗）
  for (let i = 0; i < 30 && blocker(); i++) await sleep(100);
  if (blocker()) return { ok: false, why: '送出後還有擋住畫面的框（進度應該就地顯示）' };
  const box = await find(boxSel, '');
  if (!box) return { ok: false, why: '送出後畫面上沒有就地的進度' };
  // 位置（#1907）：電腦＝對話窗最下面那一格（.op-slot，在最下面的狀態列之後）；手機＝輸入區下面、在對話內容之後
  if (phone) { const pane = document.querySelector('.m-chat .chatpane'); if (!pane || !(pane.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING)) return { ok: false, why: '手機的狀態列要在對話與輸入區之後（最下面）' } }
  else { const slot = box.closest('.op-slot'); const typing = slot?.parentElement?.querySelector(':scope > .typing'); if (!slot || !typing || !(typing.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING)) return { ok: false, why: '電腦的狀態列要在對話窗最下面（最下面那條狀態列之後）' } }
  const text = () => (document.querySelector(boxSel)?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  if (/先關掉（照常進行）/.test(document.body.textContent)) return { ok: false, why: '畫面上不該再有「先關掉（照常進行）」' };
  const btns = () => [...document.querySelectorAll(boxSel + ' button')].map(b => b.textContent.trim());
  if (want === 'working') {
    if (!/正在/.test(text())) return { ok: false, why: '進行中應寫「正在…」：' + text() };
    if (btns().length) return { ok: false, why: '進行中不需要任何按鈕：' + btns().join('、') };
    await sleep(3500);   // 輪詢一次後仍在進行：不能自己消失或變成別的
    if (!/正在/.test(text()) || blocker()) return { ok: false, why: '進行中等了一輪輪詢後變了：' + text() };
    return { ok: true, why: '' };
  }
  // 成功／失敗要等第一次輪詢（約 3 秒）
  let t = '';
  for (let i = 0; i < 80; i++) { t = text(); if (!/正在/.test(t) && t) break; await sleep(100) }
  if (want === 'done') {
    if (!/已關閉/.test(t)) return { ok: false, why: '成功應顯示結果「已關閉」：' + t };
    if (blocker()) return { ok: false, why: '成功時不該有擋畫面的框' };
    return { ok: true, why: '' };
  }
  if (!/沒有成功/.test(t)) return { ok: false, why: '失敗應用白話說明：' + t };
  if (/HTTP|partner_op|found|error/i.test(t)) return { ok: false, why: '失敗訊息露出英文原文：' + t };
  if (btns().length) return { ok: false, why: '失敗時狀態列不放任何按鈕（#1907）：' + btns().join('、') }
  if (blocker()) return { ok: false, why: '失敗時不該有擋畫面的框' };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const STATUS = {
  working: { id: 'op-1', status: 'pending' },
  done: { id: 'op-1', status: 'ok' },
  failed: { id: 'op-1', status: 'failed', detail: '找不到這個視窗' },
}
const SKINS = [['', 'aero'], ['modern', 'modern'], ['line', 'line']]
const scenarios = []
for (const want of ['working', 'done', 'failed']) {
  for (const [skin, label] of SKINS) {
    const s = skin ? { skin } : {}
    scenarios.push(
      { name: `list-op-${want}-${label}`, page: 'list.html', width: 900, height: 640, state: { signedIn: true, partnerTab: true, opProgress: want, ...s }, ready: '#app.win .actionbar', probe: { opProgress: { mode: 'desk', want } }, shot: `list-op-${want}-${label}.png` },
      { name: `m-op-${want}-${label}`, page: 'm.html', state: { signedIn: true, mbar: 'claude', chatMsgs: true, opProgress: want, ...s }, ready: '#app.m .m-chat .chatpane', probe: { opProgress: { mode: 'phone', want } }, shot: `m-op-${want}-${label}.png` },
    )
  }
}

export default {
  key: 'opProgress',
  kind: '夥伴操作進度就地顯示檢查',
  source: probe => opProgressProbeSource(probe.opProgress),
  scenarios,
  table: scenario => {
    const want = scenario.state?.opProgress
    if (!want) return undefined
    const row = STATUS[want]
    return {
      relay_launchers: { machines: [{ node: 'P', online: true, launcher: { profiles: [{ id: 'claude' }], cwd_allow: [] } }] },
      android_launchers: { machines: [{ node: 'Q', online: true, launcher: { profiles: [{ id: 'claude' }], cwd_allow: [] } }] },
      relay_partner_op: { id: 'op-1' }, android_partner_op: { id: 'op-1' },
      relay_partner_ops: { ops: [row] }, android_partner_ops: { ops: [row] },
    }
  },
}
