// 冒煙探測「電腦版切換模型的型號清單」（probe.switchModels，#2355 P3）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// agy：對話上方功能列「切換模型」開夥伴管理的對話框，清單向本機讀（agent_models，假資料用 agy 實機樣本 src-tauri/tests/fixtures/agy-models/sample.txt）；
//      讀不到時退回輸入框，並寫白話原因加「重新讀取」。
// Claude：功能列「切換模型」的選單只有別名（Fable／Opus／Sonnet），目前用的完整名稱 claude-opus-5-5 要認得是 Opus（打勾）。
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const agyText = fs.readFileSync(fileURLToPath(new URL('../../src-tauri/tests/fixtures/agy-models/sample.txt', import.meta.url)), 'utf8')
const agyModels = agyText.split(/\r?\n/).filter(l => l.includes('\t')).map(l => { const [id, name] = l.split('\t'); return { id: id.trim(), name: (name ?? '').trim() } })

export const dlswProbeSource = ({ kase, closed = false }) => `(async () => {
  const kase = ${JSON.stringify(kase)}, closed = ${JSON.stringify(closed)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 300) };
  const waitFor = async (fn, n = 60, ms = 100) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(ms) } return null };
  const txt = e => (e ? e.textContent.replace(/\\s+/g, ' ').trim() : '');
  const calls = name => (globalThis.__smokeCalls || []).filter(c => c[0] === name);
  const fail = why => ({ ok: false, why });
  try {
    const btn = await waitFor(() => [...document.querySelectorAll('.actionbar .abtn[data-slot="model"]')].find(vis), 80);
    if (!btn) return fail('找不到功能列的「切換模型」');
    await real({ click: at(btn) }, 500);
    if (kase === 'claude') {
      const items = await waitFor(() => { const m = [...document.querySelectorAll('.ab-menu')].find(vis); const its = m ? [...m.querySelectorAll('[role="menuitem"], [role="menuitemradio"], button, li')].filter(vis) : []; return its.length ? its : null }, 40);
      if (!items) return fail('點了切換模型沒有出現選單');
      const all = items.map(txt).join('|');
      for (const w of ['Fable', 'Opus', 'Sonnet', 'Haiku']) if (!all.includes(w)) return fail('選單少了 ' + w + '：' + all);
      const checked = [...document.querySelectorAll('.ab-menu [aria-checked="true"], .ab-menu .on, .ab-menu .checked')].filter(vis).map(txt).join('|');
      if (!checked.includes('Opus')) return fail('目前用 claude-opus-5-5，Opus 應該打勾：「' + checked + '」');
      if (calls('agent_models').length) return fail('Claude 不該向本機讀清單');
      return { ok: true, why: '' };
    }
    const dlg = await waitFor(() => [...document.querySelectorAll('.partner-dlg, .asn-dialog, [role="dialog"]')].find(x => vis(x) && txt(x).includes('模型')), 60);
    if (!dlg) return fail('點了切換模型沒有開出對話框');
    const select = () => [...dlg.querySelectorAll('select[aria-label="模型"]')].find(vis) || null;
    const input = () => [...dlg.querySelectorAll('input[aria-label="模型"]')].find(vis) || null;
    const note = () => [...dlg.querySelectorAll('.partner-hint[aria-label="型號清單狀況"]')].find(vis) || null;
    const call = calls('agent_models')[0]?.[1];
    if (!call || call.vendor !== 'gemini' || call.force !== false) return fail('應向本機讀 gemini 的清單：' + JSON.stringify(call));
    if (kase === 'agy') {
      if (!(await waitFor(select, 60))) return fail('清單沒有出現（還是輸入框？）：' + (input() ? '輸入框' : '都沒有'));
      const o = [...select().options].map(x => x.textContent.trim());
      if (o.length !== ${agyModels.length}) return fail('清單筆數不對：' + o.length);
      if (!o.includes('Gemini 4 Argon (High)')) return fail('清單裡沒有 Gemini 4 Argon (High)');
      if (note()) return fail('ready 不該有說明：' + txt(note()));
      if (!closed) select().size = 9;   // 截圖用：把下拉撐成清單才拍得到選項；收合版（closed）不撐開，拍實際畫面
      if (closed && select().size > 1) return fail('收合版的型號應該是下拉，不是展開的清單');
      return { ok: true, why: '' };
    }
    if (kase === 'agy-unavailable') {
      if (!(await waitFor(note, 60))) return fail('讀不到時要有說明');
      if (!txt(note()).includes('讀不到型號清單：Gemini 還沒登入（登入後再試）')) return fail('說明不對：' + txt(note()));
      if (!input() || select()) return fail('讀不到時應退回輸入框');
      if (![...note().querySelectorAll('button')].some(b => txt(b) === '重新讀取')) return fail('要有「重新讀取」鈕');
      return { ok: true, why: '' };
    }
    return fail('不認得的檢查：' + kase);
  } catch (e) { return fail('檢查出錯：' + (e && e.message || e)) }
})()`

const scene = (name, kase, bar, closed = false) => ({
  name, page: 'list.html', width: 900, height: 700,
  state: { signedIn: true, bar, dlsw: kase },
  ready: '#app.win .actionbar .abtn[aria-label="管理"]', probe: { switchModels: { kase, closed } }, shot: `${name}.png`,
})

export default {
  key: 'switchModels',
  kind: '電腦版切換模型的型號清單檢查',
  source: probe => dlswProbeSource(probe.switchModels),
  scenarios: [
    scene('list-switch-models-agy', 'agy', 'acp'),
    scene('list-switch-models-agy-unavailable', 'agy-unavailable', 'acp'),
    scene('list-switch-models-claude', 'claude', 'claude'),
    scene('list-switch-models-agy-closed', 'agy', 'acp', true),   // 收合版：實際畫面的下拉
  ],
  table: (scenario) => {
    const k = scenario.state?.dlsw
    if (!k) return undefined
    const gem = k === 'agy-unavailable' ? { vendor: 'gemini', status: 'unavailable', code: 'not_logged_in', models: [] } : { vendor: 'gemini', status: 'ok', models: agyModels }
    return {
      agent_models: { by: 'vendor', values: { gemini: { models: [gem] } }, fallback: { models: [] } },
      model_switch_query: { ok: true, canSwitch: true, idle: true, model: 'claude-opus-5-5', pid: 4242, sessionId: 's-1' },
    }
  },
}
