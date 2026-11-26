// 冒煙探測「電腦版開新夥伴三頁」（probe.dlaunch，#2354）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 第 2 頁（step 2）：步驟列寫「1. 設備 2. 廠牌 3. 設定」；沒有「運行」；廠牌卡右邊同一行有短標示
//   （Claude 無、Codex 尚未登入［反灰］、Gemini 無終端畫面、Grok 與 DeepSeek、MiniMax 尚未安裝［反灰］）；反灰的點了不會被選起來；Claude 有型號
// 第 3 頁（step 3）：名字、工作資料夾、第一句話，加上只有本機視窗廠牌才有的「顯示方式」（Gemini 沒有）；沒有摘要列、沒有 pi 的模型；按鈕寫「開始」；截圖拍得到顯示方式
// 送出（step 'submit'）：按「開始」＝呼叫 partner_launch_local，profile 是 claude，沒有「運行」欄位
// 開法：新手引導卡（這台電腦沒有視窗）→ Claude 那列的「開一個視窗」＝對話框直接在第 2 頁

const TOOL = (id, found) => ({ id, label: id, binary_found: found, install_available: false, login_available: found, install_blurb: '', login_blurb: '', version: '' })
const DETECT = { checked_at: '0', tools: ['claude', 'codex', 'agy', 'grok', 'pi'].map(id => TOOL(id, ['claude', 'codex', 'agy'].includes(id))) }
// 本機登入：Claude 已登入、Codex 沒登入；Gemini 偵測不到（unknown）
const STATUS = { tools: [{ id: 'claude', installed: true, login: 'in', login_count: 1 }, { id: 'codex', installed: true, login: 'out', login_count: 0 }, { id: 'agy', installed: true, login: 'unknown', login_count: 0 }] }
const CLAUDE = [{ email: 'me@example.com', plan: 'pro', current: true }]

export const dlaunchProbeSource = ({ step = 2 } = {}) => `(async () => {
  const want = ${JSON.stringify({ step })};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 300) };
  const waitFor = async (fn, n = 60) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const txt = e => (e ? e.textContent.replace(/\\s+/g, ' ').trim() : '');
  const calls = name => (globalThis.__smokeCalls || []).filter(c => c[0] === name);
  const dlg = () => [...document.querySelectorAll('.partner-dlg-back .partner-dlg')].find(vis);
  const stepNow = () => { const s = [...(dlg()?.querySelectorAll('.partner-steps li') ?? [])].find(l => l.className.includes('on')); return txt(s) };
  try {
    const top = document.querySelector('.ttab-partners');
    if (!top) return { ok: false, why: '找不到上方的分頁鈕' };
    await real({ click: at(top) }, 400);
    const row = await waitFor(() => [...document.querySelectorAll('.ng-card .ng-row[data-vendor="claude"] button')].find(vis), 80);
    if (!row) return { ok: false, why: '看不到新手引導卡的 Claude 那一列' };
    await real({ click: at(row) }, 600);
    if (!(await waitFor(dlg, 40))) return { ok: false, why: '按「開一個視窗」之後沒有開出開新夥伴對話框' };
    // ---- 第 2 頁 ----
    if (!stepNow().startsWith('2.')) return { ok: false, why: '對話框應該直接在第 2 步：' + stepNow() };
    await sleep(300);
    const cards = () => [...dlg().querySelectorAll('.pmodel')];
    if (want.step === 2) {
    const steps = [...dlg().querySelectorAll('.partner-steps li')].map(txt).join('|');
    if (steps !== '1. 設備|2. 廠牌|3. 設定') return { ok: false, why: '步驟列不對：' + steps };
    if (dlg().querySelector('.partner-run') || dlg().querySelector('input[name="partner-run"]')) return { ok: false, why: '第 2 頁還有「運行」選項' };
    // 只看畫面上看得到的字（innerText 不含被收起的第 3 頁；第 3 頁「顯示方式」的「背景運行」是另一回事）
    const shown = dlg().innerText.replace(/\\s+/g, ' ');
    if (shown.includes('運行')) return { ok: false, why: '對話框畫面上還寫著「運行」：' + shown.slice(0, 160) };
    const cardInfo = c => ({ label: txt(c.querySelector('.pmodel-lb')), tag: txt(c.querySelector('.pmodel-tag')), disabled: c.disabled === true })
    const got = cards().map(c => { const i = cardInfo(c); return i.label + '/' + i.tag + '/' + (i.disabled ? '灰' : '可') }).join('、');
    const wantCards = 'Claude//可、Codex/尚未登入/灰、Gemini/無終端畫面/可、Grok/尚未安裝/灰、DeepSeek/尚未安裝/灰、MiniMax/尚未安裝/灰';
    if (got !== wantCards) return { ok: false, why: '廠牌卡與標示不對：' + got + '（應為 ' + wantCards + '）' };
    // 標示在卡片右邊、跟名稱同一行
    for (const c of cards()) {
      const tag = c.querySelector('.pmodel-tag'); if (!tag) continue;
      const a = c.querySelector('.pmodel-lb').getBoundingClientRect(), b = tag.getBoundingClientRect(), box = c.getBoundingClientRect();
      if (Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) > 8) return { ok: false, why: '標示跟名稱不在同一行：' + txt(c) };
      if (b.left < a.right - 0.5 || b.right > box.right + 0.5) return { ok: false, why: '標示不在卡片右邊：' + txt(c) };
      if (c.scrollWidth > c.clientWidth + 1) return { ok: false, why: '卡片字被切掉：' + txt(c) };
    }
    if (!cards()[0].className.includes('on')) return { ok: false, why: 'Claude 沒有被選起來' };
    // 反灰的點了也不會被選
    for (const c of cards().filter(x => x.disabled)) { c.click(); await sleep(60) }
    if (!cards()[0].className.includes('on') || cards().filter(c => c.className.includes('on')).length !== 1) return { ok: false, why: '點反灰的卡片之後選取變了' };
    // 型號：Claude 有，選項是三個別名
    const pick = dlg().querySelector('.partner-model-pick select');
    if (!pick || !vis(pick)) return { ok: false, why: 'Claude 沒有型號下拉' };
    if ([...pick.options].length < 4) return { ok: false, why: '型號下拉選項太少：' + [...pick.options].map(o => o.textContent).join('、') };
    // Gemini：也有型號（內建通道），而且切過去還是只有一個被選
    cards()[2].click(); await sleep(150);
    if (!cards()[2].className.includes('on')) return { ok: false, why: '點 Gemini 沒有選起來' };
    const gp = dlg().querySelector('.partner-model-pick select');
    if (!gp || !vis(gp) || ![...gp.options].some(o => /Gemini/.test(o.textContent))) return { ok: false, why: 'Gemini 沒有型號下拉' };
    cards()[0].click(); await sleep(150);
    await sleep(200);
    return { ok: true, why: '' };
    }
    // ---- 第 3 頁 ----
    const nextBtn = () => [...dlg().querySelectorAll('.partner-actions .aero-btn.primary')].find(vis);
    const goPage3 = async () => { const b = nextBtn(); if (!b || b.disabled) return '第 2 頁的「下一步」不能按'; b.click(); await sleep(250); return stepNow().startsWith('3.') ? '' : '按下一步沒有到第 3 頁：' + stepNow() };
    let bad = await goPage3();
    if (bad) return { ok: false, why: bad };
    const labels = [...dlg().querySelectorAll('label')].filter(vis).map(l => txt(l).slice(0, 12));
    for (const w of ['名字', '工作資料夾', '第一句話']) { if (!labels.some(l => l.startsWith(w))) return { ok: false, why: '第 3 頁少了「' + w + '」：' + labels.join('、') } }
    const disp = [...dlg().querySelectorAll('.partner-display')].find(vis);
    if (!disp || !txt(disp).includes('顯示方式') || !txt(disp).includes('前台顯示') || !txt(disp).includes('背景運行')) return { ok: false, why: 'Claude 第 3 頁沒有「顯示方式」：' + txt(disp) };
    if ([...dlg().querySelectorAll('.partner-sum')].some(vis)) return { ok: false, why: '第 3 頁還有摘要列' };
    if ([...dlg().querySelectorAll('select[aria-label="經 pi 開的模型"]')].some(vis)) return { ok: false, why: '第 3 頁還有 pi 的模型下拉' };
    const go = [...dlg().querySelectorAll('.partner-actions .aero-btn.primary')].find(vis);
    if (!go || txt(go) !== '開始') return { ok: false, why: '第 3 頁的按鈕應該寫「開始」：' + txt(go) };
    if (want.step === 3) {
      // Gemini 沒有顯示方式（只有本機的視窗廠牌才有）
      const back = [...dlg().querySelectorAll('.partner-actions .aero-btn')].find(b => txt(b).includes('上一步'));
      back.click(); await sleep(200);
      cards()[2].click(); await sleep(150);
      bad = await goPage3(); if (bad) return { ok: false, why: bad };
      if ([...dlg().querySelectorAll('.partner-display')].some(vis)) return { ok: false, why: 'Gemini 不該有「顯示方式」' };
      [...dlg().querySelectorAll('.partner-actions .aero-btn')].find(b => txt(b).includes('上一步')).click(); await sleep(200);
      cards()[0].click(); await sleep(150);
      bad = await goPage3(); if (bad) return { ok: false, why: '回到 Claude：' + bad };
      if (![...dlg().querySelectorAll('.partner-display')].some(vis)) return { ok: false, why: '回到 Claude 之後「顯示方式」沒有回來' };
      await sleep(200);
      return { ok: true, why: '' };
    }
    // ---- 送出 ----
    const name = dlg().querySelector('input[aria-label="夥伴名字"]');
    if (!name || !name.value.trim()) return { ok: false, why: '名字沒有預設值' };
    const cwd = dlg().querySelector('select[aria-label="工作資料夾"]');
    if (!cwd || !cwd.value) return { ok: false, why: '工作資料夾沒有預設值' };
    const n0 = calls('partner_launch_local').length;
    go.click();
    if (!(await waitFor(() => calls('partner_launch_local').length > n0, 40))) return { ok: false, why: '按「開始」沒有呼叫 partner_launch_local' };
    const req = calls('partner_launch_local').pop()[1]?.req ?? {};
    if (req.profile !== 'claude') return { ok: false, why: '送出的 profile 應該是 claude：' + JSON.stringify(req) };
    if ('run' in req) return { ok: false, why: '送出的內容不該有 run：' + JSON.stringify(req) };
    return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const scene = (name, step, shot = true) => ({
  name, page: 'list.html', width: 900, height: 760,
  state: { signedIn: true, dlaunch: true },
  ready: '#app.win', probe: { dlaunch: { step } }, ...(shot ? { shot: `${name}.png` } : {}),
})

export default {
  key: 'dlaunch',
  kind: '電腦版開新夥伴三頁檢查',
  source: probe => dlaunchProbeSource(probe.dlaunch),
  scenarios: [
    scene('list-launch-dlg2', 2),
    scene('list-launch-dlg3', 3),
    scene('list-launch-dlg-submit', 'submit', false),
  ],
  // 假後台：這台偵測到 Claude、Codex、Gemini（agy），沒有 Grok 與 pi；Claude 已登入、Codex 沒登入
  table: (scenario, t) => {
    if (!scenario.state?.dlaunch) return undefined
    return {
      open_link: null, ai_cli_login: null, grok_accounts_list: [], launch_cwd_candidates: ['D:/work'],
      ai_cli_detect: DETECT, ai_cli_status: STATUS, pi_models: [], pi_providers: [], partner_launch_local: { ok: true },
      claude_accounts_list: CLAUDE, claude_account_current: CLAUDE[0],
    }
  },
}
