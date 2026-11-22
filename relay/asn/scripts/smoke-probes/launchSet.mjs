// 冒煙探測「啟動設定現況修正檢查」（probe.launchSet，#1548 第 1 張）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 1. 各家 CLI 清單顯示偵測到的版本（以前後端沒給版本，永遠只寫「已安裝」）
// 2. Claude 外掛只有一行狀態（#1548 第 2 張）：installed／no_claude／failed 各一個情境，畫面字照白話對照、沒有打勾框、失敗原因不外露
// 3. 每小時上限：顯示後端給的生效值（不是舊存檔的 maxPerHour）、底下有白話說明；用真的滑鼠與鍵盤打進超過 20 的值，存的是 maxPerHourSet:20（夾在 1～20）、
//    不寫舊的 maxPerHour 與顯示用的生效值，而且白名單是空的時候
//    不會把文字框裡的「建議資料夾」當成白名單存下去
// 4. err 情境：存檔被拒絕時畫面上看得到原因
// 5. 四區標題與順序（已安裝的工具／外掛與互通／安全限制／進階）、CLI 清單每列名稱與版本分欄（量得到不重疊）

export const LAUNCH_SET_TOOLS = {
  checked_at: '0',
  tools: [
    { id: 'claude', label: 'Claude', binary_found: true, install_available: true, login_available: true, install_blurb: '', login_blurb: '', version: '2.0.31' },
    { id: 'codex', label: 'Codex', binary_found: true, install_available: false, login_available: true, install_blurb: '', login_blurb: '', version: '' },
    { id: 'agy', label: 'Gemini', binary_found: false, install_available: false, login_available: false, install_blurb: '請到官網安裝 Gemini。', login_blurb: '', version: '' },
    { id: 'grok', label: 'Grok', binary_found: false, install_available: false, login_available: false, install_blurb: '請到官網安裝 Grok。', login_blurb: '', version: '' },
    { id: 'pi', label: 'pi', binary_found: false, install_available: false, login_available: false, install_blurb: '請到官網安裝 pi。', login_blurb: '', version: '' },
  ],
}
// 外掛狀態情境：Rust 回報的 {state,...} 與畫面上該看到的那一行（這裡寫死字，不引用 ui/lib/mod-line.mjs，免得自己驗自己）
export const LAUNCH_SET_MODS = {
  installed: { report: { state: 'installed', version: '1.2.3' }, text: '已安裝 v1.2.3，ASN 更新時會一起更新' },
  no_claude: { report: { state: 'no_claude' }, text: '這台電腦沒有 Claude，裝好 Claude 後重新開啟 ASN 會自動安裝' },
  failed: { report: { state: 'failed', reason: 'spawn ENOENT secret-detail' }, text: '安裝沒有成功，重新開啟 ASN 會再試一次' },
}
const SUGGEST = 'D:\\demo'
const ME = { winMode: 'merged', session: { v: 1, tabs: [{ id: '@setting' }], active: { id: '@setting' }, panel: { guide: '', setting: 'launch' }, windows: [], panelWindows: [] } }

export const launchSetProbeSource = ({ err = false, mod = 'installed' } = {}) => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const want = ${JSON.stringify({ err, mod: LAUNCH_SET_MODS[mod].text, suggest: SUGGEST })};
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
  const rows = await waitFor(() => { const r = [...box.querySelectorAll('.launch-tools li')]; return r.length === 5 && r[0].textContent.includes('2.0.31') ? r : null });
  if (!rows) return { ok: false, why: 'Claude 那一列沒有顯示版本 2.0.31：' + [...box.querySelectorAll('.launch-tools li')].map(l => l.textContent.trim()).join('｜') };
  for (const li of rows) {   // 名稱與後面的字分欄：兩個格子各自有寬度、後者在前者右邊、不重疊
    const cells = [...li.children].map(c => c.getBoundingClientRect());
    if (cells.length < 2 || cells.some(r => r.width < 1) || cells[1].left < cells[0].right + 4) return { ok: false, why: '工具清單名稱和版本擠在一起：' + li.textContent.trim() };
  }
  if (!rows[1].textContent.includes('已安裝')) return { ok: false, why: '讀不到版本的 Codex 要寫「已安裝」：' + rows[1].textContent.trim() };
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
  const area = box.querySelector('textarea.set-area');
  if (!area || !area.value.includes(want.suggest)) return { ok: false, why: '白名單空的時候文字框要先顯示建議資料夾（測試資料不對）：' + (area && area.value) };
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
    if (!p || !Array.isArray(p.cwdAllow) || p.cwdAllow.length) return { ok: false, why: '白名單是空的，改上限不該把建議資料夾存成白名單：' + JSON.stringify(p && p.cwdAllow) };
    if (p.maxPerHourSet !== 20) return { ok: false, why: '輸入超過 20 的值應該存成 maxPerHourSet:20（夾在 1～20）：' + JSON.stringify(p.maxPerHourSet) };
    if ('maxPerHour' in p || 'maxPerHourEffective' in p) return { ok: false, why: '存檔不該再寫舊的 maxPerHour 或顯示用的生效值：' + JSON.stringify(Object.keys(p)) };
  }
  await sleep(300);
  const errEl = [...box.querySelectorAll('[role="alert"]')].find(e => vis(e) && e.textContent.includes('啟動設定沒有存成功'));
  if (want.err && !errEl) return { ok: false, why: '存檔被拒絕時畫面上沒有說明' };
  if (!want.err && errEl) return { ok: false, why: '存檔成功卻顯示失敗：' + errEl.textContent };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const scene = (name, skin, err = false, mod = 'installed', width = 900) => ({ name, page: 'list.html', width, height: 760, state: { signedIn: true, launchSet: err ? 'err' : 'ok', launchMod: mod, ...(skin ? { skin } : {}) }, ready: '#app.win .launch-set', probe: { launchSet: { err, mod } }, shot: `${name}.png` })

export default {
  key: 'launchSet',
  kind: '啟動設定現況修正檢查',
  source: probe => launchSetProbeSource(probe.launchSet),
  scenarios: [scene('list-launch-set'), scene('list-launch-set-modern', 'modern'), scene('list-launch-set-line', 'line'), scene('list-launch-set-err', '', true), scene('list-launch-set-nomod', '', false, 'no_claude'), scene('list-launch-set-modfail', '', false, 'failed'), scene('list-launch-set-narrow', '', false, 'installed', 420)],
  // 假後台：偵測帶版本、外掛狀態、啟動偏好（後端填好的上限 3、白名單空、最近用過一個資料夾）；err 情境存檔被拒絕（不放 launch_prefs_set）
  table: (scenario, t) => {
    const k = scenario.state?.launchSet
    if (!k) return undefined
    const o = {
      ai_cli_detect: LAUNCH_SET_TOOLS, pi_setup_status: { pi: true, ext: true, installed: true, stale: false }, askpass_helper_info: { path: 'C:/asn/asn-askpass.exe', example: 'setx SSH_ASKPASS "C:/asn/asn-askpass.exe"' }, claude_mod_report: LAUNCH_SET_MODS[scenario.state.launchMod || 'installed'].report,
      launch_prefs_get: { maxPerHour: 6, maxPerHourEffective: 3, cwdAllow: [], recentCwd: [SUGGEST] },   // 舊程式寫的 maxPerHour:6 不算；生效值 3（例如 launcher.json 寫的）
      store_load: { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(ME) } },
    }
    if (k === 'ok') o.launch_prefs_set = null
    return o
  },
}
