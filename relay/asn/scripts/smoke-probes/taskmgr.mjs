// 冒煙探測「工作管理員檢查」（probe.taskmgr）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const TASKMGR_RESUMING_SID = '11111111-2222-4333-8444-555555555555'

export const taskmgrProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  const waitFor = async (fn, n = 80) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const self = await waitFor(() => [...document.querySelectorAll('.dv-list .dv-row')].find(r => r.querySelector('.dv-tag.me')));
  if (!self) return { ok: false, why: '設備列表裡找不到「這台」' };
  [...self.querySelectorAll('button')].find(b => b.textContent.trim() === '帳號').click();
  const entry = await waitFor(() => [...document.querySelectorAll('.dv-dev-h .dv-tasks')].find(vis));
  if (!entry) return { ok: false, why: '這台電腦的詳情頁沒有「工作管理員」入口' };
  entry.click();
  const rows = await waitFor(() => { const r = [...document.querySelectorAll('.tm-table tbody tr')]; return r.length >= 8 ? r : null });
  if (!rows) return { ok: false, why: '工作管理員沒有列出 8 列程式（實際 ' + document.querySelectorAll('.tm-table tbody tr').length + ' 列）' };
  const heads = [...document.querySelectorAll('.tm-table th')].map(h => h.textContent.trim()).join('、');
  for (const c of ['名字', '引擎', '程序編號', '記憶體', '開了多久', '狀態', '來源']) if (!heads.includes(c)) return { ok: false, why: '表頭缺「' + c + '」：' + heads };
  const dups = [...document.querySelectorAll('.tm-table tbody tr.dup')];
  if (dups.length !== 2) return { ok: false, why: '「重複」列應該有 2 列，實際 ' + dups.length };
  if (!dups.every(r => r.querySelector('.tm-tag.dup')?.textContent.trim() === '重複')) return { ok: false, why: '重複的列沒有「重複」標記' };
  if (!dups.every(r => r.textContent.includes('同名的視窗有兩個時，信可能兩邊都收不到'))) return { ok: false, why: '重複的列沒有寫出後果' };
  const banner = document.querySelector('.tm-warn');
  if (!banner || !banner.textContent.includes('同名的視窗有兩個時，信可能兩邊都收不到')) return { ok: false, why: '頂部提示沒有寫出後果' };
  const kindRow = k => document.querySelector('.tm-table tbody tr[data-kind="' + k + '"]');
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
  if (!rtext.includes('小乙') || !rtext.includes('可能卡住了') || !rtext.includes('ASN 開的') || !rtext.includes('23100')) return { ok: false, why: '接回中那一列的內容不對：' + rtext.slice(0, 120) };
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
  // 再開一次確認框，畫面截圖停在這裡
  if (!(await askResuming())) return { ok: false, why: '停止完成後再按「停止」沒有開出確認框' };
  return { ok: true };
})()`

export default {
  key: 'taskmgr',
  kind: '工作管理員檢查',
  source: () => taskmgrProbeSource(),
}
