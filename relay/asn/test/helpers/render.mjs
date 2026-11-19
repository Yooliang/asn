// 測試用的「真的掛載」小工具：在 node 內用 happy-dom 造一個 window／document，把 Vue 的 global build 當 globalThis.Vue，
// 讓 UI 元件（template 是字串、在執行時編譯、靠 globalThis.Vue）可以真的掛載、用 querySelector 查詢、dispatch 事件、收 emit。
// 用法：const m = mountComponent(SettingsPanel, { st, catKey: 'update' }); await m.trigger(m.find('input'), 'change', { checked: false }); m.emitted('act')
// 限制：happy-dom 不排版——getBoundingClientRect 全是 0、沒有 CSS 檔的樣式；尺寸、溢出、觸控目標大小要用真瀏覽器探測（scripts/smoke-probes）。
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { Window } from 'happy-dom'

const require = createRequire(import.meta.url)

// 掛載期間要放到 globalThis 的 DOM 名稱（其餘名稱 Vue 與元件用不到）
const DOM_GLOBALS = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'InputEvent', 'DocumentFragment', 'Text', 'Comment', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']

let vueSrc = null
const loadVueFactory = () => {
  // 與 App 內嵌的是同一份：含編譯器的 global build（node_modules 一定在，不靠 ui/vendor 是否已被 prep 產生）
  if (vueSrc === null) vueSrc = fs.readFileSync(require.resolve('vue/dist/vue.global.prod.js'), 'utf8')
  // global build 是 IIFE 加 var Vue，包成函式讓它只看到我們給的 window／document，不污染 globalThis
  return new Function('window', 'document', 'navigator', `${vueSrc}\nreturn Vue`)
}

let active = 0          // 目前還沒卸載的掛載數
let shared = null       // { win, Vue }：整個行程只建一次。元件物件第一次掛載時會把 template 編譯成 render 並快取在元件上，
                        // render 綁著當時的 Vue 實例；每次重建 Vue 會讓快取的 render 失效（v-model 等指令靜默不作用），所以 window 與 Vue 要共用
let env = null          // { win, Vue, saved }：第一個掛載放上全域、最後一個卸載還原
const hadOwn = (k) => Object.getOwnPropertyDescriptor(globalThis, k)

const install = (globals) => {
  if (!shared) {
    const w = new Window({ url: 'http://localhost/' })
    shared = { win: w, Vue: loadVueFactory()(w, w.document, w.navigator) }
  }
  const { win, Vue } = shared
  win.document.body.innerHTML = ''
  const saved = new Map()
  const put = (k, v) => {
    if (!saved.has(k)) saved.set(k, hadOwn(k))
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true, enumerable: true })
  }
  for (const k of DOM_GLOBALS) {
    const v = k === 'window' ? win : win[k]
    if (v !== undefined) put(k, typeof v === 'function' && !/^[A-Z]/.test(k) ? v.bind(win) : v)
  }
  put('Vue', Vue)
  for (const [k, v] of Object.entries(globals || {})) put(k, v)
  return { win, Vue, saved }
}

const uninstall = (e) => {
  for (const [k, d] of e.saved) {
    if (d) Object.defineProperty(globalThis, k, d)
    else delete globalThis[k]
  }
  e.win.document.body.innerHTML = ''   // window 本身留著給下一次掛載用（行程結束時一起消失）
}

// 元件宣告的 emits（陣列或物件）→ 事件名清單
const emitNames = (C) => (Array.isArray(C.emits) ? C.emits : C.emits && typeof C.emits === 'object' ? Object.keys(C.emits) : [])
const camel = (s) => s.replace(/-(\w)/g, (_, c) => c.toUpperCase())

export function mountComponent(Component, props = {}, { globals = {}, slots } = {}) {
  if (active === 0) env = install(globals)
  else for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true, enumerable: true })
  active++
  const { win, Vue } = env
  if (typeof props === 'function') props = props(Vue)   // 要用 Vue.reactive 造 props 時傳函式
  const events = []   // [名稱, ...參數]，照發生順序
  const listeners = {}
  for (const name of emitNames(Component)) listeners['on' + camel(name).replace(/^./, (c) => c.toUpperCase())] = (...a) => events.push([name, ...a])
  const container = win.document.createElement('div')
  win.document.body.appendChild(container)
  const app = Vue.createApp({ render: () => Vue.h(Component, { ...props, ...listeners }, slots) })
  app.mount(container)
  let done = false

  const find = (sel, root = container) => root.querySelector(sel)
  const findAll = (sel, root = container) => [...root.querySelectorAll(sel)]
  // 依可見文字找元素（預設找按鈕）：文字用「包含」比對，去掉前後空白
  const findByText = (text, sel = 'button', root = container) => findAll(sel, root).find((el) => el.textContent.includes(text)) ?? null
  // 觸發事件並等 Vue 更新完。init 裡的 checked／value 會先寫到元素上（模擬使用者改了它）再發事件；其餘欄位進事件本身。
  const trigger = async (el, type, init = {}) => {
    if (!el) throw new Error(`trigger(${type})：找不到元素`)
    const { checked, value, ...evInit } = init
    if (checked !== undefined) el.checked = checked
    if (value !== undefined) el.value = value
    const Ev = type === 'click' || /^(mouse|pointer|dbl)/.test(type) ? win.MouseEvent : /^key/.test(type) ? win.KeyboardEvent : win.Event
    el.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, ...evInit }))
    await Vue.nextTick()
  }
  // 某個 emit 事件收到的所有參數（每次一個陣列）；不給名稱＝全部 [名稱, ...參數]
  const emitted = (name) => (name === undefined ? events.map((e) => [...e]) : events.filter((e) => e[0] === name).map((e) => e.slice(1)))
  const unmount = () => {
    if (done) return
    done = true
    app.unmount()
    container.remove()
    if (--active === 0) { uninstall(env); env = null }
  }
  return { container, app, Vue, window: win, document: win.document, find, findAll, findByText, trigger, emitted, clearEmitted: () => { events.length = 0 }, nextTick: () => Vue.nextTick(), unmount }
}
