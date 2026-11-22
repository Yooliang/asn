// 冒煙探測「啟動設定現況修正檢查」（probe.launchSet，#1548 第 1 張）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 1. 各家 CLI 清單顯示偵測到的版本（以前後端沒給版本，永遠只寫「已安裝」）
// 2. Claude 外掛只有一行狀態（#1548 第 2 張）：installed／no_claude／failed 各一個情境，畫面字照白話對照、沒有打勾框、失敗原因不外露
// 3. 每小時上限：顯示後端給的生效值（不是舊存檔的 maxPerHour）、底下有白話說明；用真的滑鼠與鍵盤打進超過 20 的值，存的是 maxPerHourSet:20（夾在 1～20）、
//    不寫舊的 maxPerHour 與顯示用的生效值，而且白名單是空的時候
//    不會把文字框裡的「建議資料夾」當成白名單存下去
// 4. err 情境：存檔被拒絕時畫面上看得到原因
// 6. 工作資料夾清單（#1548 ③）：一列一個資料夾＋「移除」、「＋ 加入資料夾…」、建議列「加入」；用真的滑鼠點，量得到按鈕靠右（窄版加入鈕也靠右）；
//    加入／移除失敗時在清單下面用白話顯示；不再有文字框
// 7. 工具狀態（#1548 ④）：每家一列「版本／最新版狀態／登入狀態」——已是最新版、有新版、暫時查不到；已登入、沒登入、登入狀態查不到各一個；
//    status=fail 情境（後端查不到）全部寫「暫時查不到」、不出現「過期」；按「重新檢查」會用略過快取（force:true）再查一次
// 5. 四區標題與順序（已安裝的工具／外掛與互通／安全限制／進階）、CLI 清單每列名稱與版本分欄（量得到不重疊）

export const LAUNCH_SET_TOOLS = {
  checked_at: '0',
  tools: [
    { id: 'claude', label: 'Claude', binary_found: true, install_available: true, login_available: true, install_blurb: '', login_blurb: '', version: '2.0.31' },
    { id: 'codex', label: 'Codex', binary_found: true, install_available: false, login_available: true, install_blurb: '', login_blurb: '', version: '0.46.0' },
    { id: 'agy', label: 'Gemini', binary_found: false, install_available: false, login_available: false, install_blurb: '請到官網安裝 Gemini。', login_blurb: '', version: '' },
    { id: 'grok', label: 'Grok', binary_found: true, install_available: false, login_available: false, install_blurb: '', login_blurb: '', version: '1.4.2' },
    { id: 'pi', label: 'pi', binary_found: true, install_available: false, login_available: true, install_blurb: '', login_blurb: '', version: '0.9.1' },
  ],
}
// 後端 ai_cli_status 的回答：每種狀態至少一列（Claude 最新版＋已登入；Codex 有新版＋登入查不到；Grok 查不到＋登入查不到；pi 查不到＋已登入 2 家；Gemini 沒裝）
export const LAUNCH_SET_STATUS = {
  checked_at: '0',
  tools: [
    { id: 'claude', installed: true, version: '2.0.31', version_state: 'latest', latest: '', login: 'in', login_count: 0 },
    { id: 'codex', installed: true, version: '0.46.0', version_state: 'behind', latest: '0.48.0', login: 'unknown', login_count: 0 },
    { id: 'agy', installed: false, version: '', version_state: 'unknown', latest: '', login: 'unknown', login_count: 0 },
    { id: 'grok', installed: true, version: '1.4.2', version_state: 'unknown', latest: '', login: 'unknown', login_count: 0 },
    { id: 'pi', installed: true, version: '0.9.1', version_state: 'unknown', latest: '', login: 'in', login_count: 2 },
  ],
}
// 「沒有登入」那種情境：Codex 改成沒登入
export const LAUNCH_SET_STATUS_OUT = { ...LAUNCH_SET_STATUS, tools: LAUNCH_SET_STATUS.tools.map(t => (t.id === 'codex' ? { ...t, login: 'out' } : t)) }
// 畫面上每列該看到的兩格字（這裡寫死，不引用 ui/lib/tool-status.mjs，免得自己驗自己）
const WANT_STATUS = {
  ok: [['Claude', '已是最新版', '已登入'], ['Codex', '有新版 0.48.0', '登入狀態查不到'], ['Grok', '暫時查不到', '登入狀態查不到'], ['pi', '暫時查不到', '已登入 2 家']],
  out: [['Claude', '已是最新版', '已登入'], ['Codex', '有新版 0.48.0', '沒有登入'], ['Grok', '暫時查不到', '登入狀態查不到'], ['pi', '暫時查不到', '已登入 2 家']],
  fail: [['Claude', '暫時查不到', '登入狀態查不到'], ['Codex', '暫時查不到', '登入狀態查不到'], ['Grok', '暫時查不到', '登入狀態查不到'], ['pi', '暫時查不到', '登入狀態查不到']],
}
// 外掛狀態情境：Rust 回報的 {state,...} 與畫面上該看到的那一行（這裡寫死字，不引用 ui/lib/mod-line.mjs，免得自己驗自己）
export const LAUNCH_SET_MODS = {
  installed: { report: { state: 'installed', version: '1.2.3' }, text: '已安裝 v1.2.3，ASN 更新時會一起更新' },
  no_claude: { report: { state: 'no_claude' }, text: '這台電腦沒有 Claude，裝好 Claude 後重新開啟 ASN 會自動安裝' },
  failed: { report: { state: 'failed', reason: 'spawn ENOENT secret-detail' }, text: '安裝沒有成功，重新開啟 ASN 會再試一次' },
}
const SUGGEST = 'D:\\demo'
const SUGGEST2 = 'D:\\tmp'
const CWD_A = 'D:\\work'
const CWD_B = 'D:\\Yooliang\\asn'
const CWD_NEW = 'D:\\new'
const ME = { winMode: 'merged', session: { v: 1, tabs: [{ id: '@setting' }], active: { id: '@setting' }, panel: { guide: '', setting: 'launch' }, windows: [], panelWindows: [] } }

export const launchSetProbeSource = ({ err = false, mod = 'installed', status = 'ok' } = {}) => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const want = ${JSON.stringify({ err, mod: LAUNCH_SET_MODS[mod].text, suggest: SUGGEST, suggest2: SUGGEST2, a: CWD_A, b: CWD_B, n: CWD_NEW, status: WANT_STATUS[status], statusFail: status === 'fail' })};
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 300) };
  const waitFor = async (fn, n = 60) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const sets = () => (globalThis.__smokeCalls || []).filter(c => c[0] === 'launch_prefs_set');
  const refused = () => (globalThis.__smokeMissing || []).filter(c => c === 'launch_prefs_set').length;   // err 情境：存檔被拒絕的次數
  const box = await waitFor(() => [...document.querySelectorAll('.launch-set')].find(vis));
  if (!box) return { ok: false, why: '找不到啟動設定頁' };
  // 0. 分區：四個標題照順序出現
  const heads = [...box.querySelectorAll('.sec-h, .set-adv > summary')].filter(vis).map(e => e.textContent.trim());
  if (heads.join('｜') !== '已安裝的工具｜外掛與互通｜安全限制｜進階') return { ok: false, why: '啟動設定的分區標題不對：' + heads.join('｜') };
  // 1. 版本
  const rows = await waitFor(() => { const r = [...box.querySelectorAll('.launch-tools li')]; return r.length === 5 && r[0].textContent.includes('2.0.31') && r[0].querySelector('.launch-login') && r[0].querySelector('.launch-login').textContent.trim() !== '檢查中…' ? r : null });
  if (!rows) return { ok: false, why: 'Claude 那一列沒有顯示版本 2.0.31：' + [...box.querySelectorAll('.launch-tools li')].map(l => l.textContent.trim()).join('｜') };
  for (const li of rows) {   // 名稱與後面的字分欄：兩個格子各自有寬度、後者在前者右邊、不重疊
    const cells = [...li.children].map(c => c.getBoundingClientRect());
    if (cells.length < 2 || cells.some(r => r.width < 1) || cells[1].left < cells[0].right + 4) return { ok: false, why: '工具清單名稱和版本擠在一起：' + li.textContent.trim() };
  }
  if (!rows[1].textContent.includes('0.46.0')) return { ok: false, why: 'Codex 那一列沒有顯示版本 0.46.0：' + rows[1].textContent.trim() };
  // 1b. 工具狀態：每一列的「最新版」「登入」兩格字照對照；沒裝的那列不放這兩格；「過期」兩個字不能出現
  for (const [name, latest, login] of want.status) {
    const li = rows.find(r => r.querySelector('.launch-name').textContent.trim() === name);
    const a = li && li.querySelector('.launch-latest'), b = li && li.querySelector('.launch-login');
    if (!a || !b || a.textContent.trim() !== latest || b.textContent.trim() !== login) return { ok: false, why: name + ' 的最新版／登入狀態不對（要「' + latest + '」「' + login + '」）：' + (li && li.textContent.trim()) };
    const lr = a.getBoundingClientRect(), gr = b.getBoundingClientRect(), vr = li.querySelector('.launch-ver').getBoundingClientRect();
    if (lr.left < vr.right + 2 || (gr.top < lr.bottom - 2 && gr.left < lr.right + 2)) return { ok: false, why: name + ' 的版本、最新版、登入三格擠在一起' };
    if (gr.right < li.getBoundingClientRect().right - 6) return { ok: false, why: name + ' 的登入狀態沒有靠右' };
  }
  if (rows[2].querySelector('.launch-latest, .launch-login')) return { ok: false, why: '沒裝的 Gemini 不該有最新版與登入狀態' };
  if (/過期|undefined/.test(box.querySelector('.launch-tools').textContent)) return { ok: false, why: '工具清單不該出現「過期」或 undefined' };
  // 1b'. 旗標關（正式版預設）：五家都沒有「進行安裝／進行更新」鈕——DOM 裡完全找不到（#1548 第 5 張）
  if (box.querySelector('.launch-act, .launch-install-note') || /進行安裝|進行更新/.test(box.textContent)) return { ok: false, why: '旗標關著時不該有進行安裝／進行更新鈕：' + box.querySelector('.launch-tools').textContent.trim() };
  // 1c. 重新檢查：按下去用略過快取（force:true）再查一次；按鈕在標題列最右邊
  const rebtn = [...box.querySelectorAll('.sec-head button')].find(b => vis(b) && b.textContent.trim() === '重新檢查');
  if (!rebtn) return { ok: false, why: '找不到「重新檢查」鈕' };
  const hr = rebtn.closest('.sec-head').getBoundingClientRect(), br = rebtn.getBoundingClientRect();
  if (br.right < hr.right - 6) return { ok: false, why: '「重新檢查」沒有靠右' };
  const st = () => (globalThis.__smokeCalls || []).filter(c => c[0] === 'ai_cli_status');
  const s0 = st().length;
  if (want.statusFail) {   // 後端查不到（指令被拒絕）：有嘗試查過，畫面上兩格照樣有字（上面已驗），不出現「過期」
    if (!(globalThis.__smokeMissing || []).includes('ai_cli_status')) return { ok: false, why: '打開啟動設定時沒有嘗試查工具狀態' };
  } else {
  if (!s0 || st()[0][1].force !== false) return { ok: false, why: '打開啟動設定時要查一次工具狀態（force:false）：' + JSON.stringify(st()) };
  rebtn.scrollIntoView({ block: 'center' }); await sleep(150);
  await real({ click: at(rebtn) });
  if (!(await waitFor(() => st().length > s0 && st()[st().length - 1][1].force === true, 30))) return { ok: false, why: '按「重新檢查」沒有用略過快取（force:true）再查一次：' + JSON.stringify(st()) };
  }
  // 2. 外掛狀態
  const modEl = await waitFor(() => [...box.querySelectorAll('section[aria-label="Claude 外掛"] small[role="status"]')].find(e => vis(e) && e.textContent.trim() === want.mod));
  if (!modEl) return { ok: false, why: '看不到 Claude 外掛的狀態文字「' + want.mod + '」：' + [...box.querySelectorAll('section[aria-label="Claude 外掛"]')].map(e => e.textContent.trim()).join('｜') };
  if (box.querySelector('section[aria-label="Claude 外掛"] input[type="checkbox"]')) return { ok: false, why: 'Claude 外掛不該再有打勾框' };
  if (/ENOENT|secret-detail|undefined/.test(modEl.closest('section').textContent)) return { ok: false, why: '外掛狀態不該露出原因原文或 undefined：' + modEl.textContent };
  // 3. 上限：顯示後端給的實際值、有說明
  const input = [...box.querySelectorAll('input.set-input[type="number"]')].find(vis);
  if (!input || input.value !== '3') return { ok: false, why: '上限要顯示後端給的生效值 3（不是舊存檔的 6）：' + (input && input.value) };
  const note = box.querySelector('#set-note-launch-max');
  if (!vis(note) || !note.textContent.includes('自己在這台電腦上開不受限制') || !box.textContent.includes('別的設備一小時最多替這台開')) return { ok: false, why: '上限的欄位文字或底下說明不對' };
  if (box.querySelector('textarea')) return { ok: false, why: '工作資料夾不該再有可以自由打字的文字框' };
  // 6a. 清單：兩列已加入的、一列建議；每列右邊有按鈕且靠右；加入鈕寬版靠左、窄版靠右
  const cwdBox = box.querySelector('.launch-cwds');
  const cwdRows = () => [...cwdBox.querySelectorAll('.launch-cwd-list:not(.suggest) li')].filter(vis);
  const sugRows = () => [...cwdBox.querySelectorAll('.launch-cwd-list.suggest li')].filter(vis);
  const rows0 = cwdRows().map(l => l.querySelector('.launch-cwd-path').textContent.trim());
  if (rows0.join('｜') !== [want.a, want.b].join('｜')) return { ok: false, why: '清單要一列一個資料夾：' + rows0.join('｜') };
  if (sugRows().length !== 2 || !sugRows()[0].textContent.includes('建議：' + want.suggest) || sugRows()[0].querySelector('button').textContent.trim() !== '加入') return { ok: false, why: '建議資料夾那一列不對：' + sugRows().map(l => l.textContent.trim()).join('｜') };
  const edgeOk = (inner, outer, slack) => Math.abs(outer.right - inner.right) <= slack;
  for (const li of [...cwdRows(), ...sugRows()]) { const b = li.querySelector('button'); if (b.textContent.trim() !== (li.parentElement.classList.contains('suggest') ? '加入' : '移除') || !edgeOk(b.getBoundingClientRect(), li.getBoundingClientRect(), 14)) return { ok: false, why: '列右邊的按鈕沒有靠右：' + li.textContent.trim() }; }
  const addBtn = [...cwdBox.querySelectorAll('.launch-cwd-add button')].find(vis);
  if (!addBtn || addBtn.textContent.trim() !== '＋ 加入資料夾…') return { ok: false, why: '找不到「＋ 加入資料夾…」' };
  const ab = addBtn.getBoundingClientRect(), cb = cwdBox.getBoundingClientRect();
  if (window.innerWidth <= 560 ? !edgeOk(ab, cb, 4) : ab.left - cb.left > 4) return { ok: false, why: '加入資料夾的位置不對（窄版要靠右、寬版靠左）：' + JSON.stringify([ab.left, ab.right, cb.left, cb.right]) };
  const n0 = sets().length, r0 = refused();
  input.scrollIntoView({ block: 'center' }); await sleep(150);
  await real({ dblclick: at(input) });
  if (input !== document.activeElement) return { ok: false, why: '雙擊上限的輸入框沒有拿到焦點' };
  await real({ text: '50' });
  await real({ click: at([...box.querySelectorAll('.sec-h')][2]) });   // 點標題讓輸入框失去焦點，送出 change
  if (want.err) {
    if (!(await waitFor(() => refused() > r0, 30))) return { ok: false, why: '改上限之後沒有嘗試存檔' };
  } else {
    const s = await waitFor(() => sets().length > n0 ? sets()[sets().length - 1] : null, 30);
    if (!s) return { ok: false, why: '改上限之後沒有存檔' };
    const p = s[1] && s[1].prefs;
    if (!p || !Array.isArray(p.cwdAllow) || p.cwdAllow.join('｜') !== [want.a, want.b].join('｜')) return { ok: false, why: '改上限存下去的白名單要跟畫面上的清單一樣，不能夾帶建議資料夾：' + JSON.stringify(p && p.cwdAllow) };
    if (p.maxPerHourSet !== 20) return { ok: false, why: '輸入超過 20 的值應該存成 maxPerHourSet:20（夾在 1～20）：' + JSON.stringify(p.maxPerHourSet) };
    if ('maxPerHour' in p || 'maxPerHourEffective' in p) return { ok: false, why: '存檔不該再寫舊的 maxPerHour 或顯示用的生效值：' + JSON.stringify(Object.keys(p)) };
  }
  await sleep(300);
  const errEl = [...box.querySelectorAll('[role="alert"]')].find(e => vis(e) && e.textContent.includes('啟動設定沒有存成功'));
  if (want.err && !errEl) return { ok: false, why: '存檔被拒絕時畫面上沒有說明' };
  if (!want.err && errEl) return { ok: false, why: '存檔成功卻顯示失敗：' + errEl.textContent };
  // 6b. 加入／移除（真的點）
  const calls = name => (globalThis.__smokeCalls || []).filter(c => c[0] === name);
  const msgOf = () => { const e = [...cwdBox.querySelectorAll('[role="alert"]')].find(vis); return e ? e.textContent.trim() : '' };
  if (want.err) {
    addBtn.scrollIntoView({ block: 'center' }); await sleep(150);
    await real({ click: at(addBtn) });
    if (!(await waitFor(() => msgOf().includes('加入資料夾沒有成功'), 30))) return { ok: false, why: '加入失敗時清單下面沒有白話說明：' + msgOf() };
    await real({ click: at(cwdRows()[0].querySelector('button')) });
    if (!(await waitFor(() => msgOf().includes('移除沒有成功'), 30))) return { ok: false, why: '移除失敗時清單下面沒有白話說明：' + msgOf() };
    if (cwdRows().length !== 2) return { ok: false, why: '移除失敗清單不該少列' };
    return { ok: true, why: '' };
  }
  const base = { maxPerHour: 6, maxPerHourEffective: 3, recentCwd: [want.suggest, want.suggest2] };
  // 加入資料夾：後端挑好資料夾（假的），重讀設定後多一列
  globalThis.__smokeOverride = { launch_cwd_browse: want.n, launch_prefs_get: { ...base, cwdAllow: [want.a, want.b, want.n] } };
  await real({ click: at(addBtn) });
  if (!(await waitFor(() => cwdRows().length === 3, 30))) return { ok: false, why: '按「加入資料夾…」後清單沒有多一列：' + cwdRows().length };
  if (calls('launch_cwd_browse').length !== 1) return { ok: false, why: '「加入資料夾…」沒有呼叫挑選資料夾' };
  if (msgOf()) return { ok: false, why: '加入成功不該有錯誤訊息：' + msgOf() };
  // 建議列「加入」：走整份存檔，帶著原有的三個加上建議的那個
  const nSet = sets().length;
  await real({ click: at(sugRows()[0].querySelector('button')) });
  const s2 = await waitFor(() => sets().length > nSet ? sets()[sets().length - 1] : null, 30);
  if (!s2 || (s2[1].prefs.cwdAllow || []).join('｜') !== [want.a, want.b, want.n, want.suggest].join('｜')) return { ok: false, why: '建議列「加入」沒有存成預期的清單：' + JSON.stringify(s2 && s2[1].prefs.cwdAllow) };
  if (!(await waitFor(() => cwdRows().length === 4 && sugRows().length === 1, 30))) return { ok: false, why: '加入建議後，清單要多一列、那個建議列要消失（剩另一個）' };
  // 移除第一列
  globalThis.__smokeOverride = { ...globalThis.__smokeOverride, launch_cwd_remove: [want.b, want.n, want.suggest] };
  await real({ click: at(cwdRows()[0].querySelector('button')) });
  if (!(await waitFor(() => cwdRows().length === 3 && !cwdRows().some(l => l.textContent.includes(want.a)), 30))) return { ok: false, why: '按「移除」後那一列沒有消失' };
  const rm = calls('launch_cwd_remove');
  if (rm.length !== 1 || rm[0][1].cwd !== want.a) return { ok: false, why: '「移除」呼叫的參數不對：' + JSON.stringify(rm) };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const scene = (name, skin, err = false, mod = 'installed', width = 900, status = 'ok') => ({ name, page: 'list.html', width, height: 760, state: { signedIn: true, launchSet: err ? 'err' : 'ok', launchMod: mod, launchStatus: status, ...(skin ? { skin } : {}) }, ready: '#app.win .launch-set', probe: { launchSet: { err, mod, status } }, shot: `${name}.png` })

export default {
  key: 'launchSet',
  kind: '啟動設定現況修正檢查',
  source: probe => launchSetProbeSource(probe.launchSet),
  scenarios: [scene('list-launch-set'), scene('list-launch-set-modern', 'modern'), scene('list-launch-set-line', 'line'), scene('list-launch-set-err', '', true), scene('list-launch-set-nomod', '', false, 'no_claude'), scene('list-launch-set-modfail', '', false, 'failed'), scene('list-launch-set-narrow', '', false, 'installed', 420), scene('list-launch-set-out', '', false, 'installed', 900, 'out'), scene('list-launch-set-statusfail', '', false, 'installed', 900, 'fail'), scene('list-launch-set-modern-narrow', 'modern', false, 'installed', 420), scene('list-launch-set-line-narrow', 'line', false, 'installed', 420)],
  // 假後台：偵測帶版本、外掛狀態、啟動偏好（後端填好的上限 3、白名單兩個舊資料夾、最近用過兩個不在清單裡的資料夾當建議）；err 情境存檔被拒絕（不放 launch_prefs_set）
  table: (scenario, t) => {
    const k = scenario.state?.launchSet
    if (!k) return undefined
    const o = {
      ai_cli_detect: LAUNCH_SET_TOOLS, ...(scenario.state.launchStatus === 'fail' ? {} : { ai_cli_status: scenario.state.launchStatus === 'out' ? LAUNCH_SET_STATUS_OUT : LAUNCH_SET_STATUS }), pi_setup_status: { pi: true, ext: true, installed: true, stale: false }, askpass_helper_info: { path: 'C:/asn/asn-askpass.exe', example: 'setx SSH_ASKPASS "C:/asn/asn-askpass.exe"' }, claude_mod_report: LAUNCH_SET_MODS[scenario.state.launchMod || 'installed'].report,
      launch_prefs_get: { maxPerHour: 6, maxPerHourEffective: 3, cwdAllow: [CWD_A, CWD_B], recentCwd: [SUGGEST, SUGGEST2] },   // 舊程式寫的 maxPerHour:6 不算；生效值 3（例如 launcher.json 寫的）
      store_load: { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(ME) } },
    }
    if (k === 'ok') { o.launch_prefs_set = null; o.launch_cwd_browse = null; o.launch_cwd_remove = [] }   // 探測用 __smokeOverride 換成這次要的回應
    return o
  },
}
