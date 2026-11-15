// 冒煙探測「手機確認框危險提示檢查」（probe.mpermDanger）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const permDangerProbeSource = kind => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let panel = null;
  for (let i = 0; i < 80 && !panel; i++) { panel = document.querySelector('.m-ops-panel .m-perm-text')?.closest('.m-ops-panel'); if (!panel) { for (const fn of ((globalThis.__smokeListeners || {})['relay-bell'] || [])) fn({ event: 'relay-bell', payload: null }); await sleep(250) } }
  if (!panel) return { ok: false, why: '權限框沒有跳出來' };
  await sleep(900);   // 等 ARM_MS
  const kind = ${JSON.stringify(kind)};
  const warn = panel.querySelector('.m-perm-warn');
  const btns = [...panel.querySelectorAll('.m-term-opt')];
  if (btns.length !== 3) return { ok: false, why: '應該照原本的選項顯示三顆，實際 ' + btns.length };
  const holds = btns.map(b => b.classList.contains('m-hold'));
  if (kind === 'plain') {
    if (warn) return { ok: false, why: '平常的指令不該有警告' };
    if (panel.textContent.includes('安全')) return { ok: false, why: '畫面不該出現「安全」' };
    if (JSON.stringify(holds) !== '[false,true,false]') return { ok: false, why: '平常的指令只有「不再詢問」要按住：' + JSON.stringify(holds) };
  } else {
    if (!warn) return { ok: false, why: '沒有警告區塊' };
    const r = warn.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) return { ok: false, why: '一開框警告就要看得到：' + Math.round(r.top) + '～' + Math.round(r.bottom) };
    if (warn.compareDocumentPosition(panel.querySelector('.m-perm-text')) !== Node.DOCUMENT_POSITION_FOLLOWING) return { ok: false, why: '警告要在本文之前（本文框外面）' };
    if (kind === 'danger' && !warn.textContent.includes('git')) return { ok: false, why: '警告沒有寫出 git 那一條' };
    if (kind === 'incomplete' && !warn.textContent.includes('看不到全部指令')) return { ok: false, why: '不完整時要寫看不到全部指令' };
    if (JSON.stringify(holds) !== '[true,true,false]') return { ok: false, why: '要小心時放行類都要按住：' + JSON.stringify(holds) };
    if (kind === 'danger' && !panel.textContent.includes('後面還有')) return { ok: false, why: '截斷的字數提示不見了' };
  }
  // 要按住的那一顆：點一下不送；按住不到一秒放開不送；按滿一秒才送
  const decided = () => (globalThis.__smokeCalls || []).filter(c => c[0] === 'android_perm_req_decide');
  const hb = btns[1];
  hb.click(); await sleep(200);
  if (decided().length) return { ok: false, why: '要按住的按鈕點一下就送出了' };
  hb.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await sleep(400);
  hb.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); await sleep(900);
  if (decided().length) return { ok: false, why: '按住不到一秒就送出了' };
  hb.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await sleep(1300);
  if (decided().length !== 1) return { ok: false, why: '按滿一秒沒有送出' };
  if (document.documentElement.scrollWidth > window.innerWidth + 1) return { ok: false, why: '整頁橫向溢出' };
  return { ok: true, why: '' };
})()`

export default {
  key: 'mpermDanger',
  kind: '手機確認框危險提示檢查',
  source: probe => permDangerProbeSource(probe.mpermDanger),
}
