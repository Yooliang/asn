// 冒煙探測「手機設備與帳號返回檢查」（probe.macctBack）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const macctBackProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = sel => [...document.querySelectorAll(sel)].some(e => e.offsetParent !== null);
  const view = () => !vis('.m-fourth') ? 'closed' : vis('.m-dv-list') ? 'list' : 'detail';
  const waitView = async want => { for (let i = 0; i < 30 && view() !== want; i++) await sleep(100); await sleep(150); return view() };
  const press = async want => { history.back(); return waitView(want) };
  const one = document.querySelectorAll('.m-ghead-act').length < 2;
  const steps = [];
  const check = (label, got, want) => { steps.push(label + '=' + got); return got === want ? null : { ok: false, why: label + '：應為 ' + want + '，實際 ' + got + '（' + steps.join('；') + '）' } };
  // 一、夥伴列表某台設備旁的「選項」
  const opt = [...document.querySelectorAll('.m-ghead-act')][0];
  if (!opt) return { ok: false, why: '夥伴列表找不到設備旁的「選項」' };
  opt.click();
  let bad = check('選項進來', await waitView('detail'), 'detail'); if (bad) return bad;
  bad = check('返回一次', await press('list'), 'list'); if (bad) return bad;
  if (!one) {
    const rows = [...document.querySelectorAll('.m-dv-row')];
    // 點最後一列的「詳情」（#1860：詳情裡沒有帳號分頁了）；返回一次回列表
    [...rows[rows.length - 1].querySelectorAll('button')].find(b => b.textContent.trim() === '詳情').click(); await sleep(300);
    bad = check('點另一台', await waitView('detail'), 'detail'); if (bad) return bad;
    bad = check('再返回', await press('list'), 'list'); if (bad) return bad;
  }
  bad = check('返回收起', await press('closed'), 'closed'); if (bad) return bad;
  // 二、從設定進來：先看列表，點一台，返回
  const go = [...document.querySelectorAll('.m-tab, [role=tab], button')].find(b => b.textContent.trim() === '設定' || b.getAttribute('aria-label') === '設定');
  if (go) { go.click(); await sleep(300) }
  let btn = null;
  for (let i = 0; i < 30 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes('設備')) || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '找不到設定裡的「設備」（' + steps.join('；') + '）' };
  btn.click();
  bad = check('設定進來', await waitView('list'), 'list'); if (bad) return bad;
  { const r0 = document.querySelector('.m-dv-row'); [...r0.querySelectorAll('button')].find(b => b.textContent.trim() === '詳情').click(); await sleep(300) }   // 列上的「詳情」（#1860）
  bad = check('設定點一台', await waitView('detail'), 'detail'); if (bad) return bad;
  bad = check('設定返回一次', await press('list'), 'list'); if (bad) return bad;
  bad = check('設定返回收起', await press('closed'), 'closed'); if (bad) return bad;
  return { ok: true, why: steps.join('；') };
})()`

export default {
  key: 'macctBack',
  kind: '手機設備與帳號返回檢查',
  source: probe => macctBackProbeSource(probe),
}
