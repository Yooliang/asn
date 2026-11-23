// 冒煙探測「電腦版帳號頁重新登入 Claude」（probe.drelogin，#1645；#1860 起從設定的「帳號」頁進，設備詳情沒有帳號了）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 情境（probe.drelogin 的值）：
//   remote  別台（辦公室）回報 Claude 登入失效：帳號頁那一列出現黃色「重新登入」；按了只進確認（寫明網址送到你的手機、不會顯示網址），
//           按「確認重新登入」才送出 setup_remote_request（帶那台的節點與 mode relogin）；接手後說網址送到手機；完成後寫結果
//   local   這台自己登入失效：同一顆鈕；確認後呼叫 ai_cli_login（claude），不送任何遠端請求；本機帳號變成已登入就顯示「已登入」
//   healthy 別台登入正常：沒有這顆鈕
// 全部用真的點擊（__smokeInput）。探測原始碼是字串，裡面不寫反斜線

export const dreloginProbeSource = (kind = 'remote') => `(async () => {
  const KIND = ${JSON.stringify(kind)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 400) };
  const tap = async el => { el.scrollIntoView({ block: 'center' }); await sleep(120); await real({ click: at(el) }) };
  const wait = async (fn, n = 80) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const calls = name => (globalThis.__smokeCalls || []).filter(c => c[0] === name);
  // #1860：設備詳情沒有帳號了。重新登入改從設定的「帳號」頁進：登入失效的那一列有黃色「重新登入」鈕（本機那一列或別台那一列）
  const box = () => [...document.querySelectorAll('.dv-my')].find(vis);
  const entryBtn = () => { const b = box(); return b && [...b.querySelectorAll('.dv-devbtn.st-relogin')].find(vis) };
  if (!(await wait(() => box() && box().querySelector('.dv-acct'), 80))) return { ok: false, why: '帳號頁沒有帳號卡' };
  if (KIND === 'healthy') {
    await sleep(600);
    if (entryBtn()) return { ok: false, why: '別台登入正常，卻出現了重新登入' };
    return { ok: true, why: '' };
  }
  const entry = await wait(entryBtn);
  if (!entry) return { ok: false, why: '登入失效的帳號頁沒有黃色「重新登入」鈕' };
  if (entry.textContent.trim() !== '重新登入') return { ok: false, why: '鈕上的字不對：' + entry.textContent.trim() };
  if (calls('setup_remote_request').length || calls('ai_cli_login').length) return { ok: false, why: '還沒按就送出了' };
  await tap(entry);
  const dlg = await wait(() => box() && box().querySelector('.dv-devconfirm[role=alertdialog]'));
  if (!dlg) return { ok: false, why: '按了鈕沒有出現確認框' };
  if (calls('setup_remote_request').length || calls('ai_cli_login').length) return { ok: false, why: '按鈕就送出了（應該先確認）' };
  const dtext = dlg.textContent;
  if (KIND === 'remote' && !(dtext.includes('你的手機') && dtext.includes('不會顯示網址'))) return { ok: false, why: '確認框沒寫登入網址會送到你的手機：' + dtext.slice(0, 80) };
  if (KIND === 'local' && !(dtext.includes('官方') && dtext.includes('不會把網址送到手機'))) return { ok: false, why: '本機確認框沒寫清楚做什麼：' + dtext.slice(0, 80) };
  const yes = [...dlg.querySelectorAll('button')].find(b => /確認重新登入|開始登入/.test(b.textContent));
  if (!yes) return { ok: false, why: '確認框沒有確認鈕' };
  await tap(yes);
  const prog = () => box() && box().querySelector('.dv-prog.dv-devconfirm');
  if (KIND === 'local') {
    if (!(await wait(() => calls('ai_cli_login').length === 1))) return { ok: false, why: '確認後沒有開登入終端（ai_cli_login）' };
    if (JSON.stringify(calls('ai_cli_login')[0][1]) !== JSON.stringify({ toolId: 'claude' })) return { ok: false, why: '開的不是 Claude 的登入：' + JSON.stringify(calls('ai_cli_login')[0][1]) };
    if (calls('setup_remote_request').length) return { ok: false, why: '本機不該送遠端請求' };
    if (!(await wait(() => prog() && prog().textContent.includes('已開啟登入視窗')))) return { ok: false, why: '沒說已開啟登入視窗' };
    // 本機帳號變成已登入（假後台換掉回應），下一輪觀察就該收到
    globalThis.__smokeOverride = { claude_login_failed: false };
    if (!(await wait(() => prog() && prog().textContent.includes('已登入。'), 80))) return { ok: false, why: '登入好了沒有顯示已登入：' + (prog() ? prog().textContent : '') };
    return { ok: true, why: '' };
  }
  const sent = await wait(() => calls('setup_remote_request')[0]);
  if (!sent) return { ok: false, why: '確認後沒有送出請求' };
  if (JSON.stringify(sent[1]) !== JSON.stringify({ node: 'Q', mode: 'relogin' })) return { ok: false, why: '送出的欄位不對：' + JSON.stringify(sent[1]) };
  if (!(await wait(() => prog() && prog().textContent.includes('等這台電腦來取')))) return { ok: false, why: '送出後沒說等電腦來取：' + (prog() ? prog().textContent : '') };
  globalThis.__smokeOverride = { setup_remote_status: { nodes: [{ id: 'Q', setup: { state: 'taken', detail: null, replaced: null } }] } };
  if (!(await wait(() => prog() && prog().textContent.includes('登入網址會送到你的手機'), 120))) return { ok: false, why: '那台接手後沒說網址送到手機：' + (prog() ? prog().textContent : '') };
  if (document.body.textContent.includes('https://')) return { ok: false, why: '畫面上出現了網址' };
  globalThis.__smokeOverride = { setup_remote_status: { nodes: [{ id: 'Q', setup: { state: 'failed', detail: '這台電腦還沒安裝 Claude Code，重新登入不會替你安裝', replaced: null } }] } };
  const bad = await wait(() => { const p = prog(); return p && p.getAttribute('role') === 'alert' && p.textContent.includes('還沒安裝 Claude Code') ? p : null }, 120);
  if (!bad) return { ok: false, why: '失敗結果沒有用 alert 顯示原因：' + (prog() ? prog().getAttribute('role') + prog().textContent : '') };
  const close = [...box().querySelectorAll('button')].find(b => b.textContent.trim() === '關閉');
  if (!close) return { ok: false, why: '結果沒有關閉鈕' };
  await tap(close);
  if (!(await wait(() => entryBtn() && !prog()))) return { ok: false, why: '關閉後沒有回到只有黃色按鈕' };
  return { ok: true, why: '' };
})()`

const MEMBERS = [
  { id: 'P', agents: [{ name: 'asn真', status: 'idle', cwd_label: 'asn' }] },
  { id: 'Q', agents: [{ name: '雯', status: 'idle', cwd_label: 'asn' }] },
]
const ME = { winMode: 'merged', session: { v: 1, tabs: [{ id: '@setting' }], active: { id: '@setting' }, panel: { guide: '', setting: 'accounts' }, windows: [], panelWindows: [] } }   // 設定的「帳號」頁（#1860：設備詳情沒有帳號了）

const CASES = [
  { name: 'list-drelogin-remote', kind: 'remote', shot: 'list-drelogin-remote.png' },
  { name: 'list-drelogin-local', kind: 'local', shot: 'list-drelogin-local.png' },
  { name: 'list-drelogin-healthy', kind: 'healthy' },
]

export default {
  key: 'drelogin',
  kind: '電腦版重新登入 Claude 檢查',
  source: probe => dreloginProbeSource(typeof probe.drelogin === 'string' ? probe.drelogin : 'remote'),
  scenarios: CASES.map(c => ({ name: c.name, page: 'list.html', width: 1100, height: 760, state: { signedIn: true, drelogin: c.kind }, ready: '#app.win .dv-my .dv-acct', probe: { drelogin: c.kind }, ...(c.shot ? { shot: c.shot } : {}) })),
  // 這台（P）與辦公室（Q）：本機情境讓這台的 Claude 登入失效；別台情境讓 Q 回報登入失效（healthy 是正常）；送出要求與查狀態都只記下來
  table: (scenario, t) => {
    const kind = scenario.state?.drelogin
    if (!kind) return undefined
    const reportedAt = new Date(Math.floor((Date.now() - 3 * 60_000) / 60_000) * 60_000).toISOString()
    const failed = kind !== 'healthy'
    const q = { accounts: [{ vendor: 'claude', email: 'me@example.com', plan: 'max', current: true, ...(failed ? { login_failed: true } : {}) }], asn_online: true, reported_at: reportedAt }
    // 帳號頁的名單：同一個帳號（me@）本機與辦公室（Q）都在用，登入失效的那一列出黃色鈕
    const roster = { now: reportedAt, accounts: [{ vendor: 'claude', account: 'me@example.com', plan: 'claude_max', seen_at: reportedAt, seen_node: 'P', nodes: [{ node: 'P', current: true, reported_at: reportedAt }, { node: 'Q', current: true, reported_at: reportedAt }], windows: [] }] }
    return {
      acct_roster: roster,
      relay_list: { members: MEMBERS },
      store_load: { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(ME) } },
      relay_launchers: { machines: [{ node: 'Q', online: true, launcher: { profiles: [] } }] },
      claude_accounts_list: [{ email: 'me@example.com', plan: 'max', current: true }],
      claude_login_failed: kind === 'local',
      acct_remote_list: { by: 'node', values: { Q: q }, fallback: { accounts: [], asn_online: false, reported_at: '' } },
      setup_remote_request: { ok: true },
      setup_remote_status: { nodes: [] },
      ai_cli_login: null,
    }
  },
}
