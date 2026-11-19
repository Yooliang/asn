// 冒煙探測「設備頁不多出通知那一列」（probe.ghost1830，#1830）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 名單照「設備頁精簡」（fpMark）的，另外收到一封系統通知，名單上就會長出固定的「通知」對話（節點 notice）：設備頁不能把它當成一台設備。

const SKINS = ['aero', 'modern', 'line']
const NOTICE_MAIL = { id: '00000000-0000-4000-8000-0000000018a0', from_node: 'Q', from_agent: 'ASN 通知', kind: 'notice:waiting', body: '辦公室：夥伴 demo 正在等你確認。', trust: 'member', to_agent: '測試機' }

export const ghost1830ProbeSource = mode => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const real = req => { globalThis.__smokeInput(JSON.stringify(req)); return sleep(400) };
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const vis = e => e && e.getClientRects().length > 0;
  const phone = ${JSON.stringify(mode)} === 'phone';
  if (phone) {
    let btn = null;
    for (let i = 0; i < 60 && !btn; i++) { btn = [...document.querySelectorAll('.m-row-btn')].find(b => vis(b) && b.textContent.includes('設備')) || null; if (!btn) await sleep(100) }
    if (!btn) return { ok: false, why: '找不到設定裡的「設備」' };
    await real({ click: at(btn) }); await sleep(300);
  }
  const rowSel = phone ? '.m-dv-row' : '.dv-row';
  let rows = [];
  for (let i = 0; i < 60; i++) { rows = [...document.querySelectorAll(rowSel)].filter(vis); if (rows.length >= 3) break; await sleep(100) }
  if (rows.length < 3) return { ok: false, why: '設備列不夠：' + rows.length };
  await sleep(1500);   // 通知信收進來、名單更新都做完再數
  rows = [...document.querySelectorAll(rowSel)].filter(vis);
  const names = rows.map(r => (r.querySelector(phone ? 'b' : '.dv-name')?.textContent ?? '').trim());
  if (names.some(n => n === '未命名設備' || n === '')) return { ok: false, why: '設備頁多出一列沒有名字的設備（通知對話被當成設備）：' + names.join('、') };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

export default {
  key: 'ghost1830',
  kind: '設備頁不多出通知那一列檢查',
  source: probe => ghost1830ProbeSource(probe.ghost1830),
  // 假後台多一封系統通知（名單照 fpMark 情境）
  table: scenario => (scenario.state.noticeMail ? { relay_inbox: { messages: [{ ...NOTICE_MAIL, created_at: new Date().toISOString() }] }, relay_ack: null, relay_read_sync: { marks: [] }, show_toast: null } : undefined),
  scenarios: SKINS.flatMap(skin => [
    { name: `list-dev-ghost-${skin}`, page: 'list.html', width: 900, height: 640, state: { signedIn: true, fpMark: 'desk', skin, noticeMail: true }, ready: '#app.win .dv-set', probe: { ghost1830: 'desk' }, shot: `list-dev-ghost-${skin}.png` },
    { name: `m-dev-ghost-${skin}`, page: 'm.html', state: { signedIn: true, fpMark: 'phone', skin, noticeMail: true }, ready: '#app.m .m-row-btn', probe: { ghost1830: 'phone' }, shot: `m-dev-ghost-${skin}.png` },
  ]),
}
