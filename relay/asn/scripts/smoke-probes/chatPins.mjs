// 冒煙探測「對話名單釘選檢查」（probe.chatPins，#1479）。scripts/smoke-probes/ 底下的檔案由 smoke-registry.mjs 自動收集（#1540）
// 用真輸入（__smokeInput）：
//   - 手機（phone）：手指長按名單列 → 跳出選單（最上面是名稱、第一項「釘選」）→ 真點「釘選」→ 夥伴頁最上面多一組「釘選」、頭像有藍色圖釘徽章 → 再長按、「取消釘選」→ 回原狀；
//     長按不能順便點進那一則對話；群組列也能長按釘選
//   - 電腦（desk）：在「對話」分頁對最後一列按右鍵 → 選單最上面是名稱、第一項「釘選」→ 釘了之後它排到最上面、有徽章 → 再按右鍵「取消釘選」→ 順序回原狀；
//     群組列原本沒有右鍵選單：現在有名稱、釘選、邀請別人加入、加我的另一個 AI、成員與設定
// 三種外觀（復古 Aero、現代、第三種 line 外觀）各跑一次。舊程式（沒有釘選）一定紅：長按／右鍵不會出選單。

const COMMON = `
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
  const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
  const real = async (req, ms) => { globalThis.__smokeInput(JSON.stringify(req)); await sleep(ms || 500) };
  const waitFor = async (fn, n = 60) => { for (let i = 0; i < n; i++) { const v = fn(); if (v) return v; await sleep(100) } return null };
  const txt = e => (e?.textContent || '').replace(/\\s+/g, ' ').trim();
`

export const chatPinsPhoneSource = () => `(async () => {
  try {
  ${COMMON}
  const page = () => document.querySelector('section.m-pg[aria-label="夥伴"]');
  const nameOf = b => txt(b.querySelector('.b-nick'));
  const unreadBtns = () => [...(page()?.querySelectorAll('.m-unread li .m-buddy') || [])].filter(vis);
  const pinnedGroup = () => page()?.querySelector('.m-pinned');
  const pinnedNames = () => [...(pinnedGroup()?.querySelectorAll('li .m-buddy') || [])].map(nameOf);
  const dots = () => [...(page()?.querySelectorAll('.pin-dot') || [])].filter(vis);
  if (!(await waitFor(() => unreadBtns().length >= 2))) return { ok: false, why: '夥伴頁沒有列出兩個有未讀的夥伴' };
  if (pinnedGroup()) return { ok: false, why: '還沒釘任何對話，不該有「釘選」那一組' };
  const sheetItems = () => [...document.querySelectorAll('.m-ops .m-ops-panel .m-ops-item')].filter(vis);
  const openByHold = async el => {
    el.scrollIntoView({ block: 'center' }); await sleep(150);
    const [x, y] = at(el);
    await real({ hold: [x, y, 650] }, 1400);   // 放開手指時，這個環境會補一個 click 落在剛長出來的選單上：選單不能因此收起、也不能因此按到某一項
    return await waitFor(() => document.querySelector('.m-ops .m-ops-panel'));
  };
  const clickItem = async label => {
    const b = sheetItems().find(i => txt(i.querySelector('.m-opt-t')) === label);
    if (!b) return false;
    await real({ click: at(b) }, 700);
    return true;
  };
  const tabOn = () => txt(document.querySelector('.m-tabs button.on span'));
  // 1. 長按 demo（未讀那一組的最後一列）
  const target = unreadBtns().find(b => nameOf(b) === 'demo');
  if (!target) return { ok: false, why: '未讀那一組找不到 demo' };
  const panel = await openByHold(target);
  if (!panel) return { ok: false, why: '長按名單列沒有跳出選單' };
  if (!/demo/.test(txt(panel.querySelector('.m-ops-h')))) return { ok: false, why: '選單最上面不是對話名稱：' + txt(panel.querySelector('.m-ops-h')) };
  const first = sheetItems()[0];
  if (!first || txt(first.querySelector('.m-opt-t')) !== '釘選') return { ok: false, why: '選單第一項要是「釘選」：' + txt(first) };
  if (tabOn() !== '夥伴') return { ok: false, why: '長按不該點進那一則對話，現在在：' + tabOn() };
  if (!(await clickItem('釘選'))) return { ok: false, why: '找不到「釘選」可以按' };
  if (!(await waitFor(() => !document.querySelector('.m-ops .m-ops-panel') && pinnedGroup()))) return { ok: false, why: '按了「釘選」，夥伴頁最上面沒有出現「釘選」那一組' };
  if (page().querySelector('.m-group') !== pinnedGroup()) return { ok: false, why: '「釘選」那一組要在夥伴頁最上面' };
  if (JSON.stringify(pinnedNames()) !== JSON.stringify(['demo'])) return { ok: false, why: '「釘選」那一組的內容不對：' + JSON.stringify(pinnedNames()) };
  const pinnedAv = pinnedGroup().querySelector('li .m-buddy .pin-dot');
  if (!pinnedAv) return { ok: false, why: '釘選的那一列頭像沒有藍色圖釘徽章' };
  const col = getComputedStyle(pinnedAv).backgroundColor;
  if (col !== 'rgb(47, 127, 224)') return { ok: false, why: '徽章不是藍色：' + col };
  const r = pinnedAv.getBoundingClientRect(), av = pinnedAv.parentElement.getBoundingClientRect();
  if (!(r.left + r.width / 2 > av.left + av.width * 0.55 && r.top + r.height / 2 > av.top + av.height * 0.55) && !(pinnedAv.matches('.avb-v ~ .pin-dot') && r.top + r.height / 2 > av.top + av.height * 0.55)) return { ok: false, why: '徽章沒有在頭像的下方' };
  if (dots().length < 2) return { ok: false, why: '未讀那一組裡的 demo 也要有徽章（共兩個），實際 ' + dots().length };
  if (unreadBtns().some(b => nameOf(b) === '小工' && b.querySelector('.pin-dot'))) return { ok: false, why: '沒釘的小工不該有徽章' };
  // 2. 再長按（在「釘選」那一組）→ 取消釘選
  const again = pinnedGroup().querySelector('li .m-buddy');
  const panel2 = await openByHold(again);
  if (!panel2) return { ok: false, why: '長按釘選的那一列沒有跳出選單' };
  const first2 = sheetItems()[0];
  if (!first2 || txt(first2.querySelector('.m-opt-t')) !== '取消釘選') return { ok: false, why: '已釘選的選單第一項要是「取消釘選」：' + txt(first2) };
  if (!(await clickItem('取消釘選'))) return { ok: false, why: '找不到「取消釘選」可以按' };
  if (!(await waitFor(() => !document.querySelector('.m-ops .m-ops-panel') && !pinnedGroup()))) return { ok: false, why: '取消釘選後，「釘選」那一組還在' };
  if (dots().length) return { ok: false, why: '取消釘選後還有徽章' };
  // 3. 群組列也能長按釘選
  const roomBtn = await waitFor(() => [...(page()?.querySelectorAll('.m-rooms li .m-buddy') || [])].filter(vis)[0]);
  if (!roomBtn) return { ok: false, why: '夥伴頁沒有群組列' };
  const panel3 = await openByHold(roomBtn);
  if (!panel3) return { ok: false, why: '長按群組列沒有跳出選單' };
  const labels = sheetItems().map(i => txt(i.querySelector('.m-opt-t')));
  const want = ['釘選', '邀請別人加入', '加我的另一個 AI', '成員與設定'];
  if (JSON.stringify(labels) !== JSON.stringify(want)) return { ok: false, why: '群組列選單不對，要是 ' + want.join('／') + '，實際 ' + labels.join('／') };
  if (!(await clickItem('釘選'))) return { ok: false, why: '群組列找不到「釘選」' };
  if (!(await waitFor(() => pinnedGroup() && pinnedNames().includes('測試群')))) return { ok: false, why: '釘了群組，「釘選」那一組沒有它：' + JSON.stringify(pinnedNames()) };
  if (!pinnedGroup().querySelector('.pin-dot')) return { ok: false, why: '釘選的群組沒有徽章' };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

export const chatPinsDeskSource = () => `(async () => {
  try {
  ${COMMON}
  const tab = await waitFor(() => [...document.querySelectorAll('.top-tabs .ttab')].find(t => txt(t).startsWith('對話')));
  if (!tab) return { ok: false, why: '找不到「對話」分頁' };
  await real({ click: at(tab) }, 600);
  const rows = () => [...document.querySelectorAll('.chat-list ul > li')].filter(vis);
  const nameOf = li => txt(li.querySelector('.b-nick'));
  if (!(await waitFor(() => rows().length >= 3))) return { ok: false, why: '對話分頁要有兩位夥伴加一個群組，實際 ' + rows().length + ' 列' };
  const order0 = rows().map(nameOf);
  if (rows().some(li => li.querySelector('.pin-dot'))) return { ok: false, why: '還沒釘任何對話，不該有徽章' };
  const menu = () => [...document.querySelectorAll('.buddy-menu')].filter(vis).find(m => !m.classList.contains('buddy-subpop'));
  const menuLabels = m => [...m.querySelectorAll('li')].filter(vis).map(li => txt(li));
  const rightClick = async li => { li.scrollIntoView({ block: 'center' }); await sleep(150); const [x, y] = at(li.querySelector('button')); await real({ rightClick: [x, y] }, 600); return await waitFor(() => menu()) };
  const clickMenu = async (m, label) => { const b = [...m.querySelectorAll('button')].find(x => vis(x) && txt(x.querySelector('.mi-t') || x) === label); if (!b) return false; await real({ click: at(b) }, 700); return true };
  // 1. 一對一：對最後一位夥伴按右鍵
  const friendRows = rows().filter(li => !li.classList.contains('room-item'));
  const last = friendRows[friendRows.length - 1];
  const lastName = nameOf(last);
  const m = await rightClick(last);
  if (!m) return { ok: false, why: '對話列按右鍵沒有跳出選單' };
  const labels = menuLabels(m);
  if (!labels[0].includes(lastName)) return { ok: false, why: '選單最上面要是對話名稱 ' + lastName + '，實際：' + labels[0] };
  if (labels[1] !== '釘選') return { ok: false, why: '選單第二項要是「釘選」：' + labels.join('／') };
  if (!(await clickMenu(m, '釘選'))) return { ok: false, why: '找不到「釘選」可以按' };
  await sleep(500);
  const after = rows();
  if (nameOf(after[0]) !== lastName) return { ok: false, why: '釘選後它要排到最上面，實際第一列是 ' + nameOf(after[0]) + '（順序：' + after.map(nameOf).join('、') + '）' };
  const dot = after[0].querySelector('.pin-dot');
  if (!dot) return { ok: false, why: '釘選的那一列頭像沒有圖釘徽章' };
  if (getComputedStyle(dot).backgroundColor !== 'rgb(47, 127, 224)') return { ok: false, why: '徽章不是藍色' };
  if (after.slice(1).some(li => li.querySelector('.pin-dot'))) return { ok: false, why: '沒釘的列不該有徽章' };
  if (JSON.stringify(after.slice(1).map(nameOf)) !== JSON.stringify(order0.filter(n => n !== lastName))) return { ok: false, why: '其餘的列要維持原本順序' };
  // 2. 取消釘選
  const m2 = await rightClick(after[0]);
  if (!m2) return { ok: false, why: '釘選的列按右鍵沒有跳出選單' };
  if (menuLabels(m2)[1] !== '取消釘選') return { ok: false, why: '已釘選的選單第二項要是「取消釘選」：' + menuLabels(m2).join('／') };
  if (!(await clickMenu(m2, '取消釘選'))) return { ok: false, why: '找不到「取消釘選」可以按' };
  await sleep(500);
  if (JSON.stringify(rows().map(nameOf)) !== JSON.stringify(order0)) return { ok: false, why: '取消釘選後順序要回原狀：' + rows().map(nameOf).join('、') };
  if (rows().some(li => li.querySelector('.pin-dot'))) return { ok: false, why: '取消釘選後還有徽章' };
  // 2b. 最近沒往來的夥伴：在「夥伴」分頁按右鍵釘選，「對話」分頁照樣把它排在最上面（不受近期往來限制）
  const topTab = n => [...document.querySelectorAll('.top-tabs .ttab')].find(t => txt(t).startsWith(n));
  await real({ click: at(topTab('夥伴')) }, 700);
  if (rows().some(li => nameOf(li) === '閒置')) return { ok: false, why: '閒置的夥伴不該出現在對話分頁（沒有近期往來）' };
  const devTab = [...document.querySelectorAll('button.rtab.dev')].filter(vis).find(e => txt(e).startsWith('辦'));
  if (devTab) await real({ click: at(devTab) }, 700);   // 夥伴在「辦公室」那台的分頁
  const idle = await waitFor(() => [...document.querySelectorAll('.list li')].filter(vis).find(li => txt(li.querySelector('.b-nick')) === '閒置'));
  if (!idle) return { ok: false, why: '夥伴分頁找不到「閒置」這位夥伴' };
  const im = await rightClick(idle);
  if (!im) return { ok: false, why: '夥伴分頁按右鍵沒有跳出選單' };
  if (!(await clickMenu(im, '釘選'))) return { ok: false, why: '夥伴分頁的右鍵選單找不到「釘選」' };
  await sleep(400);
  await real({ click: at(topTab('對話')) }, 700);
  const r1 = rows();
  if (nameOf(r1[0]) !== '閒置') return { ok: false, why: '釘選的夥伴沒有往來，也要排在對話分頁最上面，實際第一列是 ' + nameOf(r1[0]) + '（順序：' + r1.map(nameOf).join('、') + '）' };
  if (!r1[0].querySelector('.pin-dot')) return { ok: false, why: '沒有往來的釘選夥伴那一列沒有徽章' };
  const im2 = await rightClick(r1[0]);
  if (!im2 || menuLabels(im2)[1] !== '取消釘選') return { ok: false, why: '這一列的右鍵選單要有「取消釘選」' };
  if (!(await clickMenu(im2, '取消釘選'))) return { ok: false, why: '找不到「取消釘選」可以按' };
  await sleep(500);
  if (rows().some(li => nameOf(li) === '閒置')) return { ok: false, why: '取消釘選後，沒有往來的夥伴要從對話分頁消失' };
  // 3. 群組列：原本沒有右鍵選單
  const room = rows().find(li => li.classList.contains('room-item'));
  if (!room) return { ok: false, why: '對話分頁沒有群組列' };
  const rm = await rightClick(room);
  if (!rm) return { ok: false, why: '群組列按右鍵沒有跳出選單' };
  const rl = menuLabels(rm);
  const want = ['釘選', '邀請別人加入', '加我的另一個 AI', '成員與設定'];
  if (!rl[0].includes('測試群') || JSON.stringify(rl.slice(1)) !== JSON.stringify(want)) return { ok: false, why: '群組列選單不對，要是 測試群／' + want.join('／') + '，實際 ' + rl.join('／') };
  if (!(await clickMenu(rm, '釘選'))) return { ok: false, why: '群組列找不到「釘選」' };
  await sleep(500);
  const r2 = rows();
  if (!r2[0].classList.contains('room-item') || !r2[0].querySelector('.pin-dot')) return { ok: false, why: '釘了群組，它要排到最上面並有徽章' };
  return { ok: true, why: '' };
  } catch (e) { return { ok: false, why: '檢查出錯：' + (e && e.message || e) } }
})()`

// 假後台：一個群組（照群組情境的格式）；夥伴與未讀沿用 munread 情境（兩位夥伴、demo 兩則未讀、小工一則）
const ROOM = { id: 'g1', name: '測試群', members: [{ member: 'P~測試機', name: '測試機' }], mine: [{ member: 'P~測試機', unread: 0 }], last_seq: 0, created_at: '2026-10-29T00:00:00Z' }

const phone = (name, skin) => ({ name, page: 'm.html', state: { signedIn: true, munread: true, mtab: 'list', chatPins: true, ...(skin ? { skin } : {}) }, ready: '#app.m .m-unread', probe: { chatPins: 'phone' }, shot: `${name}.png` })
const desk = (name, skin) => ({ name, page: 'list.html', width: 900, height: 640, state: { signedIn: true, munread: true, chatPins: true, ...(skin ? { skin } : {}) }, ready: '#app.win .top-tabs .ttab', probe: { chatPins: 'desk' }, shot: `${name}.png` })

export default {
  key: 'chatPins',
  kind: '對話名單釘選檢查',
  source: probe => (probe.chatPins === 'phone' ? chatPinsPhoneSource() : chatPinsDeskSource()),
  scenarios: [
    phone('m-chat-pins'), phone('m-chat-pins-modern', 'modern'), phone('m-chat-pins-line', 'line'),
    desk('list-chat-pins'), desk('list-chat-pins-modern', 'modern'), desk('list-chat-pins-line', 'line'),
  ],
  table: scenario => (scenario.state?.chatPins
    ? { ...(scenario.page === 'list.html' ? { relay_list: { members: [{ id: 'Q', name: '辦公室', agents: [{ name: 'demo', status: 'idle', cwd_label: 'demo' }, { name: '小工', status: 'idle', cwd_label: 'work' }, { name: '閒置', status: 'idle', cwd_label: 'idle' }] }] } } : {}), relay_rooms: { rooms: [ROOM] }, relay_room_read: { messages: [] }, android_room_read: { messages: [] }, relay_group: { by: 'action', values: { group_confirm_list: { confirms: [] } }, fallback: null } }
    : undefined),
}
