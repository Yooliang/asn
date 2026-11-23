// 冒煙探測「新手引導卡檢查」（probe.newComputerGuide，#1605）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 這台電腦一個視窗也沒有時，夥伴頁與對話頁都要出現「這台電腦還沒有 AI 夥伴，選一個開始」，四家各一個動作（用真的滑鼠點）：
//   blank：一家都沒裝 → 沒有按鈕、每家一句說明與官網連結；Claude 那句固定；點官網連結＝向系統要開瀏覽器（open_link）
//   partial：Claude 已登入、Codex 已裝沒登入、Gemini 已裝、Grok 沒裝 → 開一個視窗／登入／開一個視窗／說明
//            點「開一個視窗」＝開新夥伴對話框、直接在第 2 步、選好這台電腦與那一家；點 Codex 的「登入」＝ai_cli_login；
//            點「先不用」＝卡片收起、出現「顯示新手引導」；再點＝卡片回來
//   ready：四家都能用 → 四個「開一個視窗」
//   recheck：一開始偵測不到 Claude → 假後台改成找得到 → 真的點「重新檢查」→ Claude 變「開一個視窗」、ai_cli_detect 又被呼叫一次；
//            再點「開一個視窗」開對話框時，ai_cli_detect 又被呼叫一次（剛裝好不用重開 ASN）
//   pending：偵測還沒回來 → 四列都是「正在檢查…」、沒有按鈕
// 截圖在探測做完、卡片回到畫面之後才存。

const TOOL = (id, found) => ({ id, label: id, binary_found: found, install_available: false, login_available: found, install_blurb: '', login_blurb: '', version: '' })
const tools = found => ({ checked_at: '0', tools: ['claude', 'codex', 'agy', 'grok', 'pi'].map(id => TOOL(id, found.includes(id))) })
export const GUIDE_TOOLS = { blank: tools([]), partial: tools(['claude', 'codex', 'agy']), ready: tools(['claude', 'codex', 'agy', 'grok']), recheck: tools([]) }
const FOUND_CLAUDE = tools(['claude'])
const CLAUDE = [{ email: 'me@example.com', plan: 'pro', current: true }]

export const newComputerGuideProbeSource = ({ kind = 'blank', page = 'partners' } = {}) => `(async () => {
  const want = ${JSON.stringify({ kind, page })};
  const FOUND_CLAUDE = ${JSON.stringify(FOUND_CLAUDE)};
  const KEY = 'asnNewComputerGuideHidden';
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 300) };
  const waitFor = async (fn, n = 60) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const calls = name => (globalThis.__smokeCalls || []).filter(c => c[0] === name);
  const card = () => [...document.querySelectorAll('.ng-card')].find(vis);
  const rowOf = k => card() && card().querySelector('.ng-row[data-vendor="' + k + '"]');
  const txt = e => (e ? e.textContent.replace(/\\s+/g, ' ').trim() : '');
  const reshow = () => [...document.querySelectorAll('.ng-reshow')].find(vis);
  localStorage.removeItem(KEY);
  const top = document.querySelector(want.page === 'chats' ? '.ttab-chats' : '.ttab-partners');
  if (!top) return { ok: false, why: '找不到上方的分頁鈕' };
  await real({ click: at(top) }, 400);
  if (!(await waitFor(card, 80))) return { ok: false, why: '看不到新手引導卡（頁面：' + want.page + '）：' + txt(document.querySelector('.list-pane') || document.body).slice(0, 120) };
  if (!txt(card().querySelector('.ng-title')).includes('這台電腦還沒有 AI 夥伴，選一個開始')) return { ok: false, why: '標題不對：' + txt(card().querySelector('.ng-title')) };
  if (document.body.textContent.includes('這一頁目前沒有視窗。') || document.body.textContent.includes('還沒有對話。到「夥伴」點一位開始。')) return { ok: false, why: '出現卡片時還留著舊的空白說明' };
  const order = [...card().querySelectorAll('.ng-row')].map(r => r.getAttribute('data-vendor')).join(',');
  if (order !== 'claude,codex,gemini,grok') return { ok: false, why: '四家順序不對：' + order };
  const btns = k => [...rowOf(k).querySelectorAll('button')].map(b => b.textContent.trim());
  const expectRow = async (k, buttons, noteHas) => {
    const got = await waitFor(() => { const b = btns(k); return JSON.stringify(b) === JSON.stringify(buttons) ? b : null }, 40);
    if (!got) return k + ' 這一列的按鈕應該是 [' + buttons.join('、') + ']，實際是 [' + btns(k).join('、') + ']：' + txt(rowOf(k));
    if (noteHas !== undefined && !txt(rowOf(k)).includes(noteHas)) return k + ' 這一列少了「' + noteHas + '」：' + txt(rowOf(k));
    return '';
  };
  const closeDlg = async () => { if (document.querySelector('.partner-dlg-back')) await real({ click: [4, 4] }, 300); };
  const checkDlg = async (vendorLabel) => {
    const back = await waitFor(() => [...document.querySelectorAll('.partner-dlg-back')].find(vis));
    if (!back) return '按「開一個視窗」之後沒有開出開新夥伴對話框';
    const dev = back.querySelector('.pdevice.on');
    if (!dev || dev.getAttribute('data-node') !== 'P') return '對話框沒有選好這台電腦：' + (dev ? dev.getAttribute('data-node') : '沒有選到');
    const on = back.querySelector('.pmodel.on .pmodel-lb');
    if (!on || txt(on) !== vendorLabel) return '對話框沒有選好 ' + vendorLabel + '：' + txt(on);
    const step = [...back.querySelectorAll('.partner-steps li')].find(l => l.className.includes('on'));
    if (!step || !txt(step).startsWith('2.')) return '對話框應該直接在第 2 步（廠牌與運行）：' + txt(step);
    await closeDlg();
    if (!(await waitFor(() => !document.querySelector('.partner-dlg-back'), 20))) return '對話框沒有關掉';
    return '';
  };
  let bad = '';
  if (want.kind === 'pending') {
    for (const k of ['claude', 'codex', 'gemini', 'grok']) { if (!txt(rowOf(k)).includes('正在檢查…') || btns(k).length) return { ok: false, why: k + ' 偵測還沒回來應該只寫「正在檢查…」：' + txt(rowOf(k)) } }
    return { ok: true, why: '' };
  }
  if (want.kind === 'blank') {
    if (card().querySelector('button.ng-btn')) return { ok: false, why: '一家都沒裝，不該有動作按鈕' };
    if ((bad = await expectRow('claude', [], '找不到 Claude Code。剛裝好的話，按下面的「重新檢查」。'))) return { ok: false, why: bad };
    for (const [k, n] of [['codex', 'Codex'], ['gemini', 'Gemini'], ['grok', 'Grok']]) { if ((bad = await expectRow(k, [], '還沒裝 ' + n + '，裝好後這裡會出現「開一個視窗」。'))) return { ok: false, why: bad } }
    for (const [k, n] of [['claude', 'Claude'], ['codex', 'Codex'], ['gemini', 'Gemini'], ['grok', 'Grok']]) { if (!txt(rowOf(k)).includes('到 ' + n + ' 官網 下載安裝')) return { ok: false, why: k + ' 少了官網說明：' + txt(rowOf(k)) } }
    for (const k of ['claude', 'codex', 'gemini', 'grok']) { const e = rowOf(k).querySelectorAll('.ng-edge'); if (e.length !== 1 || txt(e[0]) !== 'Edge 擋下載的話，按「…」→「保留」→「仍要保留」') return { ok: false, why: k + ' 官網下面應該有一行 Edge 擋下載的提醒：' + txt(rowOf(k)) } }
    if (/https?:|curl|irm /.test(txt(card()))) return { ok: false, why: '卡片上不該出現網址或安裝指令文字：' + txt(card()) };
    const before = calls('open_link').length;
    const link = rowOf('codex').querySelector('a.ng-link');
    if (!link) return { ok: false, why: 'Codex 那列沒有官網連結' };
    await real({ click: at(link) }, 400);
    const c = calls('open_link');
    if (c.length !== before + 1 || !c[c.length - 1][1] || c[c.length - 1][1].url !== 'https://developers.openai.com/codex') return { ok: false, why: '點官網連結應該呼叫 open_link 開 Codex 官網：' + JSON.stringify(c.slice(before)) };
    if (location.hash) return { ok: false, why: '點官網連結不該改頁面網址' };
  }
  if (want.kind === 'partial') {
    if ((bad = await expectRow('claude', ['開一個視窗']))) return { ok: false, why: bad };
    if ((bad = await expectRow('codex', ['登入']))) return { ok: false, why: bad };
    if ((bad = await expectRow('gemini', ['開一個視窗']))) return { ok: false, why: bad };
    if ((bad = await expectRow('grok', [], '還沒裝 Grok，裝好後這裡會出現「開一個視窗」。'))) return { ok: false, why: bad };
    // 登入：走既有的 ai_cli_login
    const b0 = calls('ai_cli_login').length;
    await real({ click: at(rowOf('codex').querySelector('button')) }, 400);
    const lg = calls('ai_cli_login');
    if (lg.length !== b0 + 1 || !lg[lg.length - 1][1] || lg[lg.length - 1][1].toolId !== 'codex') return { ok: false, why: '按 Codex 的「登入」應該呼叫 ai_cli_login（toolId codex）：' + JSON.stringify(lg.slice(b0)) };
    // 開一個視窗：Claude、Gemini 各一次
    await real({ click: at(rowOf('claude').querySelector('button')) }, 500);
    if ((bad = await checkDlg('Claude'))) return { ok: false, why: bad };
    await real({ click: at(rowOf('gemini').querySelector('button')) }, 500);
    if ((bad = await checkDlg('Gemini'))) return { ok: false, why: bad };
  }
  if (want.kind === 'recheck') {
    if ((bad = await expectRow('claude', [], '找不到 Claude Code。剛裝好的話，按下面的「重新檢查」。'))) return { ok: false, why: bad };
    const d0 = calls('ai_cli_detect').length;
    const rb = [...card().querySelectorAll('.ng-recheck')].find(vis);
    if (!rb || txt(rb) !== '重新檢查') return { ok: false, why: '卡片上沒有「重新檢查」鈕：' + txt(rb) };
    globalThis.__smokeOverride = { ai_cli_detect: FOUND_CLAUDE };   // 這時才「裝好」Claude
    await real({ click: at(rb) }, 300);
    if (!(await waitFor(() => calls('ai_cli_detect').length > d0, 30))) return { ok: false, why: '按「重新檢查」沒有再呼叫 ai_cli_detect' };
    if ((bad = await expectRow('claude', ['開一個視窗']))) return { ok: false, why: '重新檢查後 Claude 沒有變成可開視窗：' + bad };
    if (!(await waitFor(() => { const b = [...card().querySelectorAll('.ng-recheck')].find(vis); return b && !b.disabled && txt(b) === '重新檢查' }, 30))) return { ok: false, why: '檢查完「重新檢查」鈕沒有恢復' };
    const d1 = calls('ai_cli_detect').length;
    await real({ click: at(rowOf('claude').querySelector('button')) }, 500);
    if ((bad = await checkDlg('Claude'))) return { ok: false, why: bad };
    if (calls('ai_cli_detect').length <= d1) return { ok: false, why: '開新夥伴對話框時沒有再偵測一次（ai_cli_detect 沒有再被呼叫）' };
  }
  if (want.kind === 'ready') {
    for (const k of ['claude', 'codex', 'gemini', 'grok']) { if ((bad = await expectRow(k, ['開一個視窗']))) return { ok: false, why: bad } }
    await real({ click: at(rowOf('grok').querySelector('button')) }, 500);
    if ((bad = await checkDlg('Grok'))) return { ok: false, why: bad };
  }
  // 先不用：卡片收起、出現「顯示新手引導」、記在本機；再點回來
  const hide = card().querySelector('.ng-hide');
  if (!hide || txt(hide) !== '先不用') return { ok: false, why: '卡片上沒有「先不用」' };
  await real({ click: at(hide) }, 400);
  if (!(await waitFor(() => !card(), 60))) return { ok: false, why: '按「先不用」之後卡片還在' };
  if (localStorage.getItem(KEY) !== '1') return { ok: false, why: '「先不用」沒有記在本機' };
  const rs = await waitFor(reshow, 20);
  if (!rs || txt(rs) !== '顯示新手引導') return { ok: false, why: '收起後沒有「顯示新手引導」：' + txt(rs) };
  await real({ click: at(rs) }, 400);
  if (!(await waitFor(card, 20))) return { ok: false, why: '按「顯示新手引導」之後卡片沒有回來' };
  if (localStorage.getItem(KEY) !== null) return { ok: false, why: '「顯示新手引導」沒有清掉本機的記號' };
  if (reshow()) return { ok: false, why: '卡片回來後「顯示新手引導」還在' };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
  finally { try { localStorage.removeItem(KEY) } catch (e) {} delete globalThis.__smokeOverride }
})()`

// 手機：設定 → 設備 → 辦公室（只有 ASN 程式本身的視窗、沒有 AI 夥伴）的細部頁：Claude 已登入、Codex 已裝沒登入、Gemini／Grok 沒裝
export const newComputerGuidePhoneProbeSource = (open = false) => `(async () => {
  const OPEN = ${open ? 'true' : 'false'};
  const KEY = 'asnNewComputerGuideHidden';
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 300) };
  const waitFor = async (fn, n = 60) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const txt = e => (e ? e.textContent.replace(/\s+/g, ' ').trim() : '');
  const card = () => [...document.querySelectorAll('.ng-card')].find(vis);
  const rowOf = k => card() && card().querySelector('.ng-row[data-vendor="' + k + '"]');
  const btns = k => [...rowOf(k).querySelectorAll('button')].map(b => b.textContent.trim());
  localStorage.removeItem(KEY);
  const set = await waitFor(() => [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes('設備')));
  if (!set) return { ok: false, why: '找不到設定裡的「設備」' };
  set.click(); await sleep(500);
  const row = await waitFor(() => [...document.querySelectorAll('.m-dv-row')].find(r => vis(r) && txt(r).includes('辦公室')));
  if (!row) return { ok: false, why: '找不到「辦公室」那一列' };
  [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '詳情')?.click(); await sleep(600);   // 列上的「詳情」：新手引導卡直接放在詳情裡（#1860：詳情沒有帳號分頁了）
  if ([...document.querySelectorAll('.m-dv-subbtn')].some(vis)) return { ok: false, why: '辦公室的詳情裡不該再有「帳號」分頁' };
  if (!(await waitFor(card, 60))) return { ok: false, why: '辦公室沒有 AI 視窗，細部頁卻看不到新手引導卡：' + txt(document.querySelector('.m-dv') || document.body).slice(0, 160) };
  const order = [...card().querySelectorAll('.ng-row')].map(r => r.getAttribute('data-vendor')).join(',');
  if (order !== 'claude,codex,gemini,grok') return { ok: false, why: '四家順序不對：' + order };
  const want = [['claude', ['開一個視窗']], ['codex', ['登入']], ['gemini', []], ['grok', []]];
  for (const [k, b] of want) { if (JSON.stringify(btns(k)) !== JSON.stringify(b)) return { ok: false, why: k + ' 的按鈕應為 [' + b.join('、') + ']，實際 [' + btns(k).join('、') + ']：' + txt(rowOf(k)) } }
  if (card().querySelector('.ng-recheck')) return { ok: false, why: '手機叫不動那台電腦重新偵測，不該有「重新檢查」' };
  if (!txt(rowOf('grok')).includes('還沒裝 Grok，裝好後這裡會出現「開一個視窗」。') || !txt(rowOf('grok')).includes('到 Grok 官網 下載安裝')) return { ok: false, why: 'Grok 那列說明不對：' + txt(rowOf('grok')) };
  // 手機：沒裝的 Gemini／Grok 官網下面有 Edge 提醒，而且不超出卡片
  for (const k of ['gemini', 'grok']) {
    const e = rowOf(k).querySelectorAll('.ng-edge');
    if (e.length !== 1 || txt(e[0]) !== 'Edge 擋下載的話，按「…」→「保留」→「仍要保留」') return { ok: false, why: k + ' 手機版官網下面應該有一行 Edge 擋下載的提醒：' + txt(rowOf(k)) };
    if (e[0].getBoundingClientRect().right > card().getBoundingClientRect().right + 1) return { ok: false, why: k + ' 手機版 Edge 提醒超出卡片' };
  }
  if (rowOf('claude').querySelector('.ng-edge')) return { ok: false, why: '已安裝的 Claude 不該有 Edge 提醒' };
  if (OPEN) {
    // 開一個視窗：走手機既有的開新夥伴，選好辦公室與 Claude
    await real({ click: at(rowOf('claude').querySelector('button')) }, 800);
    const lch = await waitFor(() => [...document.querySelectorAll('.m-lch')].find(vis), 40);
    if (!lch) return { ok: false, why: '按「開一個視窗」之後沒有進到開新夥伴頁' };
    if (!txt(lch).includes('辦公室')) return { ok: false, why: '開新夥伴頁沒有選好辦公室：' + txt(lch).slice(0, 160) };
    const claudeOn = await waitFor(() => [...document.querySelectorAll('.m-lch [aria-pressed="true"]')].some(e => txt(e).includes('Claude')), 40);
    if (!claudeOn) return { ok: false, why: '開新夥伴頁沒有選好 Claude：' + txt(document.querySelector('.m-lch')).slice(0, 200) };
    return { ok: true, why: '' };
  }
  // 官網連結：交給系統瀏覽器（open_link）
  const l0 = (globalThis.__smokeCalls || []).filter(c => c[0] === 'open_link').length;
  await real({ click: at(rowOf('grok').querySelector('a.ng-link')) }, 400);
  const ol = (globalThis.__smokeCalls || []).filter(c => c[0] === 'open_link');
  if (ol.length !== l0 + 1 || ol[ol.length - 1][1].url !== 'https://docs.x.ai/build/overview') return { ok: false, why: '點 Grok 官網應該呼叫 open_link：' + JSON.stringify(ol.slice(l0)) };
  // 登入：Codex 走既有的「從手機替這台登入」確認
  await real({ click: at(rowOf('codex').querySelector('button')) }, 500);
  const conf = await waitFor(() => [...document.querySelectorAll('.m-dv-confirm')].find(vis), 30);
  if (!conf || !txt(conf).includes('Codex')) return { ok: false, why: '按 Codex 的「登入」之後沒有出現確認：' + txt(conf) };
  const no = [...conf.querySelectorAll('button')].find(b => txt(b) === '先不要');
  if (no) { await real({ click: at(no) }, 300) }
  // 先不用／顯示新手引導
  const hide = card().querySelector('.ng-hide');
  await real({ click: at(hide) }, 400);
  if (card()) return { ok: false, why: '按「先不用」之後卡片還在' };
  const rs = await waitFor(() => [...document.querySelectorAll('.ng-reshow')].find(vis), 20);
  if (!rs) return { ok: false, why: '收起後沒有「顯示新手引導」' };
  await real({ click: at(rs) }, 400);
  if (!(await waitFor(card, 20))) return { ok: false, why: '按「顯示新手引導」之後卡片沒有回來' };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
  finally { try { localStorage.removeItem(KEY) } catch (e) {} }
})()`

const scene = (name, kind, page = 'partners', skin = '') => ({
  name, page: 'list.html', width: 900, height: 760,
  state: { signedIn: true, guideKind: kind, ...(skin ? { skin } : {}) },
  ready: '#app.win', probe: { newComputerGuide: { kind, page } }, shot: `${name}.png`,
})

export default {
  key: 'newComputerGuide',
  kind: '新手引導卡檢查',
  source: probe => (probe.newComputerGuide.phone ? newComputerGuidePhoneProbeSource(probe.newComputerGuide.open === true) : newComputerGuideProbeSource(probe.newComputerGuide)),
  scenarios: [
    scene('list-guide-blank', 'blank'),
    scene('list-guide-partial', 'partial'),
    scene('list-guide-ready', 'ready'),
    scene('list-guide-pending', 'pending'),
    scene('list-guide-recheck', 'recheck'),
    scene('list-guide-chats-blank', 'blank', 'chats'),
    scene('list-guide-chats-partial', 'partial', 'chats'),
    scene('list-guide-modern', 'partial', 'partners', 'modern'),
    scene('list-guide-line', 'blank', 'partners', 'line'),
    { name: 'm-guide-open', page: 'm.html', state: { signedIn: true, guideKind: 'phone' }, ready: '#app.m .m-pager', probe: { newComputerGuide: { phone: true, open: true } } },
    { name: 'm-guide', page: 'm.html', state: { signedIn: true, guideKind: 'phone' }, ready: '#app.m .m-pager', probe: { newComputerGuide: { phone: true } }, shot: 'm-guide.png' },
  ],
  // 假後台：偵測結果與本機帳號（pending 不放 ai_cli_detect，偵測回不來）；官網、登入都收下
  table: (scenario, t) => {
    const k = scenario.state?.guideKind
    if (!k) return undefined
    if (k === 'phone') {
      // 辦公室（Q）只有 ASN 程式本身的視窗；啟動設定回報裝了 Claude、Codex；帳號回報只有 Claude 已登入
      const fresh = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000).toISOString()
      return {
        relay_list: { members: [{ id: 'Q', name: '辦公室', agents: [{ name: '辦公室-asn', status: 'idle', engine: 'asn', cwd_label: '' }] }] },
        store_load: { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify({ navTab: 'me' }) } },
        android_launchers: { machines: [{ node: 'Q', online: true, platform: 'windows', launcher: { profiles: [{ id: 'claude' }, { id: 'codex' }], cwd_allow: ['D:/work'] } }] },
        android_acct_list: { by: 'node', values: { Q: { asn_online: true, reported_at: fresh, accounts: [{ vendor: 'claude', email: 'work@example.com', plan: 'claude_pro', current: true }] } }, fallback: null },
        android_acct_roster: null,
        open_link: null,
      }
    }
    const o = { open_link: null, ai_cli_login: null, grok_accounts_list: [], launch_cwd_candidates: [] }
    if (k !== 'pending') o.ai_cli_detect = GUIDE_TOOLS[k]
    if (k === 'partial' || k === 'ready' || k === 'recheck') { o.claude_accounts_list = CLAUDE; o.claude_account_current = CLAUDE[0] }
    if (k === 'ready') { o.codex_account_current = { email: 'me@example.com', plan: 'plus' }; o.grok_accounts_list = [{ email: 'me@example.com', current: true }] }
    return o
  },
}
