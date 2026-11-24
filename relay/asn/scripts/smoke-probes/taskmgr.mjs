// 冒煙探測「工作管理員檢查」（probe.taskmgr）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const TASKMGR_RESUMING_SID = '11111111-2222-4333-8444-555555555555'

export const taskmgrProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  const waitFor = async (fn, n = 80) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const self = await waitFor(() => [...document.querySelectorAll('.dv-list .dv-row')].find(r => !r.querySelector('.dv-grip')));   // 本機那一列沒有排序把手（畫面上不寫「這台」）
  if (!self) return { ok: false, why: '設備列表裡找不到本機那一列' };
  [...self.querySelectorAll('button')].find(b => b.textContent.trim() === '詳情').click();   // 工作管理員入口在詳情頁籤列（#1860）
  const entry = await waitFor(() => [...document.querySelectorAll('.dv-tabs .dv-tasks')].find(vis));
  if (!entry) return { ok: false, why: '這台電腦的詳情頁沒有「工作管理員」入口' };
  entry.click();
  const rows = await waitFor(() => { const r = [...document.querySelectorAll('.tm-tree .tm-node')]; return r.length >= 9 ? r : null });
  if (!rows) return { ok: false, why: '工作管理員沒有列出 9 個節點（實際 ' + document.querySelectorAll('.tm-tree .tm-node').length + ' 個）' };
  // 小字預設收起：沒點開之前看不到程序編號等；每個節點有帶 aria-expanded 的「詳細」鈕
  const treeText = () => document.querySelector('.tm-tree').textContent;
  for (const c of ['程序編號', '記憶體', '開了多久', '運行位置']) if (treeText().includes(c)) return { ok: false, why: '預設應收起小字，卻看到「' + c + '」' };
  const mores = () => [...document.querySelectorAll('.tm-tree .tm-title')];
  if (document.querySelector('.tm-tree .tm-more') || [...document.querySelectorAll('.tm-tree button')].some(b => b.textContent.trim() === '詳細')) return { ok: false, why: '#2219 不該再有「詳細」鈕' };
  const panelText = document.querySelector('.tm').textContent;
  for (const c of ['ASN 管的程式共', '每 5 秒自動更新', '是整個視窗（含底下的程式）合計', '封存只是從名單隱藏', '壓縮次數只算']) if (panelText.includes(c)) return { ok: false, why: '#2219 該拿掉的字還在：「' + c + '」' };
  if (document.querySelector('.dv-dev-h .dv-tag.me')) return { ok: false, why: '#2219 設備細部頁標題旁不該有「這台」標籤' };
  if (mores().length !== document.querySelectorAll('.tm-tree .tm-node').length ||!mores().every(b => b.getAttribute('aria-expanded') === 'false' && b.getAttribute('role') === 'button' && b.tabIndex === 0)) return { ok: false, why: '每個節點的主行都該是收著、可聚焦的展開控制（實際 ' + mores().length + ' 個）' };
  if (!treeText().includes('同名的視窗有兩個時，信可能兩邊都收不到')) return { ok: false, why: '重複列的警示句收起時也要看得到' };
  // 點整列（節點本身）展開：先試一列，再全部展開；按列上的操作鈕不該展開
  const firstNode = document.querySelector('.tm-tree .tm-node[data-kind="mux"]');
  firstNode.click();
  if (!(await waitFor(() => firstNode.querySelector('.tm-title').getAttribute('aria-expanded') === 'true'))) return { ok: false, why: '點整列後那一列沒有展開' };
  firstNode.click();
  if (!(await waitFor(() => firstNode.querySelector('.tm-title').getAttribute('aria-expanded') === 'false'))) return { ok: false, why: '再點整列沒有收回' };
  // 列上的操作鈕不展開那一列：由單元測試 task-tree-1860f 守著
  for (const b of mores()) b.click();
  if (!(await waitFor(() => mores().every(b => b.getAttribute('aria-expanded') === 'true')))) return { ok: false, why: '點主行後小字沒有展開' };
  const labels = [...document.querySelectorAll('.tm-tree .tm-node')].map(n => n.textContent).join('|');
  for (const c of ['引擎', '程序編號', '記憶體', '開了多久', '運行位置']) if (!labels.includes(c)) return { ok: false, why: '節點裡缺「' + c + '」欄位' };
  // 樹狀（#1860 F）：ASN 在最外層、終端服務在它底下、開在終端服務裡的代理再下一層；原生主控台的代理與終端服務並列
  const lvl = sel => document.querySelector('.tm-node' + sel)?.getAttribute('data-level');
  if (lvl('[data-kind="asn"]') !== '1') return { ok: false, why: 'ASN 本體不在最外層（層級 ' + lvl('[data-kind="asn"]') + '）' };
  if (lvl('[data-kind="mux"]') !== '2') return { ok: false, why: '終端服務不在 ASN 底下（層級 ' + lvl('[data-kind="mux"]') + '）' };
  const nodeOfPid = pid => [...document.querySelectorAll('.tm-tree .tm-node')].find(n => n.querySelector('.tm-meta')?.textContent.includes('程序編號 ' + pid));
  if (nodeOfPid(18420)?.getAttribute('data-level') !== '3') return { ok: false, why: '開在終端服務裡的視窗（18420）沒有排在終端服務底下' };
  if (nodeOfPid(3001)?.getAttribute('data-level') !== '2') return { ok: false, why: '原生主控台的視窗（3001）應該和終端服務並列、掛在 ASN 底下' };
  if (!document.querySelector('.tm-node[data-kind="mux"] .tm-state')?.textContent.includes('底下 3 個代理')) return { ok: false, why: '終端服務沒有寫「底下 3 個代理」' };
  // 收合：按終端服務的 ▾ → 底下的視窗不見、▸；再按 → 回來
  const muxFold = document.querySelector('.tm-node[data-kind="mux"] .tm-fold');
  if (!muxFold) return { ok: false, why: '終端服務沒有收合鈕' };
  muxFold.click();
  if (!(await waitFor(() => !nodeOfPid(18420) && document.querySelector('.tm-node[data-kind="mux"]').getAttribute('aria-expanded') === 'false'))) return { ok: false, why: '按了收合，終端服務底下的視窗沒有收起來' };
  document.querySelector('.tm-node[data-kind="mux"] .tm-fold').click();
  if (!(await waitFor(() => nodeOfPid(18420)))) return { ok: false, why: '再按一次，終端服務底下的視窗沒有回來' };
  const dups = [...document.querySelectorAll('.tm-tree .tm-node.dup')];
  if (dups.length !== 2) return { ok: false, why: '「重複」列應該有 2 列，實際 ' + dups.length };
  if (!dups.every(r => r.querySelector('.tm-tag.dup')?.textContent.trim() === '重複')) return { ok: false, why: '重複的列沒有「重複」標記' };
  if (!dups.every(r => r.textContent.includes('同名的視窗有兩個時，信可能兩邊都收不到'))) return { ok: false, why: '重複的列沒有寫出後果' };
  const banner = document.querySelector('.tm-warn');
  if (!banner || !banner.textContent.includes('同名的視窗有兩個時，信可能兩邊都收不到')) return { ok: false, why: '頂部提示沒有寫出後果' };
  const kindRow = k => document.querySelector('.tm-tree .tm-node[data-kind="' + k + '"]');
  for (const k of ['process', 'mux', 'asn']) { const r = kindRow(k); if (!r) return { ok: false, why: '沒有 ' + k + ' 那一列' }; if (r.querySelector('.tm-stop')) return { ok: false, why: '只能看的列（' + k + '）不該有停止鈕' } }
  const text = document.querySelector('.tm').textContent;
  if (!text.includes('—')) return { ok: false, why: '拿不到的欄位沒有顯示「—」' };
  if (!text.includes('3 小時 12 分') || !text.includes('412 MB') || !text.includes('18420')) return { ok: false, why: '欄位內容不對（開了多久／記憶體／程序編號）' };
  if (!document.querySelector('.tm-known summary')?.textContent.includes('認得但目前沒在跑（1）')) return { ok: false, why: '沒有「認得但目前沒在跑」折疊區' };
  if (dups[1].querySelector('.tm-stop')) return { ok: false, why: '自己開的那一列（編號 21096）不該有停止鈕' };
  const stop = await waitFor(() => { const b = dups[0].querySelector('.tm-stop'); return b && !b.disabled ? b : null });
  if (!stop) return { ok: false, why: '重複那一列的停止鈕不能按（' + (dups[0].querySelector('.tm-why')?.textContent || '') + '）' };
  stop.click();
  const dlg = await waitFor(() => document.querySelector('.dlg-back .dlg .tm-confirm'));
  if (!dlg) return { ok: false, why: '按下停止後沒有出現確認框' };
  const body = document.querySelector('.dlg').textContent;
  if (!body.includes('程序編號 18420') || !body.includes('不受影響') || !body.includes('停止這個視窗')) return { ok: false, why: '確認框內容不對：' + body.slice(0, 120) };
  // 卡在接回中的夥伴視窗：有「停止」鈕 → 確認框文字正確 → 確認後只呼叫 term_stop（帶終端編號與對話編號）
  const dlgOpen = () => document.querySelector('.dlg-back .dlg .tm-confirm');
  const cancel = [...document.querySelectorAll('.dlg .partner-actions button')].find(b => b.textContent.trim() === '取消');
  if (!cancel) return { ok: false, why: '確認框沒有「取消」鈕' };
  cancel.click();
  if (!(await waitFor(() => !dlgOpen()))) return { ok: false, why: '按取消後確認框沒有關' };
  const rrow = () => kindRow('resuming');
  if (!rrow()) return { ok: false, why: '沒有「接回中」那一列' };
  const rtext = rrow().textContent;
  if (!rtext.includes('小乙') || !rtext.includes('可能卡住了') || !rtext.includes('終端服務') || !rtext.includes('23100')) return { ok: false, why: '接回中那一列的內容不對：' + rtext.slice(0, 120) };
  if (rtext.includes('11111111')) return { ok: false, why: '接回中那一列不該顯示對話編號' };
  const askResuming = async () => {
    const b = await waitFor(() => { const x = rrow() && rrow().querySelector('.tm-stop'); return x && !x.disabled ? x : null });
    if (!b || b.textContent.trim() !== '停止') return false;
    b.click();
    return Boolean(await waitFor(dlgOpen));
  };
  if (!(await askResuming())) return { ok: false, why: '接回中那一列沒有能按的「停止」鈕，或按了沒有確認框' };
  const rbody = document.querySelector('.dlg').textContent;
  if (!rbody.includes('關掉這個還在接回的終端。對話紀錄不會受影響，之後可以再按喚醒。')) return { ok: false, why: '接回中的確認框文字不對：' + rbody.slice(0, 160) };
  if (dlgOpen().textContent.trim() !== '停止') return { ok: false, why: '接回中的確認鈕應寫「停止」：' + dlgOpen().textContent.trim() };
  if (rbody.includes('11111111')) return { ok: false, why: '確認框不該顯示對話編號' };
  dlgOpen().click();
  const stopCall = await waitFor(() => (globalThis.__smokeCalls || []).find(c => c[0] === 'term_stop'));
  if (!stopCall) return { ok: false, why: '確認後沒有呼叫 term_stop' };
  const want = JSON.stringify({ req: { id: '7', resuming_sid: ${JSON.stringify(TASKMGR_RESUMING_SID)} } });
  if (JSON.stringify(stopCall[1]) !== want) return { ok: false, why: 'term_stop 的參數不對：' + JSON.stringify(stopCall[1]) };
  const others = (globalThis.__smokeCalls || []).map(c => c[0]).filter(c => /^(partner_op|term_(send|start))/.test(c));
  if (others.length) return { ok: false, why: '停止接回中的視窗不該呼叫別的動作：' + others.join('、') };
  if (!(await waitFor(() => !dlgOpen()))) return { ok: false, why: '確認後確認框沒有關' };
  // 再開一次確認框確認還開得起來，然後關掉，讓截圖看得到完整的樹；小字收回，只留終端服務那一列展開當對照
  if (!(await askResuming())) return { ok: false, why: '停止完成後再按「停止」沒有開出確認框' };
  const cancel2 = [...document.querySelectorAll('.dlg .partner-actions button')].find(b => b.textContent.trim() === '取消');
  if (!cancel2) return { ok: false, why: '再開的確認框沒有「取消」鈕' };
  cancel2.click();
  if (!(await waitFor(() => !dlgOpen()))) return { ok: false, why: '截圖前確認框沒有關' };
  for (const b of mores()) if (b.getAttribute('aria-expanded') === 'true' && !b.closest('.tm-node[data-kind="mux"]')) b.click();
  // 重啟（#1860 F）：ASN 與終端服務各有「重啟」；點終端服務的，原位展開確認框（文字逐字、取消在左、重啟在右），探針不按「重啟」，截圖留著確認框
  const restartBtns = [...document.querySelectorAll('.tm-tree .tm-restart')];
  if (restartBtns.length !== 2) return { ok: false, why: 'ASN 與終端服務各該有一顆「重啟」，實際 ' + restartBtns.length };
  const muxNode = () => document.querySelector('.tm-node[data-kind="mux"]');
  muxNode().querySelector('.tm-restart').click();
  const box = await waitFor(() => muxNode().querySelector('.asn-confirm'));
  if (!box) return { ok: false, why: '按了終端服務的「重啟」沒有原位展開確認框' };
  const wantText = '重啟終端服務？底下所有代理（3 個）會暫時斷線，之後會自動連回。';
  if (box.querySelector('.asn-confirm-text').textContent.trim() !== wantText) return { ok: false, why: '重啟確認框文字不對：' + box.textContent.slice(0, 120) };
  const btns = [...box.querySelectorAll('button')].map(b => b.textContent.trim());
  if (btns.join('|') !== '取消|重啟') return { ok: false, why: '確認框按鈕應是「取消」在左、「重啟」在右，實際 ' + btns.join('|') };
  if ((globalThis.__smokeCalls || []).some(c => /^task_manager_restart/.test(c[0]))) return { ok: false, why: '還沒按「重啟」就呼叫了重啟指令' };
  await sleep(200);
  return { ok: true };
})()`

export default {
  key: 'taskmgr',
  kind: '工作管理員檢查',
  source: () => taskmgrProbeSource(),
}
