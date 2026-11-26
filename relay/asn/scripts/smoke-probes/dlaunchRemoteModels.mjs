// 冒煙探測「電腦版替別台開新夥伴第 2 頁的型號下拉、開好後的通知」（probe.dlaunchRemoteModels，#2355 P4）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 別台（辦公室）回報的摘要：Gemini 的清單用 agy 的實機樣本（src-tauri/tests/fixtures/agy-models/sample.txt），跟手機（mlaunchModels）、電腦版本機（dlaunchModels）同一份。
//   ready＝讀到清單；claude＝四個別名；unavailable＝讀不到（白話原因＋「再查一次」，按了重新向後台問）；noflag＝那台沒有 launch_model：不出下拉，只有一句說明
//   used＝選了型號送出，開好後跳右下角提示（show_toast），寫出那台回報的實際型號顯示名
//   flagoff／flagoff-submit＝選了型號之後那台的 launch_model 不見：下拉消失、選擇清掉，送出不被擋也不帶型號
// 開法：新手引導卡（這台電腦沒有視窗）→ Claude 那一列的「開一個視窗」＝對話框在第 2 頁（這台）→ 〈 上一步 → 選「辦公室」→ 下一步 〉＝別台的第 2 頁。
// 為了拍到選項，把下拉撐成清單（size）；收合版（closed）不撐開，拍實際畫面。
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { launchOkToastText } from '../../ui/lib/partner-launch-notify.mjs'
import { hueOf, initial } from '../../ui/lib/text.mjs'

const agyText = fs.readFileSync(fileURLToPath(new URL('../../src-tauri/tests/fixtures/agy-models/sample.txt', import.meta.url)), 'utf8')
const agyModels = agyText.split(/\r?\n/).filter(l => l.includes('\t')).map(l => { const [id, name] = l.split('\t'); return { id: id.trim(), name: (name ?? '').trim() } })
const GEM_OK = { vendor: 'gemini', status: 'ok', models: agyModels }
const GEM_GONE = { vendor: 'gemini', status: 'unavailable', code: 'not_logged_in', models: [] }
const CLAUDE_NONE = { vendor: 'claude', status: 'unavailable', code: 'unsupported', models: [] }
const FIRST = agyModels[0]

const launcher = (extra = {}) => ({
  profiles: [{ id: 'claude', label: 'Claude', engine: 'claude', mode: 'window' }, { id: 'gemini', label: 'Gemini', engine: 'acp', mode: 'background' }],
  cwd_allow: ['D:/work'], launch_model: true, models: [GEM_OK, CLAUDE_NONE], ...extra,
})
const noFlag = (() => { const { launch_model: _x, ...rest } = launcher(); return rest })()
const GEM_STALE = { ...GEM_OK, stale: true, age_s: 900, code: 'timeout' }   // 清單是舊的：有「再查一次」，按了重新向後台問
export const DRM_LAUNCHERS = { ready: launcher(), claude: launcher(), unavailable: launcher({ models: [GEM_GONE, CLAUDE_NONE] }), 'unavailable-retry': launcher({ models: [GEM_GONE, CLAUDE_NONE] }), noflag: noFlag, used: launcher(), flagoff: launcher({ models: [GEM_STALE, CLAUDE_NONE] }), 'flagoff-submit': launcher({ models: [GEM_STALE, CLAUDE_NONE] }) }
const body = l => ({ machines: [{ node: 'Q', online: true, platform: 'windows', launcher: l }] })

export const drmProbeSource = ({ kase, closed = false }) => `(async () => {
  const want = ${JSON.stringify({ kase, closed })};
  const GEM_COUNT = ${agyModels.length}, FIRST = ${JSON.stringify(FIRST.id)}, FIRST_NAME = ${JSON.stringify(FIRST.name)};
  const READY = ${JSON.stringify(body(DRM_LAUNCHERS.ready))};
  const NOFLAG = ${JSON.stringify(body(noFlag))};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 300) };
  const waitFor = async (fn, n = 60, ms = 100) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(ms) } return null };
  const txt = e => (e ? e.textContent.split(String.fromCharCode(10)).join(' ').split(' ').filter(Boolean).join(' ') : '');
  const calls = name => (globalThis.__smokeCalls || []).filter(c => c[0] === name);
  const dlg = () => [...document.querySelectorAll('.partner-dlg-back .partner-dlg')].find(vis);
  const cards = () => [...dlg().querySelectorAll('.pmodel')];
  const pick = () => [...dlg().querySelectorAll('.partner-model-pick select')].find(vis) || null;
  const hint = () => [...dlg().querySelectorAll('.partner-hint[aria-label="型號清單狀況"]')].find(vis) || null;
  const retry = () => { const h = hint(); return h ? [...h.querySelectorAll('button')].find(b => txt(b) === '再查一次' && vis(b)) || null : null };
  const opts = () => (pick() ? [...pick().options].map(o => o.textContent.trim()) : []);
  const btn = label => [...dlg().querySelectorAll('.partner-actions button')].find(b => txt(b).includes(label) && vis(b)) || null;
  const stepNow = () => txt([...dlg().querySelectorAll('.partner-steps li')].find(l => l.className.includes('on')));
  const fail = why => ({ ok: false, why });
  const expand = () => {
    const s = pick();
    if (!want.closed && s && s.options.length > 1) s.size = Math.min(s.options.length, 9);
    if (want.closed && (!s || s.size > 1 || s.multiple)) throw new Error('收合版的型號應該是下拉，不是展開的清單');
  };
  try {
    const top = document.querySelector('.ttab-partners');
    if (!top) return fail('找不到上方的分頁鈕');
    await real({ click: at(top) }, 400);
    const row = await waitFor(() => [...document.querySelectorAll('.ng-card .ng-row[data-vendor="claude"] button')].find(vis), 80);
    if (!row) return fail('看不到新手引導卡的 Claude 那一列');
    await real({ click: at(row) }, 600);
    if (!(await waitFor(dlg, 40))) return fail('按「開一個視窗」之後沒有開出開新夥伴對話框');
    // 換到別台：上一步 → 選「辦公室」→ 下一步
    await real({ click: at(btn('上一步')) }, 300);
    const dev = await waitFor(() => [...dlg().querySelectorAll('.pdevice')].find(d => d.getAttribute('data-node') === 'Q'), 40);
    if (!dev) return fail('第 1 頁找不到「辦公室」：' + txt(dlg()).slice(0, 160));
    if (dev.disabled) return fail('「辦公室」不能選：' + txt(dev));
    await real({ click: at(dev) }, 400);
    await real({ click: at(btn('下一步')) }, 500);
    if (!stepNow().startsWith('2.')) return fail('應該在第 2 步：' + stepNow());
    if (!txt(dlg()).includes('設備：辦公室')) return fail('第 2 頁要寫是替哪台開：' + txt(dlg()).slice(0, 120));
    if (want.kase === 'claude') {
      const c = cards().find(x => txt(x.querySelector('.pmodel-lb')) === 'Claude');
      if (!c) return fail('找不到 Claude 的卡片');
      if (!c.className.includes('on')) { c.click(); await sleep(250) }
      await sleep(300);
      const o = opts();
      if (o.length !== 5 || o[0] !== '不指定（照預設）') return fail('Claude 型號下拉應為不指定＋四個別名：' + o.join('、'));
      if (!o.slice(1).every(x => x.endsWith('別名（最新版）'))) return fail('四個別名都要標「別名（最新版）」：' + o.join('、'));
      if (!/fable/i.test(o[1]) || !/opus/i.test(o[2]) || !/sonnet/i.test(o[3]) || !/haiku/i.test(o[4])) return fail('別名順序不對：' + o.join('、'));
      if (hint()) return fail('別名不該有狀況說明：' + txt(hint()));
      expand();
      return { ok: true, why: '' };
    }
    const g = cards().find(x => txt(x.querySelector('.pmodel-lb')) === 'Gemini');
    if (!g) return fail('找不到 Gemini 的卡片：' + cards().map(x => txt(x)).join('、'));
    if (g.disabled) return fail('Gemini 的卡片是反灰的');
    g.click(); await sleep(300);
    if (!g.className.includes('on')) return fail('點了 Gemini 沒有選起來');
    if (want.kase === 'ready' || want.kase === 'used') {
      if (!(await waitFor(() => opts().length > 1, 60))) return fail('型號下拉沒有出現清單：' + opts().join('、') + '／' + txt(hint()));
      const o = opts();
      if (o[0] !== '不指定（照預設）') return fail('第一項應是「不指定（照預設）」：' + o[0]);
      if (o.length !== 1 + GEM_COUNT) return fail('清單筆數不對：' + (o.length - 1) + '（應為 ' + GEM_COUNT + '）');
      if (hint()) return fail('ready 不該有說明：' + txt(hint()));
      if (want.kase === 'ready') { expand(); return { ok: true, why: '' } }
      // 送出：帶選的型號；開好後跳通知寫出那台回報的實際型號
      pick().value = FIRST; pick().dispatchEvent(new Event('change', { bubbles: true })); await sleep(150);
      await real({ click: at(btn('下一步')) }, 400);
      const nameInput = dlg().querySelector('input[aria-label="夥伴名字"]');
      if (!nameInput) return fail('第 3 頁找不到名字欄');
      nameInput.value = '小格'; nameInput.dispatchEvent(new Event('input', { bubbles: true })); await sleep(120);
      globalThis.__smokeOverride = { relay_launch: { id: 'L1' }, relay_launchers: { ...READY, launches: [{ id: 'L1', status: 'ok', model_used: FIRST }] } };
      const go = btn('開始');
      if (!go || go.disabled) return fail('「開始」不能按：' + txt(dlg().querySelector('.partner-err')));
      await real({ click: at(go) }, 400);
      const sent = calls('relay_launch')[0];
      if (!sent) return fail('按了開始，沒有送出開窗請求：' + txt(dlg()?.querySelector('.partner-err')));
      const b = sent[1] && sent[1].body;
      if (!b || b.model !== FIRST || b.profile !== 'gemini' || b.node !== 'Q') return fail('送出的請求要帶選的型號：' + JSON.stringify(b));
      if (b.pi_provider || b.pi_model) return fail('不經 pi 的請求不該帶 pi 欄位：' + JSON.stringify(b));
      // 開好了：右下角提示（不蓋住畫面），內容是實際型號的顯示名（那台清單裡查到的名字，不是代號）
      const tc = await waitFor(() => calls('show_toast')[0], 120);
      if (!tc) return fail('等了 12 秒，沒有跳出開好的提示');
      const tt = tc[1] && tc[1].toast;
      if (!tt || tt.cid !== 'Q/小格' || tt.title !== '「小格」在那台開好了' || tt.line !== '型號：' + FIRST_NAME) return fail('提示內容不對：' + JSON.stringify(tt));
      if (tt.line.includes(FIRST)) return fail('有清單時要顯示名，不能寫代號：' + tt.line);
      if ([...document.querySelectorAll('.launch-notice-body')].some(vis)) return fail('不該再跳擋畫面的對話框');
      return { ok: true, why: '' };
    }
    // 旗標消失：選了型號之後那台的 launch_model 不見了＝下拉消失、選擇清掉；送出不被擋、不帶型號
    if (want.kase === 'flagoff' || want.kase === 'flagoff-submit') {
      if (!(await waitFor(() => opts().length > 1, 60))) return fail('型號下拉沒有出現清單：' + txt(hint()));
      pick().value = FIRST; pick().dispatchEvent(new Event('change', { bubbles: true })); await sleep(150);
      if (pick().value !== FIRST) return fail('選不起來：' + pick().value);
      if (!retry()) return fail('清單是舊的，要有「再查一次」：' + txt(hint()));
      globalThis.__smokeOverride = { relay_launchers: NOFLAG };
      await real({ click: at(retry()) }, 300);
      if (!(await waitFor(() => !pick(), 60))) return fail('那台沒有 launch_model 了，下拉應該消失');
      if (txt(hint()) !== '那台電腦的 ASN 版本較舊，不能選型號，請先更新') return fail('說明不對：「' + txt(hint()) + '」');
      if (want.kase === 'flagoff') return { ok: true, why: '' };
      await real({ click: at(btn('下一步')) }, 400);
      const nameInput = dlg().querySelector('input[aria-label="夥伴名字"]');
      if (!nameInput) return fail('第 3 頁找不到名字欄（被舊的選擇擋住？）：' + txt(dlg().querySelector('.partner-err')));
      nameInput.value = '小格'; nameInput.dispatchEvent(new Event('input', { bubbles: true })); await sleep(120);
      globalThis.__smokeOverride = { relay_launch: { id: 'L1' }, relay_launchers: { ...NOFLAG, launches: [{ id: 'L1', status: 'ok' }] } };
      const go = btn('開始');
      if (!go || go.disabled) return fail('「開始」不能按：' + txt(dlg().querySelector('.partner-err')));
      await real({ click: at(go) }, 400);
      const sent = calls('relay_launch')[0];
      if (!sent) return fail('按了開始，沒有送出開窗請求：' + txt(dlg()?.querySelector('.partner-err')));
      const b = sent[1] && sent[1].body;
      if (!b || 'model' in b) return fail('下拉消失後的請求不該帶型號：' + JSON.stringify(b));
      return { ok: true, why: '' };
    }
    if (want.kase === 'unavailable') {
      if (!(await waitFor(hint, 60))) return fail('讀不到時要有說明');
      const t = txt(hint());
      if (!t.includes('讀不到型號清單：Gemini 還沒登入（到那台電腦登入後再試）')) return fail('說明不對：' + t);
      if (!t.includes('那台電腦約每 10 分鐘會自己更新一次清單')) return fail('要說明那台會定期更新：' + t);
      if (/not_logged_in|unavailable/.test(t)) return fail('代碼不該上畫面：' + t);
      if (!pick() || opts().length !== 1 || opts()[0] !== '不指定（照預設）') return fail('讀不到時下拉只該有「不指定」：' + opts().join('、'));
      if (!retry()) return fail('要有「再查一次」鈕');
      return { ok: true, why: '' };
    }
    if (want.kase === 'unavailable-retry') {
      if (!(await waitFor(retry, 60))) return fail('讀不到時要有「再查一次」');
      const before = calls('relay_launchers').length;
      globalThis.__smokeOverride = { relay_launchers: READY };
      await real({ click: at(retry()) }, 300);
      if (!(await waitFor(() => opts().length > 1, 60))) return fail('按了再查一次，清單沒有出來：' + txt(hint()));
      if (calls('relay_launchers').length <= before) return fail('再查一次沒有重新向後台問');
      if (hint()) return fail('讀到之後說明該消失：' + txt(hint()));
      return { ok: true, why: '' };
    }
    if (want.kase === 'noflag') {
      await sleep(500);
      if (pick()) return fail('那台沒有 launch_model，不該出現型號下拉：' + opts().join('、'));
      if (txt(hint()) !== '那台電腦的 ASN 版本較舊，不能選型號，請先更新') return fail('說明不對：「' + txt(hint()) + '」');
      if (retry()) return fail('版本較舊不該有「再查一次」');
      return { ok: true, why: '' };
    }
    return fail('不認得的檢查：' + want.kase);
  } catch (e) { return fail('檢查出錯：' + (e && e.message || e)) }
})()`

const scene = (name, kase, { closed = false, shot = true } = {}) => ({
  name, page: 'list.html', width: 900, height: 760,
  state: { signedIn: true, dlaunch: true, drm: kase },
  ready: '#app.win', probe: { dlaunchRemoteModels: { kase, closed } }, ...(shot ? { shot: `${name}.png` } : {}),
})

// 開好後的右下角提示的實景：toast.html 吃跟 show_toast 一樣的網址參數（wins.rs 的 toast_url），內容用正式的 launchOkToastText 做，不手寫一份
const toastScene = (() => {
  const t = launchOkToastText('小格', FIRST.name)
  const q = new URLSearchParams({ cid: 'Q/小格', title: t.title, line: t.line, status: 'online', hue: String(hueOf('Q/小格')), dp: initial('小格') })
  return { name: 'toast-launch-ok', page: `toast.html?${q}`, width: 270, height: 96, state: { signedIn: true }, ready: '#app', shot: 'toast-launch-ok.png' }
})()

export default {
  key: 'dlaunchRemoteModels',
  kind: '電腦版替別台開新夥伴的型號下拉檢查',
  source: probe => drmProbeSource(probe.dlaunchRemoteModels),
  scenarios: [
    // golden：別台的型號下拉一張（讀到的清單）、開好後的通知一張；另外補收合版、Claude 別名、讀不到、舊版沒有 launch_model
    scene('list-launch-remote-models-ready', 'ready'),
    scene('list-launch-remote-models-ready-closed', 'ready', { closed: true }),
    scene('list-launch-remote-models-claude', 'claude'),
    scene('list-launch-remote-models-unavailable', 'unavailable'),
    scene('list-launch-remote-models-noflag', 'noflag'),
    scene('list-launch-remote-models-notice', 'used'),   // 開好後的右下角提示（show_toast 的內容另有 toast.html 的實景：toast-launch-ok）
    toastScene,
    scene('list-launch-remote-models-flagoff', 'flagoff'),
    scene('list-launch-remote-models-flagoff-submit', 'flagoff-submit', { shot: false }),
    scene('list-launch-remote-models-unavailable-retry', 'unavailable-retry', { shot: false }),
  ],
  table: (scenario) => {
    const k = scenario.state?.drm
    if (!k) return undefined
    return {
      relay_list: { members: [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }] }] },
      relay_launchers: body(DRM_LAUNCHERS[k]),
      relay_launch: { id: 'L1' },
      show_toast: null,   // 開好後的右下角提示（假後台只記下呼叫）
      ...(k === 'used' ? { __fastPoll: 400 } : {}),
    }
  },
}
