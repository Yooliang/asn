// 冒煙探測「手機看終端按鍵列檢查」（probe.termKeys，#1512 B）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 用真的點擊與真的打字重演一輪登入：那台停在「選登入方式」→ 按鍵列按 ↓、Enter（第一次按會先開始打字，那台跳本人確認）→
// 畫面出現登入網址（被折成好幾列）→ 點「開啟登入網址」在這台開 → 輸入框貼回 code 送出 → 那台只收到一次 Enter。
// 另外驗：複製畫面文字會把折行接回來；那台回報按鍵被拿掉時要告訴本人；按鍵列不橫向溢出、在輸入框上面。
// 探測原始碼是字串，裡面不寫反斜線（ESC、Enter 用 String.fromCharCode）

const COLS = 60
export const TERMKEYS_LOGIN_URL = 'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=smoke-state-1512'

export const termKeysProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 300) };
  const tap = async el => { el.scrollIntoView({ block: 'nearest' }); await sleep(80); await real({ click: at(el) }) };
  const wait = async (fn, n = 80) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const CR = String.fromCharCode(13), ESC = String.fromCharCode(27), NL = String.fromCharCode(13, 10);
  const COLS = ${COLS};
  const LOGIN = ${JSON.stringify(TERMKEYS_LOGIN_URL)};
  // 打字開始前的本人確認（外殼）：直接通過
  globalThis.AsnAndroid = Object.assign(globalThis.AsnAndroid || {}, { confirmWithToken(id) { setTimeout(() => globalThis.__asnConfirmViewer && globalThis.__asnConfirmViewer(id, 'ok'), 30) } });
  // 複製：記下來（無頭瀏覽器的剪貼簿不一定能用）
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { globalThis.__copied = t } } }) } catch (e) { return { ok: false, why: '換不掉剪貼簿：' + e.message } }
  const frame = (rows, extra) => { for (const fn of ((globalThis.__smokeListeners || {})['term-view-remote-frame'] || [])) fn({ event: 'term-view-remote-frame', payload: { id: 'v1', text: rows.join(NL), meta: Object.assign({ cursor_x: 2, cursor_y: 3, cols: COLS, rows: 40 }, extra || {}) } }) };
  const inputs = () => (globalThis.__smokeCalls || []).filter(c => c[0] === 'term_view_remote_input').map(c => c[1] || {});
  // 終端的切換鈕：一般外觀在下方圖示列，LINE 外觀在標頭
  const sw = await wait(() => [...document.querySelectorAll('.m-term-switch, .m-head-term')].find(vis));
  if (!sw) return { ok: false, why: '對話頁沒有「對話／終端」切換鈕' };
  await tap(sw);
  if (!(await wait(() => (document.querySelector('.term-view-screen .xterm-rows')?.textContent || '').includes('測試通過')))) return { ok: false, why: '終端畫面沒有出現假畫面的字' };
  // 那台停在選登入方式
  frame(['Select login method:', '', ' ' + String.fromCharCode(10095) + ' 1. Claude account with subscription', '   2. Anthropic Console account', '', 'Enter to confirm']);
  const keys = await wait(() => { const ks = [...document.querySelectorAll('.m-term-keys .m-term-key')].filter(vis); return ks.length === 7 ? ks : null });
  if (!keys) return { ok: false, why: '按鍵列沒有七顆鍵' };
  const labels = keys.map(k => k.textContent.trim());
  if (labels.join(',') !== '1,2,3,↑,↓,Esc,Enter') return { ok: false, why: '按鍵列的字不對：' + labels.join(',') };
  if (keys.some(k => k.disabled)) return { ok: false, why: '看終端（可以打字）時按鍵不該是停用的' };
  for (const k of keys) { const r = k.getBoundingClientRect(); if (r.height < 39.5 || r.width < 39.5) return { ok: false, why: '按鍵太小不好按：' + k.textContent + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) } }
  const byLabel = l => [...document.querySelectorAll('.m-term-keys .m-term-key')].find(k => k.textContent.trim() === l);
  // 按 ↓：還沒在打字 → 先開始（本人確認）→ 那台開始送畫面才算開始打字 → 這時才送。假那台一直送同一幅
  globalThis.__tkBefore = (globalThis.__smokeCalls || []).length;
  await tap(byLabel('↓'));
  const menu = ['Select login method:', '', ' ' + String.fromCharCode(10095) + ' 1. Claude account with subscription', '   2. Anthropic Console account', '', 'Enter to confirm'];
  if (!(await wait(() => { frame(menu); return inputs().some(a => a.data === ESC + '[B') }))) return { ok: false, why: '按 ↓ 沒有送出向下鍵（送出的：' + JSON.stringify(inputs().map(a => a.data)) + '；按了之後呼叫過：' + (globalThis.__smokeCalls || []).slice(globalThis.__tkBefore).map(c => c[0] + (c[0] === 'term_view_remote_start' ? JSON.stringify(c[1]) : '')).join(',') + '；本人確認：' + JSON.stringify(globalThis.__smokeConfirms || []) + '；狀態列：' + (document.querySelector('.m-chat .typing')?.textContent || '').slice(0, 60) + '）' };
  const starts = (globalThis.__smokeCalls || []).filter(c => c[0] === 'term_view_remote_start' && c[1] && c[1].scope === 'input');
  if (starts.length !== 1) return { ok: false, why: '第一次按鍵應該開始打字一次，實際 ' + starts.length };
  await tap(byLabel('Enter'));
  if (!(await wait(() => inputs().filter(a => a.data === CR).length === 1))) return { ok: false, why: '按 Enter 沒有送出' };
  if (inputs().some(a => a.paste)) return { ok: false, why: '按鍵不能走貼上模式' };
  // 畫面出現登入網址，被折成好幾列
  const parts = []; for (let i = 0; i < LOGIN.length; i += COLS) parts.push(LOGIN.slice(i, i + COLS));
  frame(['Browser didn' + String.fromCharCode(39) + 't open? Use the url below to sign in:', '', ...parts, '', 'Paste code here if prompted >']);
  const link = await wait(() => [...document.querySelectorAll('.m-term-keys .m-term-login')].find(vis));
  if (!link) return { ok: false, why: '畫面有登入網址，但沒有「開啟登入網址」的按鈕' };
  if (!link.textContent.includes('claude.ai')) return { ok: false, why: '登入網址按鈕要寫出網域：' + link.textContent };
  await tap(link);
  const opened = await wait(() => (globalThis.__smokeCalls || []).find(c => c[0] === 'open_link'));
  if (!opened) return { ok: false, why: '點了登入網址沒有在這台開' };
  if (opened[1].url !== LOGIN) return { ok: false, why: '開的網址不是完整的登入網址（折行沒接回）：' + String(opened[1].url).slice(0, 80) };
  // 複製畫面文字：折行接回來
  await tap(document.querySelector('.m-term-keys .m-term-copy'));
  if (!(await wait(() => typeof globalThis.__copied === 'string'))) return { ok: false, why: '按了複製畫面文字沒有寫進剪貼簿' };
  if (!globalThis.__copied.includes(LOGIN)) return { ok: false, why: '複製的文字裡網址沒有接回成一行' };
  if (!(await wait(() => (document.querySelector('.m-term-keys .m-term-copied')?.textContent || '').includes('已複製')))) return { ok: false, why: '複製後沒有提示' };
  // 輸入框貼回 code 送出：字一次、Enter 一次
  const before = inputs().length;
  const ta = document.querySelector('.m-chat .composer textarea');
  if (!ta) return { ok: false, why: '找不到輸入框' };
  await tap(ta);
  await real({ text: 'abc123-smoke-code' });
  const go = ta.closest('form').querySelector('button[type=submit]');
  await tap(go);
  await sleep(900);
  const after = inputs().slice(before).map(a => a.data);
  if (JSON.stringify(after) !== JSON.stringify(['abc123-smoke-code', CR])) return { ok: false, why: '貼回 code 應該只送出字一次、Enter 一次：' + JSON.stringify(after) };
  // 那台回報按鍵被拿掉（畫面需要人確認）：告訴本人
  frame(['What do you want to do?', '', ' ' + String.fromCharCode(10095) + ' 1. Stop and wait for limit to reset', '', 'Enter to confirm'], { keys_dropped: 1 });
  if (!(await wait(() => (document.querySelector('.m-chat .typing')?.textContent || '').includes('不能用按鍵代選')))) return { ok: false, why: '按鍵被拿掉時沒有告訴本人：' + (document.querySelector('.m-chat .typing')?.textContent || '') };
  // 版面：按鍵列在輸入框上面、不橫向溢出
  const row = document.querySelector('.m-term-keys').getBoundingClientRect(), form = ta.getBoundingClientRect();
  if (row.bottom > form.top + 0.5) return { ok: false, why: '按鍵列蓋到輸入框：' + Math.round(row.bottom) + ' > ' + Math.round(form.top) };
  if (document.documentElement.scrollWidth > window.innerWidth + 1) return { ok: false, why: '整頁橫向溢出' };
  return { ok: true, why: '' };
})()`

export default {
  key: 'termKeys',
  kind: '手機看終端按鍵列檢查',
  source: () => termKeysProbeSource(),
  scenarios: [
    { name: 'm-term-keys', page: 'm.html', state: { signedIn: true, mtermview: true, termKeys: true }, ready: '#app.m .m-pager .m-search', probe: { termKeys: true }, shot: 'm-term-keys.png' },
    { name: 'm-term-keys-line', page: 'm.html', state: { signedIn: true, mtermview: true, termKeys: true, skin: 'line' }, ready: '#app.m .m-pager .m-search', probe: { termKeys: true }, shot: 'm-term-keys-line.png' },
  ],
  // 打字要先過：那台的指紋確認過、拿得到一次性憑證；送字、開網址都只記下來
  table: scenario => (scenario.state?.termKeys ? {
    android_known_list: { peers: [{ node: 'Q', name: '辦公室', confirmed: true, fp: '3fa2c91b7d0e4a5f8c6b2d1e0f9a8b7c', first_seen_ms: 1763000000000 }] },
    android_known_token: 'a'.repeat(64),
    term_view_remote_input: null,
    open_link: null,
  } : undefined),
}
