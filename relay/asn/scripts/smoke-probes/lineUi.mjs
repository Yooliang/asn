// 冒煙探測「LINE 輸入列與標題列檢查」（probe.lineUi）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

// LINE 外觀（#1517 之 1）：每則時間各自貼在自己泡泡的底部旁邊——對方在泡泡右邊、自己在泡泡左邊，「已讀」疊在時間上面；時間彼此不重疊、也不能跑到畫面角落
// LINE 外觀（#1517 之 2～4）：part＝'compose'（白底、灰框、表情在框內、麥克風最右、打字時收成「＞」，真點擊＋真打字）或 'busy'（標題列不變黃、「忙碌」是黃色小標籤）
export const lineUiProbeSource = ({ lineUi }) => `(async () => {
  try {
  const want = ${JSON.stringify(lineUi)};
  const phone = want.mode === 'phone';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async req => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(350) };
  const R = e => e.getBoundingClientRect();
  let pane = null;
  for (let i = 0; i < 60 && !pane; i++) { pane = [...document.querySelectorAll('.chatpane')].find(vis) || null; if (!pane) await sleep(100) }
  if (!pane) return { ok: false, why: '找不到對話' };
  await sleep(400);
  if (want.part === 'busy') {
    const pill = [...document.querySelectorAll(phone ? '.m-chathead .l-busy' : '.mbar .l-busy')].find(vis);
    if (!pill || pill.textContent.trim() !== '忙碌') return { ok: false, why: '標題列沒有「忙碌」黃色小標籤' };
    if (getComputedStyle(pill).backgroundColor !== 'rgb(255, 213, 74)') return { ok: false, why: '「忙碌」標籤不是黃色：' + getComputedStyle(pill).backgroundColor };
    if (phone) {
      const head = document.querySelector('.m-chathead'), conv = pane.querySelector('.conv-main') || pane;
      const hb = getComputedStyle(head).backgroundColor, cb = getComputedStyle(conv).backgroundColor;
      if (hb !== cb) return { ok: false, why: '忙碌時標題列底色跟對話區不同：' + hb + ' ／ ' + cb };
    }
    return { ok: true, why: '' };
  }
  const main = pane.querySelector('.compose-main'), ta = main && main.querySelector('textarea');
  if (!ta) return { ok: false, why: '找不到輸入框' };
  // 電腦版（#1527）：按鈕區固定在輸入框上方，打字不收合、沒有「＞」（手機才有）
  if (!phone) {
    const bar = main.querySelector(':scope > .toolbar');
    if (!vis(bar) || vis(main.querySelector('.lc-more')) || vis(main.querySelector('.mc-plus'))) return { ok: false, why: '電腦版應該是上方按鈕區、沒有「＋」和「＞」' };
    await real({ click: at(ta) });
    await real({ text: '哈囉' });
    if (!vis(bar) || vis(main.querySelector('.lc-more'))) return { ok: false, why: '電腦版打字後按鈕區不該收起來' };
    await real({ key: 'Enter' });
    if (ta.value !== '') return { ok: false, why: '電腦版按 Enter 沒有送出' };
    return { ok: true, why: '' };
  }
  const row = main.closest('.compose-row') || main;
  for (const [el, name] of [[row, '輸入區'], [main, '輸入列']]) if (getComputedStyle(el).backgroundColor !== 'rgb(255, 255, 255)') return { ok: false, why: name + '不是白底：' + getComputedStyle(el).backgroundColor };
  const tbg = getComputedStyle(ta).backgroundColor;
  if (tbg === 'rgb(255, 255, 255)' || tbg === 'rgba(0, 0, 0, 0)') return { ok: false, why: '輸入框不是淺灰：' + tbg };
  if (parseFloat(getComputedStyle(ta).borderTopLeftRadius) < 14) return { ok: false, why: '輸入框不是圓角' };
  const emo = main.querySelector('.lc-emo'), t = R(ta);
  if (!vis(emo)) return { ok: false, why: '找不到表情鈕' };
  { const e = R(emo); if (e.left < t.left || e.right > t.right + 1 || e.top < t.top - 1 || e.bottom > t.bottom + 1) return { ok: false, why: '表情鈕不在輸入框裡' } }
  const plus = main.querySelector('.mc-plus'), photo = main.querySelector('.lc-photo'), more = main.querySelector('.lc-more');
  if (!vis(plus) || !vis(photo) || vis(more)) return { ok: false, why: '還沒打字時應該看得到「＋」和圖片鈕、看不到「＞」' };
  await real({ click: at(ta) });
  if (document.activeElement !== ta) return { ok: false, why: '點輸入框沒有取得焦點' };
  // 手機：有焦點就收；電腦打開對話本來就聚焦輸入框，要等有字才收
  if (phone && (vis(plus) || vis(photo) || !vis(more))) return { ok: false, why: '輸入框有焦點時「＋」和圖片鈕沒有收成「＞」' };
  if (!phone && (!vis(plus) || vis(more))) return { ok: false, why: '電腦還沒打字就收起來了' };
  await real({ text: '哈囉' });
  if (vis(plus) || vis(photo) || !vis(more)) return { ok: false, why: '打字後「＋」和圖片鈕應該收成「＞」' };
  const mic = [...main.querySelectorAll('.mc-dict')].find(vis);
  if (mic) {
    const m = R(mic);
    for (const b of [...main.querySelectorAll('button')].filter(vis)) if (b !== mic && R(b).right > m.right + 1) return { ok: false, why: '麥克風不在最右邊（' + (b.getAttribute('aria-label') || b.className) + ' 在它右邊）' };
    if (m.left < t.right - 1) return { ok: false, why: '麥克風不在輸入框外' };
  }
  await real({ click: at(more) });
  if (!vis(plus) || !vis(photo)) return { ok: false, why: '按「＞」沒有展開「＋」和圖片鈕' };
  if (document.activeElement !== ta) return { ok: false, why: '按「＞」不該讓輸入框失去焦點' };
  // 送出後一律收回展開狀態：下一句一開始打字又收成「＞」（#1524 審查）。電腦按 Enter 送（焦點留在輸入框），手機點送出鈕
  if (phone) {
    const send = [...pane.querySelectorAll('button[type="submit"]')].find(vis);
    if (!send) return { ok: false, why: '有字時找不到送出鈕' };
    await real({ click: at(send) });
  } else await real({ key: 'Enter' });
  if (ta.value !== '') return { ok: false, why: '送出後輸入框沒有清空' };
  if (document.activeElement !== ta) await real({ click: at(ta) });
  await real({ text: '再一句' });
  if (vis(plus) || vis(photo) || !vis(more)) return { ok: false, why: '送出後下一句開始打字，沒有再收成「＞」' };
  // 用鍵盤按「＞」（空白鍵）：展開後焦點要移到「＋」，不能掉到整頁
  more.focus();
  await real({ key: ' ' });
  if (!vis(plus) || document.activeElement !== plus) return { ok: false, why: '用鍵盤按「＞」展開後，焦點應該在「＋」上（現在在 ' + (document.activeElement && (document.activeElement.className || document.activeElement.tagName)) + '）' };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

export default {
  key: 'lineUi',
  kind: 'LINE 輸入列與標題列檢查',
  source: probe => lineUiProbeSource(probe),
}
