// 冒煙探測「手機帳號卡檢查」（probe.mcards）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

export const mcardsProbeSource = ({ open }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const open = ${JSON.stringify(open)};
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes(open)) || null; if (!btn) await sleep(100) }
  if (!btn) return { ok: false, why: '找不到「' + open + '」' };
  btn.click();
  let cards = [];
  for (let i = 0; i < 60 && cards.length < 2; i++) { cards = [...document.querySelectorAll('.m-dv-my .m-dv-acct')].filter(c => c.offsetParent !== null); if (cards.length < 2) await sleep(100) }
  if (cards.length < 2) return { ok: false, why: '帳號卡少於 2 張：' + cards.length };
  await sleep(300);
  const rect = (c, sel) => { const e = c.querySelector(sel); return e ? e.getBoundingClientRect() : null };
  let right = null;
  for (const c of cards) {
    const mail = rect(c, '.m-dv-mail'), act = rect(c, '.m-dv-act'), plan = rect(c, '.m-dv-planrow'), quota = rect(c, '.m-dv-quota');
    const name = (c.closest('[data-vendor]')?.dataset.vendor ?? '') + ' ' + (c.querySelector('.m-dv-mail')?.textContent.trim() ?? '');
    if (!mail || !act || !plan || !quota) return { ok: false, why: name + ' 不是三行卡片（少了某一行）' };
    if (Math.abs((act.top + act.bottom) / 2 - (mail.top + mail.bottom) / 2) > Math.max(mail.height, act.height) / 2) return { ok: false, why: name + ' 的使用中／切換不在第一行' };
    if (plan.top < mail.bottom - 1 || quota.top < plan.bottom - 1) return { ok: false, why: name + ' 三行順序不對' };
    if (right === null) right = act.right; else if (Math.abs(act.right - right) > 1) return { ok: false, why: name + ' 的使用中／切換位置跟別張不一樣' };
    const planText = c.querySelector('.m-dv-plan')?.textContent.trim() ?? '';
    if (!planText || /_/.test(planText)) return { ok: false, why: name + ' 的方案寫成「' + planText + '」' };
    if (getComputedStyle(c.querySelector('.m-dv-quota')).fontStyle === 'italic') return { ok: false, why: name + ' 的額度是斜體' };
  }
  const claude = cards.find(c => c.closest('[data-vendor="claude"]'));
  if (!claude) return { ok: false, why: '沒有 Claude 帳號卡' };
  if (claude.querySelector('.m-dv-plan')?.textContent.trim() !== 'Max') return { ok: false, why: 'claude_max 沒寫成 Max' };
  const bars = [...claude.querySelectorAll('.m-dv-bar')];
  if (bars.length !== 2) return { ok: false, why: 'Claude 額度條是 ' + bars.length + ' 條' };
  if (bars.some(b => !(b.querySelector('.m-dv-br')?.textContent.trim() ?? '').endsWith('重置'))) return { ok: false, why: 'Claude 額度條沒有各自的重置時間' };
  const tw = [...document.querySelectorAll('.m-dv-my .m-dv-track')].filter(e => e.offsetParent !== null).map(e => Math.round(e.getBoundingClientRect().width));
  if (tw.length < 2 || tw.some(x => x !== 130)) return { ok: false, why: '額度條寬度不是固定的 130px：' + tw.join(',') };
  if (cards.some(c => c.textContent.includes('較舊'))) return { ok: false, why: '舊資料不該寫「較舊」標籤（#2111）' };
  if (!cards.some(c => c.querySelector('.m-dv-quota.stale'))) return { ok: false, why: '舊資料那張額度區沒有淡色 class' };
  if (document.querySelector('.m-fourth .m-dv-back')) return { ok: false, why: '頁內還有第二個返回' };
  const foot = document.querySelector('.m-fourth .m-dv-foot');
  if (!foot) return { ok: false, why: '最下面沒有說明' };
  const last = [...foot.parentElement.children].filter(e => e.offsetParent !== null).at(-1);
  if (last !== foot) return { ok: false, why: '說明不在最下面' };
  if (Array.from(foot.textContent.trim()).length > 20) return { ok: false, why: '說明超過 20 字' };
  return { ok: true, why: '' };
})()`

export default {
  key: 'mcards',
  kind: '手機帳號卡檢查',
  source: probe => mcardsProbeSource(probe),
}
