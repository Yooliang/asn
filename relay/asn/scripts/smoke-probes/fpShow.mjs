// 冒煙探測「核對指紋時電腦自動跳出 QR Code」（probe.fpShow，#1863）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
//
// 電腦（panel.html?kind=fpshow）：標題、說明、QR Code 畫布、指紋、倒數、「取消核對」（按下去會叫 fp_show_cancel 帶那筆編號），三套外觀
// 手機（m.html）：設定 → 設備 → 工作機的「確認」→ 選「用相機掃電腦上的 QR Code」之後的畫面：
//   wait＝那台在線、後台一直回 pending：等待中（轉圈＋說明＋最多等 20 秒＋取消）
//   shown＝後台回 shown：「QR Code 出現了」＋「用相機掃」
//   noreply＝名單上那台的 ASN 不在線：不送請求，直接說沒有回應（重試、取消）
//   old＝那台的 ASN 版本太舊：不送請求，說要更新
const REQ_ID = '11111111-1111-4111-8111-111111111111'

// 假的 29×29 格子（三個定位方塊＋固定亂數），只拿來看畫面，不是真的能掃的碼
function fakeRows(n = 29) {
  const g = Array.from({ length: n }, () => Array(n).fill('0'))
  let s = 1863
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) g[y][x] = rnd() < 0.48 ? '1' : '0'
  for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    for (let i = -1; i < 8; i++) for (let j = -1; j < 8; j++) { const y = oy + i, x = ox + j; if (y >= 0 && y < n && x >= 0 && x < n) g[y][x] = '0' }
    for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) g[oy + i][ox + j] = (i === 0 || j === 0 || i === 6 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4)) ? '1' : '0'
  }
  return g.map(r => r.join(''))
}

// skin：這扇視窗是 Rust 新開的，外觀跟著名單視窗走（真機是同一個 localStorage 的 asnSkin，加上名單送的 asn:skin 事件）；
// 冒煙每個情境是獨立的分頁，這裡走 asn:skin 那條路把外觀交給它。click：按「取消核對」看有沒有帶編號送出（按下去會變灰，所以截圖的情境不按）
export const fpShowDeskSource = ({ skin = 'aero', click = false } = {}) => `(async () => {
  try {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  for (const fn of ((globalThis.__smokeListeners || {})['asn:skin'] || [])) fn({ event: 'asn:skin', payload: ${JSON.stringify(skin)} });
  await sleep(300);
  if (document.documentElement.getAttribute('data-skin') !== ${JSON.stringify(skin)}) return { ok: false, why: '外觀沒有換成 ' + ${JSON.stringify(skin)} };
  let box = null;
  for (let i = 0; i < 60 && !box; i++) { box = document.querySelector('.fps canvas.fp-qr'); if (!box) await sleep(100) }
  if (!vis(box)) return { ok: false, why: '沒有畫出 QR Code' };
  if (box.getBoundingClientRect().width < 180) return { ok: false, why: 'QR Code 太小：' + Math.round(box.getBoundingClientRect().width) };
  const t = s => (document.querySelector(s)?.textContent ?? '').trim();
  if (t('.fps-h') !== '你的手機正在核對這台電腦') return { ok: false, why: '標題不對：' + t('.fps-h') };
  if (t('.fps-body') !== '請用手機的相機，掃下面這個 QR Code。') return { ok: false, why: '說明不對：' + t('.fps-body') };
  if (!/^這台電腦的指紋　[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/.test(t('.fps-fp'))) return { ok: false, why: '指紋不對：' + t('.fps-fp') };
  if (!/^核對完成後，這個視窗會自己關起來（還剩 [0-5] 分 \\d{1,2} 秒）$/.test(t('.fps-left'))) return { ok: false, why: '倒數不對：' + t('.fps-left') };
  if ((document.querySelector('.titlebar .t-text')?.textContent ?? '').trim() !== '核對這台電腦') return { ok: false, why: '視窗標題不對' };
  const btn = document.querySelector('.fps-cancel');
  if (!vis(btn) || btn.textContent.trim() !== '取消核對') return { ok: false, why: '沒有「取消核對」' };
  const r = btn.getBoundingClientRect();
  if (r.bottom > innerHeight || r.right > innerWidth) return { ok: false, why: '「取消核對」超出視窗' };
  if (document.documentElement.scrollWidth > innerWidth + 1) return { ok: false, why: '有橫向捲動' };
  { const h = document.querySelector('.fps-h').getBoundingClientRect(), b = document.querySelector('.t-btns').getBoundingClientRect();
    if (h.top < b.bottom && b.left < h.right && h.bottom > b.top) return { ok: false, why: '標題被右上角的視窗鈕蓋到' } }
  if (btn.disabled) return { ok: false, why: '「取消核對」一開始就不能按' };
  if (!${JSON.stringify(click)}) return { ok: true, why: '' };
  globalThis.__smokeCalls = [];
  globalThis.__smokeInput(JSON.stringify({ click: at(btn) }));
  let sent = [];
  for (let i = 0; i < 30; i++) { sent = (globalThis.__smokeCalls || []).filter(c => c[0] === 'fp_show_cancel'); if (sent.length) break; await sleep(100) }
  if (sent.length !== 1 || sent[0][1]?.id !== ${JSON.stringify(REQ_ID)}) return { ok: false, why: '按「取消核對」沒有帶那筆編號送出：' + JSON.stringify(sent) };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const PHONE_EXPECT = {
  wait: { sel: '.m-fps-wait', texts: ['已通知那台電腦，請看電腦螢幕，會自動跳出一個 QR Code。', '等待中…（最多等 20 秒）'], buttons: ['取消'], sent: true },
  shown: { sel: '.m-fps-shown', texts: ['電腦上的 QR Code 出現了。請用相機掃它。'], buttons: ['用相機掃電腦上的 QR Code', '取消'], sent: true },
  noreply: { sel: '.m-fps-noreply', texts: ['那台電腦沒有回應。', '請先到那台電腦打開 ASN，再按「重試」。'], buttons: ['重試', '取消'], sent: false },
  old: { sel: '.m-fps-old', texts: ['那台電腦的 ASN 要更新'], buttons: ['知道了'], sent: false },
}

export const fpShowPhoneSource = mode => `(async () => {
  try {
  const E = ${JSON.stringify(PHONE_EXPECT)}[${JSON.stringify(mode)}];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const tap = async el => { el.scrollIntoView({ block: 'center' }); await sleep(150); globalThis.__smokeInput(JSON.stringify({ click: at(el) })); await sleep(400) };
  const find = async (pred, n = 60) => { for (let i = 0; i < n; i++) { const el = pred(); if (el) return el; await sleep(100) } return null };
  const setBtn = await find(() => [...document.querySelectorAll('.m-row-btn')].find(b => vis(b) && b.textContent.includes('設備')));
  if (!setBtn) return { ok: false, why: '找不到設定裡的「設備」' };
  await tap(setBtn);
  const row = await find(() => [...document.querySelectorAll('.m-dv-row')].filter(vis).find(r => (r.querySelector('.m-dv-rn b')?.textContent ?? '').trim() === '工作機'));
  if (!row) return { ok: false, why: '找不到「工作機」那一列' };
  await tap([...row.querySelectorAll('button')].find(b => b.textContent.trim() === '詳情'));
  const confirm = await find(() => [...document.querySelectorAll('.m-dv-fprow button')].find(b => vis(b) && b.textContent.trim() === '確認'));
  if (!confirm) return { ok: false, why: '詳情裡沒有「確認」' };
  await tap(confirm);
  const go = await find(() => [...document.querySelectorAll('.m-fps-go')].find(vis));
  if (!go) return { ok: false, why: '沒有出現選方法的浮層' };
  globalThis.__smokeCalls = [];
  await tap(go);
  const sheet = await find(() => [...document.querySelectorAll(E.sel)].find(vis), 80);
  if (!sheet) return { ok: false, why: '沒有換到 ' + E.sel + '，現在是：' + ([...document.querySelectorAll('.m-fps')].map(s => s.className).join(' ') || '沒有核對浮層') };
  await sleep(300);
  const text = sheet.textContent.replace(/\\s+/g, ' ');
  for (const t of E.texts) if (!text.includes(t)) return { ok: false, why: '少了文字：' + t + '｜實際：' + text.slice(0, 160) };
  if (!text.includes('確認「工作機」的指紋')) return { ok: false, why: '標題要寫是哪一台' };
  const labels = [...sheet.querySelectorAll('button')].filter(vis).map(b => b.textContent.trim());
  if (JSON.stringify(labels) !== JSON.stringify(E.buttons)) return { ok: false, why: '按鈕不對：' + JSON.stringify(labels) };
  for (const b of sheet.querySelectorAll('button')) { const r = b.getBoundingClientRect(); if (r.height < 44) return { ok: false, why: '按鈕太小：' + b.textContent.trim() }; if (r.right > innerWidth + 1) return { ok: false, why: '按鈕超出畫面：' + b.textContent.trim() } }
  const req = (globalThis.__smokeCalls || []).filter(c => c[0] === 'android_fp_show_request');
  if (E.sent && (req.length < 1 || req[0][1]?.node !== 'R')) return { ok: false, why: '在線的電腦要送請求（帶那台的節點）：' + JSON.stringify(req) };
  if (!E.sent && req.length) return { ok: false, why: '不在線或版本舊不該送請求' };
  if (${JSON.stringify(mode)} === 'wait' && !vis(sheet.querySelector('.m-fps-spin'))) return { ok: false, why: '等待中要有轉圈' };
  if (document.documentElement.scrollWidth > innerWidth + 1) return { ok: false, why: '有橫向捲動' };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

const asnRow = version => [{ window_name: 'asn', version, status: 'online', psm: '' }]
const PHONE_MEMBERS = mode => [
  { id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }] },
  { id: 'R', name: '工作機', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }], ...(mode === 'noreply' ? {} : { asn: asnRow(mode === 'old' ? '0.2.50' : '0.2.97') }) },
]

// until 給很遠的未來：視窗的倒數最多顯示 5 分鐘（panel.js 夾住），截圖每次一樣
const desk = (name, skin, click = false) => ({ name, page: `panel.html?kind=fpshow&id=${REQ_ID}&until=4102444800000`, width: 480, height: 560, state: { signedIn: true, fpShowDesk: true, ...(skin ? { skin } : {}) }, ready: '#app.win .fps', probe: { fpShow: 'desk', skin: skin ?? 'aero', click }, ...(click ? {} : { shot: `${name}.png` }) })
const phone = (name, mode, skin) => ({ name, page: 'm.html', reducedMotion: true, state: { signedIn: true, fpMark: 'phone', fpShowPhone: mode, ...(skin ? { skin } : {}) }, ready: '#app.m .m-row-btn', probe: { fpShow: mode }, shot: `${name}.png` })

export default {
  key: 'fpShow',
  kind: probe => (probe.fpShow === 'desk' ? '核對指紋時電腦跳出的 QR Code 視窗檢查' : '手機請電腦跳出 QR Code 的畫面檢查'),
  source: probe => (probe.fpShow === 'desk' ? fpShowDeskSource({ skin: probe.skin, click: probe.click === true }) : fpShowPhoneSource(probe.fpShow)),
  scenarios: [
    desk('panel-fpshow-aero'), desk('panel-fpshow-modern', 'modern'), desk('panel-fpshow-line', 'line'), desk('panel-fpshow-cancel', undefined, true),
    phone('m-fpshow-wait-aero', 'wait'), phone('m-fpshow-noreply-aero', 'noreply'), phone('m-fpshow-shown-aero', 'shown'), phone('m-fpshow-old-aero', 'old'),
    phone('m-fpshow-wait-modern', 'wait', 'modern'), phone('m-fpshow-noreply-modern', 'noreply', 'modern'),
    phone('m-fpshow-wait-line', 'wait', 'line'), phone('m-fpshow-shown-line', 'shown', 'line'),
  ],
  table: scenario => {
    if (scenario.state?.fpShowDesk) return { device_own_fingerprint_qr: { size: 29, rows: fakeRows(29) }, device_own_fingerprint: 'a3f907c251de8b40', fp_show_cancel: null }
    const mode = scenario.state?.fpShowPhone
    if (!mode) return undefined
    return {
      relay_list: { members: PHONE_MEMBERS(mode) },
      android_fp_show_request: { id: REQ_ID, expires_at: '2026-11-25T00:05:00Z' },
      android_fp_show_status: { id: REQ_ID, status: mode === 'shown' ? 'shown' : 'pending', detail: null, expires_at: '2026-11-25T00:05:00Z' },
      android_fp_show_end: { ok: true, status: 'ended' },
      android_acct_list: { accounts: [], reported_at: null, asn_online: mode !== 'noreply' },   // 詳情頁背景會讀那台的帳號；沒有這個指令畫面會多一行錯誤，干擾截圖
    }
  },
}
