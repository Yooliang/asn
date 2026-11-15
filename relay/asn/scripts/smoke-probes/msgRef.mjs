// 冒煙探測「訊息裡的編號可以點檢查」（probe.msgRef，#1530）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 群組裡有一則「請看 #3880 和 #1512；回 #3850 說的。`#3881` 不動，https://example.com/#3882 也不動」，畫面上已載入第 3871～3920 則：
//   #3880＝範圍內→群組；#1512＝範圍外→GitHub；#3850＝範圍外但寫成「回 #3850」→群組；程式碼與網址裡的不處理。
// 用真的點擊：點 #1512 開 https://github.com/Yooliang/asn/issues/1512（open_link）；點 #3880 跳到那一則並標亮；
// 點 #3850 先往前載入（since 3849）再跳過去標亮。手機另外長按 #1512：下方顯示「開啟 GitHub #1512」、不開網頁。
// 以上是設定「把 #編號 連到 ASN 的 GitHub 議題」打開（gh）的情境；關閉（預設）的情境：#1512 是普通文字，群組編號照樣可點。探測原始碼是字串，裡面不寫反斜線

export const REF_LAST = 3920
const msg = (seq, body, extra = {}) => ({ seq, from: 'x:r2bbbbbb', at: new Date(Date.UTC(2026, 10, 15, 0, 0, 0) + seq * 60_000).toISOString(), body, relation: 'other', from_kind: 'ai', from_name: '報表', ...extra })
export const REF_BODY = '請看 #3880 和 #1512；回 #3850 說的。`#3881` 不動，https://example.com/#3882 也不動'
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
export const REF_RECENT = [...range(REF_LAST - 49, REF_LAST - 1).map(s => msg(s, `第 ${s} 則`)), msg(REF_LAST, REF_BODY)]
export const REF_OLDER = range(3850, REF_LAST - 50).map(s => msg(s, `第 ${s} 則`))

export const msgRefProbeSource = ({ msgRef }) => `(async () => {
  try {
  const want = ${JSON.stringify(msgRef)};
  const phone = want.mode === 'phone';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (el, req) => { el.scrollIntoView({ block: 'center' }); await sleep(150); globalThis.__smokeInput(JSON.stringify(req || { click: at(el) })); await sleep(300) };
  const pane = () => [...document.querySelectorAll('.chatpane')].find(vis) || null;
  const wait = async (fn, n = 40) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const host = await wait(() => [...(pane()?.querySelectorAll('.m-body') || [])].find(b => vis(b) && b.textContent.includes('請看')), 80);
  if (!host) return { ok: false, why: '群組裡找不到那則訊息' };
  const refs = [...host.querySelectorAll('.msg-ref')];
  const got = refs.map(e => [e.textContent, e.getAttribute('data-ref'), e.getAttribute('title')]);
  const expect = want.gh ? [['#3880', 'group', '跳到群組第 3880 則'], ['#1512', 'github', '開啟 GitHub #1512'], ['#3850', 'group', '跳到群組第 3850 則']] : [['#3880', 'group', '跳到群組第 3880 則'], ['#3850', 'group', '跳到群組第 3850 則']];
  if (JSON.stringify(got) !== JSON.stringify(expect)) return { ok: false, why: '編號判斷或提示不對：' + JSON.stringify(got) };
  if (!want.gh && !host.textContent.includes('和 #1512；')) return { ok: false, why: '設定關閉時 #1512 應該維持普通文字' };
  if (host.querySelector('code .msg-ref, a .msg-ref')) return { ok: false, why: '程式碼或網址裡的 # 被包成編號' };
  for (const e of refs) {
    const cs = getComputedStyle(e);
    if (!/underline/.test(cs.textDecorationLine) || cs.cursor !== 'pointer') return { ok: false, why: '編號看起來不像可以點（底線／游標）：' + e.textContent };
    if (e.getAttribute('role') !== 'link' || e.getAttribute('tabindex') !== '0') return { ok: false, why: '編號沒有 role=link 或不能用鍵盤選到' };
  }
  const refEl = t => [...host.querySelectorAll('.msg-ref')].find(e => e.textContent === t);
  const calls = () => (globalThis.__smokeCalls || []);
  const opens = () => calls().filter(c => c[0] === 'open_link');
  const bar = () => [...document.querySelectorAll('.typing')].find(vis);
  // 手機：長按 #1512 只顯示提示，不開網頁
  if (phone && want.gh) {
    const n0 = opens().length;
    await real(refEl('#1512'), { hold: [...at(refEl('#1512')), 800] });
    const tip = await wait(() => (bar()?.textContent || '').includes('開啟 GitHub #1512'), 20);
    if (!tip) return { ok: false, why: '長按 #1512 沒有顯示提示：' + (bar()?.textContent || '（下方沒有提示列）') };
    await sleep(400);
    if (opens().length !== n0) return { ok: false, why: '長按 #1512 卻開了網頁' };
  }
  // 1. 點 #1512：用 open_link 開固定網址（設定關閉時：手機長按 #3880 照樣有提示）
  if (want.gh) {
    const n1 = opens().length;
    await real(refEl('#1512'));
    const o = await wait(() => opens().length > n1 ? opens()[opens().length - 1] : null, 20);
    if (!o) return { ok: false, why: '點 #1512 沒有呼叫 open_link' };
    if (o[1]?.url !== 'https://github.com/Yooliang/asn/issues/1512') return { ok: false, why: '開的網址不對：' + o[1]?.url };
  } else if (phone) {
    await real(refEl('#3880'), { hold: [...at(refEl('#3880')), 800] });
    const tip = await wait(() => (bar()?.textContent || '').includes('跳到群組第 3880 則'), 20);
    if (!tip) return { ok: false, why: '長按 #3880 沒有顯示提示' };
    await sleep(3200);
  }
  const n1 = opens().length;
  const msgOf = s => [...(pane()?.querySelectorAll('.msg') || [])].find(m => (m.querySelector('.m-body')?.textContent || '').trim() === '第 ' + s + ' 則');
  const box = () => pane()?.querySelector('.msgs');
  const inView = el => { const a = el.getBoundingClientRect(), b = box().getBoundingClientRect(); return a.top >= b.top - 2 && a.bottom <= b.bottom + 2 };
  const jumped = async s => {
    const el = await wait(() => { const m = msgOf(s); return m && m.classList.contains('flash') ? m : null }, 30);
    if (!el) return '第 ' + s + ' 則沒有標亮';
    await sleep(900);
    return inView(msgOf(s)) ? '' : '第 ' + s + ' 則不在畫面上';
  };
  // 2. 點 #3880：已載入，跳過去標亮，不再讀後台
  const r0 = calls().filter(c => /room_read$/.test(c[0])).length;
  await real(refEl('#3880'));
  let why = await jumped(3880);
  if (why) return { ok: false, why: '點 #3880：' + why };
  if (opens().length !== n1) return { ok: false, why: '點群組編號卻開了網頁' };
  // 3. 點「回 #3850」：還沒載入，往前載入後跳過去
  if (msgOf(3850)) return { ok: false, why: '第 3850 則一開始就載入了（測試資料不對）' };
  await real(refEl('#3850'));
  const back = await wait(() => calls().slice(r0).find(c => /room_read$/.test(c[0]) && c[1]?.since === 3849 && c[1]?.mark === false), 30);
  if (!back) return { ok: false, why: '點 #3850 沒有從第 3849 則之後往前補載（或標了已讀）' };
  why = await jumped(3850);
  if (why) return { ok: false, why: '點 #3850：' + why };
  if (!msgOf(3870) || !msgOf(3871)) return { ok: false, why: '補載的跟原本的沒有接上' };
  if (document.documentElement.scrollWidth > window.innerWidth + 1) return { ok: false, why: '整頁橫向溢出' };
  // 截圖前等畫面停下來（#1576）：標亮動畫 1.4 秒、平滑捲動都跑完，第 3850 則的位置連續 3 次量到一樣；不然截圖每次拍到淡出、捲動的不同階段
  if (!(await wait(() => !document.querySelector('.msg.flash'), 30))) return { ok: false, why: '標亮一直沒有結束' };
  let lastTop = null, same = 0;
  for (let i = 0; i < 40 && same < 3; i++) { await sleep(100); const top = msgOf(3850)?.getBoundingClientRect().top; same = top === lastTop ? same + 1 : 0; lastTop = top }
  if (same < 3) return { ok: false, why: '跳到第 3850 則之後畫面一直在捲' };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

// gh＝設定「把 #編號 連到 ASN 的 GitHub 議題」打開（存檔：電腦 me.ghRefs、手機 me.mobilePrefs.ghRefs）
const desk = (name, skin, gh = true) => ({ name, page: 'list.html', width: 900, height: 640, state: { signedIn: true, groupTab: true, msgRef: gh ? 'gh' : 'off', ...(skin ? { skin } : {}) }, ready: '#app.win .actionbar', probe: { msgRef: { mode: 'desk', gh } }, shot: `${name}.png` })
const phone = (name, skin, gh = true) => ({ name, page: 'm.html', state: { signedIn: true, mgroup: true, msgRef: gh ? 'gh' : 'off', ...(skin ? { skin } : {}) }, ready: '#app.m .m-chat .chatpane', probe: { msgRef: { mode: 'phone', gh } }, shot: `${name}.png` })

export default {
  key: 'msgRef',
  kind: '訊息裡的編號可以點檢查',
  source: probe => msgRefProbeSource(probe),
  scenarios: [
    desk('list-msg-ref'), desk('list-msg-ref-modern', 'modern'), desk('list-msg-ref-line', 'line'),
    phone('m-msg-ref'), phone('m-msg-ref-modern', 'modern'), phone('m-msg-ref-line', 'line'),
    desk('list-msg-ref-off', '', false), phone('m-msg-ref-off', '', false),
  ],
  // 群組最新是第 3920 則；第一次讀（since 3870）回最近 50 則；往前補載（since 3849）回第 3850～3870 則；其他（輪詢）回空
  table: (scenario, t) => {
    if (!scenario.state?.msgRef) return undefined
    const room = { id: 'g1', name: '測試群', members: [{ member: 'P~測試機', name: '測試機' }], mine: [{ member: 'P~測試機', unread: 0 }], last_seq: REF_LAST, created_at: '2026-10-29T00:00:00Z' }
    const read = { by: 'since', values: { [REF_LAST - 50]: { messages: REF_RECENT, last_seq: REF_LAST }, 3849: { messages: REF_OLDER, last_seq: REF_LAST } }, fallback: { messages: [], last_seq: REF_LAST } }
    const gh = scenario.state.msgRef === 'gh'
    const me = JSON.parse(t?.store_load?.values?.me ?? '{}')
    const store = { ...t.store_load, values: { ...t.store_load.values, me: JSON.stringify({ ...me, ghRefs: gh, mobilePrefs: { ...(me.mobilePrefs ?? {}), ghRefs: gh } }) } }
    return { relay_rooms: { rooms: [room] }, relay_room_read: read, android_room_read: read, open_link: null, store_load: store }   // open_link：點 GitHub 編號時呼叫，參數記在 __smokeCalls
  },
}
