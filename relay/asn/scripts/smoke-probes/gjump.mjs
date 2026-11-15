// 冒煙探測「群組點成員跳一對一檢查」（probe.gjump）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）

// mode＝desk／phone；list＝也測「N 人離線」名單（只有現代外觀有那顆鈕）；shotOnly＝只截圖不點（逐像素比對用）
export const gjumpProbeSource = ({ gjump }) => `(async () => {
  try {
  const want = ${JSON.stringify(gjump)};
  const phone = want.mode === 'phone';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async el => { el.scrollIntoView({ block: 'center' }); await sleep(120); globalThis.__smokeInput(JSON.stringify({ click: at(el) })); await sleep(500) };
  const pane = () => [...document.querySelectorAll('.chatpane')].find(vis) || null;
  const isGroup = () => { const p = pane(); return !!p && [...p.querySelectorAll('.m-body')].some(b => b.textContent.includes('審稿這邊看完了')) };
  const isFriend = () => { const p = pane(); return !!p && !isGroup() && (phone ? (document.querySelector('.m-chathead')?.textContent || '').includes('審稿') : (p.querySelector('.to-line')?.textContent || '').includes('審稿')) };
  const spk = (cls, name) => [...(pane()?.querySelectorAll(cls) || [])].find(e => vis(e) && (cls === '.m-av-spk' ? e.closest('.msg')?.textContent.includes(name) : e.textContent.trim() === name));
  for (let i = 0; i < 60 && !isGroup(); i++) await sleep(100);
  if (!isGroup()) return { ok: false, why: '沒有開在群組上' };
  await sleep(300);
  if (want.shotOnly) return { ok: true, why: '' };
  // 審查重現（#1516）：跳過去 → 從夥伴頁換到別人 → 返回 → 再從夥伴頁點回審稿：畫面要停在審稿，不能被舊的跳轉標記拉回群組
  if (want.stale) {
    const showing = name => !isGroup() && (document.querySelector('.m-chathead')?.textContent || '').includes(name);
    const tabBtn = () => [...document.querySelectorAll('button')].find(b => vis(b) && b.getAttribute('role') === 'tab' && b.textContent.trim() === '夥伴');
    const row = name => [...document.querySelectorAll('section[aria-label="夥伴"] button')].find(b => vis(b) && (b.querySelector('.b-nick')?.textContent || '').trim() === name);
    const n0 = spk('.who-name', '審稿');
    if (!n0) return { ok: false, why: '找不到審稿的名字' };
    await real(n0);
    for (let i = 0; i < 20 && !showing('審稿'); i++) await sleep(100);
    if (!showing('審稿')) return { ok: false, why: '第一步沒跳到審稿' };
    let t = tabBtn(); if (!t) return { ok: false, why: '找不到「夥伴」分頁' };
    await real(t);
    let r = row('財務'); if (!r) return { ok: false, why: '夥伴頁找不到財務' };
    await real(r);
    for (let i = 0; i < 20 && !showing('財務'); i++) await sleep(100);
    if (!showing('財務')) return { ok: false, why: '從夥伴頁點財務沒有進到財務' };
    history.back(); await sleep(700);
    if (isGroup()) return { ok: false, why: '換過別人之後按返回，被拉回群組' };
    t = tabBtn(); if (!t) return { ok: false, why: '第二次找不到「夥伴」分頁' };
    await real(t);
    r = row('審稿'); if (!r) return { ok: false, why: '夥伴頁找不到審稿' };
    await real(r);
    await sleep(500);
    if (isGroup()) return { ok: false, why: '從夥伴頁點審稿卻進了群組（舊的跳轉標記沒清掉）' };
    if (!showing('審稿')) return { ok: false, why: '從夥伴頁點審稿沒有停在審稿' };
    if (history.state && history.state.jumpFrom) return { ok: false, why: '記錄上還留著跳轉標記' };
    return { ok: true, why: '' };
  }
  // 1. 點發言者的名字
  const n1 = spk('.who-name', '審稿');
  if (!n1) return { ok: false, why: '找不到群組訊息上「審稿」的名字' };
  if (n1.getAttribute('role') !== 'button' || !/開啟和 審稿 的對話/.test(n1.getAttribute('aria-label') || '')) return { ok: false, why: '名字沒有 role=button 或 aria-label' };
  await real(n1);
  for (let i = 0; i < 20 && !isFriend(); i++) await sleep(100);
  if (!isFriend()) return { ok: false, why: '點名字沒有跳到跟審稿的一對一' };
  const back = async () => {
    if (phone) { history.back(); await sleep(600); return }
    // 復古 Aero 點上面的對話分頁；現代外觀沒有分頁列，點左邊名單的群組
    const find = () => [...document.querySelectorAll('.ctab, .room-btn')].find(e => vis(e) && e.textContent.includes('測試群'));
    let tab = find();
    if (!tab) { const t = [...document.querySelectorAll('.ttab-chats')].find(vis); if (t) { await real(t); tab = find() } }
    if (tab) await real(tab);
  };
  await back();
  for (let i = 0; i < 20 && !isGroup(); i++) await sleep(100);
  if (!isGroup()) return { ok: false, why: phone ? '按返回沒有回到群組' : '切回群組分頁失敗' };
  if (phone && history.state && history.state.jumpFrom) return { ok: false, why: '回到群組後記錄上還留著跳轉標記' };
  // 2. 點發言者的頭像
  const a1 = spk('.m-av-spk', '審稿');
  if (!a1) return { ok: false, why: '找不到審稿的頭像' };
  await real(a1);
  for (let i = 0; i < 20 && !isFriend(); i++) await sleep(100);
  if (!isFriend()) return { ok: false, why: '點頭像沒有跳到跟審稿的一對一' };
  await back();
  for (let i = 0; i < 20 && !isGroup(); i++) await sleep(100);
  if (!isGroup()) return { ok: false, why: '第二次沒回到群組' };
  // 3. 不在夥伴名單的人：不跳、出現說明
  const n2 = spk('.who-name', '報表');
  if (!n2) return { ok: false, why: '找不到「報表」的名字' };
  await real(n2);
  if (!isGroup()) return { ok: false, why: '點了不在名單的人卻跳走了' };
  if (!(pane()?.textContent || '').includes('不在你的夥伴名單')) return { ok: false, why: '點了不在名單的人沒有說明' };
  // 4. 「N 人離線」名單（現代外觀）
  if (want.list) {
    const btn = [...document.querySelectorAll(phone ? '.m-plate-head .m-offline-btn' : '.mbar .mbtn-offline')].find(vis);
    if (!btn) return { ok: false, why: '找不到「N 人離線」' };
    await real(btn);
    const row = [...document.querySelectorAll(phone ? '.m-offline-menu li' : '.offline-menu .menu-note')].find(e => vis(e) && e.textContent.trim() === '審稿');
    if (!row || row.getAttribute('role') !== 'button') return { ok: false, why: '名單裡的審稿不能點' };
    await real(row);
    for (let i = 0; i < 20 && !isFriend(); i++) await sleep(100);
    if (!isFriend()) return { ok: false, why: '點名單裡的人沒有跳過去' };
    if (document.querySelector(phone ? '.m-offline-menu' : '.offline-menu')) return { ok: false, why: '跳過去後名單還開著' };
    await back();
    for (let i = 0; i < 20 && !isGroup(); i++) await sleep(100);
    if (!isGroup()) return { ok: false, why: '從名單跳過去後' + (phone ? '按一次返回' : '切回') + '沒回到群組（記錄層數不對）' };
    if (phone && document.querySelector('.m-offline-menu')) return { ok: false, why: '返回後名單又出現（名單那一筆沒退乾淨）' };
  }
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

export default {
  key: 'gjump',
  kind: '群組點成員跳一對一檢查',
  source: probe => gjumpProbeSource(probe),
}
