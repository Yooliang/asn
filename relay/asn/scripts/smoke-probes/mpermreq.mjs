// 冒煙探測「手機權限框分隔線檢查」（probe.mpermreq）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const mpermreqProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let box = null;
  for (let i = 0; i < 80 && !box; i++) { box = document.querySelector('.m-perm-text'); if (!box) { for (const fn of ((globalThis.__smokeListeners || {})['relay-bell'] || [])) fn({ event: 'relay-bell', payload: null }); await sleep(250) } }
  if (!box) return { ok: false, why: '權限框沒有跳出來' };
  await sleep(300);
  const ALL = '│┃║| ─━═-_=', RULE = '─━═-_=';
  const lines = box.innerText.split(String.fromCharCode(10));
  const ruleOnly = lines.filter(l => [...l].every(c => ALL.includes(c) || c === String.fromCharCode(9)) && [...l].filter(c => RULE.includes(c)).length >= 3);
  if (ruleOnly.length) return { ok: false, why: '還有整行是分隔線的文字：' + ruleOnly[0].slice(0, 20) };
  const hrs = box.querySelectorAll('hr.m-perm-rule');
  if (hrs.length !== 1) return { ok: false, why: '分隔線應該剛好一條（前後的拿掉、中間四行合成一條），實際 ' + hrs.length };
  if (hrs[0].getBoundingClientRect().height > 3) return { ok: false, why: '分隔線太粗' };
  if (!box.textContent.includes('npm test --silent')) return { ok: false, why: '指令文字不見了' };
  if (!box.textContent.includes('Do you want to proceed?')) return { ok: false, why: '問題文字不見了' };
  const panel = box.closest('.m-ops-panel');
  const bad = [box, panel].find(e => e && e.scrollWidth > e.clientWidth + 1);
  if (bad) return { ok: false, why: '卡片橫向溢出：' + bad.className };
  if (document.documentElement.scrollWidth > window.innerWidth + 1) return { ok: false, why: '整頁橫向溢出' };
  return { ok: true, why: '' };
})()`

export default {
  key: 'mpermreq',
  kind: '手機權限框分隔線檢查',
  source: probe => mpermreqProbeSource(probe),
}
