// 冒煙探測「名單頁提示搬家」（probe.listnotes，#2425 PR-4）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 兩個情境，改前、改後各拍一張：
//   env-list     名單頁上方：改前有環境變數黃條（env-notice），改後沒有
//   env-settings 設定頁終端區：改前沒有那一句，改後在「夥伴共用同一個終端服務」底下有一句
// 電腦換名失敗的提示直接用既有情境 devname-d-note（改前是左上角紅字、改後是結果提示）。
// 判定改前改後：讀 list.html 原文有沒有 env-notice。改前只確認畫面有出現黃條（讓截圖有東西可比），改後才檢查新行為。

const NOTICE = '使用者環境變數裡有 ASN 不傳給夥伴的變數（ASN_RELAY_KEY）。Claude 夥伴不會收到；建議移到別處'

export const listnotesProbeSource = ({ listnotes }) => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const wait = async (fn, n = 60) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const kind = ${JSON.stringify(listnotes)};
  const html = await (await fetch(new URL('./list.html', document.baseURI).href)).text();
  const after = !html.includes('env-notice');
  if (kind === 'env-list') {
    const bar = await wait(() => [...document.querySelectorAll('.env-notice')].find(vis), 40);
    await sleep(300);
    if (!after) return bar ? { ok: true, why: '' } : { ok: false, why: '改前基準：名單上方沒有出現環境變數黃條' };
    if (document.querySelector('.env-notice, .archive-note')) return { ok: false, why: '名單上方不該再有黃條' };
    if (!document.querySelector('.search')) return { ok: false, why: '名單頁沒有掛起來' };
    return { ok: true, why: '' };
  }
  if (kind === 'env-settings') {
    const find = (vn, d) => {
      if (!vn || d > 60) return null;
      const comp = vn.component;
      if (comp) { const st = comp.setupState; if (st && 'openPanel' in st) return comp; const r = find(comp.subTree, d + 1); if (r) return r }
      if (Array.isArray(vn.children)) for (const ch of vn.children) { const r = find(ch, d + 1); if (r) return r }
      return null;
    };
    const root = document.querySelector('#app')?._vnode;
    const host = root && find(root, 0);
    if (!host) return { ok: false, why: '找不到有 openPanel 的元件' };
    await host.setupState.openPanel('setting', 'window');
    const row = await wait(() => [...document.querySelectorAll('label.chk')].find(e => vis(e) && (e.textContent || '').includes('夥伴共用同一個終端服務')), 60);
    if (!row) return { ok: false, why: '設定頁終端區沒有出現「夥伴共用同一個終端服務」' };
    row.scrollIntoView({ block: 'center' });
    await sleep(300);
    const note = document.querySelector('[data-env-notice]');
    if (!after) return { ok: true, why: '' };
    if (!note || !vis(note)) return { ok: false, why: '設定頁終端區沒有環境變數提醒' };
    if (!(note.textContent || '').includes('ASN_RELAY_KEY')) return { ok: false, why: '提醒的字不對：' + note.textContent };
    return { ok: true, why: '' };
  }
  return { ok: false, why: '不認得的情境 ' + kind };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const scenario = (name, kind) => ({
  name, page: 'list.html', width: 1100, height: 700,
  state: { signedIn: true, listnotes: kind }, ready: '#app.win', probe: { listnotes: kind }, shot: `${name}.png`,
})

export default {
  key: 'listnotes',
  kind: '名單頁提示搬家檢查',
  source: probe => listnotesProbeSource(probe),
  scenarios: [scenario('list-notes-env', 'env-list'), scenario('list-notes-env-settings', 'env-settings')],
  table: scenario => {
    if (!scenario.state.listnotes) return undefined
    return {
      term_env_notice: NOTICE,
      bridge_status: { enabled: true, running: true, term_server: true, term_server_supported: true, term_server_active: true, term_server_why: '' },
    }
  },
}
