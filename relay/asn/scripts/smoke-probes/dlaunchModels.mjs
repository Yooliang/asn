// 冒煙探測「電腦版開新夥伴第 2 頁的型號清單」（probe.dlaunchModels，#2355 P3）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 假後台的 agent_models 用實機抓下來的樣本：agy＝src-tauri/tests/fixtures/agy-models/sample.txt、Codex＝codex-models/debug-models.json、
// pi＝test/fixtures/pi-list-models-30home.txt（說明檔在旁邊；custom／model-a～model-h 是替換過的假值）。
// 狀態：ready（列清單）／stale（列清單＋幾分鐘前）／pending（正在讀取）／unavailable（白話原因＋重新讀取）／none（讀不到）；
//   claude＝別名（不向本機讀）、codex＝清單讀得到但開窗不能帶，下拉不出現、pi＝經 pi 開的廠牌（DeepSeek）走 pi_models。
// 不截圖的情境：pending 自動再問後變 ready（transition）、連問都 pending 時約 15 秒後當成讀不到、按重新讀取帶 force（giveup）。
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = rel => fileURLToPath(new URL(rel, import.meta.url))
const agyText = fs.readFileSync(here('../../src-tauri/tests/fixtures/agy-models/sample.txt'), 'utf8')
const codexJson = JSON.parse(fs.readFileSync(here('../../src-tauri/tests/fixtures/codex-models/debug-models.json'), 'utf8'))
const piText = fs.readFileSync(here('../../test/fixtures/pi-list-models-30home.txt'), 'utf8')

// 解析方式跟 Rust 的 agent_tools/models/parse.rs 一樣（agy：一行「代號<Tab>顯示名」；Codex：visibility 為 list 的依 priority；pi：表格）
const agyModels = agyText.split(/\r?\n/).filter(l => l.includes('\t')).map(l => { const [id, name] = l.split('\t'); return { id: id.trim(), name: (name ?? '').trim() } })
const codexModels = codexJson.models.filter(m => m.visibility === 'list').sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9)).map(m => ({ id: m.slug, name: m.display_name ?? '' }))
const piRows = piText.split(/\r?\n/).slice(1).filter(l => l.trim()).map(l => { const c = l.trim().split(/\s+/); return { provider: c[0], model: c[1], thinking: c[4] === 'yes', images: c[5] === 'yes' } })

const ok = (vendor, models, extra = {}) => ({ vendor, status: 'ok', models, ...extra })
const gone = (vendor, code) => ({ vendor, status: 'unavailable', code, models: [] })
const reply = (...v) => ({ models: v })
const byVendor = values => ({ by: 'vendor', values, fallback: { models: [] } })

export const DLM_TABLES = {
  ready: byVendor({ gemini: reply(ok('gemini', agyModels)), codex: reply(ok('codex', codexModels)) }),
  stale: byVendor({ gemini: reply(ok('gemini', agyModels, { stale: true, age_s: 900, code: 'timeout' })) }),
  pending: byVendor({ gemini: reply({ vendor: 'gemini', status: 'pending', models: [] }) }),
  unavailable: byVendor({ gemini: reply(gone('gemini', 'not_logged_in')) }),
  none: { models: null },
}
export const DLM_READY_AFTER = reply(ok('gemini', agyModels))

const TOOL = (id, found) => ({ id, label: id, binary_found: found, install_available: false, login_available: found, install_blurb: '', login_blurb: '', version: '' })

export const dlmProbeSource = ({ kase, card = '', expect = {} }) => `(async () => {
  const want = ${JSON.stringify({ kase, card, expect })};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 300) };
  const waitFor = async (fn, n = 60, ms = 100) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(ms) } return null };
  const txt = e => (e ? e.textContent.replace(/\\s+/g, ' ').trim() : '');
  const calls = name => (globalThis.__smokeCalls || []).filter(c => c[0] === name);
  const dlg = () => [...document.querySelectorAll('.partner-dlg-back .partner-dlg')].find(vis);
  const cards = () => [...dlg().querySelectorAll('.pmodel')];
  const pick = () => { const s = [...dlg().querySelectorAll('.partner-model-pick select')].find(vis); return s || null };
  const hint = () => [...dlg().querySelectorAll('.partner-hint[aria-label="型號清單狀況"]')].find(vis) || null;
  const retry = () => { const h = hint(); return h ? [...h.querySelectorAll('button')].find(b => txt(b) === '重新讀取' && vis(b)) || null : null };
  const opts = () => (pick() ? [...pick().options].map(o => o.textContent.trim()) : []);
  const fail = why => ({ ok: false, why });
  try {
    const top = document.querySelector('.ttab-partners');
    if (!top) return fail('找不到上方的分頁鈕');
    await real({ click: at(top) }, 400);
    const row = await waitFor(() => [...document.querySelectorAll('.ng-card .ng-row[data-vendor="claude"] button')].find(vis), 80);
    if (!row) return fail('看不到新手引導卡的 Claude 那一列');
    await real({ click: at(row) }, 600);
    if (!(await waitFor(dlg, 40))) return fail('按「開一個視窗」之後沒有開出開新夥伴對話框');
    const stepNow = txt([...dlg().querySelectorAll('.partner-steps li')].find(l => l.className.includes('on')));
    if (!stepNow.startsWith('2.')) return fail('對話框應該直接在第 2 步：' + stepNow);
    if (want.card) {
      const c = cards().find(x => txt(x.querySelector('.pmodel-lb')) === want.card);
      if (!c) return fail('找不到廠牌卡「' + want.card + '」：' + cards().map(x => txt(x)).join('、'));
      if (c.disabled) return fail('廠牌卡「' + want.card + '」是反灰的');
      c.click(); await sleep(300);
      if (!c.className.includes('on')) return fail('點了「' + want.card + '」沒有選起來');
    }
    const E = want.expect;
    const settle = async () => { await sleep(500) };
    // 截圖用：原生下拉在無頭瀏覽器拍不到展開的選項，把它撐成清單（size）才看得到內容；只改這張圖，不影響檢查
    const expand = () => { const s = pick(); if (s && s.options.length > 1) s.size = Math.min(s.options.length, 9) };
    switch (want.kase) {
      case 'claude': {
        await settle();
        const o = opts();
        if (o.length !== 4 || o[0] !== '不指定（照預設）') return fail('Claude 型號下拉應為不指定＋三個別名：' + o.join('、'));
        if (!o.slice(1).every(x => x.endsWith('別名（最新版）'))) return fail('別名沒有標「別名（最新版）」：' + o.join('、'));
        if (!/fable/i.test(o[1]) || !/opus/i.test(o[2]) || !/sonnet/i.test(o[3])) return fail('別名順序不對：' + o.join('、'));
        if (calls('agent_models').length) return fail('Claude 不該向本機讀清單：' + JSON.stringify(calls('agent_models')));
        if (hint()) return fail('Claude 別名不該有狀況說明：' + txt(hint()));
        expand();
        return { ok: true, why: '' };
      }
      case 'codex': {
        await settle();
        if (pick()) return fail('Codex 開窗不能帶型號，下拉不該出現：' + opts().join('、'));
        if (calls('agent_models').length) return fail('Codex 不該向本機讀清單');
        return { ok: true, why: '' };
      }
      case 'pi': {
        await settle();
        const o = opts();
        if (!o.some(x => x.includes('deepseek-flash')) || !o.some(x => x.includes('deepseek-v4-pro'))) return fail('經 pi 的型號下拉應有 pi 的清單：' + o.join('、'));
        if (calls('agent_models').length) return fail('經 pi 開的廠牌不該向 agent_models 讀（走 pi_models）');
        expand();
        return { ok: true, why: '' };
      }
      case 'ready': case 'stale': {
        if (!(await waitFor(() => opts().length > 1, 60))) return fail('型號下拉沒有出現清單：' + opts().join('、') + '／' + txt(hint()));
        const o = opts();
        if (o[0] !== '不指定（照預設）') return fail('第一項應是「不指定（照預設）」：' + o[0]);
        if (o.length !== 1 + E.count) return fail('清單筆數不對：' + (o.length - 1) + '（應為 ' + E.count + '）');
        if (!o.some(x => x.includes(E.sample))) return fail('清單裡沒有 ' + E.sample);
        const first = calls('agent_models')[0]?.[1];
        if (!first || first.vendor !== 'gemini' || first.force !== false) return fail('第一次讀取的參數不對：' + JSON.stringify(first));
        if (want.kase === 'ready' && hint()) return fail('ready 不該有說明：' + txt(hint()));
        if (want.kase === 'stale') {
          if (!hint() || !txt(hint()).includes('清單是 15 分鐘前讀到的')) return fail('stale 要說清單是幾分鐘前的：' + txt(hint()));
          if (!retry()) return fail('stale 要有「重新讀取」');
          if (/timeout/.test(txt(hint()))) return fail('代碼不該上畫面');
        }
        expand();
        return { ok: true, why: '' };
      }
      case 'pending': {
        await settle();
        if (!pick() || opts().length !== 1) return fail('pending 時下拉只該有「不指定」：' + opts().join('、'));
        if (!hint() || !txt(hint()).includes('正在讀取型號清單…')) return fail('pending 要寫「正在讀取型號清單…」：' + txt(hint()));
        if (retry()) return fail('pending 不該有重新讀取');
        return { ok: true, why: '' };
      }
      case 'unavailable': case 'none': {
        await settle();
        if (!pick() || opts().length !== 1 || opts()[0] !== '不指定（照預設）') return fail('讀不到時下拉只該有「不指定」：' + opts().join('、'));
        const t = txt(hint());
        if (!t.includes(E.note)) return fail('說明不對：「' + t + '」（應含 ' + E.note + '）');
        if (/not_logged_in|timeout|spawn_failed|unavailable/.test(t)) return fail('代碼不該上畫面：' + t);
        if (E.retry && !retry()) return fail('要有「重新讀取」鈕');
        if (!E.retry && retry()) return fail('不該有「重新讀取」鈕');
        return { ok: true, why: '' };
      }
      case 'transition': {
        // pending → 自動再問 → ready
        if (!(await waitFor(() => hint() && txt(hint()).includes('正在讀取型號清單…'), 40))) return fail('沒看到「正在讀取型號清單…」：' + txt(hint()));
        globalThis.__smokeOverride = { agent_models: ${JSON.stringify(DLM_READY_AFTER)} };
        if (!(await waitFor(() => opts().length > 1, 80, 100))) return fail('等了 8 秒，自動再問之後清單還沒出來：' + opts().join('、') + '／' + txt(hint()));
        if (calls('agent_models').length < 2) return fail('沒有自動再問：' + calls('agent_models').length);
        if (hint()) return fail('讀到清單後說明該消失：' + txt(hint()));
        return { ok: true, why: '' };
      }
      case 'giveup': {
        // 一直 pending：自動再問 3 次（約 15 秒）後當成讀不到；按「重新讀取」帶 force，讀到就換成清單
        if (!(await waitFor(() => hint() && txt(hint()).includes('正在讀取型號清單…'), 40))) return fail('沒看到「正在讀取型號清單…」：' + txt(hint()));
        if (!(await waitFor(() => retry(), 220, 100))) return fail('22 秒內沒有放棄等待：' + txt(hint()) + '，呼叫 ' + calls('agent_models').length + ' 次');
        if (calls('agent_models').length !== 4) return fail('應該問 4 次（第一次加自動再問 3 次），實際 ' + calls('agent_models').length);
        if (!txt(hint()).includes('讀不到型號清單：讀取逾時')) return fail('逾時的說明不對：' + txt(hint()));
        globalThis.__smokeOverride = { agent_models: ${JSON.stringify(DLM_READY_AFTER)} };
        await real({ click: at(retry()) }, 300);
        if (!(await waitFor(() => opts().length > 1, 60))) return fail('按了重新讀取，清單沒有出來：' + txt(hint()));
        const last = calls('agent_models').pop()[1];
        if (last.force !== true || last.vendor !== 'gemini') return fail('重新讀取應帶 force：' + JSON.stringify(last));
        return { ok: true, why: '' };
      }
      default: return fail('不認得的檢查：' + want.kase);
    }
  } catch (e) { return fail('檢查出錯：' + (e && e.message || e)) }
})()`

const GEMINI_COUNT = agyModels.length
const scene = (name, kase, { card = '', expect = {}, shot = true, skin, state = kase === 'transition' || kase === 'giveup' ? 'pending' : kase, noEngine } = {}) => ({
  name, page: 'list.html', width: 900, height: 760,
  state: { signedIn: true, dlaunch: true, dlm: state, ...(skin ? { skin } : {}) },
  ready: '#app.win', probe: { dlaunchModels: { kase, card, expect } }, ...(shot ? { shot: `${name}.png` } : {}),
})

const READY = { count: GEMINI_COUNT, sample: 'Gemini 4 Argon (High)' }
const UNAV = { note: '讀不到型號清單：Gemini 還沒登入（登入後再試）', retry: true }
const NONE = { note: '這台電腦讀不到型號清單', retry: false }

export default {
  key: 'dlaunchModels',
  kind: '電腦版開新夥伴第 2 頁的型號清單檢查',
  source: probe => dlmProbeSource(probe.dlaunchModels),
  scenarios: [
    // golden：第 2 頁 ready／unavailable／pending／none 各一張（外觀 aero 與 modern 各一）
    scene('list-launch-models-ready', 'ready', { card: 'Gemini', expect: READY }),
    scene('list-launch-models-unavailable', 'unavailable', { card: 'Gemini', expect: UNAV }),
    scene('list-launch-models-pending', 'pending', { card: 'Gemini' }),
    scene('list-launch-models-none', 'none', { card: 'Gemini', expect: NONE }),
    scene('list-launch-models-ready-modern', 'ready', { card: 'Gemini', expect: READY, skin: 'modern' }),
    scene('list-launch-models-unavailable-modern', 'unavailable', { card: 'Gemini', expect: UNAV, skin: 'modern' }),
    scene('list-launch-models-pending-modern', 'pending', { card: 'Gemini', skin: 'modern' }),
    scene('list-launch-models-none-modern', 'none', { card: 'Gemini', expect: NONE, skin: 'modern' }),
    // 其他截圖：stale、Claude 別名、Codex（清單讀得到但不出下拉）、經 pi 的廠牌（pi 清單）
    scene('list-launch-models-stale', 'stale', { card: 'Gemini', expect: READY }),
    scene('list-launch-models-claude', 'claude', { state: 'ready' }),
    scene('list-launch-models-codex', 'codex', { card: 'Codex', state: 'ready' }),
    scene('list-launch-models-pi', 'pi', { card: 'DeepSeek', state: 'ready' }),
    // 不截圖：自動再問、放棄等待加重新讀取
    scene('list-launch-models-transition', 'transition', { card: 'Gemini', shot: false }),
    scene('list-launch-models-giveup', 'giveup', { card: 'Gemini', shot: false }),
  ],
  table: (scenario, t) => {
    const k = scenario.state?.dlm
    if (!k) return undefined
    const tools = ['claude', 'codex', 'agy', 'grok', 'pi'].map(id => TOOL(id, ['claude', 'codex', 'agy', 'pi'].includes(id)))
    return {
      ai_cli_detect: { checked_at: '0', tools },
      agent_models: DLM_TABLES[k],
      pi_models: piRows,
      pi_providers: [{ provider: 'deepseek', state: 'ready' }, { provider: 'minimax', state: 'ready' }, { provider: 'anthropic', state: 'ready' }, { provider: 'xai', state: 'ready' }, { provider: 'openai-codex', state: 'ready' }],
    }
  },
}
