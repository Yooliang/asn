// 冒煙探測「設備名稱只有一份」（probe.devname，#1803）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 重現小良哥的畫面：這支手機在名單裡在線、底下沒有夥伴，後台記的名字是「Oppo 手機」。
//   m-devices：手機 設定 → 設備：頂部的名字、清單第一列都要寫「Oppo 手機」（「這支手機」只是旁邊的小標籤），整張清單沒有「未命名設備」，同一台只有一列
//   m-me：手機 設定 → 個人：沒有設備名稱輸入欄，只有「到設備頁改名」連結；按了會到設備頁並打開改名框（框裡是目前的名字）
//   d-devices：電腦 設定 → 設備：本機（名單裡沒有夥伴）也寫真名，不寫「這台電腦」，沒有「未命名設備」
// 截圖用：環境變數 ASN_DEVNAME_NOCHECK=1 時只把畫面走到位、不判斷（舊程式上用它拍「改前」）

const NAME_M = 'Oppo 手機', NAME_D = '我的電腦'

const memberOf = (id, name, agents, asn) => ({ id, name, kind: 'claude', agents, asn: asn ? [{ window_name: asn, version: '0.2.33', status: 'online', psm: '' }] : [] })
const membersFor = mobile => [
  memberOf('P', mobile ? NAME_M : NAME_D, [], mobile ? NAME_M : NAME_D),
  memberOf('Q', '辦公室', [{ name: 'demo', status: 'idle', engine: 'claude', cwd_label: 'demo' }], 'Q-ASN'),
]
const DESK_ME = { winMode: 'merged', session: { v: 1, tabs: [{ id: '@setting' }], active: { id: '@setting' }, panel: { guide: '', setting: 'devices' }, windows: [], panelWindows: [] } }

export const devnameProbeSource = ({ devname }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  const check = ${JSON.stringify(process.env.ASN_DEVNAME_NOCHECK !== '1')};
  const kind = ${JSON.stringify(devname)};
  const wait = async (fn, n = 60) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const press = async label => { const b = await wait(() => [...document.querySelectorAll('.m-row-btn')].find(x => x.textContent.includes(label))); if (!b) return false; b.click(); await sleep(500); return true };
  try {
    if (kind === 'm-devices') {
      if (!await press('設備')) return { ok: false, why: '找不到設定裡的「設備」' };
      const rows = await wait(() => { const r = [...document.querySelectorAll('.m-dv-row')].filter(vis); return r.length >= 2 ? r : null });
      await sleep(400);
      if (!check) return { ok: true, why: '' };
      if (!rows) return { ok: false, why: '設備列表少於 2 列' };
      const names = rows.map(r => r.querySelector('b')?.textContent.trim());
      const cur = document.querySelector('.m-dv-curname')?.textContent.trim();
      if (cur !== ${JSON.stringify(NAME_M)}) return { ok: false, why: '頂部「這支手機的名字」寫的是「' + cur + '」，要寫後台的名字' };
      if (names[0] !== ${JSON.stringify(NAME_M)}) return { ok: false, why: '清單第一列寫的是「' + names[0] + '」：' + names.join('、') };
      if (!rows[0].textContent.includes('這支手機')) return { ok: false, why: '第一列旁邊要有「這支手機」的小標籤' };
      if (names.filter(n => n === ${JSON.stringify(NAME_M)}).length !== 1) return { ok: false, why: '同一台被列了不只一次：' + names.join('、') };
      if (document.querySelector('.m-dv-list').textContent.includes('未命名設備')) return { ok: false, why: '清單裡還有「未命名設備」：' + names.join('、') };
      return { ok: true, why: '' };
    }
    if (kind === 'm-me' || kind === 'm-me-page') {
      if (!await press('個人')) return { ok: false, why: '找不到設定裡的「個人」' };
      await sleep(400);
      if (!check) return { ok: true, why: '' };
      const labelHit = [...document.querySelectorAll('label')].find(l => l.textContent.includes('這台設備的名稱') && l.querySelector('input'));
      if (labelHit) return { ok: false, why: '個人頁還有可以改設備名稱的輸入欄' };
      const link = [...document.querySelectorAll('button')].find(b => vis(b) && b.textContent.includes('到設備頁改名'));
      if (!link) return { ok: false, why: '個人頁沒有「到設備頁改名」連結' };
      if (kind === 'm-me-page') return { ok: true, why: '' };
      link.click();
      const inp = await wait(() => [...document.querySelectorAll('.m-known-edit input')].find(vis), 80);
      if (!inp) return { ok: false, why: '按了「到設備頁改名」，設備頁沒有打開改名框' };
      if (inp.value !== ${JSON.stringify(NAME_M)}) return { ok: false, why: '改名框裡寫的是「' + inp.value + '」，要是目前的名字' };
      return { ok: true, why: '' };
    }
    const rows = await wait(() => { const r = [...document.querySelectorAll('.dv-row')].filter(vis); return r.length >= 2 ? r : null });
    await sleep(400);
    if (!check) return { ok: true, why: '' };
    if (!rows) return { ok: false, why: '電腦設備列表少於 2 列' };
    const names = rows.map(r => r.querySelector('.dv-name')?.textContent.trim());
    if (names[0] !== ${JSON.stringify(NAME_D)}) return { ok: false, why: '本機那一列寫的是「' + names[0] + '」：' + names.join('、') };
    if (names.some(n => n.includes('未命名設備'))) return { ok: false, why: '清單裡有「未命名設備」：' + names.join('、') };
    return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '探測出錯：' + e.message } }
})()`

const SKINS = [['', ''], ['modern', '-modern'], ['line', '-line']]
const scenarios = SKINS.flatMap(([skin, suffix]) => [
  ['m-devices', 'm.html', '#app.m .m-row-btn'],
  ['m-me', 'm.html', '#app.m .m-row-btn'],
  ['m-me-page', 'm.html', '#app.m .m-row-btn'],
  ['d-devices', 'list.html', '#app.win'],
].map(([kind, page, ready]) => ({
  name: `devname-${kind}${suffix}`, page, width: kind === 'd-devices' ? 1100 : 412, height: kind === 'd-devices' ? 700 : 800,
  state: { signedIn: true, devname: kind, ...(skin ? { skin } : {}) }, ready, probe: { devname: kind }, shot: `devname-${kind}${suffix}.png`,
})))

export default {
  key: 'devname',
  kind: '設備名稱只有一份檢查',
  source: probe => devnameProbeSource(probe),
  scenarios,
  table: (scenario, t) => {
    const kind = scenario.state.devname
    if (!kind) return undefined
    const mobile = kind.startsWith('m-')
    const out = { relay_list: { members: membersFor(mobile) }, startup_info: { ...t.startup_info, node: 'P', window_name: mobile ? NAME_M : NAME_D } }
    if (mobile) {
      out.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify({ navTab: 'me' }) } }
      out.android_launchers = { machines: [{ node: 'P', platform: 'android', launcher: null }] }
      out.android_acct_roster = { now: new Date().toISOString(), accounts: [] }
      out.android_known_list = { peers: [] }
      out.android_known_rename = { ok: true, name: NAME_M, changed: true }
      out.android_acct_list = { by: 'node', values: {}, fallback: null }
    } else {
      out.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(DESK_ME) } }
    }
    return out
  },
}
