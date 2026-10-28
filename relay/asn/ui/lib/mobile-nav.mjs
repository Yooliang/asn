// 手機的分頁切換與瀏覽記錄（系統返回鍵＝瀏覽器上一頁）：三個固定分頁＋條件出現的第四頁籤（lib/mobile-fourth.mjs）。
// 規則：
//   - 夥伴分頁是底；切到其他分頁推一筆記錄，其他分頁之間互換不增加記錄，切回夥伴＝上一頁。
//   - 進內頁（設備與帳號、設置的某一項、使用指引）：打開第四頁籤並切過去，內頁的每一層各推一筆（指引單篇、設備細部各多一層）。
//   - 在第四頁籤按返回：先退內頁自己的層，退到頭就收起第四頁籤，回到進內頁之前的那個頁籤。
//   - 從第四頁籤切到前三頁：先把它那幾筆記錄退掉（之後的返回鍵照前三頁的規則走），頁籤與內容留著，開始計時；切回來再把那幾層推回去。
// 不碰 DOM：history（pushState／replaceState／back／go）、nav（畫面用的導覽狀態）、st（st.fourth＝第四頁籤）與時鐘都由呼叫端給，node 測試用假的。
import { normalizeNav, pageNav, tabList, tabNav } from './mobile.mjs'
import { PAGE_TAB, fourthExpired, fourthOnTab, normalizePage, openFourth, pageLayers } from './mobile-fourth.mjs'
import { mobileSettingTitle } from './mobile-settings.mjs'
import { GUIDE_ENTRY_LABEL, phoneGuide } from './mobile-guides.mjs'
import { ACCT_PAGE_TITLE } from './mobile-acct.mjs'

// 第四頁籤的標題：內頁的標題（指引單篇用那一篇的標題）
export function pageTitle(raw) {
  const p = normalizePage(raw)
  if (!p) return ''
  if (p.kind === 'acct') return ACCT_PAGE_TITLE
  if (p.kind === 'setting') return mobileSettingTitle(p.cat)
  return p.guide ? (phoneGuide(p.guide)?.guide.title ?? GUIDE_ENTRY_LABEL) : GUIDE_ENTRY_LABEL
}

export function createMobileNav({ history, nav, st, now = () => Date.now() }) {
  // 退掉第四頁籤的記錄後要接著做的事（history.go 是非同步的，等 popstate 回來才做）：{ tab } 切到某分頁、{ page } 換一個內頁
  let pending = null
  const setNav = n => {
    const prev = nav.tab
    const { page, ...rest } = n
    Object.assign(nav, { step: 0 }, rest)
    if (prev !== nav.tab) st.fourth = fourthOnTab(st.fourth, nav.tab, now())
  }
  const go = next => { history.pushState(next, ''); setNav(next) }
  // 第四頁籤目前佔了幾筆記錄（只有正在看它時才有）
  const depth = () => (nav.tab === PAGE_TAB && st.fourth ? pageLayers(st.fourth.page).length : 0)
  // 現在這一頁的記錄（通話中按返回要原地補回去時用）
  const state = () => (nav.tab === PAGE_TAB && st.fourth ? pageNav(st.fourth.page) : { tab: nav.tab, sheet: nav.sheet })
  // 前三頁之間切換（目前不在第四頁籤上）
  function switchTab(t) {
    if (t === nav.tab) return
    if (nav.tab === 'list') go(tabNav(t))
    else if (t === 'list') history.back()
    else { const n = tabNav(t); history.replaceState(n, ''); setNav(n) }
  }
  // 切到第四頁籤：把內頁的每一層推回記錄
  function showPage() {
    for (const p of pageLayers(st.fourth.page)) history.pushState(pageNav(p), '')
    setNav({ tab: PAGE_TAB, sheet: '' })
  }
  const leavePage = then => { pending = then; history.go(-depth()) }
  // 點頁籤、左右滑：浮層（開新夥伴、⋯ 選單、要密碼…）開著時不動
  function goTab(t) {
    if (pending || nav.sheet || t === nav.tab || !tabList(st.fourth).includes(t)) return
    if (t === PAGE_TAB) showPage()
    else if (nav.tab === PAGE_TAB) leavePage({ tab: t })
    else switchTab(t)
  }
  // 進一個內頁：第四頁籤換成它（計時歸零），從目前的分頁進來。回 false＝沒打開（浮層開著、描述不合法）
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
    if (replace) history.replaceState(pageNav(p), ''); else history.pushState(pageNav(p), '')
    st.fourth = { ...st.fourth, page: p }
  }
  // 整個收起第四頁籤（內頁的「關閉」）：一次退掉它所有的記錄，popstate 回來時收起並回原頁籤
  function closePage() { if (!pending && depth()) history.go(-depth()) }
  function onPop(raw) {
    const n = normalizeNav(raw)
    if (pending) {
      const then = pending
      pending = null
      setNav(n)
      if (then.page) openPage(then.page)
      else if (then.tab) switchTab(then.tab)
      return
    }
    if (n.tab === PAGE_TAB) {   // 退回內頁的上一層（或從浮層退回第四頁籤）；第四頁籤已經收起又退到它的舊記錄＝照記錄重開
      st.fourth = st.fourth ? { ...st.fourth, page: n.page } : openFourth(n.page, 'list')
      setNav(n)
      return
    }
    if (nav.tab === PAGE_TAB && !nav.sheet) {   // 退過第四頁籤的第一層：收起，回到進內頁之前的那個頁籤
      const from = st.fourth?.from
      st.fourth = null
      setNav(n)
      if (from && from !== n.tab && !n.sheet) switchTab(from)
      return
    }
    setNav(n)
  }
  // 計時到了就收起（切頁、回到前景、計時器到點都會叫）；正在看第四頁籤時 leftAt 是 0，不會收
  function check() {
    if (!fourthExpired(st.fourth, now())) return false
    st.fourth = null
    return true
  }
  return { go, goTab, openPage, pushLayer, closePage, onPop, check, state, depth, busy: () => !!pending }
}
