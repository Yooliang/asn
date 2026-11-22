// 冒煙探測「登入失效：那一列的黃色重新登入、名單上方提示、卡片標籤」（probe.reloginrow，#2111 ⑤ #1960）。
// scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）。不帶截圖（不動 ui-shots-diff 的基準）。

export const reloginrowProbeSource = ({ reloginrow, open = '' }) => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  const mobile = ${JSON.stringify(reloginrow)} === 'mobile', open = ${JSON.stringify(open)};
  if (open) {
    let row = null;
    for (let i = 0; i < 60 && !row; i++) { row = [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes(open)) || null; if (!row) await sleep(100) }
    if (!row) return { ok: false, why: '找不到「' + open + '」' };
    row.click();
  }
  const S = mobile
    ? { box: '.m-dv-my', card: '.m-dv-acct', row: '.m-dv-devrow', btn: '.m-dv-dev', yellow: '.m-dv-dev.relogin', notes: '.m-dv-lostnotes', tag: '.m-dv-lost', why: '.m-dv-devname' }
    : { box: '.dv-my', card: '.dv-acct', row: '.dv-devrow', btn: '.dv-devbtn', yellow: '.dv-devbtn.st-relogin', notes: '.dv-lostnotes', tag: '.dv-lost', why: '.dv-devname' };
  let y = [];
  for (let i = 0; i < 80 && !y.length; i++) { y = [...document.querySelectorAll(S.box + ' ' + S.yellow)].filter(vis); if (!y.length) await sleep(100) }
  if (!y.length) return { ok: false, why: '登入失效的情境，卻沒有看到黃色「重新登入」鈕' };
  if (y.length !== 1) return { ok: false, why: '黃色鈕應只有失效那一列有一顆，現在有 ' + y.length + ' 顆' };
  const b = y[0], row = b.closest(S.row), card = b.closest(S.card);
  if (b.textContent.trim() !== '重新登入') return { ok: false, why: '黃色鈕上的字是「' + b.textContent.trim() + '」，應為「重新登入」' };
  if (b.disabled) return { ok: false, why: '黃色「重新登入」鈕應該可以按' };
  const rgb = (getComputedStyle(b).backgroundColor.match(/[0-9]+/g) || []).map(Number);
  if (!(rgb[0] > 200 && rgb[1] > 180 && rgb[2] < 140)) return { ok: false, why: '重新登入鈕不是黃色：' + getComputedStyle(b).backgroundColor };
  if (!row.querySelector(S.why).textContent.includes('登入已失效')) return { ok: false, why: '失效那一列的設備名下方沒有寫「登入已失效」' };
  // 黃鈕在該列右側、和同卡其他列的鈕同一欄（右緣一致）
  const br = b.getBoundingClientRect(), kr = card.getBoundingClientRect();
  for (const o of [...card.querySelectorAll(S.btn)].filter(vis)) {
    if (Math.abs(o.getBoundingClientRect().right - br.right) > 0.6) return { ok: false, why: '黃色鈕和「' + o.textContent.trim() + '」鈕沒有在同一欄（右緣不一致）' };
  }
  if (kr.right - br.right > 24) return { ok: false, why: '黃色鈕沒有靠右' };
  const rr = row.getBoundingClientRect();
  if (br.top < rr.top - 1 || br.bottom > rr.bottom + 1) return { ok: false, why: '黃色鈕不在它那一列裡' };
  if (card.querySelectorAll(S.btn + ':not(.relogin):not(.st-relogin)').length && [...document.querySelectorAll(S.box + ' ' + S.row)].filter(vis).some(r => r !== row && r.querySelector('.relogin, .st-relogin'))) return { ok: false, why: '黃色鈕出現在別列' };
  // 名單上方提示：寫明哪台哪家、不放鈕、在名單（卡片）上方
  const notes = [...document.querySelectorAll(S.notes)].find(vis);
  if (!notes) return { ok: false, why: '名單上方沒有登入失效的提示' };
  const nt = notes.textContent;
  if (!nt.includes('需要重新登入') || !nt.includes('Claude') || !/這台（|的 Claude/.test(nt)) return { ok: false, why: '提示沒寫明是哪台、哪家的帳號：' + nt.trim() };
  if (notes.querySelector('button')) return { ok: false, why: '提示本身不該放鈕' };
  if (notes.getBoundingClientRect().bottom > kr.top + 0.5) return { ok: false, why: '提示應在帳號卡上方' };
  const tag = [...card.querySelectorAll(S.tag)].find(vis);
  if (!tag || tag.textContent.trim() !== '登入已失效') return { ok: false, why: '帳號卡頂端沒有「登入已失效」標籤' };
  if (!card.textContent.includes('額度暫時看不到')) return { ok: false, why: '額度區沒有寫「額度暫時看不到」' };
  return { ok: true, why: (mobile ? '手機' : '電腦') + '：黃鈕 ' + Math.round(br.width) + '×' + Math.round(br.height) + '、右緣 ' + Math.round(br.right) + '（同欄），提示「' + nt.trim().slice(0, 60) + '」' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const base = { signedIn: true }

export default {
  key: 'reloginrow',
  kind: '登入失效的重新登入鈕與提示檢查',
  source: probe => reloginrowProbeSource(probe),
  scenarios: [
    { name: 'list-acct-relogin', page: 'list.html', state: { ...base, devicesPage: true, roster: 'resets', localAcct: true, reloginrow: 'desktop' }, ready: '#app.win .dv-my .dv-acct', probe: { reloginrow: 'desktop' } },
    { name: 'm-acct-relogin', page: 'm.html', state: { ...base, mnoself: 'android', reloginrow: 'mobile' }, ready: '#app.m .m-row-btn', probe: { reloginrow: 'mobile', open: '帳號' } },
  ],
  table: scenario => {
    const k = scenario.state?.reloginrow
    if (k === 'desktop') return { claude_login_failed: true }   // 本機目前登入的帳號（me@）登入失效
    if (k === 'mobile') {
      // 辦公室（Q）現在用的帳號 me@ 登入失效；Q 的 ASN 在線，所以可以從手機要求它重新登入
      return { android_acct_list: { by: 'node', values: { Q: { asn_online: true, reported_at: new Date().toISOString().slice(0, 16) + ':00.000Z', accounts: [{ vendor: 'claude', email: 'work@example.com', plan: 'claude_pro', current: false }, { vendor: 'claude', email: 'me@example.com', plan: 'claude_max', current: true, login_failed: true }] } }, fallback: null } }
    }
    return undefined
  },
}
