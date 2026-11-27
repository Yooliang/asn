// 冒煙探測「手機開新夥伴的型號、開好後顯示實際型號、手機切換模型」（probe.mlaunchModels，#2355 P4）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 資料：那台電腦（辦公室）回報的摘要。Gemini 的清單用 agy 的實機樣本 src-tauri/tests/fixtures/agy-models/sample.txt（#2382），跟電腦版（dlaunchModels）同一份。
// 開新夥伴（手機 390×844）：
//   ready＝Gemini 讀到清單；claude＝Claude 的四個別名；unavailable＝讀不到（白話原因＋「再查一次」，按了重新向後台問）；
//   noflag＝那台沒有回報 launch_model（舊版 ASN）：不出下拉，只有一句說明；pending＝正在讀取
//   used＝選了型號送出，開好後寫出那台回報的實際型號（顯示名，用那台的清單查；used-unknown＝清單裡查不到就顯示代號）；used-missing＝那台沒回報 model_used（只講沒回報，不寫成已套用）；error＝後台回 model_unsupported，顯示 launch.ts 同一句
//   flagoff／flagoff-submit＝選了型號之後那台的 launch_model 不見：下拉消失、選擇清掉，送出不被擋也不帶型號
// 切換模型（對話頁「⋯」→ 切換模型）：sw-agy＝Gemini 讀摘要的清單（頭一秒半不能先露出輸入框）；sw-agy-pending＝那台還在讀，只有「正在讀取型號清單…」；sw-agy-unavailable＝讀不到，退回輸入框並說明；sw-claude＝四個別名
// 收合版（closed）：實際畫面的下拉；其餘為了拍到選項，把下拉撐成清單（size），不影響檢查。
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const agyText = fs.readFileSync(fileURLToPath(new URL('../../src-tauri/tests/fixtures/agy-models/sample.txt', import.meta.url)), 'utf8')
const agyModels = agyText.split(/\r?\n/).filter(l => l.includes('\t')).map(l => { const [id, name] = l.split('\t'); return { id: id.trim(), name: (name ?? '').trim() } })
const GEM_OK = { vendor: 'gemini', status: 'ok', models: agyModels }
const GEM_GONE = { vendor: 'gemini', status: 'unavailable', code: 'not_logged_in', models: [] }
const GEM_PENDING = { vendor: 'gemini', status: 'pending', models: [] }
const CLAUDE_NONE = { vendor: 'claude', status: 'unavailable', code: 'unsupported', models: [] }

const launcher = (extra = {}) => ({
  profiles: [{ id: 'claude', label: 'Claude', engine: 'claude', mode: 'window' }, { id: 'gemini', label: 'Gemini', engine: 'acp', mode: 'background' }],
  cwd_allow: ['D:/work'], launch_model: true, models: [GEM_OK, CLAUDE_NONE], ...extra,
})
const noFlag = (() => { const { launch_model: _x, ...rest } = launcher(); return rest })()
const GEM_STALE = { ...GEM_OK, stale: true, age_s: 900, code: 'timeout' }   // 清單是舊的：有「再查一次」，按了重新向後台問
export const MLM_LAUNCHERS = {
  ready: launcher(), claude: launcher(), unavailable: launcher({ models: [GEM_GONE, CLAUDE_NONE] }), 'unavailable-retry': launcher({ models: [GEM_GONE, CLAUDE_NONE] }), noflag: noFlag, pending: launcher({ models: [GEM_PENDING, CLAUDE_NONE] }),
  used: launcher(), 'used-unknown': launcher(), 'used-missing': launcher(), error: launcher(),
  flagoff: launcher({ models: [GEM_STALE, CLAUDE_NONE] }), 'flagoff-submit': launcher({ models: [GEM_STALE, CLAUDE_NONE] }),
  'sw-agy': launcher(), 'sw-agy-pending': launcher({ models: [GEM_PENDING, CLAUDE_NONE] }), 'sw-agy-unavailable': launcher({ models: [GEM_GONE, CLAUDE_NONE] }), 'sw-agy-unavailable-retry': launcher({ models: [GEM_GONE, CLAUDE_NONE] }), 'sw-claude': launcher(),
}
const machines = l => ({ machines: [{ node: 'Q', online: true, launcher: l }] })
const MEMBERS_WITH_NEW = [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }, { name: '小格', status: 'idle', cwd_label: 'work' }] }]
const FIRST = agyModels[0]

export const mlmProbeSource = ({ kase, closed = false, expect = {} }) => `(async () => {
  const want = ${JSON.stringify({ kase, closed, expect })};
  const GEM_COUNT = ${agyModels.length}, FIRST = ${JSON.stringify(FIRST.id)}, FIRST_NAME = ${JSON.stringify(FIRST.name)};
  const READY = ${JSON.stringify(machines(MLM_LAUNCHERS.ready))};
  const NOFLAG = ${JSON.stringify(machines(noFlag))};
  const NONE_NOTE = '那台電腦的 ASN 版本較舊，不能選型號，請先更新';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const waitFor = async (fn, n = 60, ms = 100) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(ms) } return null };
  const txt = e => (e ? e.textContent.split(String.fromCharCode(10)).join(' ').split(' ').filter(Boolean).join(' ') : '');
  const calls = name => (globalThis.__smokeCalls || []).filter(c => c[0] === name);
  const fail = why => ({ ok: false, why });
  const root = () => document.querySelector('.m-lch');
  const sel = () => [...(root()?.querySelectorAll('select[aria-label="型號"]') ?? [])].find(vis) || null;
  const note = () => [...(root()?.querySelectorAll('[aria-label="型號清單狀況"]') ?? [])].find(vis) || null;
  const retry = () => [...(root()?.querySelectorAll('button.m-btn') ?? [])].find(b => vis(b) && (txt(b) === '再查一次')) || null;
  const opts = () => (sel() ? [...sel().options].map(o => o.textContent.trim()) : []);
  const expand = () => {
    const s = sel();
    if (!want.closed && s && s.options.length > 1) s.size = Math.min(s.options.length, 9);
    if (want.closed && (!s || s.size > 1 || s.multiple)) throw new Error('收合版的型號應該是下拉，不是展開的清單');
  };
  const openStep2 = async () => {
    const plus = await waitFor(() => document.querySelector('.m-plus-wrap .m-icon-btn'), 80);
    if (!plus) return '找不到名單頁的「新增」鈕';
    plus.click();
    const item = await waitFor(() => [...document.querySelectorAll('.m-plus-menu button')].find(b => b.textContent.includes('開新夥伴')));
    if (!item) return '新增選單沒有「開新夥伴」';
    item.click();
    const dev = await waitFor(() => [...document.querySelectorAll('.m-lch .m-opt')].find(b => b.textContent.includes('辦公室') && !b.disabled));
    if (!dev) return '第 1 步找不到可選的「辦公室」';
    dev.click(); await sleep(100);
    const next = [...document.querySelectorAll('.m-lch .m-btn-big')].find(b => b.textContent.includes('下一步'));
    if (!next || next.disabled) return '「下一步」不能按';
    next.click();
    if (!(await waitFor(() => [...document.querySelectorAll('.m-lch fieldset legend')].find(l => txt(l) === '廠牌')))) return '第 2 步沒有「廠牌」';
    return '';
  };
  const pickCard = async name => {
    const c = [...document.querySelectorAll('.m-lch fieldset .m-opt')].find(o => txt(o.querySelector('.m-opt-t')) === name);
    if (!c) return '找不到廠牌卡「' + name + '」';
    if (c.disabled) return '廠牌卡「' + name + '」是反灰的';
    c.click(); await sleep(250);
    if (c.getAttribute('aria-pressed') !== 'true') return '點了「' + name + '」沒有選起來';
    return '';
  };
  const setInput = async (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); await sleep(100) };
  try {
    // ---------- 切換模型 ----------
    if (want.kase.startsWith('sw-')) {
      for (let i = 0; i < 60 && !document.querySelector('.m-chat .chatpane'); i++) await sleep(100);
      await sleep(300);
      const dots = document.querySelector('.m-chathead .m-icon-btn[aria-label="更多操作"]');
      if (!dots) return fail('找不到「⋯」');
      dots.click();
      const row = await waitFor(() => [...document.querySelectorAll('.m-ops-panel .m-ops-item')].find(b => txt(b.querySelector('.m-opt-t')) === '切換模型'), 40);
      if (!row) return fail('「⋯」裡沒有「切換模型」');
      if (row.getAttribute('aria-disabled') === 'true') return fail('「切換模型」是反灰的：' + txt(row));
      row.click();
      const panel = () => document.querySelector('.m-ops-panel');
      const msel = () => [...(panel()?.querySelectorAll('select[aria-label="模型"]') ?? [])].find(vis) || null;
      const minput = () => [...(panel()?.querySelectorAll('input[aria-label="模型"]') ?? [])].find(vis) || null;
      const mnote = () => [...(panel()?.querySelectorAll('[aria-label="型號清單狀況"]') ?? [])].find(vis) || null;
      const mretry = () => [...(panel()?.querySelectorAll('button.m-btn') ?? [])].find(b => vis(b) && txt(b) === '再查一次') || null;
      // 進到「切換模型」的頭一秒半，每個畫面都看一次：清單出來之前不能先露出一個空的輸入框
      let sawInput = false;
      const sampler = (async () => { const t0 = performance.now(); while (performance.now() - t0 < 1500) { if (minput()) sawInput = true; await new Promise(r => requestAnimationFrame(r)) } })();
      const expandM = () => {
        const s = msel();
        if (!want.closed && s && s.options.length > 1) s.size = Math.min(s.options.length, 9);
        if (want.closed && (!s || s.size > 1 || s.multiple)) throw new Error('收合版的型號應該是下拉，不是展開的清單');
      };
      if (want.kase === 'sw-claude') {
        const items = await waitFor(() => { const r = [...panel().querySelectorAll('.m-ops-item')].map(b => txt(b)); return r.join('|') === 'Fable|Opus|Sonnet|Haiku' ? r : null }, 30) || [...panel().querySelectorAll('.m-ops-item')].map(b => txt(b));
        const got = (items || []).join('|');
        if (got !== 'Fable|Opus|Sonnet|Haiku') return fail('Claude 的切換選項應是 Fable、Opus、Sonnet、Haiku：' + got);
        if (!txt(panel()).includes('別名') || !txt(panel()).includes('最新版')) return fail('要說明這是會指向最新版的別名：' + txt(panel()).slice(0, 160));
        if (calls('android_launchers').length > 2) return fail('Claude 不該為了清單再問後台：' + calls('android_launchers').length);
        return { ok: true, why: '' };
      }
      if (want.kase === 'sw-agy-pending') {
        // 那台還在讀（pending）：一進去就寫「正在讀取型號清單…」，沒有輸入框也沒有下拉，也沒有「再查一次」
        await sleep(700);
        if (minput() || msel()) return fail('讀取中不該先露出輸入框或下拉：' + (minput() ? '輸入框' : '下拉'));
        if (txt(mnote()) !== '正在讀取型號清單…') return fail('讀取中要寫「正在讀取型號清單…」：「' + txt(mnote()) + '」');
        if (mretry()) return fail('讀取中不該有「再查一次」');
        await sampler;
        if (sawInput) return fail('頭一秒半內曾經露出輸入框');
        return { ok: true, why: '' };
      }
      if (want.kase === 'sw-agy') {
        if (!(await waitFor(msel, 60))) return fail('Gemini 的清單沒有出現（還是輸入框？）：' + (minput() ? '輸入框' : '都沒有') + '／' + txt(mnote()));
        await sampler;
        if (sawInput) return fail('清單出來之前，曾經先露出一個空的輸入框');
        const o = [...msel().options].map(x => x.textContent.trim());
        if (o.length !== GEM_COUNT) return fail('清單筆數不對：' + o.length + '（應為 ' + GEM_COUNT + '）');
        if (!o.includes('Gemini 4 Argon (High)')) return fail('清單裡沒有 Gemini 4 Argon (High)');
        if (mnote()) return fail('讀到清單不該有說明：' + txt(mnote()));
        if (msel().value !== FIRST) return fail('預設應選第一個：' + msel().value);
        expandM();
        return { ok: true, why: '' };
      }
      if (want.kase === 'sw-agy-unavailable' || want.kase === 'sw-agy-unavailable-retry') {
        if (!(await waitFor(mnote, 60))) return fail('讀不到時要有說明');
        const t = txt(mnote());
        if (!t.includes('讀不到型號清單：Gemini 還沒登入（到那台電腦登入後再試）')) return fail('說明不對：' + t);
        if (!t.includes('那台電腦約每 10 分鐘會自己更新一次清單')) return fail('要說明那台會定期更新：' + t);
        if (/not_logged_in|unavailable/.test(t)) return fail('代碼不該上畫面：' + t);
        if (!minput() || msel()) return fail('讀不到時應退回輸入框');
        if (!mretry()) return fail('要有「再查一次」鈕');
        if (want.kase === 'sw-agy-unavailable') return { ok: true, why: '' };   // 截圖拍「讀不到」的樣子；按「再查一次」另用 sw-agy-unavailable-retry 檢查
        const before = calls('android_launchers').length;
        globalThis.__smokeOverride = { android_launchers: READY };
        mretry().click();
        if (!(await waitFor(msel, 60))) return fail('按了再查一次，清單沒有出來：' + txt(mnote()));
        if (calls('android_launchers').length <= before) return fail('再查一次沒有重新向後台問');
        if (mnote()) return fail('讀到之後說明該消失：' + txt(mnote()));
        return { ok: true, why: '' };
      }
      return fail('不認得的檢查：' + want.kase);
    }
    // ---------- 開新夥伴 ----------
    let e = await openStep2(); if (e) return fail(e + '：' + txt(root()).slice(0, 120));
    if (want.kase === 'claude') {
      await sleep(300);
      if (txt(document.querySelector('.m-lch fieldset .m-opt[aria-pressed="true"] .m-opt-t')) !== 'Claude') return fail('預設應選 Claude');
      const o = opts();
      if (o.length !== 5 || o[0] !== '不指定（照預設）') return fail('Claude 型號下拉應為不指定＋四個別名：' + o.join('、'));
      if (!o.slice(1).every(x => x.endsWith('別名（最新版）'))) return fail('四個別名都要標「別名（最新版）」：' + o.join('、'));
      if (!/fable/i.test(o[1]) || !/opus/i.test(o[2]) || !/sonnet/i.test(o[3]) || !/haiku/i.test(o[4])) return fail('別名順序不對：' + o.join('、'));
      if (note()) return fail('別名不該有狀況說明：' + txt(note()));
      expand();
      return { ok: true, why: '' };
    }
    e = await pickCard('Gemini'); if (e) return fail(e);
    if (want.kase === 'ready') {
      if (!(await waitFor(() => opts().length > 1, 60))) return fail('型號下拉沒有出現清單：' + opts().join('、') + '／' + txt(note()));
      const o = opts();
      if (o[0] !== '不指定（照預設）') return fail('第一項應是「不指定（照預設）」：' + o[0]);
      if (o.length !== 1 + GEM_COUNT) return fail('清單筆數不對：' + (o.length - 1) + '（應為 ' + GEM_COUNT + '）');
      if (!o.includes('Gemini 4 Argon (High)')) return fail('清單裡沒有 Gemini 4 Argon (High)');
      if (note()) return fail('ready 不該有說明：' + txt(note()));
      expand();
      return { ok: true, why: '' };
    }
    if (want.kase === 'unavailable' || want.kase === 'unavailable-retry') {
      if (!(await waitFor(note, 60))) return fail('讀不到時要有說明');
      const t = txt(note());
      if (!t.includes('讀不到型號清單：Gemini 還沒登入（到那台電腦登入後再試）')) return fail('說明不對：' + t);
      if (!t.includes('那台電腦約每 10 分鐘會自己更新一次清單')) return fail('要說明那台會定期更新：' + t);
      if (/not_logged_in|unavailable/.test(t)) return fail('代碼不該上畫面：' + t);
      if (!sel() || opts().length !== 1 || opts()[0] !== '不指定（照預設）') return fail('讀不到時下拉只該有「不指定」：' + opts().join('、'));
      if (!retry()) return fail('要有「再查一次」鈕');
      // 截圖要拍「讀不到」的樣子，所以按「再查一次」另外用 unavailable-retry 檢查（不截圖）
      if (want.kase === 'unavailable') return { ok: true, why: '' };
      const before = calls('android_launchers').length;
      globalThis.__smokeOverride = { android_launchers: READY };
      retry().click();
      if (!(await waitFor(() => opts().length > 1, 60))) return fail('按了再查一次，清單沒有出來：' + txt(note()));
      if (calls('android_launchers').length <= before) return fail('再查一次沒有重新向後台問');
      return { ok: true, why: '' };
    }
    if (want.kase === 'noflag') {
      await sleep(400);
      if (sel()) return fail('那台沒有 launch_model，不該出現型號下拉：' + opts().join('、'));
      if (txt(note()) !== '那台電腦的 ASN 版本較舊，不能選型號，請先更新') return fail('說明不對：「' + txt(note()) + '」');
      if (retry()) return fail('版本較舊不該有「再查一次」');
      return { ok: true, why: '' };
    }
    if (want.kase === 'pending') {
      await sleep(400);
      if (!sel() || opts().length !== 1) return fail('pending 時下拉只該有「不指定」：' + opts().join('、'));
      if (txt(note()) !== '正在讀取型號清單…') return fail('pending 要寫「正在讀取型號清單…」：' + txt(note()));
      if (retry()) return fail('pending 不該有「再查一次」');
      return { ok: true, why: '' };
    }
    // ---------- 旗標消失：選了型號之後，那台的 launch_model 不見了（flagoff 看畫面、flagoff-submit 送出） ----------
    if (want.kase === 'flagoff' || want.kase === 'flagoff-submit') {
      if (!(await waitFor(() => opts().length > 1, 60))) return fail('型號下拉沒有出現清單：' + txt(note()));
      sel().value = FIRST; sel().dispatchEvent(new Event('change', { bubbles: true })); await sleep(150);
      if (sel().value !== FIRST) return fail('選不起來：' + sel().value);
      if (!retry()) return fail('清單是舊的，要有「再查一次」：' + txt(note()));
      globalThis.__smokeOverride = { android_launchers: NOFLAG };
      retry().click();
      if (!(await waitFor(() => !sel(), 60))) return fail('那台沒有 launch_model 了，下拉應該消失：' + opts().join('、'));
      if (txt(note()) !== NONE_NOTE) return fail('說明不對：「' + txt(note()) + '」');
      if ([...root().querySelectorAll('.m-err')].some(vis)) return fail('畫面上不該有錯誤：' + txt(root().querySelector('.m-err')));
      if (want.kase === 'flagoff') return { ok: true, why: '' };
      const name = [...root().querySelectorAll('label.m-field')].find(l => txt(l).startsWith('名字'))?.querySelector('input');
      if (!name) return fail('找不到名字欄');
      await setInput(name, '小格');
      const go = [...root().querySelectorAll('.m-btn-big')].find(b => txt(b) === '開始');
      if (!go || go.disabled) return fail('「開始」不能按：' + txt(root()).slice(0, 160));
      go.click();
      const sent = await waitFor(() => calls('android_launch')[0], 30);
      if (!sent) return fail('按了開始卻沒送出（被舊的選擇擋住？）：' + txt(root().querySelector('.m-err')));
      const body = sent[1] && sent[1].body;
      if (!body || 'model' in body) return fail('下拉消失後的請求不該帶型號：' + JSON.stringify(body));
      return { ok: true, why: '' };
    }
    // ---------- 送出：used／used-missing／error ----------
    if (!(await waitFor(() => opts().length > 1, 60))) return fail('型號下拉沒有出現清單：' + txt(note()));
    sel().value = FIRST; sel().dispatchEvent(new Event('change', { bubbles: true })); await sleep(150);
    const name = [...root().querySelectorAll('label.m-field')].find(l => txt(l).startsWith('名字'))?.querySelector('input');
    if (!name) return fail('找不到名字欄');
    await setInput(name, '小格');
    const go = [...root().querySelectorAll('.m-btn-big')].find(b => txt(b) === '開始');
    if (!go || go.disabled) return fail('「開始」不能按：' + txt(root().querySelector('.m-err, .m-note:last-of-type')));
    const used = want.kase === 'used' ? FIRST : want.kase === 'used-unknown' ? 'gemini-9-unknown' : null;   // used-unknown：回報的型號不在那台的清單裡（顯示代號）；used-missing：那台沒回報 model_used
    if (want.kase !== 'error') globalThis.__smokeOverride = {
      android_launch: { id: 'L1' },
      android_launchers: { ...READY, launches: [used ? { id: 'L1', status: 'ok', model_used: used } : { id: 'L1', status: 'ok' }] },
      relay_list: { members: ${JSON.stringify(MEMBERS_WITH_NEW)} },
    };
    go.click();
    const sent = await waitFor(() => calls('android_launch')[0], 30);
    if (!sent) return fail('按了開始，沒有送出開窗請求：' + txt(root().querySelector('.m-err')));
    const body = sent[1] && sent[1].body;
    if (!body || body.model !== FIRST) return fail('送出的請求要帶選的型號：' + JSON.stringify(body));
    if (body.pi_provider || body.pi_model) return fail('不經 pi 的請求不該帶 pi 欄位：' + JSON.stringify(body));
    if (want.kase === 'error') {
      const err = await waitFor(() => [...root().querySelectorAll('.m-err')].find(vis), 40);
      if (!err) return fail('後台回 model_unsupported 要顯示錯誤');
      if (txt(err) !== want.expect.error) return fail('錯誤文案不對：「' + txt(err) + '」（應為「' + want.expect.error + '」）');
      err.scrollIntoView({ block: 'center' });   // 截圖要拍到錯誤那一行
      await sleep(250);
      return { ok: true, why: '' };
    }
    const prog = await waitFor(() => { const p = [...root().querySelectorAll('.m-prog')].find(vis); return p && txt(p).includes('已經開好') ? p : null }, 160);
    if (!prog) return fail('等了 16 秒，沒有看到「已經開好」：' + txt(root().querySelector('.m-prog')));
    const t = txt(prog);
    if (want.kase === 'used') {
      if (t !== '「小格」已經開好了（型號：' + FIRST_NAME + '），可以直接對話。') return fail('要寫出那台回報的實際型號（顯示名，不是代號）：' + t);
      if (t.includes(FIRST)) return fail('有清單時要顯示名，不能把代號也寫上去：' + t);
    } else if (want.kase === 'used-unknown') {
      if (t !== '「小格」已經開好了（型號：gemini-9-unknown），可以直接對話。') return fail('清單裡查不到時顯示代號：' + t);
    } else {
      if (t.includes(FIRST) || t.includes('型號：')) return fail('那台沒回報 model_used，不能寫出型號（更不能拿選的頂替）：' + t);
      if (t !== '「小格」已經開好了，可以直接對話。（那台沒有回報實際使用的型號）') return fail('要照實說那台沒有回報：' + t);
    }
    return { ok: true, why: '' };
  } catch (e) { return fail('檢查出錯：' + (e && e.message || e)) }
})()`

const scene = (name, kase, { closed = false, shot = true, expect = {}, mbar = '' } = {}) => ({
  name, page: 'm.html', width: 390, height: 844,
  state: { signedIn: true, mlm: kase, ...(mbar ? { mbar } : { mlaunch: true }) },
  ready: mbar ? '#app.m .m-chat .chatpane' : '#app.m .m-plus-wrap', probe: { mlaunchModels: { kase, closed, expect } }, ...(shot ? { shot: `${name}.png` } : {}),
})

export default {
  key: 'mlaunchModels',
  kind: '手機開新夥伴的型號與切換模型檢查',
  source: probe => mlmProbeSource(probe.mlaunchModels),
  scenarios: [
    // golden：手機開新夥伴含型號下拉（讀到、收合、讀不到、舊電腦沒有 launch_model）、開好後顯示實際型號、錯誤、手機切換模型
    scene('m-launch-models-ready', 'ready'),
    scene('m-launch-models-ready-closed', 'ready', { closed: true }),
    scene('m-launch-models-claude', 'claude'),
    scene('m-launch-models-claude-closed', 'claude', { closed: true }),
    scene('m-launch-models-unavailable', 'unavailable'),
    scene('m-launch-models-unavailable-retry', 'unavailable-retry', { shot: false }),
    scene('m-launch-models-noflag', 'noflag'),
    scene('m-launch-models-pending', 'pending', { shot: false }),
    scene('m-launch-models-used', 'used'),
    scene('m-launch-models-used-missing', 'used-missing'),
    scene('m-launch-models-used-unknown', 'used-unknown', { shot: false }),
    // 旗標消失（一審）：選了型號之後，那台的 launch_model 不見了＝下拉消失、選擇一起清掉，送出不再被擋也不帶型號
    scene('m-launch-models-flagoff', 'flagoff'),
    scene('m-launch-models-flagoff-submit', 'flagoff-submit', { shot: false }),
    scene('m-launch-models-error', 'error', { expect: { error: '那台電腦的 ASN 版本還不支援指定型號，請先更新' } }),
    scene('m-switch-models-agy', 'sw-agy', { mbar: 'acp' }),
    scene('m-switch-models-agy-closed', 'sw-agy', { mbar: 'acp', closed: true }),
    scene('m-switch-models-agy-pending', 'sw-agy-pending', { mbar: 'acp' }),
    scene('m-switch-models-agy-unavailable', 'sw-agy-unavailable', { mbar: 'acp' }),
    scene('m-switch-models-agy-unavailable-retry', 'sw-agy-unavailable-retry', { mbar: 'acp', shot: false }),
    scene('m-switch-models-claude', 'sw-claude', { mbar: 'claude' }),
  ],
  table: (scenario) => {
    const k = scenario.state?.mlm
    if (!k) return undefined
    const patch = { android_launchers: machines(MLM_LAUNCHERS[k]), android_launch: { id: 'L1' } }
    if (k === 'error') patch.__fail = { android_launch: 'launch HTTP 400 model_unsupported' }
    return patch
  },
}
