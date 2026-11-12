// 手機的分頁切換與瀏覽記錄（系統返回鍵＝瀏覽器上一頁）：四個固定分頁「對話／夥伴／通知／設定」，內頁蓋在進來的那個分頁上（lib/mobile-fourth.mjs）。
// 規則：
//   - 對話分頁是底；切到其他分頁推一筆記錄，其他分頁之間互換不增加記錄，切回對話＝上一頁（回到離開時的樣子：清單或那一則對話）。
//   - 對話分頁裡點進一則對話推一筆（chat＝true），返回回清單；在那則對話上再點一次「對話」分頁也回清單。從別的分頁點夥伴／群組：先回對話分頁，再進那一則。
//   - 進內頁（設備與帳號、設定的某一項、使用指引、開新夥伴）：蓋在目前的分頁上，內頁的每一層各推一筆（指引單篇、設備細部、開新夥伴第 2 步各多一層）。
//   - 在內頁按返回：先退內頁自己的層，退到頭就收起內頁，回到底下那個分頁。
//   - 從內頁切到別的分頁：先把它那幾筆記錄退掉（之後的返回鍵照分頁的規則走），內頁與內容留著，開始計時；切回那一格再把那幾層推回去。3 分鐘沒回來就收起（回到那一格時看到的是分頁本身）。
// 不碰 DOM：history（pushState／replaceState／back／go）、nav（畫面用的導覽狀態）、st（st.fourth＝內頁）與時鐘都由呼叫端給，node 測試用假的。
import { HOME_TAB, TABS, chatNav, normalizeNav, pageHost, pageNav, tabNav } from './mobile.mjs'
import { PAGE_TAB, fourthExpired, fourthOnTab, normalizePage, openFourth, pageLayers } from './mobile-fourth.mjs'
import { mobileSettingTitle } from './mobile-settings.mjs'
import { GUIDE_ENTRY_LABEL, phoneGuide } from './mobile-guides.mjs'
import { acctPageTitle } from './mobile-acct.mjs'

// 內頁的標題（指引單篇用那一篇的標題；開新夥伴第 2 步叫「設定這位夥伴」）
export const LAUNCH_TITLE = { 1: '開新夥伴', 2: '設定這位夥伴' }
export function pageTitle(raw) {
  const p = normalizePage(raw)
  if (!p) return ''
  if (p.kind === 'acct') return acctPageTitle('devices')   // 預設；實際標題畫面上依分頁換（m.js 的 acctTitle）
  if (p.kind === 'launch') return LAUNCH_TITLE[p.step]
  if (p.kind === 'setting') return mobileSettingTitle(p.cat)
  return p.guide ? (phoneGuide(p.guide)?.guide.title ?? GUIDE_ENTRY_LABEL) : GUIDE_ENTRY_LABEL
}

export function createMobileNav({ history, nav, st, now = () => Date.now() }) {
  // 退掉記錄後要接著做的事（history.go／back 是非同步的，等 popstate 回來才做）：{ tab, chat } 切到某分頁（chat＝進那一則對話）、{ page } 換一個內頁、{ close, tab } 收起後切到某分頁
  let pending = null
  // 等導覽結束的人（whenSettled）：pending 清空、畫面切好之後才叫，例如要在那一則對話上再推「⋯」選單的記錄
  let waiters = []
  const settle = () => { if (pending) return; const w = waiters; waiters = []; for (const f of w) f() }
  const whenSettled = () => (pending ? new Promise(r => waiters.push(r)) : Promise.resolve())
  // 內頁實際在瀏覽記錄裡佔幾筆（取代那一層前要確認底下真有一層，否則取代會把唯一一層換掉，返回鍵就直接收起整頁）
  let layers = 0
  const setNav = n => {
    const prev = nav.tab
    const { page, ...rest } = n
    Object.assign(nav, { step: 0, chat: false }, rest)
    if (prev !== nav.tab) st.fourth = fourthOnTab(st.fourth, nav.tab, now())
  }
  const go = next => { history.pushState(next, ''); setNav(next) }
  // 內頁目前佔了幾筆記錄（只有正在看它時才有）
  const depth = () => (nav.tab === PAGE_TAB && st.fourth ? pageLayers(st.fourth.page).length : 0)
  // 現在這一頁的記錄（通話中按返回要原地補回去時用）
  const state = () => (nav.tab === PAGE_TAB ? pageNav(st.fourth?.page ?? null) : { tab: nav.tab, sheet: nav.sheet, chat: !!nav.chat })
  // 分頁之間切換（目前不在內頁上）；chat＝切到對話分頁並進那一則
  function switchTab(t, { chat = false } = {}) {
    if (t === HOME_TAB && nav.tab === HOME_TAB) {
      if (chat && !nav.chat) go(chatNav())
      else if (!chat && nav.chat && !nav.sheet) history.back()
      return
    }
    if (t === nav.tab) return
    if (nav.tab === HOME_TAB) go(tabNav(t))
    else if (t === HOME_TAB) { if (chat) pending = { tab: HOME_TAB, chat: true }; history.back() }
    else { const n = tabNav(t); history.replaceState(n, ''); setNav(n) }
  }
  // 切到內頁：把內頁的每一層推回記錄
  function showPage() {
    const ls = pageLayers(st.fourth?.page)
    if (!ls.length) return
    for (const p of ls) history.pushState(pageNav(p), '')
    layers = ls.length
    setNav({ tab: PAGE_TAB, sheet: '' })
  }
  const leavePage = then => { pending = then; history.go(-depth()) }
  // 點頁籤、左右滑：浮層（開新夥伴、⋯ 選單、要密碼…）開著時不動
  function goTab(t) {
    if (pending || nav.sheet || !TABS.includes(t)) return
    const host = pageHost(st.fourth)
    if (nav.tab === PAGE_TAB) { if (t !== host) leavePage({ tab: t }); return }
    if (t === host) { showPage(); return }   // 這一格底下還留著內頁：回到內頁
    if (t === nav.tab) { if (t === HOME_TAB && nav.chat) switchTab(HOME_TAB); return }   // 在一則對話上再點「對話」：回清單
    switchTab(t)
  }
  // 打開一則對話（點夥伴、群組、橫幅）：切到對話分頁並進那一則。回 false＝沒動（浮層開著）
  function openChat() {
    if (pending || nav.sheet) return false
    if (nav.tab === PAGE_TAB) leavePage({ tab: HOME_TAB, chat: true })
    else switchTab(HOME_TAB, { chat: true })
    return true
  }
  // 進一個內頁：蓋在目前的分頁上（計時歸零）。回 false＝沒打開（浮層開著、描述不合法）
  function openPage(raw) {
    const p = normalizePage(raw)
    if (!p || pending || nav.sheet) return false
    if (nav.tab === PAGE_TAB) { leavePage({ page: p }); return true }
    st.fourth = openFourth(p, nav.tab)
    showPage()
    return true
  }
  // 內頁往裡走一層（指引篇目→單篇、設備列表→細部）；replace＝取代目前這層（例如細部那台不見了又點另一台）
  function pushLayer(raw, { replace = false } = {}) {
    const p = normalizePage(raw)
    if (!p || nav.tab !== PAGE_TAB || !st.fourth) return
    if (replace && layers > 1) history.replaceState(pageNav(p), '')
    else { history.pushState(pageNav(p), ''); layers++ }
    st.fourth = { ...st.fourth, page: p }
  }
  // 整個收起內頁（內頁的「關閉」）：一次退掉它所有的記錄，popstate 回來時收起並回原分頁；給了 tab 就收起後切到那一頁（例如開好夥伴直接去對話，chat＝進那一則）
  function closePage(tab = '', { chat = false } = {}) {
    if (pending || !depth()) return
    if (tab) leavePage({ close: true, tab, chat })
    else history.go(-depth())
  }
  function onPop(raw) {
    const n = normalizeNav(raw)
    if (pending) {
      const then = pending
      pending = null
      if (then.close) st.fourth = null
      setNav(n)
      if (then.page) openPage(then.page)
      else if (then.tab) switchTab(then.tab, { chat: !!then.chat })
      settle()
      return
    }
    if (n.tab === PAGE_TAB) {   // 退回內頁的上一層（或從浮層退回內頁）；內頁已經收起又退到它的舊記錄＝照記錄重開
      layers = st.fourth ? Math.min(layers, pageLayers(n.page).length) || 1 : 1   // 照記錄重開時底下有沒有列表層不確定，當作只有這一層
      st.fourth = st.fourth ? { ...st.fourth, page: n.page } : openFourth(n.page, HOME_TAB)
      setNav(n)
      return
    }
    if (nav.tab === PAGE_TAB && !nav.sheet) {   // 退過內頁的第一層：收起，回到進內頁之前的那個分頁
      const from = st.fourth?.from
      st.fourth = null
      setNav(n)
      if (from && from !== n.tab && !n.sheet) switchTab(from)
      return
    }
    setNav(n)
  }
  // 計時到了就收起（切頁、回到前景、計時器到點都會叫）；正在看內頁時 leftAt 是 0，不會收
  function check(keep) {   // keep＝這一頁保留多久（毫秒）；不給＝預設 3 分鐘（雲端代理的金鑰還在畫面上時 m.js 給較長的）
    if (!fourthExpired(st.fourth, now(), keep)) return false
    st.fourth = null
    return true
  }
  return { go, goTab, openChat, openPage, pushLayer, closePage, onPop, check, state, depth, whenSettled, busy: () => !!pending }
}

// 換內頁前先問一句（例如開新夥伴第 2 步還沒送出）：needs(next) 說要不要問；要問就開一層底部浮層（sheet: 'leave'，系統返回鍵＝留下）。
// 選離開：先收起浮層，等它的記錄退掉（nav.sheet 不再是 leave，呼叫端在監看 nav.sheet 時叫 onSheet）才做 run；選留下就什麼都不做。
// st＝畫面用的狀態（st.ask：{ run, leave } 或 null）；go／back 用上面那套導覽
export function createLeaveAsk({ nav, st, go, back, needs }) {
  function ask(next, run) {
    if (!needs(next)) { run(); return 'ran' }
    if (nav.sheet) return 'blocked'
    st.ask = { run, leave: false }
    go({ tab: nav.tab, sheet: 'leave' })
    return 'asked'
  }
  function answer(leave) {
    if (!st.ask) return
    st.ask = { ...st.ask, leave: leave === true }
    back()
  }
  function onSheet(sheet) {
    const a = st.ask
    if (sheet === 'leave' || !a) return
    st.ask = null
    if (a.leave) a.run()
  }
  return { ask, answer, onSheet }
}
