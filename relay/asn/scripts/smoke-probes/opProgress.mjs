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
  const boxSel = '.chatpane .typing.typing-op';   // #2177：進度就是對話最下面那條狀態列（取代「上次接收訊息」），電腦與手機同一條
  // 一、打開「管理」→「關閉視窗」→ 確認
  const opener = await find(phone ? '.m-head-more, .m-plate' : '.actionbar .abtn[aria-label="管理"], .mbtn[data-slot="more"]');
  if (!opener) return { ok: false, why: '找不到管理夥伴的入口' };
  opener.click();
  const label = want === 'agents' ? '換班接手' : '關閉視窗';   // #1908：換班接手等子代理時的進度行
  const item = await find(phone ? '.m-ops-item:not(.off)' : '.ab-ops button:not(.off)', label);
  if (!item) return { ok: false, why: '管理選單裡找不到能按的「' + label + '」' };
  item.click();
  const ok = await find(phone ? '.m-ops-panel .m-btn-big' : '.dlg .partner-actions button:last-child');
  if (!ok) return { ok: false, why: '找不到確認鈕' };
  ok.click();
  // 二、送出後擋畫面的框一定要收起來（不管進行中、成功或失敗）
  for (let i = 0; i < 30 && blocker(); i++) await sleep(100);
  if (blocker()) return { ok: false, why: '送出後還有擋住畫面的框（進度應該就地顯示）' };
  const box = await find(boxSel, '');
  if (!box) return { ok: false, why: '送出後畫面上沒有就地的進度' };
  // 位置與只有一行（#2177）：進度直接顯示在最下面那條狀態列，取代「上次接收訊息」；對話窗裡不能再多一條獨立的進度列
  const pane = box.closest('.chatpane');
  if (!pane || pane.querySelectorAll(':scope .typing').length !== 1) return { ok: false, why: (phone ? '手機' : '電腦') + '的對話窗最下面只該有一條狀態列' };
  if (pane.querySelector('.op-strip-row, .op-slot, .m-ops-run')) return { ok: false, why: '進度不該另外多一條獨立的進度列' };
  if (/上次接收訊息/.test(box.textContent)) return { ok: false, why: '進度中這一行不該同時寫「上次接收訊息」' };
  const text = () => (document.querySelector(boxSel)?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  if (/先關掉（照常進行）/.test(document.body.textContent)) return { ok: false, why: '畫面上不該再有「先關掉（照常進行）」' };
  const btns = () => [...document.querySelectorAll(boxSel + ' button')].map(b => b.textContent.trim());
  if (want === 'agents') {
    // #1908：電腦端回報 stage:agents:2 → 同一條狀態列寫「等 2 個子代理做完」，沒有按鈕、不擋畫面、不露出階段代號
    let t2 = '';
    for (let i = 0; i < 80; i++) { t2 = text(); if (/子代理做完/.test(t2)) break; await sleep(100) }
    if (!/等 2 個子代理做完/.test(t2)) return { ok: false, why: '換班等子代理時應寫「等 2 個子代理做完」：' + t2 };
    if (/stage|agents/.test(t2)) return { ok: false, why: '畫面不該露出階段代號：' + t2 };
    if (btns().length) return { ok: false, why: '等子代理時狀態列不放按鈕：' + btns().join('、') };
    if (blocker()) return { ok: false, why: '等子代理時不該有擋畫面的框' };
    return { ok: true, why: '' };
  }
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
  agents: { id: 'op-1', status: 'taken', detail: 'stage:agents:2' },
}
const SKINS = [['', 'aero'], ['modern', 'modern'], ['line', 'line']]
const scenarios = []
for (const want of ['working', 'done', 'failed', 'agents']) {
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
