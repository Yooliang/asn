// 冒煙探測「啟動設定：Claude 那一列的進行安裝／進行更新」（probe.launchInstall，#1548 第 5 張）。旗標 LAUNCH_INSTALL_BTN 正式版預設關；
// 這裡靠假後台的 __launchInstallBtn 把它打開，驗「打開後」的行為（旗標關的情境由 launchSet 探測驗：整頁找不到這顆鈕）。全部用假的安裝，絕不真的執行。
// mode：install（Claude 沒裝）／update（Claude 有新版 2.1.0）；end：
//   idle    只驗鈕出現（只有 Claude 那一列、其他四家都沒有），並走一次「按了跳確認 → 先不要 → 沒有呼叫安裝」
//   ok      同意後呼叫一次 ai_cli_install（toolId=claude）、原位寫進度（不跳框）、成功字樣、自動重查狀態（force:true）、鈕消失
//   fail    後端丟錯：畫面白話、原文不外露、鈕還在可以重試、一樣重查狀態
//   off     旗標沒開（正式版預設）：Claude 沒裝或有新版，五家照樣都沒有鈕
//   running 後端一直不回：原位寫「正在安裝／更新」、沒有鈕
import { LAUNCH_SET_STATUS, LAUNCH_SET_TOOLS } from './launchSet.mjs'

const ME = { winMode: 'merged', session: { v: 1, tabs: [{ id: '@setting' }], active: { id: '@setting' }, panel: { guide: '', setting: 'launch' }, windows: [], panelWindows: [] } }
const patch = (list, id, o) => list.map(t => (t.id === id ? { ...t, ...o } : t))
const tools = mode => ({ ...LAUNCH_SET_TOOLS, tools: patch(LAUNCH_SET_TOOLS.tools, 'claude', mode === 'install' ? { binary_found: false, version: '' } : {}) })
const status = mode => ({ ...LAUNCH_SET_STATUS, tools: patch(LAUNCH_SET_STATUS.tools, 'claude', mode === 'install' ? { installed: false, version: '', version_state: 'unknown' } : { version_state: 'behind', latest: '2.1.0' }) })
// 裝好／更新好之後重查回來的樣子
const toolsAfter = { ...LAUNCH_SET_TOOLS, tools: patch(LAUNCH_SET_TOOLS.tools, 'claude', { binary_found: true, version: '2.1.0' }) }
const statusAfter = { ...LAUNCH_SET_STATUS, tools: patch(LAUNCH_SET_STATUS.tools, 'claude', { installed: true, version: '2.1.0', version_state: 'latest', latest: '' }) }

export const launchInstallProbeSource = ({ mode = 'install', end = 'idle' } = {}) => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const want = ${JSON.stringify({ mode, end, label: mode === 'install' ? '進行安裝' : '進行更新', yes: mode === 'install' ? '同意並安裝' : '同意並更新', running: mode === 'install' ? '正在安裝 Claude' : '正在更新 Claude', done: mode === 'install' ? '已安裝完成' : '已更新完成', fail: mode === 'install' ? '這次沒有安裝成功' : '這次沒有更新成功', toolsAfter, statusAfter })};
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 300) };
  const waitFor = async (fn, n = 60) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const calls = name => (globalThis.__smokeCalls || []).filter(c => c[0] === name);
  const box = await waitFor(() => [...document.querySelectorAll('.launch-set')].find(vis));
  if (!box) return { ok: false, why: '找不到啟動設定頁' };
  if (want.end === 'off') {   // 旗標關（正式版預設）：Claude 沒裝／有新版也一樣，五家都沒有這顆鈕，DOM 裡找不到、字也沒有
    const ready = await waitFor(() => { const r = [...box.querySelectorAll('.launch-tools li')]; return r.length === 5 && !box.querySelector('.launch-tools').textContent.includes('檢查中') && r[0].querySelector(want.mode === 'update' ? '.launch-latest' : '.launch-hint') ? r : null });
    if (!ready) return { ok: false, why: '工具清單沒有載入：' + box.querySelector('.launch-tools').textContent.trim() };
    if (box.querySelector('.launch-tools button, .launch-act, .launch-install-note') || /進行安裝|進行更新/.test(box.textContent)) return { ok: false, why: '旗標關著時五家都不該有進行安裝／進行更新鈕：' + box.querySelector('.launch-tools').textContent.trim() };
    return { ok: true, why: '' };
  }
  const rows = await waitFor(() => { const r = [...box.querySelectorAll('.launch-tools li')]; return r.length === 5 && r[0].querySelector('.launch-act') ? r : null });
  if (!rows) return { ok: false, why: '工具清單沒有載入：' + [...box.querySelectorAll('.launch-tools li')].map(l => l.textContent.trim()).join('｜') };
  const rowOf = name => rows.find(r => r.querySelector('.launch-name').textContent.trim() === name);
  const btnOf = li => li && [...li.querySelectorAll('button.launch-act')].find(vis);
  const claude = rowOf('Claude');
  // 1. 只有 Claude 那一列有鈕；Codex（有新版）、Gemini（沒裝）、Grok、pi 完全沒有（DOM 裡都找不到）
  const b = await waitFor(() => btnOf(claude));
  if (!b || b.textContent.trim() !== want.label) return { ok: false, why: 'Claude 那一列要有「' + want.label + '」：' + claude.textContent.trim() };
  const others = rows.filter(r => r !== claude);
  if (others.some(r => r.querySelector('button, .launch-install-note'))) return { ok: false, why: '其他四家不該有任何按鈕：' + others.map(r => r.textContent.trim()).join('｜') };
  if (box.querySelectorAll('button.launch-act').length !== 1) return { ok: false, why: '整頁只該有一顆進行安裝／更新鈕' };
  // 靠右：鈕的右邊貼著列的右邊（窄版換行後也是）
  const edge = (el, outer, slack) => Math.abs(outer.getBoundingClientRect().right - el.getBoundingClientRect().right) <= slack;
  if (!edge(b, claude, 8)) return { ok: false, why: '進行安裝／更新鈕沒有靠右' };
  b.scrollIntoView({ block: 'center' }); await sleep(150);
  // 2. 按下先跳確認（在原位，不是跳框）；文字講會發生什麼；先不要＝不呼叫安裝
  await real({ click: at(b) });
  const note = await waitFor(() => [...claude.querySelectorAll('.launch-install-note')].find(e => vis(e) && e.textContent.includes('驗過數位簽章')), 30);
  if (!note) return { ok: false, why: '按下去沒有在原位跳出確認說明：' + claude.textContent.trim() };
  if (btnOf(claude)) return { ok: false, why: '確認時進行安裝／更新鈕應先收起' };
  const btns = [...note.querySelectorAll('button')].filter(vis);
  if (btns.map(x => x.textContent.trim()).join('｜') !== '先不要｜' + want.yes) return { ok: false, why: '確認的兩顆鈕不對：' + btns.map(x => x.textContent.trim()).join('｜') };
  if (!btns.every(x => edge(x, note, 8) || x.getBoundingClientRect().right <= note.getBoundingClientRect().right)) return { ok: false, why: '確認的鈕沒有在右邊' };
  if (calls('ai_cli_install').length) return { ok: false, why: '還沒同意就呼叫了安裝' };
  if (want.end === 'idle') {
    await real({ click: at(btns[0]) });
    if (!(await waitFor(() => btnOf(claude) && !claude.querySelector('.launch-install-note'), 30))) return { ok: false, why: '按「先不要」後應回到只有一顆鈕' };
    if (calls('ai_cli_install').length) return { ok: false, why: '按「先不要」不該呼叫安裝' };
    return { ok: true, why: '' };
  }
  // 3. 同意
  if (want.end === 'ok') globalThis.__smokeOverride = { ai_cli_detect: want.toolsAfter, ai_cli_status: want.statusAfter };
  const s0 = calls('ai_cli_status').length;
  await real({ click: at(btns[1]) });
  const inst = await waitFor(() => calls('ai_cli_install').length === 1 ? calls('ai_cli_install')[0] : null, 30);
  if (!inst || inst[1].toolId !== 'claude') return { ok: false, why: '同意後要呼叫一次 ai_cli_install，toolId=claude：' + JSON.stringify(calls('ai_cli_install')) };
  if (want.end === 'running') {
    const run = await waitFor(() => [...claude.querySelectorAll('.launch-install-note')].find(e => vis(e) && e.textContent.includes(want.running)), 30);
    if (!run) return { ok: false, why: '進行中沒有在原位寫「' + want.running + '」：' + claude.textContent.trim() };
    if (btnOf(claude) || claude.querySelector('.launch-install-note button')) return { ok: false, why: '進行中不該有鈕' };
    if (document.querySelector('.dlg, [role="dialog"], .modal')) return { ok: false, why: '進行中不該跳框' };
    return { ok: true, why: '' };
  }
  const word = want.end === 'ok' ? want.done : want.fail;
  const res = await waitFor(() => [...claude.querySelectorAll('.launch-install-note')].find(e => vis(e) && e.textContent.includes(word)), 40);
  if (!res) return { ok: false, why: '沒有在原位看到結果「' + word + '」：' + claude.textContent.trim() };
  if (/ENOENT|boom|0x8|HTTP|secret/.test(claude.textContent)) return { ok: false, why: '結果不該露出原文：' + claude.textContent.trim() };
  // 完成後自動重跑狀態檢查（略過快取）
  if (!(await waitFor(() => calls('ai_cli_status').length > s0 && calls('ai_cli_status')[calls('ai_cli_status').length - 1][1].force === true, 30))) return { ok: false, why: '完成後沒有自動重跑狀態檢查（force:true）' };
  if (want.end === 'ok') {
    if (!(await waitFor(() => !btnOf(claude) && claude.textContent.includes('已是最新版') && claude.textContent.includes('2.1.0'), 40))) return { ok: false, why: '裝好重查後鈕應消失、狀態變成已是最新版 2.1.0：' + claude.textContent.trim() };
  } else if (!btnOf(claude) || btnOf(claude).textContent.trim() !== want.label) return { ok: false, why: '失敗後鈕應還在、可以再按：' + claude.textContent.trim() };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const scene = (name, mode, end, width = 900, skin = '') => ({ name, page: 'list.html', width, height: 760, state: { signedIn: true, launchInstall: { mode, end }, ...(skin ? { skin } : {}) }, ready: '#app.win .launch-set', probe: { launchInstall: { mode, end } }, shot: `${name}.png` })

export default {
  key: 'launchInstall',
  kind: '啟動設定 Claude 進行安裝／進行更新檢查',
  source: probe => launchInstallProbeSource(probe.launchInstall),
  scenarios: [
    scene('list-launch-install-idle', 'install', 'idle'), scene('list-launch-update-idle', 'update', 'idle'),
    scene('list-launch-install-ok', 'install', 'ok'), scene('list-launch-update-ok', 'update', 'ok'),
    scene('list-launch-install-fail', 'install', 'fail'), scene('list-launch-install-running', 'install', 'running'),
    scene('list-launch-install-idle-narrow', 'install', 'idle', 420), scene('list-launch-update-idle-narrow', 'update', 'idle', 420),
    scene('list-launch-install-off', 'install', 'off'), scene('list-launch-update-off', 'update', 'off'),
    scene('list-launch-install-fail-narrow', 'install', 'fail', 420), scene('list-launch-install-idle-modern', 'install', 'idle', 900, 'modern'), scene('list-launch-install-idle-line-narrow', 'install', 'idle', 420, 'line'),
  ],
  // 假後台：偵測／狀態照 mode；ai_cli_install 成功回 ok、fail 丟錯（原文帶代碼與路徑，畫面不該出現）、running 一直不回
  table: (scenario, t) => {
    const k = scenario.state?.launchInstall
    if (!k) return undefined
    const o = {
      ...(k.end === 'off' ? {} : { __launchInstallBtn: true }),
      ai_cli_detect: tools(k.mode), ai_cli_status: status(k.mode), pi_setup_status: { pi: true, ext: true, installed: true, stale: false },
      askpass_helper_info: { path: 'C:/asn/asn-askpass.exe', example: 'setx SSH_ASKPASS "C:/asn/asn-askpass.exe"' }, claude_mod_report: { state: 'installed', version: '1.2.3' },
      launch_prefs_get: { maxPerHour: 6, maxPerHourEffective: 3, cwdAllow: ['D:\\work'], recentCwd: [] },
      store_load: { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(ME) } },
      ai_cli_install: { ok: true, message: 'fake', opened_login: false },
    }
    if (k.end === 'fail') { o.__fail = { ai_cli_install: 'boom ENOENT 0x80070005 HTTP 503 C:\\secret' } }
    if (k.end === 'running') o.__hang = ['ai_cli_install']
    return o
  },
}
