// 線條圖示（0.2.21，#1461；設計稿 0.2.20-line-icons，小良哥 11-13 同意）：只給現代外觀用，復古 Aero 照舊用原本的彩色圖。
// 電腦和手機都讀這一份；同一個動作在電腦的「更多」和手機的「⋯」用同一個 key（見 MENU_ICON）。
// 規格：24×24、線寬 1.75、圓頭圓角、不填色（「更多」的三個點是唯一的填色）；顏色跟著 currentColor 走。
// 圖形存成 [標籤, 屬性] 的資料，畫面用 render 函式畫，不用 v-html。
import { ADOPT_LABEL, SELF_PULL_LABEL } from './partner-ops.mjs'
import { WINDOW_LABEL } from './actionbar.mjs'   // 互相引用沒關係：只在 itemIcon 被呼叫時才讀

/** 圖示本體：key → [[標籤, 屬性], …]（標籤只有 path、circle、rect） */
export const ICONS = {
  "emoji": [["circle",{"cx":"12","cy":"12","r":"9"}],["path",{"d":"M8.3 14.3c1 1.6 2.3 2.4 3.7 2.4s2.7-.8 3.7-2.4"}],["path",{"d":"M9 9.6v.6M15 9.6v.6"}]],
  "call": [["path",{"d":"M5.2 3.8h3l1.6 4-2 1.4a11 11 0 0 0 5 5l1.4-2 4 1.6v3a1.9 1.9 0 0 1-2 1.9C9.7 18.3 5.7 14.3 3.3 6a1.9 1.9 0 0 1 1.9-2.2z"}]],
  "dict": [["rect",{"x":"3.5","y":"3.5","width":"5.5","height":"9.5","rx":"2.75"}],["path",{"d":"M1.8 10.2a4.5 4.5 0 0 0 9 0M6.3 15v3.2M13.5 6.5h7M13.5 10.5h7M13.5 14.5h4.5"}]],
  "nudge": [["rect",{"x":"8","y":"3.5","width":"8","height":"17","rx":"2"}],["path",{"d":"M11 17.2h2M4.6 8.5v7M19.4 8.5v7M2 10.5v3M22 10.5v3"}]],
  "photo": [["rect",{"x":"3","y":"5","width":"18","height":"14","rx":"2"}],["circle",{"cx":"8.5","cy":"10","r":"1.6"}],["path",{"d":"M4 17.2l5-4.4 3.4 3 2.6-2.2 5 4"}]],
  "file": [["path",{"d":"M6.5 3h7.5l4 4v14h-11.5z"}],["path",{"d":"M14 3v4h4M9.5 12h5.5M9.5 15.5h5.5"}]],
  "shot": [["path",{"d":"M4 8V5.2A1.2 1.2 0 0 1 5.2 4H8M16 4h2.8A1.2 1.2 0 0 1 20 5.2V8M20 16v2.8a1.2 1.2 0 0 1-1.2 1.2H16M8 20H5.2A1.2 1.2 0 0 1 4 18.8V16"}],["circle",{"cx":"12","cy":"12","r":"3"}]],
  "mic": [["rect",{"x":"9","y":"3","width":"6","height":"11","rx":"3"}],["path",{"d":"M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6"}]],
  "term": [["rect",{"x":"3","y":"4.5","width":"18","height":"15","rx":"2"}],["path",{"d":"M7 9.5l3 2.5-3 2.5M12.5 15h4.5"}]],
  "msg": [["path",{"d":"M4 5h16v11H9.5L4 20z"}],["path",{"d":"M8 9h8M8 12.5h5"}]],
  "win_up": [["rect",{"x":"3","y":"4","width":"18","height":"15.5","rx":"2"}],["path",{"d":"M3 8h18M12 17v-5.5M9.5 14l2.5-2.5 2.5 2.5"}]],
  "win_dn": [["rect",{"x":"3","y":"4","width":"18","height":"15.5","rx":"2"}],["path",{"d":"M3 8h18M12 11.5V17M9.5 14.5 12 17l2.5-2.5"}]],
  "wake": [["path",{"d":"M12 3v8.5"}],["path",{"d":"M7.2 6.2a7.5 7.5 0 1 0 9.6 0"}]],
  "model": [["rect",{"x":"7","y":"7","width":"10","height":"10","rx":"1.6"}],["path",{"d":"M10 7V4M14 7V4M10 20v-3M14 20v-3M7 10H4M7 14H4M20 10h-3M20 14h-3M10.5 10.5h3v3h-3z"}]],
  "subs": [["circle",{"cx":"12","cy":"5.5","r":"2.5"}],["circle",{"cx":"5.5","cy":"18.5","r":"2.5"}],["circle",{"cx":"18.5","cy":"18.5","r":"2.5"}],["path",{"d":"M12 8v4M5.5 16v-4h13v4"}]],
  "tasks": [["rect",{"x":"5","y":"4","width":"14","height":"17","rx":"2"}],["path",{"d":"M9.5 2.8h5v2.6h-5zM8.5 11l1.5 1.5 2.5-2.5M14.5 11.5h2M8.5 16l1.5 1.5 2.5-2.5M14.5 16.5h2"}]],
  "group": [["circle",{"cx":"9","cy":"8.5","r":"3"}],["path",{"d":"M3.5 19.5c.5-3.3 2.7-5.2 5.5-5.2s5 1.9 5.5 5.2"}],["circle",{"cx":"16.5","cy":"9.5","r":"2.4"}],["path",{"d":"M16.2 14.3c2.5 0 4.1 1.7 4.5 4.6"}]],
  "info": [["circle",{"cx":"12","cy":"12","r":"9"}],["path",{"d":"M12 11v5.5M12 7.8v.4"}]],
  "rename": [["path",{"d":"M4 20h3.8L19 8.8 15.2 5 4 16.2z"}],["path",{"d":"M13.5 6.7l3.8 3.8M13 20h7"}]],
  "close": [["rect",{"x":"3","y":"4","width":"18","height":"15.5","rx":"2"}],["path",{"d":"M3 8h18M9.8 11.2l4.4 4.4M14.2 11.2l-4.4 4.4"}]],
  "handover": [["path",{"d":"M4 8.5h14l-3.2-3.2M20 15.5H6l3.2 3.2"}]],
  "restart": [["path",{"d":"M20 12a8 8 0 1 1-2.3-5.7"}],["path",{"d":"M20 4v5h-5"}]],
  "remove": [["path",{"d":"M4 7h16M9 7V4.5h6V7M6.2 7l.9 13h9.8l.9-13M10 11v5.5M14 11v5.5"}]],
  "archive": [["rect",{"x":"3","y":"4","width":"18","height":"4.5","rx":"1"}],["path",{"d":"M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5M10 12.5h4"}]],
  "adopt": [["path",{"d":"M12 3.5v10M8 9.5l4 4 4-4M5 13.5v5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-5"}]],
  "invite": [["circle",{"cx":"9.5","cy":"8","r":"3.2"}],["path",{"d":"M3.5 19.5c.5-3.3 2.9-5.3 6-5.3 1.4 0 2.6.4 3.6 1M18 12.5v6M15 15.5h6"}]],
  "addai": [["rect",{"x":"3","y":"8","width":"13","height":"10.5","rx":"3"}],["path",{"d":"M9.5 8V4.5M7 12.5v1M12 12.5v1M7.5 16h4M19.5 3.5v5M17 6h5"}]],
  "members": [["path",{"d":"M4 7h9M17 7h3M4 17h3M11 17h9"}],["circle",{"cx":"15","cy":"7","r":"2"}],["circle",{"cx":"9","cy":"17","r":"2"}]],
  "me": [["circle",{"cx":"12","cy":"8","r":"4"}],["path",{"d":"M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"}]],
  "devices": [["rect",{"x":"3","y":"5","width":"13","height":"9","rx":"1.2"}],["path",{"d":"M1.5 18h16"}],["rect",{"x":"19","y":"8","width":"3","height":"11","rx":"1"}]],
  "accounts": [["circle",{"cx":"12","cy":"7.5","r":"3.5"}],["path",{"d":"M5 20c0-3.5 3.1-5.5 7-5.5s7 2 7 5.5"}],["path",{"d":"M16.8 3.8l1.2 1.2 2.2-2.2"}]],
  "cloud": [["path",{"d":"M7 18a4 4 0 1 1 1-7.9A5.5 5.5 0 0 1 18.5 11 3.5 3.5 0 0 1 18 18z"}]],
  "look": [["path",{"d":"M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.5-2s0-2 1.5-2h2a3 3 0 0 0 3-3c0-5-4-11-8-11z"}],["circle",{"cx":"7.5","cy":"11","r":"1"}],["circle",{"cx":"10","cy":"7","r":"1"}],["circle",{"cx":"15","cy":"7.5","r":"1"}]],
  "tabs": [["path",{"d":"M3 6.5a1 1 0 0 1 1-1h6l2 2h8a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"}]],
  "notify": [["path",{"d":"M6 10a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 15 6 10z"}],["path",{"d":"M10 19.5a2 2 0 0 0 4 0"}]],
  "voice": [["rect",{"x":"9","y":"3","width":"6","height":"11","rx":"3"}],["path",{"d":"M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"}]],
  "window": [["rect",{"x":"3","y":"5","width":"18","height":"14","rx":"1.8"}],["path",{"d":"M3 9h18M6 7h.5M8.5 7h.5"}]],
  "launch": [["path",{"d":"M7 4.5l12 7.5-12 7.5z"}]],
  "usage": [["path",{"d":"M4 20V11M10 20V5M16 20v-6M2 20h20"}]],
  "about": [["circle",{"cx":"12","cy":"12","r":"9"}],["path",{"d":"M12 11v6M12 7.6v.4"}]],
  "guide": [["path",{"d":"M4 5.5a1.5 1.5 0 0 1 1.5-1.5H11v16H5.5A1.5 1.5 0 0 1 4 18.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z"}]],
  "settings": [["circle",{"cx":"12","cy":"12","r":"3"}],["path",{"d":"M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M5.5 18.5l1.8-1.8M16.7 7.3l1.8-1.8"}],["circle",{"cx":"12","cy":"12","r":"6.2"}]],
  "search": [["circle",{"cx":"10.5","cy":"10.5","r":"6.5"}],["path",{"d":"M15.5 15.5 21 21"}]],
  "plus": [["path",{"d":"M12 5v14M5 12h14"}]],
  "back": [["path",{"d":"M15 4.5 7.5 12 15 19.5"}]],
}

/** 同一個圖的別名（設計稿上註明「和○○同一個圖」的） */
export const ALIAS = { partners: 'group', chats: 'msg', notice: 'notify', update: 'restart' }

/** 「更多」的三個實心點（唯一用填色的圖示） */
const DOTS = [5.5, 12, 18.5].map(cx => ['circle', { cx: String(cx), cy: '12', r: '1.4', fill: 'currentColor', stroke: 'none' }])

/** 取圖示的圖形；不認得的 key 回空陣列（畫面就不畫，不報錯） */
export function iconShapes(key) {
  if (key === 'more') return DOTS
  const k = ALIAS[key] ?? key
  return Object.hasOwn(ICONS, k) ? ICONS[k] : []
}

export const hasIcon = key => iconShapes(key).length > 0

/**
 * 選單項目 key → 圖示 key。電腦現代外觀的「更多」（moreMenuItems）和手機「⋯」（phoneOpsRows、chatGroupItems）都查這一份，
 * 所以同一個動作兩邊一定是同一個圖示；沒列的項目不畫圖示。key 前面的「p:」（夥伴管理項目）不算。
 */
export const MENU_ICON = {
  info: 'info',
  rename: 'rename',
  model: 'model',
  close: 'close',
  handover: 'handover',
  resume: 'wake',
  restart: 'restart',
  remove: 'remove',
  archive: 'archive',
  unarchive: 'archive',
  adopt: 'adopt',
  invite: 'invite',
  addai: 'addai',
  manage: 'members',
  call: 'call',
  window: 'win_up',
  subs: 'subs',
  tasks: 'tasks',
}

/** 危險動作（移除）的圖示用紅色，和現代外觀的危險按鈕同色 */
export const DANGER_KEYS = new Set(['remove'])

const bareKey = key => String(key ?? '').replace(/^p:/, '')

/**
 * 一個選單項目 { key, label } 該畫哪個圖示：
 *   前台／後台（window）：字是 WINDOW_LABEL.hide（按了會收到後台）畫朝下的箭頭，其餘朝上；
 *   換班接手（handover）遇到可以接手的終端時字會換成 ADOPT_LABEL 或 SELF_PULL_LABEL，畫「接手」的圖。
 *   都和那幾個文字常數比對（選單字尾可能多一個「…」），不看字頭，改文案時跟著常數走。
 */
export function itemIcon(item) {
  const k = bareKey(item?.key)
  const label = String(item?.label ?? '')
  const is = text => label === text || label === `${text}…`
  if (k === 'window') return is(WINDOW_LABEL.hide) ? 'win_dn' : 'win_up'
  if (k === 'handover' && (is(ADOPT_LABEL) || is(SELF_PULL_LABEL))) return 'adopt'
  return MENU_ICON[k] ?? ''
}

export const isDangerItem = item => DANGER_KEYS.has(bareKey(item?.key))

/** 手機四大分頁（mobile.mjs 的 TABS）→ 圖示；第四格暫放內頁時沒有圖示 */
export const TAB_ICON = { list: 'partners', chats: 'chats', me: 'settings', notice: 'notice' }
export const tabIcon = t => TAB_ICON[t] ?? ''

/**
 * Vue 元件 <line-icon name="term" :size="20">：畫一個線條圖示（aria-hidden，字由按鈕自己帶）。
 * 不認得的 name 什麼都不畫。
 */
export const LineIcon = {
  name: 'LineIcon',
  props: { name: { type: String, required: true }, size: { type: [Number, String], default: 20 } },
  setup(props) {
    const { h } = globalThis.Vue
    return () => {
      const shapes = iconShapes(props.name)
      if (!shapes.length) return null
      return h('svg', {
        class: 'lic', viewBox: '0 0 24 24', width: props.size, height: props.size, fill: 'none', stroke: 'currentColor',
        'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', 'data-icon': props.name,
      }, shapes.map(([tag, attrs]) => h(tag, attrs)))
    }
  },
}
