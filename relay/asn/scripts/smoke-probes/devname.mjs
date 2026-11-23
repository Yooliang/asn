// 冒煙探測「設備名稱只有一份」（probe.devname，#1803）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 重現擁有者回報的畫面：這支手機在名單裡在線、底下沒有夥伴，後台記的名字是「測試手機」。
//   m-devices：手機 設定 → 設備：頂部的名字、清單第一列都要寫「測試手機」（「這支手機」只是旁邊的小標籤），整張清單沒有「未命名設備」，同一台只有一列
//   m-me：手機 設定 → 個人：設備名稱只放設備頁（#1855），個人頁沒有設備名稱的輸入欄、那一列、說明，也沒有「到設備頁改名」按鈕
//   d-devices：電腦 設定 → 設備：本機（名單裡沒有夥伴）也寫真名，不寫「這台電腦」，沒有「未命名設備」
// 截圖用：環境變數 ASN_DEVNAME_NOCHECK=1 時只把畫面走到位、不判斷（舊程式上用它拍「改前」）

const NAME_M = '測試手機', NAME_D = '測試電腦', NAME_NEW = '新設備名'

const memberOf = (id, name, agents, asn) => ({ id, name, kind: 'claude', agents, asn: asn ? [{ window_name: asn, version: '0.2.33', status: 'online', psm: '' }] : [] })
const membersFor = mobile => [
  memberOf('P', mobile ? NAME_M : NAME_D, [], mobile ? NAME_M : NAME_D),
  memberOf('Q', '辦公室', [{ name: 'demo', status: 'idle', engine: 'claude', cwd_label: 'demo' }], 'Q-ASN'),
]
const DESK_ME = { winMode: 'merged', session: { v: 1, tabs: [{ id: '@setting' }], active: { id: '@setting' }, panel: { guide: '', setting: 'devices' }, windows: [], panelWindows: [] } }

export const devnameProbeSource = ({ devname, skin = '' }) => `(async () => {
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
      if (document.querySelector('.m-dv-own')) return { ok: false, why: '列表最上面不該再有「這支手機的名字」區塊' };
      if (names[0] !== ${JSON.stringify(NAME_M)}) return { ok: false, why: '清單第一列寫的是「' + names[0] + '」：' + names.join('、') };
      if (!rows[0].textContent.includes('運作中') || rows[0].textContent.includes('這支手機')) return { ok: false, why: '第一列（本機）只寫「手機 · 運作中」，不寫「這支手機」' };
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
      // 設備名稱只放設備頁（#1855）：個人頁不能出現設備名稱的任何一列、說明或「到設備頁改名」按鈕
      const page = document.querySelector('.m-pgin') || document.body;
      const text = page.textContent;
      if (text.includes('這台設備的名稱') || text.includes('設備名稱只在設備頁')) return { ok: false, why: '個人頁還有設備名稱那一列或說明' };
      if ([...document.querySelectorAll('button')].some(b => vis(b) && b.textContent.includes('到設備頁改名'))) return { ok: false, why: '個人頁還有「到設備頁改名」按鈕' };
      if (!text.includes('我的名字')) return { ok: false, why: '沒有走到個人頁（找不到「我的名字」）' };
      return { ok: true, why: '' };
    }
    // ---- 改名流程（手機）：假的 Tauri 外殼包一層，模擬「後台記住新名字、重讀名單就帶新名字」 ----
    if (kind.startsWith('m-rename')) {
      const T = globalThis.__TAURI__.core, inv = T.invoke; let renamed = '';
      const mode = kind === 'm-rename-fail' ? 'fail' : kind === 'm-rename-blocked' ? 'blocked' : 'ok';
      T.invoke = async (cmd, args) => {
        if (cmd === 'android_known_rename') {
          if (mode === 'fail') throw '改名沒成功，請稍後再試';
          renamed = args.name;
          if (mode === 'blocked') return { ok: true, name: args.name, changed: true, window_rename_failed: '這個名字是保留給系統通知的（「ASN 通知」或結尾是「收發室」）' };
          return { ok: true, name: args.name, changed: true, self_renamed: true, window_name: args.name };
        }
        const r = await inv(cmd, args);
        if (cmd === 'relay_list' && renamed) for (const m of r.members) if (m.id === 'P') m.name = renamed;
        return r;
      };
      if (!await press('設備')) return { ok: false, why: '找不到設定裡的「設備」' };
      // 列表最上面沒有改名區塊了（#1860）：進這支手機自己那一列的「詳情」再改名
      const selfRow = await wait(() => [...document.querySelectorAll('.m-dv-row')].find(r => vis(r) && r.textContent.includes('運作中')));   // 本機那一列只寫「運作中」
      if (!selfRow) return { ok: false, why: '找不到這支手機那一列' };
      [...selfRow.querySelectorAll('button')].find(b => b.textContent.trim() === '詳情')?.click();
      await sleep(400);
      const edit = await wait(() => { const b = [...document.querySelectorAll('.m-dv-actions .m-btn')].find(x => vis(x) && x.textContent.includes('改名')); if (b) b.click(); return b });
      if (!edit) return { ok: false, why: '找不到設備頁的「改名」' };
      const inp = await wait(() => [...document.querySelectorAll('.m-known-edit input')].find(vis));
      if (!inp) return { ok: false, why: '沒有打開改名框' };
      inp.value = ${JSON.stringify(NAME_NEW)}; inp.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(100);
      document.querySelector('.m-known-edit button[type=submit]').click();
      if (mode === 'ok') {
        const done = await wait(() => document.querySelector('.m-dv-headtx .m-title')?.textContent.includes(${JSON.stringify(NAME_NEW)}), 50);
        await sleep(300);
        if (!check) return { ok: true, why: '' };
        if (!done) return { ok: false, why: '改名成功後，詳情頁頂部沒有立刻顯示新名字：' + document.querySelector('.m-dv-headtx .m-title')?.textContent.trim() };
        [...document.querySelectorAll('.m-icon-btn[aria-label="返回"]')].find(vis)?.click();
        await sleep(500);
        const first = [...document.querySelectorAll('.m-dv-row')].filter(vis)[0]?.querySelector('b')?.textContent.trim();
        if (first !== ${JSON.stringify(NAME_NEW)}) return { ok: false, why: '改名成功後，清單第一列沒有顯示新名字：' + first };
        if (document.querySelector('.m-known-edit')) return { ok: false, why: '改名成功後改名框還開著' };
        return { ok: true, why: '' };
      }
      if (mode === 'fail') {
        const err = await wait(() => [...document.querySelectorAll('.m-known-edit .m-err')].find(e => vis(e) && e.textContent.includes('改名沒成功')), 40);
        await sleep(200);
        if (!check) return { ok: true, why: '' };
        if (!err) return { ok: false, why: '改名失敗，畫面沒有說原因' };
        if (!document.querySelector('.m-dv-headtx .m-title')?.textContent.includes(${JSON.stringify(NAME_M)})) return { ok: false, why: '改名失敗，名字不該變' };
        return { ok: true, why: '' };
      }
      const toast = await wait(() => { const t = document.querySelector('.m-toast'); return t && t.textContent.includes('寄信時用的名字沒有換成功') ? t : null }, 40);
      await sleep(200);
      if (!check) return { ok: true, why: '' };
      if (!toast) return { ok: false, why: '名字被規則擋下，畫面沒有說明' };
      if (!toast.textContent.includes('保留給系統通知') || !toast.textContent.includes('請改用別的名字')) return { ok: false, why: '說明少了原因或怎麼辦：' + toast.textContent };
      return { ok: true, why: '' };
    }
    // ---- 首次引導（電腦 onboard.html、手機 m.html）連不上後台：名字先存本機，說「連上後會自動套用」 ----
    if (kind === 'o-offline' || kind === 'mo-offline') {
      if (${JSON.stringify(skin)}) document.documentElement.dataset.skin = ${JSON.stringify(skin)};
      const T = globalThis.__TAURI__.core, inv = T.invoke;
      T.invoke = async (cmd, args) => { if (cmd === 'device_rename' || cmd === 'android_known_rename') throw '改名沒成功，請稍後再試'; return inv(cmd, args) };
      const inp = await wait(() => [...document.querySelectorAll('.onboard-form input')].find(vis));
      if (!inp) return { ok: false, why: '沒有首次引導的輸入欄' };
      inp.value = ${JSON.stringify(NAME_NEW)}; inp.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(100);
      document.querySelector('.onboard-form button[type=submit]').click();
      const note = await wait(() => [...document.querySelectorAll('.onboard-note')].find(vis), 40);
      if (!check) return { ok: true, why: '' };
      if (!note) return { ok: false, why: '連不上後台時，引導畫面沒有說「連上後會自動套用」，或卡在錯誤上：' + (document.querySelector('.login-err')?.textContent ?? '') };
      if (!note.textContent.includes('連上後會自動套用')) return { ok: false, why: '說明寫的是：' + note.textContent };
      const saved = (globalThis.__smokeCalls || []).filter(c => c[0] === 'store_save' && c[1]?.name === 'onboard').some(c => String(c[1].text).includes('pendingDeviceName'));
      if (!saved) return { ok: false, why: '名字沒有先存在本機' };
      return { ok: true, why: '' };
    }
    // ---- 電腦：啟動對齊換不成時，左上角名字下面說明原因 ----
    if (kind === 'd-note') {
      const note = await wait(() => [...document.querySelectorAll('.nick-err')].find(vis), 60);
      await sleep(300);
      if (!check) return { ok: true, why: '' };
      if (!note || !note.textContent.includes('寄信時用的名字沒有換成功')) return { ok: false, why: '對齊換不成時，左上角沒有說明：' + (note?.textContent ?? '') };
      if (document.querySelector('.me-row input.nick-input')) return { ok: false, why: '電腦左上角的名字還是輸入欄' };
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
const wide = k => k === 'd-devices' || k === 'd-note' || k === 'o-offline'
const scenarios = SKINS.flatMap(([skin, suffix]) => [
  ['m-devices', 'm.html', '#app.m .m-row-btn'],
  ['m-me', 'm.html', '#app.m .m-row-btn'],
  ['m-me-page', 'm.html', '#app.m .m-row-btn'],
  ['m-rename', 'm.html', '#app.m .m-row-btn'],
  ['m-rename-fail', 'm.html', '#app.m .m-row-btn'],
  ['m-rename-blocked', 'm.html', '#app.m .m-row-btn'],
  ['d-devices', 'list.html', '#app.win'],
  ['d-note', 'list.html', '#app.win'],
  ['o-offline', 'onboard.html', '#app.win'],
  ['mo-offline', 'm.html', '.onboard-form'],
].map(([kind, page, ready]) => ({
  name: `devname-${kind}${suffix}`, page, width: wide(kind) ? 1100 : 412, height: wide(kind) ? 700 : 800,
  state: { signedIn: true, devname: kind, ...(skin ? { skin } : {}) }, ready, probe: { devname: kind, skin }, shot: `devname-${kind}${suffix}.png`,
})))

export default {
  key: 'devname',
  kind: '設備名稱只有一份檢查',
  source: probe => devnameProbeSource(probe),
  scenarios,
  table: (scenario, t) => {
    const kind = scenario.state.devname
    if (!kind) return undefined
    const mobile = kind.startsWith('m-') || kind === 'mo-offline'
    const out = { relay_list: { members: membersFor(mobile) }, startup_info: { ...t.startup_info, node: 'P', window_name: mobile ? NAME_M : NAME_D } }
    if (kind === 'o-offline' || kind === 'mo-offline') {
      // 首次引導：帳號已有名字，只剩設備名稱這一步；後台連不上（探測裡讓改名命令丟錯）
      out.store_load = { by: 'name', values: {}, fallback: null }
      out.auth_account_info = { ...t.auth_account_info, owner_name: '測試者' }
      out.startup_info = { ...out.startup_info, window_name_custom: false }
      if (mobile) { out.android_known_list = { peers: [] }; out.android_launchers = { machines: [] } }
      return out
    }
    if (kind === 'd-note') {
      out.device_name_align = { state: 'failed', name: NAME_D, reason: '名字不能含控制字元' }
      out.store_load = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify(DESK_ME) } }
      return out
    }
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
