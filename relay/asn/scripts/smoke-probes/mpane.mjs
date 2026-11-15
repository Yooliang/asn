// 冒煙探測「整合模式窄視窗檢查」（probe.mpane）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
import { CHAT_PANE_MIN_W, SIDE_OPEN_W } from '../../ui/lib/merge.mjs'

export const MPANE_CHAT_MIN = CHAT_PANE_MIN_W   // 跟斷點用同一個常數（200）

export const mpaneProbeSource = ({ single }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const shown = e => { if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0 };
  const W = window.innerWidth, wantSingle = ${single ? 'true' : 'false'};
  const list = document.querySelector('.shell > .list-pane'), chat = document.querySelector('.shell > .chat-area');
  if (!list || !chat) return { ok: false, why: '找不到名單或對話窗格' };
  const noScroll = () => document.documentElement.scrollWidth <= W + 1 && document.body.scrollWidth <= W + 1;
  if (!noScroll()) return { ok: false, why: '寬 ' + W + ' 出現橫向捲動：' + document.documentElement.scrollWidth };
  const both = shown(list) && shown(chat);
  if (wantSingle && both) return { ok: false, why: '寬 ' + W + ' 應該一次只顯示一個窗格，但名單 ' + Math.round(list.getBoundingClientRect().width) + 'px、右邊 ' + Math.round(chat.getBoundingClientRect().width) + 'px 同時顯示' };
  if (!wantSingle && !both) return { ok: false, why: '寬 ' + W + ' 應該左右並排，但只顯示一個窗格' };
  if (!shown(chat)) return { ok: false, why: '開著設定時右窗格沒顯示' };
  const cw = chat.getBoundingClientRect().width;
  if (cw < ${MPANE_CHAT_MIN}) return { ok: false, why: '右窗格只有 ' + Math.round(cw) + 'px（至少 ${MPANE_CHAT_MIN}）' };
  const h = document.querySelector('.panel-pane .panel-h');
  if (!h) return { ok: false, why: '找不到設定標題' };
  const lh = parseFloat(getComputedStyle(h).lineHeight) || parseFloat(getComputedStyle(h).fontSize) * 1.3;
  if (h.getBoundingClientRect().height > lh * 2 + 2) return { ok: false, why: '設定標題高 ' + Math.round(h.getBoundingClientRect().height) + 'px，被擠成直排' };
  const card = document.querySelector('.panel-pane .dv-acct');
  if (!card || !shown(card) || card.getBoundingClientRect().width < 120) return { ok: false, why: '帳號卡看不到或太窄：' + (card ? Math.round(card.getBoundingClientRect().width) : '不存在') };
  if (wantSingle) {
    const back = chat.querySelector('button[aria-label="返回名單"]');
    if (!back || !shown(back)) return { ok: false, why: '單窗格顯示右邊時沒有「返回名單」按鈕' };
    if (back.disabled) return { ok: false, why: '返回名單按鈕不能按' };
    back.click(); await sleep(400);
    if (!shown(list) || shown(chat)) return { ok: false, why: '按返回名單後應只剩名單' };
    if (list.getBoundingClientRect().right > W + 1 || !noScroll()) return { ok: false, why: '名單單獨顯示時超出視窗寬 ' + W };
    // 從名單再開一次設定的帳號：應切回右窗格、看得到帳號卡
    const gear = [...list.querySelectorAll('.top-tabs .ttab')].find(e => e.getAttribute('aria-label') === '設定');   // 0.2.18：齒輪拿掉，改成上方的「設定」分頁
    if (!gear) return { ok: false, why: '名單找不到設定分頁' };
    gear.click(); await sleep(300);
    const acct = [...list.querySelectorAll('.cat-list .buddy')].find(e => e.textContent.includes('帳號'));
    if (!acct) return { ok: false, why: '設定清單找不到帳號' };
    acct.click(); await sleep(500);
    if (!shown(chat) || shown(list) || !shown(chat.querySelector('.dv-acct'))) return { ok: false, why: '從名單開帳號後應只顯示右窗格與帳號卡' };
  }
  return { ok: true, why: '' };
})()`

export const MPANE_CONV_MIN = 160

export const mpaneChatProbeSource = ({ single, folded }) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const shown = e => { if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0 };
  const W = window.innerWidth, wantSingle = ${single ? 'true' : 'false'};
  const R = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), w: Math.round(r.width), r: Math.round(r.right) } };
  const q = s => document.querySelector(s);
  let box = null;
  for (let i = 0; i < 40 && !(box = q('.chat-area .compose-main textarea')); i++) await sleep(100);
  await sleep(300);
  const list = q('.shell > .list-pane'), chat = q('.shell > .chat-area');
  const m = { W, list: R(list), chat: R(chat), side: R(q('.chat-area .dp-side')), main: R(q('.chat-area .chatpane-main')), conv: R(q('.chat-area .conv-main')), compose: R(q('.chat-area .compose-main')), ta: R(box), send: R(q('.chat-area .composer .aero-btn')), doc: document.documentElement.scrollWidth };
  if (${JSON.stringify(process.env.ASN_MEASURE || '')}) return { ok: false, why: 'MEASURE ' + JSON.stringify(m) };
  if (!list || !chat) return { ok: false, why: '找不到名單或對話窗格' };
  if (!box) return { ok: false, why: '右邊沒有輸入框：' + JSON.stringify(m) };
  const both = shown(list) && shown(chat);
  if (wantSingle && both) return { ok: false, why: '寬 ' + W + ' 應該一次只顯示一個窗格：' + JSON.stringify(m) };
  if (!wantSingle && !both) return { ok: false, why: '寬 ' + W + ' 應該左右並排：' + JSON.stringify(m) };
  if (document.documentElement.scrollWidth > W + 1 || document.body.scrollWidth > W + 1) return { ok: false, why: '寬 ' + W + ' 出現橫向捲動：' + JSON.stringify(m) };
  const send = q('.chat-area .composer .aero-btn');
  const cr = chat.getBoundingClientRect();
  for (const [name, e] of [['輸入框', box], ['傳送鈕', send]]) {
    if (!shown(e)) return { ok: false, why: name + '看不到：' + JSON.stringify(m) };
    const r = e.getBoundingClientRect();
    if (r.left < cr.left - 1 || r.right > cr.right + 1 || r.right > W + 1) return { ok: false, why: name + '被截掉（超出右窗格 ' + Math.round(cr.left) + '~' + Math.round(cr.right) + '）：' + JSON.stringify(m) };
  }
  if (box.getBoundingClientRect().width < 60) return { ok: false, why: '輸入框只剩 ' + Math.round(box.getBoundingClientRect().width) + 'px：' + JSON.stringify(m) };
  // 大頭貼欄被自動收起（右窗格放不下展開的欄）時展開鈕反灰並寫原因；放得下時照舊可按
  const strip = q('.chat-area .dp-fold-strip'), foldBtn = strip || q('.chat-area .dp-fold-bar');
  if (!foldBtn) return { ok: false, why: '找不到大頭貼欄的收合鈕' };
  if (${folded ? 'true' : 'false'}) {
    if (!strip) return { ok: false, why: '寬 ' + W + ' 大頭貼欄應該被自動收起' };
    if (!strip.disabled) return { ok: false, why: '自動收起時展開鈕應該反灰' };
    const cs = getComputedStyle(strip);
    if (!(parseFloat(cs.opacity) < 1) || cs.cursor === 'pointer') return { ok: false, why: '自動收起時展開鈕要看得出反灰：opacity ' + cs.opacity + '、cursor ' + cs.cursor };
    strip.click(); await sleep(300);   // 反灰的鈕按了不能改設定（放寬後的 widen 探測會確認欄恢復展開）
    if (!q('.chat-area .dp-fold-strip')) return { ok: false, why: '點反灰的展開鈕後欄不該展開' };
    if (strip.title !== '視窗太窄，放寬就會恢復' || strip.getAttribute('aria-label') !== '視窗太窄，放寬就會恢復') return { ok: false, why: '展開鈕提示不對：' + strip.title + ' / ' + strip.getAttribute('aria-label') };
  } else {
    if (strip) return { ok: false, why: '寬 ' + W + ' 大頭貼欄不該被收起' };
    const cs = getComputedStyle(foldBtn);
    if (cs.opacity !== '1' || cs.cursor !== 'pointer') return { ok: false, why: '可按的收合鈕 opacity 要 1、cursor 要 pointer：' + cs.opacity + ' / ' + cs.cursor };
    if (foldBtn.disabled || foldBtn.title.includes('視窗太窄')) return { ok: false, why: '放得下時收合鈕應該可按、沒有「視窗太窄」提示：' + foldBtn.title };
  }
  const conv = q('.chat-area .conv-main');
  if (!conv || conv.getBoundingClientRect().width < ${MPANE_CONV_MIN}) return { ok: false, why: '對話區只有 ' + (conv ? Math.round(conv.getBoundingClientRect().width) : 0) + 'px（至少 ${MPANE_CONV_MIN}）：' + JSON.stringify(m) };
  return { ok: true, why: '' };
})()`

// 放寬視窗後（smoke-ui 把寬度改成 sc.widen 再跑這個）：自動收起沒有寫進設定，所以大頭貼欄要恢復展開、收合鈕可按
export const mpaneWidenProbeSource = () => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await sleep(500);
  const side = document.querySelector('.chat-area .dp-side'), bar = document.querySelector('.chat-area .dp-fold-bar');
  if (!side) return { ok: false, why: '找不到大頭貼欄' };
  if (document.querySelector('.chat-area .dp-fold-strip')) return { ok: false, why: '放寬到 ' + window.innerWidth + ' 後大頭貼欄還是收起（自動收起不該寫進設定）' };
  if (Math.round(side.getBoundingClientRect().width) !== ${SIDE_OPEN_W}) return { ok: false, why: '大頭貼欄寬 ' + side.getBoundingClientRect().width + '，應該恢復展開的 ${SIDE_OPEN_W}' };
  if (!bar || bar.disabled) return { ok: false, why: '放寬後收合鈕應該可按' };
  return { ok: true, why: '' };
})()`

export default {
  key: 'mpane',
  kind: '整合模式窄視窗檢查',
  source: probe => probe.chat ? mpaneChatProbeSource(probe) : mpaneProbeSource(probe),
}
