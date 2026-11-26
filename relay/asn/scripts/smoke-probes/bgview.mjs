// 冒煙探測「背景夥伴沒有看畫面入口」（probe.bgview，#2354）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 別台電腦上用內建通道（acp）在後台跑的夥伴（Gemini、Grok）沒有終端畫面：看畫面的入口與打字列都不能出現。
// 每個畫面各跑兩個情境，假後台一樣（別台的夥伴、後台說看得到畫面），只差夥伴的引擎：
//   背景夥伴（gemini）：等夠久之後入口（手機：切換鈕、標頭的終端鈕、按鍵列；電腦：按鈕列的「終端」）一個都不能有（明寫「應不存在」，不是找不到就略過）
//   終端夥伴（claude，對照組）：同樣等待後入口一定要有；手機按下去之後按鍵列出現。對照組讓「不存在」不會是假綠（假後台根本沒開看畫面）

const MEMBERS = engine => [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', ...(engine === 'claude' ? {} : { engine }), cwd_label: 'demo' }] }]

export const bgviewProbeSource = ({ phone, engine }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (fn, n = 80) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const want = ${JSON.stringify({ phone, engine })};
  const bg = want.engine !== 'claude';
  if (want.phone) {
    if (!(await wait(() => document.querySelector('.m-chat .composer textarea')))) return { ok: false, why: '沒有進到對話頁' };
    const sw = bg ? null : await wait(() => document.querySelector('.m-term-switch'), 60);
    if (!bg && !sw) return { ok: false, why: '終端夥伴（對照組）對話頁沒有看畫面的切換鈕：假後台沒開看畫面？' };
    await sleep(bg ? 2500 : 300);
    const q = s => document.querySelector(s);
    if (bg) {
      if (q('.m-term-switch')) return { ok: false, why: '背景夥伴的對話頁不該有看畫面的切換鈕' };
      if (q('.m-head-term')) return { ok: false, why: '背景夥伴的標頭不該有看畫面的終端鈕' };
      if (q('.m-term-keys')) return { ok: false, why: '背景夥伴不該有打字用的按鍵列' };
      return { ok: true, why: '' };
    }
    sw.click();
    if (!(await wait(() => q('.m-term-keys'), 60))) return { ok: false, why: '終端夥伴（對照組）按切換鈕之後沒有按鍵列' };
    return { ok: true, why: '' };
  }
  if (!(await wait(() => document.querySelector('.chatpane .actionbar button')))) return { ok: false, why: '按鈕列沒有出現' };
  const entry = () => [...document.querySelectorAll('.chatpane .actionbar button')].find(b => (b.getAttribute('aria-label') || b.textContent || '').includes('終端'));
  if (bg) {
    await sleep(2500);
    if (entry()) return { ok: false, why: '背景夥伴的按鈕列不該有「終端」：' + (entry().getAttribute('aria-label') || entry().textContent) };
    return { ok: true, why: '' };
  }
  if (!(await wait(entry, 60))) return { ok: false, why: '終端夥伴（對照組）按鈕列沒有「終端」：假後台沒開看畫面？' };
  return { ok: true, why: '' };
})()`

const scene = (name, phone, engine) => ({
  name, page: phone ? 'm.html' : 'list.html', ...(phone ? {} : { width: 1100 }),
  state: { signedIn: true, ...(phone ? { mtermview: true } : { dterm: true }), bgview: engine },
  ready: phone ? '#app.m .m-pager' : '#app.win .chatpane .actionbar',
  probe: { bgview: { phone, engine } }, shot: `${name}.png`,
})

export default {
  key: 'bgview',
  kind: '背景夥伴看畫面入口檢查',
  source: probe => bgviewProbeSource(probe.bgview),
  scenarios: [
    scene('m-bg-no-view', true, 'gemini'),
    scene('m-bg-grok-no-view', true, 'grok'),
    scene('m-term-has-view', true, 'claude'),
    scene('list-bg-no-view', false, 'gemini'),
    scene('list-term-has-view', false, 'claude'),
  ],
  // 假後台：夥伴的引擎照情境；其餘沿用 mtermview／dterm 已放好的看畫面假資料（available、start、frames）
  table: (scenario, t) => {
    const engine = scenario.state?.bgview
    if (!engine) return undefined
    return { relay_list: { members: MEMBERS(engine) } }
  },
}
