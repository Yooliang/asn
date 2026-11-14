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
  { seq: 3, from: 'P~測試機', at: '2026-11-13T01:02:00Z', body: '測試機加入了群組', relation: 'system', from_kind: 'system' },
]
// 第二張：一對一對話樣本（relay_chat_history 的格式）：自己一則（對方讀過）、對方連發兩則、自己一則（只送達）
export const LINE_CHAT_MSGS = [
  { id: '00000000-0000-4000-8000-0000000000a1', dir: 'me', body: '幫我看一下 CI 為什麼紅了', created_at: '2026-11-13T01:00:00Z', delivered_at: '2026-11-13T01:00:01Z', acked_at: '2026-11-13T01:00:02Z' },
  { id: '00000000-0000-4000-8000-0000000000a2', dir: 'them', body: '看過了，是截圖名稱的問題。', created_at: '2026-11-13T01:01:00Z' },
  { id: '00000000-0000-4000-8000-0000000000a3', dir: 'them', body: '改成新的名字就會過。', created_at: '2026-11-13T01:01:30Z' },
  { id: '00000000-0000-4000-8000-0000000000a4', dir: 'me', body: '好，改完推上來', created_at: '2026-11-13T01:02:00Z', delivered_at: '2026-11-13T01:02:01Z' },
]
export const LINE_PROBES = {
  deskNav: { skinCheck: true, line: 'desk-nav' },
  deskChat: { skinCheck: true, line: 'desk-chat' },
  deskNarrow: { skinCheck: true, line: 'desk-narrow' },
  mobileNav: { skinCheck: true, line: 'm-nav' },
  mobileChat: { skinCheck: true, line: 'm-chat' },
  deskMsgs: { skinCheck: true, line: 'msgs' },
  deskList: { skinCheck: true, line: 'desk-list' },
  mobileMsgs: { skinCheck: true, line: 'msgs' },
  mobileList: { skinCheck: true, line: 'm-list' },
  deskSettings: { skinCheck: true, line: 'desk-settings' },
  mobileSettings: { skinCheck: true, line: 'm-settings' },
  deskRows: { skinCheck: true, line: 'desk-rows' },
  mobileRows: { skinCheck: true, line: 'm-rows' },
  deskCompose: { skinCheck: true, line: 'desk-compose' },
  mobileCompose: { skinCheck: true, line: 'm-compose' },
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


  // ---- 第三張：清單列右上時間與右下未讀圓、輸入列收尾（真的點擊與輸入）----
  if (kind === 'desk-rows' || kind === 'm-rows') {
    const mobile = kind === 'm-rows';
    if (!mobile) {
      const tab = await wait(() => [...document.querySelectorAll('.top-tabs .ttab')].find(b => (b.getAttribute('aria-label') || '').startsWith('對話')));
      if (!tab) return { ok: false, why: 'LINE 外觀：' + '找不到左欄「對話」' };
      await real({ click: at(tab) });
    }
    const rowsOf = () => [...document.querySelectorAll(mobile ? '.m-unread .m-buddy' : '.chat-list .buddy, .chat-list .room-btn')].filter(b => b.querySelector('.unread'));
    const rows = await wait(() => rowsOf().length >= 1 && rowsOf(), 60);
    if (!rows) return { ok: false, why: 'LINE 外觀：' + '清單上找不到有未讀的列' };
    await sleep(300);
    for (const row of rows) {
      const t = row.querySelector('.l-time'), u = row.querySelector('.unread');
      if (!t) return { ok: false, why: 'LINE 外觀：' + '有往來的列右上要有最後時間（.l-time）' };
      if (!/^((上午|下午) [0-9]{1,2}:[0-9]{2}|昨天)$/.test(t.textContent.trim())) return { ok: false, why: 'LINE 外觀：' + '清單時間要寫成「下午 3:52」或「昨天」：' + t.textContent };
      if (!/^[0-9]+$/.test(u.textContent.trim())) return { ok: false, why: 'LINE 外觀：' + '未讀圓圈裡是數字：' + u.textContent };
      const rr = row.getBoundingClientRect(), tr = t.getBoundingClientRect(), ur = u.getBoundingClientRect();
      if (rr.right - tr.right > 20 || tr.top - rr.top > 20 || tr.top < rr.top) return { ok: false, why: 'LINE 外觀：' + '時間要在列的右上角：' + [rr.right - tr.right, tr.top - rr.top].join() };
      if (rr.right - ur.right > 20 || rr.bottom - ur.bottom > 20 || ur.top < tr.bottom - 1) return { ok: false, why: 'LINE 外觀：' + '未讀圓圈要在時間正下方（右下）：' + [rr.right - ur.right, rr.bottom - ur.bottom].join() };
      if (Math.abs(ur.height - 20) > 1 || ur.width < 19 || parseFloat(cs(u, 'border-top-left-radius')) < 9 || cs(u, 'background-color') === 'rgba(0, 0, 0, 0)') return { ok: false, why: 'LINE 外觀：' + '未讀要是實心圓：' + ur.width + 'x' + ur.height + ' ' + cs(u, 'background-color') };
      const nick = row.querySelector('.b-nick').getBoundingClientRect();
      if (nick.right > tr.left + 1 && nick.bottom > tr.top && nick.top < tr.bottom) return { ok: false, why: 'LINE 外觀：' + '名字被右上角的時間蓋住' };
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) return { ok: false, why: 'LINE 外觀：' + '視窗出現橫向捲動' };
    return { ok: true, why: '' };
  }

  if (kind === 'desk-compose' || kind === 'm-compose') {
    const main = await wait(() => document.querySelector('.compose-main .composer textarea') && document.querySelector('.compose-main'));
    if (!main) return { ok: false, why: 'LINE 外觀：' + '找不到輸入列' };
    await sleep(500);
    const ta = main.querySelector('.composer textarea'), plus = main.querySelector('.mc-plus'), photo = main.querySelector('.lc-photo'), emo = main.querySelector('.lc-emo'), send = main.querySelector('.composer .aero-btn');
    if (!plus || !photo || !emo || !send) return { ok: false, why: 'LINE 外觀：' + '輸入列缺「＋」、圖片、表情或送出鈕' };
    // 排列：左邊「＋」「圖片」，中間輸入框，表情在框內右側
    const R = e => e.getBoundingClientRect(), pr = R(plus), hr = R(photo), tr = R(ta), er = R(emo);
    if (!(pr.right <= hr.left + 1 && hr.right <= tr.left + 1)) return { ok: false, why: 'LINE 外觀：' + '「＋」、圖片要依序在輸入框左邊' };
    if (!(er.left >= tr.left && er.right <= tr.right + 1 && er.top >= tr.top - 1 && er.bottom <= tr.bottom + 1)) return { ok: false, why: 'LINE 外觀：' + '表情鈕要在輸入框裡面的右側：' + [er.left - tr.left, tr.right - er.right].join() };
    if (er.left < tr.left + tr.width / 2) return { ok: false, why: 'LINE 外觀：' + '表情鈕要靠框的右邊' };
    if (parseFloat(cs(ta, 'border-top-left-radius')) < 14) return { ok: false, why: 'LINE 外觀：' + '輸入框要是圓角：' + cs(ta, 'border-top-left-radius') };
    for (const b of [plus, photo, emo]) { const r = R(b); if (r.width < 30 || r.height < 30) return { ok: false, why: 'LINE 外觀：' + '按鈕太小：' + r.width + 'x' + r.height }; const top = document.elementFromPoint(...at(b)); if (!top || !b.contains(top)) return { ok: false, why: 'LINE 外觀：' + '按鈕被別的東西蓋住：' + (top && top.className) } }
    const mic = main.querySelector('.mc-dict');
    if (mic && cs(mic, 'display') !== 'none' && R(mic).left < tr.right - 1) return { ok: false, why: 'LINE 外觀：' + '麥克風要在最右邊、輸入框外' };
    // 沒有字：送出鈕不出現，輸入框一行高
    if (cs(send, 'display') !== 'none') return { ok: false, why: 'LINE 外觀：' + '沒有字，送出鈕不該出現' };
    const oneH = R(ta).height;
    if (oneH < 36 || oneH > 44) return { ok: false, why: 'LINE 外觀：' + '一行時輸入框高度不對：' + oneH };
    // 真的輸入：一行、三行、七行（最多長到 6 行，之後框內捲動）
    await real({ click: at(ta) });
    await real({ text: '第1行' });
    if (!(await wait(() => cs(send, 'display') !== 'none', 20))) return { ok: false, why: 'LINE 外觀：' + '有字了，送出鈕要出現' };
    if (Math.abs(R(ta).height - oneH) > 1) return { ok: false, why: 'LINE 外觀：' + '一行字高度不該變：' + R(ta).height };
    for (let i = 2; i <= 3; i++) { await real({ shiftEnter: true }); await real({ text: '第' + i + '行' }) }
    await sleep(200);
    const h3 = R(ta).height;
    if (Math.abs(h3 - 84) > 2) return { ok: false, why: 'LINE 外觀：' + '三行時高度應約 84：' + h3 };
    for (let i = 4; i <= 7; i++) { await real({ shiftEnter: true }); await real({ text: '第' + i + '行' }) }
    await sleep(250);
    const h7 = R(ta), nLines = ta.value.split(String.fromCharCode(10)).length;
    if (nLines !== 7) return { ok: false, why: 'LINE 外觀：' + '應該輸入了七行：' + nLines };
    if (Math.abs(h7.height - 150) > 2) return { ok: false, why: 'LINE 外觀：' + '七行時高度要停在六行（約 150）：' + h7.height };
    if (!(ta.scrollHeight > ta.clientHeight + 4) || cs(ta, 'overflow-y') !== 'auto') return { ok: false, why: 'LINE 外觀：' + '超過六行要在框內捲動：' + ta.scrollHeight + ' / ' + ta.clientHeight + ' ' + cs(ta, 'overflow-y') };
    const er7 = R(emo), tr7 = R(ta);
    if (er7.bottom > tr7.bottom + 1 || er7.top < tr7.top) return { ok: false, why: 'LINE 外觀：' + '多行時表情鈕要還在框內（貼框底）' };
    // 表情：點框內的表情鈕，選一個，字進輸入框、選單收起
    const before = ta.value.length;
    await real({ click: at(emo) });
    const pick = await wait(() => document.querySelector('.compose-main .lc-picker'));
    if (!pick) return { ok: false, why: 'LINE 外觀：' + '點框內的表情鈕沒有出現表情選單' };
    await real({ click: at(pick.querySelector('button')) });
    if (!(await wait(() => ta.value.length > before && !document.querySelector('.compose-main .lc-picker'), 20))) return { ok: false, why: 'LINE 外觀：' + '選了表情，字要進輸入框、選單收起：' + before + ' → ' + ta.value.length };
    // 圖片：點圖片鈕，要打開既有的選檔（hidden 的 image input 收到 click）
    const fileIn = [...main.querySelectorAll('input[type="file"]')].find(i => i.accept === 'image/*');
    let opened = 0; const stop = ev => { ev.preventDefault(); opened++ };
    fileIn.addEventListener('click', stop);
    await real({ click: at(photo) });
    fileIn.removeEventListener('click', stop);
    if (opened !== 1) return { ok: false, why: 'LINE 外觀：' + '按圖片鈕沒有打開選檔：' + opened };
    // 「＋」選單：原本的按鈕都收在裡面、看得到、可按
    await real({ click: at(plus) });
    const menu = await wait(() => document.querySelector('.compose-main > .toolbar.mc-open'));
    if (!menu) return { ok: false, why: 'LINE 外觀：' + '按「＋」沒有展開選單' };
    const items = [...menu.querySelectorAll('.tool')].filter(b => cs(b, 'display') !== 'none');
    const labels = items.map(b => b.getAttribute('aria-label'));
    for (const want of ['表情符號', '傳照片', '傳送檔案', '傳送震動']) if (!labels.includes(want)) return { ok: false, why: 'LINE 外觀：' + '「＋」選單裡少了「' + want + '」：' + labels.join() };
    for (const b of items) { const r = R(b); if (r.width < 20 || r.height < 20 || b.offsetParent === null) return { ok: false, why: 'LINE 外觀：' + '選單項目看不到：' + b.getAttribute('aria-label') }; if (b.disabled) return { ok: false, why: 'LINE 外觀：' + '選單項目不能按：' + b.getAttribute('aria-label') } }
    await real({ key: 'Escape' });
    // 清空：送出鈕消失、高度回到一行
    ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true }));
    if (!(await wait(() => cs(send, 'display') === 'none' && Math.abs(R(ta).height - oneH) <= 1, 20))) return { ok: false, why: 'LINE 外觀：' + '清空後送出鈕要消失、高度回一行：' + cs(send, 'display') + ' ' + R(ta).height };
    // 收尾：再打幾行字，讓截圖看得到多行的輸入框與送出鈕
    await real({ click: at(ta) });
    for (let i = 1; i <= 4; i++) { if (i > 1) await real({ shiftEnter: true }); await real({ text: '多行輸入第' + i + '行' }) }
    await sleep(250);
    if (document.documentElement.scrollWidth > innerWidth + 1) return { ok: false, why: 'LINE 外觀：' + '視窗出現橫向捲動' };
    return { ok: true, why: '' };
  }

  // ---- 第二張：深色左欄、底部導覽、對話區、標題列（真的點擊）----
  const vis = el => !!el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';
  if (kind === 'desk-nav') {
    const bar = await wait(() => document.querySelector('.top-tabs'));
    if (!bar) return { ok: false, why: 'LINE 外觀：' + '找不到左側圖示欄' };
    const br = bar.getBoundingClientRect(), pr = document.querySelector('.list-pane').getBoundingClientRect();
    if (cs(bar, 'background-color') !== 'rgb(43, 47, 56)' || Math.abs(br.width - 60) > 1 || cs(bar, 'flex-direction') !== 'column') return { ok: false, why: 'LINE 外觀：' + '左欄要是約 60px 寬的深色直排：' + cs(bar, 'background-color') + ' ' + br.width };
    if (Math.abs(br.left - pr.left) > 1 || br.height < pr.height - 2) return { ok: false, why: 'LINE 外觀：' + '左欄沒有貼在名單欄最左邊、撐滿高度' };
    const btns = [...bar.querySelectorAll('.ttab')];
    const name = b => b.getAttribute('aria-label').replace(/（.*/, '');
    const want = ['夥伴', '對話', '設定', '通知'];
    if (btns.map(name).join() !== want.join()) return { ok: false, why: 'LINE 外觀：' + '左欄順序要是 夥伴、對話、設定、通知：' + btns.map(name).join() };
    for (const b of btns) {
      if (b.getAttribute('title') !== name(b)) return { ok: false, why: 'LINE 外觀：' + '圖示要有滑過提示（title）：' + name(b) };
      if (!b.querySelector('svg.lic')) return { ok: false, why: 'LINE 外觀：' + '左欄按鈕沒有線條圖示：' + name(b) };
      const lab = [...b.children].find(x => x.tagName === 'SPAN' && !x.className);
      if (lab && vis(lab)) return { ok: false, why: 'LINE 外觀：' + '左欄只留圖示，文字要收起來：' + name(b) };
      const r = b.getBoundingClientRect(); if (r.width < 36 || r.height < 36 || r.left < br.left || r.right > br.right) return { ok: false, why: 'LINE 外觀：' + '左欄按鈕大小或位置不對' };
    }
    const onBtn = () => btns.filter(b => b.classList.contains('on')).map(name);
    if (onBtn().join() !== '夥伴') return { ok: false, why: 'LINE 外觀：' + '一開始選中的應該是夥伴：' + onBtn().join() };
    const mark = getComputedStyle(btns[0], '::before');
    if (mark.content === 'none' || parseFloat(mark.width) < 2) return { ok: false, why: 'LINE 外觀：' + '選中的那顆沒有亮色細條' };
    await real({ click: at(btns[2]) });
    if (!(await wait(() => onBtn().join() === '設定', 20))) return { ok: false, why: 'LINE 外觀：' + '點左欄「設定」沒有切到設定分頁：' + onBtn().join() };
    await real({ click: at(btns[0]) });
    if (!(await wait(() => onBtn().join() === '夥伴', 20))) return { ok: false, why: 'LINE 外觀：' + '點左欄「夥伴」沒有切回：' + onBtn().join() };
    return { ok: true, why: '' };
  }

  if (kind === 'desk-chat' || kind === 'm-chat') {
    const mobile = kind === 'm-chat';
    const msgs = await wait(() => document.querySelectorAll('.msgs .msg').length >= 4 && document.querySelector('.msgs'));
    if (!msgs) return { ok: false, why: 'LINE 外觀：' + '對話裡應該有四則訊息：' + document.querySelectorAll('.msgs .msg').length };
    await sleep(300);
    const all = [...msgs.querySelectorAll('.msg')];
    const them = all.filter(m => !m.classList.contains('mine'));
    if (them.length !== 2 || !them[1].classList.contains('l-cont') || them[0].classList.contains('l-cont')) return { ok: false, why: 'LINE 外觀：' + '對方連發兩則，只有第二則是連續訊息：' + them.map(m => m.className).join(' | ') };
    const av = m => m.querySelector('.m-av');
    if (!vis(av(them[0]))) return { ok: false, why: 'LINE 外觀：' + '對方第一則要有頭像' };
    if (vis(av(them[1]))) return { ok: false, why: 'LINE 外觀：' + '對方連續的第二則不該顯示頭像' };
    if (Math.abs(av(them[1]).getBoundingClientRect().width - av(them[0]).getBoundingClientRect().width) > 1) return { ok: false, why: 'LINE 外觀：' + '省略頭像要留空位對齊' };
    const names = msgs.querySelectorAll('.l-name');
    if (names.length !== 1 || names[0].textContent.trim() !== 'demo') return { ok: false, why: 'LINE 外觀：' + '名字只在對方連續的第一則上方出現一次：' + names.length };
    if (names[0].getBoundingClientRect().bottom > them[0].querySelector('.m-body').getBoundingClientRect().top + 1) return { ok: false, why: 'LINE 外觀：' + '名字要在泡泡上方' };
    if (msgs.querySelector('.who')) return { ok: false, why: 'LINE 外觀：' + '原本的名字列不該出現' };
    const times = [...msgs.querySelectorAll('.l-time')].map(t => t.textContent.trim());
    if (times.length !== 4 || times.some(t => !/^(上午|下午) [0-9]{1,2}:[0-9]{2}$/.test(t))) return { ok: false, why: 'LINE 外觀：' + '時間要寫成「下午 3:52」：' + times.join(',') };
    const st = [...msgs.querySelectorAll('.msg.mine .l-st')].map(x => x.textContent.trim());
    if (st.join() !== '已讀,✓') return { ok: false, why: 'LINE 外觀：' + '一對一：對方讀過顯示「已讀」、只送達顯示 ✓：' + st.join() };
    if (msgs.querySelector('.msg-st, .read-n')) return { ok: false, why: 'LINE 外觀：' + '原本的 ✓✓ 符號不該出現' };
    // 位置：自己的時間在泡泡左側、對方的時間在泡泡右側，貼在泡泡底邊
    for (const m of all) {
      const body = m.querySelector('.m-body').getBoundingClientRect(), meta = m.querySelector('.l-meta').getBoundingClientRect();
      if (m.classList.contains('mine') ? meta.right > body.left + 1 : meta.left < body.right - 1) return { ok: false, why: 'LINE 外觀：' + '時間／已讀的位置不對（自己的在泡泡左、對方的在泡泡右）' };
      if (meta.bottom < body.bottom - 8 || meta.bottom > body.bottom + 4) return { ok: false, why: 'LINE 外觀：' + '時間要貼在泡泡底邊旁' };
    }
    // 樣本是固定的舊日期，所以第一則上方一定有日期膠囊（不是「今天」）；同一天只有一個
    const pill = msgs.querySelector('.l-day');
    if (!pill || !/^(昨天|[0-9]{4}[/][0-9]{1,2}[/][0-9]{1,2}（.）)$/.test(pill.textContent.trim()) || msgs.querySelectorAll('.l-day').length !== 1) return { ok: false, why: 'LINE 外觀：' + '同一天只有一個日期膠囊：' + (pill && pill.textContent) };
    if (document.documentElement.scrollWidth > innerWidth + 1) return { ok: false, why: 'LINE 外觀：' + '視窗出現橫向捲動' };
    if (mobile) {
      const page = document.querySelector('.m-page'), tabs = document.querySelector('.m-tabs');
      if (!page.hasAttribute('data-line-chat') || cs(tabs, 'display') !== 'none') return { ok: false, why: 'LINE 外觀：' + '進到對話頁，底部導覽要收起來：' + cs(tabs, 'display') };
      const back = document.querySelector('.m-plate-head .m-back');
      if (!vis(back)) return { ok: false, why: 'LINE 外觀：' + '手機標題列要有返回鍵' };
      const plate = document.querySelector('.m-plate-head .m-plate').getBoundingClientRect();
      if (plate.left > innerWidth / 3) return { ok: false, why: 'LINE 外觀：' + '名字要靠左：' + plate.left };
      await real({ click: at(back) });
      if (!(await wait(() => !page.hasAttribute('data-line-chat') && cs(tabs, 'display') !== 'none' && tabs.getBoundingClientRect().bottom > innerHeight - 4, 30))) return { ok: false, why: 'LINE 外觀：' + '離開對話頁後，底部導覽要回來並貼在畫面最下面' };
      return { ok: true, why: '' };
    }
    // 標題列：名字靠左、寬視窗沒有返回鍵、通話鍵走既有的通話入口
    const bar = document.querySelector('.mbar'), plate = bar.querySelector('.mbar-plate').getBoundingClientRect(), br = bar.getBoundingClientRect();
    if (plate.left - br.left > 60) return { ok: false, why: 'LINE 外觀：' + '標題列的名字要靠左：' + (plate.left - br.left) };
    if (document.querySelector('.mbar-back')) return { ok: false, why: 'LINE 外觀：' + '寬視窗不該有返回鍵' };
    const call = bar.querySelector('.mbtn-call'), more = bar.querySelector('.mbar-more .mbtn');
    if (!vis(call) || !more) return { ok: false, why: 'LINE 外觀：' + '標題列右側要有通話鍵與「⋯」' };
    if (call.getBoundingClientRect().right > more.getBoundingClientRect().left) return { ok: false, why: 'LINE 外觀：' + '通話鍵要在「⋯」左邊' };
    globalThis.__smokeCalls = []; globalThis.__smokeMissing.length = 0;
    await real({ click: at(call) });
    const hit = () => (globalThis.__smokeCalls || []).some(c => c[0] === 'stt_status') || globalThis.__smokeMissing.includes('stt_status');
    if (!(await wait(hit, 20))) return { ok: false, why: 'LINE 外觀：' + '按標題列的通話鍵，沒有走到既有的通話流程（沒有向語音功能查狀態）' };
    return { ok: true, why: '' };
  }

  if (kind === 'desk-narrow') {
    const bar = await wait(() => document.querySelector('.mbar'));
    if (!bar) return { ok: false, why: 'LINE 外觀：' + '窄視窗找不到標題列' };
    const back = bar.querySelector('.mbar-back');
    if (!vis(back)) return { ok: false, why: 'LINE 外觀：' + '窄視窗單窗格，標題列要有返回鍵' };
    if (back.getBoundingClientRect().left > bar.getBoundingClientRect().left + 24) return { ok: false, why: 'LINE 外觀：' + '返回鍵要在最左邊' };
    if (back.getAttribute('aria-label') !== '返回名單') return { ok: false, why: 'LINE 外觀：' + '返回鍵要有文字說明' };
    if (vis(document.querySelector('.shell.only-chat .tabbar'))) return { ok: false, why: 'LINE 外觀：' + '返回鍵搬進標題列後，上面那一列不該還在' };
    await real({ click: at(back) });
    if (!(await wait(() => document.querySelector('.shell.only-list') && vis(document.querySelector('.top-tabs')), 20))) return { ok: false, why: 'LINE 外觀：' + '按返回鍵沒有回到名單' };
    return { ok: true, why: '' };
  }

  if (kind === 'm-nav') {
    const tabs = await wait(() => document.querySelector('.m-tabs'));
    if (!tabs) return { ok: false, why: 'LINE 外觀：' + '找不到手機分頁列' };
    const r = tabs.getBoundingClientRect();
    if (r.bottom < innerHeight - 4 || r.height < 50) return { ok: false, why: 'LINE 外觀：' + '分頁列要貼在畫面最下面：' + r.bottom + ' / ' + innerHeight };
    const btns = [...tabs.querySelectorAll('button')];
    if (btns.map(b => b.textContent.trim()).join() !== '夥伴,對話,設定,通知') return { ok: false, why: 'LINE 外觀：' + '分頁順序要是 夥伴、對話、設定、通知：' + btns.map(b => b.textContent.trim()).join() };
    for (const b of btns) {
      const ic = b.querySelector('svg.lic'), tx = b.querySelector('span');
      if (!ic || !tx) return { ok: false, why: 'LINE 外觀：' + '每個分頁要有圖示與文字' };
      if (ic.getBoundingClientRect().bottom > tx.getBoundingClientRect().top + 1) return { ok: false, why: 'LINE 外觀：' + '圖示要在文字上面' };
    }
    const onTab = () => btns.filter(b => b.classList.contains('on')).map(b => b.textContent.trim()).join();
    if (onTab() !== '夥伴') return { ok: false, why: 'LINE 外觀：' + '一開始選中的應該是夥伴：' + onTab() };
    const dot = tabs.querySelector('.red');
    if (dot && btns.indexOf(dot.closest('button')) !== 0) return { ok: false, why: 'LINE 外觀：' + '未讀紅點要掛在「夥伴」' };
    await real({ click: at(btns[2]) });
    if (!(await wait(() => onTab() === '設定', 20))) return { ok: false, why: 'LINE 外觀：' + '點底部「設定」沒有切過去：' + onTab() };
    await real({ click: at(btns[0]) });
    if (!(await wait(() => onTab() === '夥伴', 20))) return { ok: false, why: 'LINE 外觀：' + '點底部「夥伴」沒有切回：' + onTab() };
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
