// 外觀「LINE 風格」（0.2.22，#1449 第一張）的冒煙探測：只產生探測原始碼（在頁面裡執行），字串裡不寫反斜線。
// 量的是「畫面真的長成設計稿那樣」：淡藍純色底、對方白泡泡有尾巴、自己泡泡顏色等於變數 --line-me、系統提示膠囊、
// 清單頭像 48px、搜尋框、懸浮新增鈕；設定頁外觀三選一用「真的點擊」（window.__smokeInput，由 smoke-ui.mjs 用偵錯協定送滑鼠）切換，
// 來回切換後頭像模式、文字底色的選單值不變（不寫回存檔）。
export const LINE_BG = 'rgb(169, 189, 226)'
// 電腦「設定 → 外觀」：整合模式開著設定分頁；存檔裡的頭像模式與文字底色故意設成「不是 LINE 固定的值」（left／none），才看得出沒被洗掉
export const LINE_LOOK_ME = { winMode: 'merged', dpMode: 'left', bubble: 'none', session: { v: 1, tabs: [{ id: '@setting' }], active: { id: '@setting' }, panel: { guide: '', setting: 'look' }, windows: [], panelWindows: [] } }
// 群組對話樣本（relay_room_read 的格式）：對方一則、自己一則、系統提示一則
export const LINE_GROUP_MSGS = [
  { seq: 1, from: 'P~測試機', at: '2026-11-13T01:00:00Z', body: '大家早，今天的測試已經跑完了。', relation: 'other', from_kind: 'ai' },
  { seq: 2, from: 'me', at: '2026-11-13T01:01:00Z', body: '好，我來看結果', relation: 'mine' },
  { seq: 3, from: 'P~測試機', at: '2026-11-13T01:02:00Z', body: '', relation: 'system', from_kind: 'system' },
]
export const LINE_PROBES = {
  deskMsgs: { skinCheck: true, line: 'msgs' },
  deskList: { skinCheck: true, line: 'desk-list' },
  mobileMsgs: { skinCheck: true, line: 'msgs' },
  mobileList: { skinCheck: true, line: 'm-list' },
  deskSettings: { skinCheck: true, line: 'desk-settings' },
  mobileSettings: { skinCheck: true, line: 'm-settings' },
}

export const lineProbeSource = kind => `(async () => {
  try {
  const kind = ${JSON.stringify(kind)};
  const BG = ${JSON.stringify(LINE_BG)};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (fn, n = 60) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const real = req => { globalThis.__smokeInput(JSON.stringify(req)); return sleep(450) };
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const cs = (el, p, pseudo) => getComputedStyle(el, pseudo).getPropertyValue(p).trim();
  const skinNow = () => document.documentElement.dataset.skin;
  if (!(await wait(() => skinNow() === 'line', 40))) return { ok: false, why: 'LINE 外觀：' + '存檔選了 LINE，畫面卻是 ' + (skinNow() || '沒有設定') };
  // 自己泡泡的顏色寫成變數，亮綠（小良哥拍板）
  const me = cs(document.documentElement, '--line-me').toLowerCase();
  if (me !== '#9be685') return { ok: false, why: 'LINE 外觀：' + '--line-me 應該是 #9be685：' + me };
  const probeBg = document.createElement('div'); probeBg.style.cssText = 'background:var(--line-me);position:fixed;left:-99px;top:0;width:1px;height:1px'; document.body.appendChild(probeBg);
  const meRgb = cs(probeBg, 'background-color'); probeBg.remove();

  if (kind === 'msgs') {
    const msgs = await wait(() => document.querySelector('.msgs') && document.querySelector('.msg .m-body.tone-them') && document.querySelector('.msgs'));
    if (!msgs) return { ok: false, why: 'LINE 外觀：' + '沒有出現對方的訊息泡泡（tone-them）；頭像模式或底色沒有被 LINE 固定成「頭像在旁、自動」？' };
    if (cs(msgs, 'background-color') !== BG) return { ok: false, why: 'LINE 外觀：' + '對話區底色不是淡藍純色：' + cs(msgs, 'background-color') };
    if (cs(msgs, 'background-image') !== 'none') return { ok: false, why: 'LINE 外觀：' + '對話區底色不該有圖（純色）：' + cs(msgs, 'background-image') };
    const them = document.querySelector('.msg .m-body.tone-them');
    if (cs(them, 'background-color') !== 'rgb(255, 255, 255)') return { ok: false, why: 'LINE 外觀：' + '對方泡泡不是白色：' + cs(them, 'background-color') };
    const tail = getComputedStyle(them, '::before');
    if (tail.content === 'none' || tail.clipPath === 'none' || parseFloat(tail.width) < 4) return { ok: false, why: 'LINE 外觀：' + '對方泡泡沒有尾巴（::before）' };
    const mine = document.querySelector('.msg .m-body.tone-me');
    if (mine) {
      if (cs(mine, 'background-color') !== meRgb) return { ok: false, why: 'LINE 外觀：' + '自己泡泡顏色不等於 --line-me：' + cs(mine, 'background-color') + ' ≠ ' + meRgb };
      if (parseFloat(cs(mine, 'border-top-left-radius')) < 15) return { ok: false, why: 'LINE 外觀：' + '自己泡泡圓角不對：' + cs(mine, 'border-top-left-radius') };
    }
    // 泡泡最大寬約 68%（純文字的泡泡）
    const main = them.closest('.m-main'), pw = msgs.clientWidth;
    if (main.getBoundingClientRect().width > pw * 0.69 + 1) return { ok: false, why: 'LINE 外觀：' + '泡泡超過欄寬的 68%：' + main.getBoundingClientRect().width + ' / ' + pw };
    // 系統提示是置中的灰藍小膠囊
    const sys = document.querySelector('.sys');
    if (sys) {
      if (parseFloat(cs(sys, 'border-top-left-radius')) < 10 || cs(sys, 'background-color') === 'rgba(0, 0, 0, 0)') return { ok: false, why: 'LINE 外觀：' + '系統提示不是膠囊：' + cs(sys, 'border-top-left-radius') + ' ' + cs(sys, 'background-color') };
      const sr = sys.getBoundingClientRect(), mr = msgs.getBoundingClientRect();
      if (Math.abs((sr.left + sr.right) / 2 - (mr.left + mr.right) / 2) > 20) return { ok: false, why: 'LINE 外觀：' + '系統提示沒有置中' };
    }
    const meAv = document.querySelector('.msg .m-av-me');
    if (meAv && cs(meAv, 'display') !== 'none') return { ok: false, why: 'LINE 外觀：' + '自己的頭像還在' };
    if (!document.querySelector('.msg .m-av')) return { ok: false, why: 'LINE 外觀：' + '對方的頭像不見了（應該在泡泡旁）' };
    if (document.documentElement.scrollWidth > innerWidth + 1) return { ok: false, why: 'LINE 外觀：' + '視窗出現橫向捲動' };
    return { ok: true, why: '' };
  }

  if (kind === 'desk-list' || kind === 'm-list') {
    const mobile = kind === 'm-list';
    const dp = await wait(() => document.querySelector(mobile ? '.m-av-wrap .dp' : '.buddy .dp, .room-btn .dp'));
    if (!dp) return { ok: false, why: 'LINE 外觀：' + '清單上找不到頭像' };
    if (cs(dp, 'width') !== '48px' || cs(dp, 'border-top-left-radius') !== '50%') return { ok: false, why: 'LINE 外觀：' + '清單頭像要是 48px 圓形：' + cs(dp, 'width') + ' ' + cs(dp, 'border-top-left-radius') };
    const input = document.querySelector(mobile ? '.m-search input' : '.search input');
    if (!input) return { ok: false, why: 'LINE 外觀：' + '找不到搜尋框' };
    if (cs(input, 'background-color') !== 'rgb(238, 240, 243)' || cs(input, 'background-image') === 'none') return { ok: false, why: 'LINE 外觀：' + '搜尋框要灰底、框內左側有放大鏡：' + cs(input, 'background-color') };
    if (parseFloat(cs(input, 'padding-left')) < 30) return { ok: false, why: 'LINE 外觀：' + '搜尋框左邊要留位置給放大鏡' };
    const nick = document.querySelector(mobile ? '.m-buddy .b-nick, .m-buddy b' : '.b-nick');
    if (nick && parseInt(cs(nick, 'font-weight'), 10) < 600) return { ok: false, why: 'LINE 外觀：' + '名字要加粗：' + cs(nick, 'font-weight') };
    if (!mobile) {
      const fab = document.querySelector('.search-plus'), box = document.querySelector('.content');
      if (!fab || !box) return { ok: false, why: 'LINE 外觀：' + '找不到懸浮新增鈕' };
      if (cs(fab, 'position') !== 'absolute') return { ok: false, why: 'LINE 外觀：' + '新增鈕要是懸浮的：' + cs(fab, 'position') };
      const f = fab.getBoundingClientRect(), b = box.getBoundingClientRect();
      if (f.right > b.right + 1 || f.bottom > b.bottom + 1 || b.right - f.right > 40 || b.bottom - f.bottom > 40) return { ok: false, why: 'LINE 外觀：' + '新增鈕不在清單欄的右下角' };
      const top = document.elementFromPoint(...at(fab));
      if (!top || !fab.contains(top)) return { ok: false, why: 'LINE 外觀：' + '新增鈕被別的東西蓋住了：' + (top && top.className) };
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) return { ok: false, why: 'LINE 外觀：' + '視窗出現橫向捲動' };
    return { ok: true, why: '' };
  }

  // 設定頁外觀三選一：用真的點擊切換；來回切換後頭像模式、文字底色的選單值不變
  const radios = () => [...document.querySelectorAll('.skin-pick input[type="radio"]')];
  const pickSkin = async v => {
    const r = radios().find(x => x.value === v);
    if (!r) return '找不到外觀選項 ' + v;
    await real({ click: at(r.closest('label') || r) });
    if (!(await wait(() => skinNow() === v, 20))) return '點了「' + v + '」，畫面外觀卻是 ' + skinNow();
    let stored = null; try { stored = localStorage.getItem('asnSkin') } catch (e) {}
    if (stored !== v) return '點了「' + v + '」，記下來的外觀卻是 ' + stored;
    return '';
  };
  if (kind === 'm-settings') {
    const tabs = [...document.querySelectorAll('.m-tabs button')];
    if (tabs.length < 3) return { ok: false, why: 'LINE 外觀：' + '找不到手機的大分頁' };
    await real({ click: at(tabs[2]) });
    const row = await wait(() => [...document.querySelectorAll('.m-row-btn')].find(b => b.textContent.includes('外觀') && b.offsetParent !== null));
    if (!row) return { ok: false, why: 'LINE 外觀：' + '設定頁沒有「外觀」這一列' };
    await real({ click: at(row) });
    if (!(await wait(() => radios().length === 3 && radios()[0].offsetParent !== null))) return { ok: false, why: 'LINE 外觀：' + '手機外觀頁不是三選一：' + radios().length };
    for (const v of ['modern', 'aero', 'line']) { const w = await pickSkin(v); if (w) return { ok: false, why: 'LINE 外觀：' + '手機：' + w } }
    if (!document.querySelector('.skin-mini-line')) return { ok: false, why: 'LINE 外觀：' + '手機外觀頁沒有 LINE 的縮圖' };
    return { ok: true, why: '' };
  }
  // desk-settings
  if (!(await wait(() => radios().length === 3))) return { ok: false, why: 'LINE 外觀：' + '電腦外觀頁不是三選一：' + radios().length };
  const sel = label => document.querySelector('.set-sel[aria-label="' + label + '"]');
  if (!sel('頭像模式') || !sel('文字底色')) return { ok: false, why: 'LINE 外觀：' + '找不到頭像模式／文字底色選單' };
  // 存檔的值是 left／none；LINE 下停用的選單顯示「實際生效的值」（頭像在訊息旁、底色自動），切回其他外觀仍顯示並保留存檔的原值
  const SAVED = ['left', 'none'], EFFECTIVE = ['inline', 'auto'];
  const shown = () => [sel('頭像模式').value, sel('文字底色').value];
  const disabled = () => sel('頭像模式').disabled && sel('文字底色').disabled;
  const notes = () => document.querySelectorAll('.set-note').length;
  if (shown().join() !== EFFECTIVE.join()) return { ok: false, why: 'LINE 外觀：' + '停用的選單要顯示實際生效的值（頭像在訊息旁、底色自動）：' + shown().join('／') };
  if (!disabled() || notes() < 2) return { ok: false, why: 'LINE 外觀：' + 'LINE 外觀下，頭像模式與文字底色要停用並附說明：' + disabled() + ' ' + notes() };
  for (const v of ['modern', 'aero', 'line']) {
    const w = await pickSkin(v); if (w) return { ok: false, why: 'LINE 外觀：' + w };
    await sleep(300);
    const want = v === 'line' ? EFFECTIVE : SAVED;
    if (shown().join() !== want.join()) return { ok: false, why: 'LINE 外觀：' + '切到「' + v + '」後，頭像模式／文字底色顯示 ' + shown().join('／') + '，應該是 ' + want.join('／') };
    if (v === 'line' ? !disabled() || notes() < 2 : (sel('頭像模式').disabled || sel('文字底色').disabled || notes() > 0)) return { ok: false, why: 'LINE 外觀：' + '切到「' + v + '」後，停用狀態不對' };
  }
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: 'LINE 外觀：' + '探測出錯：' + e.message } }
})()`
