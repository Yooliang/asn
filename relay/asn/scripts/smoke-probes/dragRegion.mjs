// 冒煙探測「拖曳區檢查」（probe.dragRegion，#2302）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
//
// LINE／現代外觀拿掉標題列之後，視窗只能從使用者直覺會去拖的地方拖：對話標題列、分頁列（窄視窗）、名單頂端。
// Tauri 的 data-tauri-drag-region 判斷方式（tauri 2.12 的 drag.js）：從被點到的元素往上找，
//   空屬性／true＝只有點到「這個元素本身」才算；deep＝底下整棵子樹都算；false＝這裡擋掉；
//   途中遇到按鈕、輸入框、select、role=tab 等可點元素（自己沒帶屬性）就擋掉。
// 這裡把同一套判斷抄進頁面，用 elementFromPoint 掃出「真的點得到、又是拖曳區」的點，確認：
//   ① 每個該能拖的地方，連續往下有 ≥ 30 CSS px 的拖曳點（1.25／1.5／2 三種縮放各量一次）
//   ② 三顆鈕、通話、⋯、返回、搜尋框、名牌、大頭貼、分頁都不是拖曳區
//   ③ 上緣縮放把手 .rz-n 還在、只占最上面幾 px、點得到
//   ④ Aero 外觀沒有多出任何拖曳區、三顆鈕容器照常接點擊
// 參數：{ skin: 'line'|'modern'|'aero', layout: 'wide'|'narrow'|'narrowList', dpr, paint? }。paint＝把拖曳點塗紅，給截圖用。

export const dragRegionProbeSource = p => `(async () => {
  try {
  const P = ${JSON.stringify(p)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const R = e => e.getBoundingClientRect();
  const at = el => { const r = R(el); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async req => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(350) };
  // ---- 抄 tauri drag.js 的判斷 ----
  const CLICK = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY']);
  const ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'option']);
  const clickable = el => CLICK.has(el.tagName) || (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false') || (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') || ROLES.has(el.getAttribute('role'));
  const isDrag = start => {
    for (let el = start; el; el = el.parentElement) {
      if (!(el instanceof HTMLElement)) continue;
      const a = el.getAttribute('data-tauri-drag-region');
      if (clickable(el) && a === null) return false;
      if (a === null) continue;
      if (a === 'false') return false;
      if (a === 'deep') return true;
      if (a === '' || a === 'true') return el === start;
    }
    return false;
  };
  const dragAt = (x, y) => { const el = document.elementFromPoint(x, y); return !!el && isDrag(el) };
  const name = el => el.getAttribute('aria-label') || el.className || el.tagName;
  const notes = [];

  if (Math.abs(devicePixelRatio - P.dpr) > 0.001) return { ok: false, why: '縮放沒有套上：要 ' + P.dpr + '，實際 ' + devicePixelRatio };

  // 名單以外的視窗外觀從 localStorage 讀（冒煙的假資料只管名單），這裡直接把 <html data-skin> 切過去，跟別的視窗改外觀時的做法一樣（skin-boot.js）
  if (P.layout === 'small' || P.layout === 'chat') { document.documentElement.setAttribute('data-skin', P.skin); await sleep(600) }
  // 獨立對話視窗的資料是名單視窗用事件推來的（asn:state）：冒煙沒有名單視窗，這裡自己推一份最小的夥伴與自己
  if (P.layout === 'chat') {
    const snap = { friends: [{ id: 'P/demo', nick: 'demo', status: 'online', hue: 205, psm: '', kind: 'claude', node: 'P', online: true }], me: { nick: '測試機', status: 'online', psm: '' }, ui: {}, selfNode: 'P', windowName: '測試機' };
    for (const fn of ((globalThis.__smokeListeners || {})['asn:state'] || [])) fn({ event: 'asn:state', payload: snap });
    await sleep(800);
  }

  // ---- Aero：什麼都不能變 ----
  if (P.skin === 'aero') {
    const extra = [...document.querySelectorAll('[data-tauri-drag-region]')].filter(e => !e.classList.contains('titlebar') && e.getAttribute('data-tauri-drag-region') !== 'false');   // false＝明確擋掉，本來就不是拖曳區
    if (extra.length) return { ok: false, why: 'Aero 外觀多出了拖曳區：' + extra.map(name).join('、') };
    const tb = document.querySelector('.t-btns');
    if (tb && getComputedStyle(tb).pointerEvents !== 'auto') return { ok: false, why: 'Aero 外觀的三顆鈕容器不該動 pointer-events' };
    return { ok: true, why: 'Aero 沒有多出拖曳區' };
  }

  // ---- 窄視窗名單：先按返回 ----
  if (P.layout === 'narrowList') {
    const back = [...document.querySelectorAll('.mbar-back, .pane-back')].find(vis);
    if (!back) return { ok: false, why: '窄視窗找不到返回名單的鈕' };
    await real({ click: at(back) });
    await sleep(300);
  }

  // ---- 掃一個區域，找最長的連續往下拖曳點 ----
  const scan = rect => {
    let best = { h: 0, x: 0, y0: 0 };
    for (let x = Math.ceil(rect.left) + 2; x < rect.right - 2; x += 4) {
      let run = 0, y0 = 0;
      for (let y = Math.floor(rect.top); y < rect.bottom; y += 1) {
        if (dragAt(x, y)) { if (!run) y0 = y; run++; if (run > best.h) best = { h: run, x, y0 } } else run = 0;
      }
    }
    return best;
  };
  const regions = [];
  const want = (label, sel) => { const el = [...document.querySelectorAll(sel)].find(vis); if (!el) throw new Error('找不到' + label + '（' + sel + '）'); regions.push([label, el]) };
  const line = P.skin === 'line';
  if (P.layout === 'small') want('標題列', '.titlebar');   // 登入、設定／指引、開機引導（#2302）
  else if (P.layout === 'chat') want('對話標題列', '.mbar');   // 獨立的對話視窗 chat.html
  else if (P.layout === 'narrowList') want('名單頂端', line ? '.list-pane > .me' : '.list-pane > .top-tabs');
  else if (P.layout === 'wide') { want('對話標題列', '.chat-area .mbar'); want('名單頂端', line ? '.list-pane > .me' : '.list-pane > .top-tabs') }
  else { want('對話標題列', '.chat-area .mbar'); if (!line) want('分頁列', '.chat-area .tabbar') }
  for (const [label, el] of regions) {
    const r = R(el), best = scan(r);
    if (best.h < 30) return { ok: false, why: label + '能拖的地方太小：最長連續 ' + best.h + ' CSS px（要 ≥ 30；區塊 ' + Math.round(r.width) + '×' + Math.round(r.height) + '）' };
    notes.push(label + ' ' + best.h + 'px');
  }

  // ---- 不能拖的東西 ----
  const never = ['.titlebar .tb', '.mbar .mbtn', '.mbar-plate', '.mbar-back', '.pane-back', '.content .search input', '.me-dp', '.ctab', '.top-tabs .ttab'];
  for (const sel of never) for (const el of document.querySelectorAll(sel)) {
    if (!vis(el)) continue;
    const [x, y] = at(el), hit = document.elementFromPoint(x, y);
    if (hit && isDrag(hit)) return { ok: false, why: '「' + name(el) + '」（' + sel + '）被當成拖曳區，點下去會拖視窗（點到的是 ' + (hit.tagName + '.' + hit.className) + '）' };
  }

  // ---- 上緣縮放把手 ----
  const rn = document.querySelector('.rz-n');
  if (!rn || !vis(rn)) return { ok: false, why: '找不到上緣縮放把手 .rz-n' };
  if (R(rn).height > 6) return { ok: false, why: '上緣縮放把手太高：' + R(rn).height + ' px（要 ≤ 6，免得吃掉拖曳區）' };
  const rr = R(rn), rx = Math.round(rr.left + rr.width / 2);
  if (document.elementFromPoint(rx, 1) !== rn) return { ok: false, why: '最上緣的點不是縮放把手（被 ' + name(document.elementFromPoint(rx, 1) || document.body) + ' 蓋住），上緣縮放失效' };
  notes.push('縮放把手 ' + R(rn).height + 'px');

  // ---- 截圖：把拖曳點塗成紅色 ----
  if (P.paint) {
    const c = document.createElement('canvas'), W = innerWidth, H = innerHeight;
    c.width = W; c.height = H;
    c.style.cssText = 'position:fixed;left:0;top:0;width:' + W + 'px;height:' + H + 'px;z-index:99999;pointer-events:none';
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(230,30,30,.38)';
    for (let x = 0; x < W; x += 3) for (let y = 0; y < H; y += 3) if (dragAt(x, y)) g.fillRect(x, y, 3, 3);
    g.fillStyle = 'rgba(30,90,230,.55)';
    g.fillRect(rr.left, rr.top, rr.width, rr.height);
    document.body.appendChild(c);
  }
  return { ok: true, why: notes.join('，') };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const LINE_STATE = { signedIn: true, partnerTab: true, lineMsgs: true, skin: 'line' }
const MODERN_STATE = { signedIn: true, bar: 'offline', chatMsgs: true, skin: 'modern' }
const AERO_STATE = { signedIn: true, bar: 'offline', chatMsgs: true, skin: 'aero' }
const WIDTH = { wide: 900, narrow: 500, narrowList: 500 }

const make = (skin, layout, dpr, extra = {}) => ({
  name: `drag-${skin}-${layout}-${String(dpr).replace('.', '_')}`,
  page: 'list.html', width: WIDTH[layout], height: 640, dpr,
  state: skin === 'line' ? LINE_STATE : skin === 'modern' ? MODERN_STATE : AERO_STATE,
  ready: skin === 'line' ? '#app.win .chat-area .compose-main' : '#app.win .actionbar',
  probe: { dragRegion: { skin, layout, dpr, ...extra } },
  ...(extra.paint && process.env.ASN_DRAG_SHOTS ? { shot: `drag-${skin}-${layout}.png` } : {}),   // 截圖只有要看拖曳區時才存（設 ASN_DRAG_SHOTS=1），不然會擠進 ui-shots 的情境分組
})

// 其他視窗（#2302）：登入、設定／指引（panel）、開機引導（onboard）、獨立的對話視窗（chat）。都是 500×640。
const WINDOWS = {
  login: { page: 'login.html', layout: 'small', state: { signedIn: false, needsLogin: true } },
  panel: { page: 'panel.html', layout: 'small', state: { signedIn: true } },
  onboard: { page: 'onboard.html', layout: 'small', state: { signedIn: true, onboard: true } },
  chat: { page: 'chat.html?id=P%2Fdemo', layout: 'chat', state: { signedIn: true, bar: 'offline', chatMsgs: true, lineMsgs: true } },
}
const makeWin = (skin, win, dpr, extra = {}) => {
  const w = WINDOWS[win]
  return {
    name: `drag-${skin}-win-${win}-${String(dpr).replace('.', '_')}`,
    page: w.page, width: 500, height: 640, dpr,
    state: { ...w.state, skin },
    ready: '#app.win',
    probe: { dragRegion: { skin, layout: w.layout, dpr, ...extra } },
    ...(extra.paint && process.env.ASN_DRAG_SHOTS ? { shot: `drag-${skin}-win-${win}.png` } : {}),
  }
}

const DPRS = [1.25, 1.5, 2]
const SCENARIOS = [
  ...['line', 'modern'].flatMap(skin => ['wide', 'narrow', 'narrowList'].flatMap(layout => DPRS.map(dpr => make(skin, layout, dpr, dpr === 1.25 ? { paint: true } : {})))),
  make('aero', 'wide', 1.5),
  ...['line', 'modern'].flatMap(skin => Object.keys(WINDOWS).flatMap(win => DPRS.map(dpr => makeWin(skin, win, dpr, dpr === 1.25 ? { paint: true } : {})))),
  ...Object.keys(WINDOWS).map(win => makeWin('aero', win, 1.5)),
]

export default {
  key: 'dragRegion',
  kind: '拖曳區檢查',
  source: probe => dragRegionProbeSource(probe.dragRegion),
  scenarios: SCENARIOS,
}
