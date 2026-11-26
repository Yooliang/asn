// 事件守門（#2038 PR-8）：畫面檔收事件只准走事件中心（hub），不准各自去碰 Tauri 的事件 API。
// 作法沿用 test/arch-guard.test.mjs：stripComments 去註解、DETECT 偵測器、白名單棘輪
// （名單只准少、不准多；已經乾淨的檔還留在名單上，測試也紅）、偵測器自己要有牙齒（壞字抓得到、好字不誤抓）。
//
// 規則（掃 ui/*.js 與 ui/lib/*.mjs）：
//  G1 不 import tauri.mjs（或之後的 host.mjs）的 listen／once
//  G2 不直接碰 Tauri 事件 API（__TAURI__ 的 event、T.event、event.listen／once、@tauri-apps/api/event）
//  G3 不呼叫「別人傳進來的 listen」（api.listen、deps.listen、裸呼叫 listen(…)）；native.listen（語音辨識）不是事件
//  G4 事件名只能從表（rust-events.mjs）來：hub 的 on／subscribe／readyFor 與 emit／broadcast／sendTo 用到的名字都要在表裡
//  G5 表裡登記的事件（除了 listeners:0 與白名單）前端真的有人接
//  G6 同一個事件名，同一扇視窗只准在一座 hub 訂閱（tauri.mjs 模組層、initFrame()、core.hub、createWindowHub() 各是一座）
//
// 呼叫可以寫成 x.f(…)、x?.f(…)、x.f?.(…)、x.f ?. (…)（readyFor、broadcast、sendTo、emit 都一樣）；G7 的 createWindowHub( 與 createEventHub( 都算自建 hub。
// 事件名的寫法：單引號、雙引號、反引號的字面值，或同檔／import 來的常數都認得；
// 反引號裡有 ${}、或名字是別的運算式（認不出來），一律點名紅，不會被略過（emit 與訂閱端同一套規則）。
// 入口檔的 createWindowHub( 只准「const X = createWindowHub()」或「createWindowHub().subscribe／on(…)」兩種寫法，其他用法點名紅。
// 入口檔載入了有訂閱的 lib、LIB_WIRING 沒登記該視窗，也是紅；只借純函式、不經 hub 訂閱的寫 'none:原因'。
//
// 已知繞不過的範圍（守門不是萬能，審 diff 時要留意）：
//  - G2 把 Tauri 的事件 API 拆行、換名字再呼叫（例如先存進別的變數）會繞過字面偵測
//  - LIB_WIRING 的登記值只是自我聲明，守門不驗證那座 hub 真的是傳進去的那座
//  - 例外表（ALLOW、HUB_DUP_ALLOW、NO_SUBSCRIBER_ALLOW、LIB_WIRING 的 none）變長不會紅，要靠看 diff 才發現
//
// 直接碰 Tauri 事件 API 的例外只有兩個：host.mjs（主機接縫，#1763 F3）與 skin-boot.js（classic script，要早於 Vue 套外觀）；
// tauri.mjs 只剩自己定義的 listen（轉給 host.listen）列在 G3。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { jsEventNames, rustEventNames, RUST_EVENTS } from '../ui/lib/rust-events.mjs'

const UI = fileURLToPath(new URL('../ui', import.meta.url))
const readDir = (sub) => {
  const dir = path.join(UI, sub)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /\.m?js$/.test(e.name)).map((e) => e.name).sort()
    .map((f) => ({ name: sub ? `${sub}/${f}` : f, src: fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n') }))
}
export const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

const TABLE = new Set([...rustEventNames(), ...jsEventNames()])
const INTERNAL = new Set(['state', 'log', 'notify', 'avatars'])   // AsnCore 內部事件（core.on），不是 Rust 也不是視窗之間的事件

// ---------- G1～G3 偵測器 ----------
const importsOf = (s, mod) => [...s.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\/(?:tauri|host)\.mjs['"]/g)].flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]))
const listenReceivers = (s) => [...s.matchAll(/(?<![\w$])(?:([\w$]+(?:\??\.[\w$]+)*)\s*\??\.)?listen\s*\(/g)].map((m) => m[1] ?? '')
export const DETECT = {
  importListen: (s) => importsOf(s).some((n) => n === 'listen' || n === 'once'),
  tauriEvent: (s) => s.split('\n').some((l) => (/__TAURI(?:_[A-Z]+)*__/.test(l) && /\bevent\b/.test(l)) || /(?<![\w$.])T\s*\??\.\s*event\b/.test(l) || /\bevent\s*\??\.\s*(listen|once)\s*\(/.test(l) || /\.event\s*\??\.\s*once\b/.test(l) || /@tauri-apps\/api\/event/.test(l)),
  // 裸呼叫 listen(、或任何接收者的 .listen(（native.listen 是語音辨識，不是事件）
  foreignListen: (s) => listenReceivers(s).some((r) => r !== 'native'),
}
const hits = (files, rule) => files.filter((f) => DETECT[rule](stripComments(f.src))).map((f) => f.name)

// 白名單：檔名 → 原因。只准少、不准多。
const ALLOW = {
  importListen: {},
  tauriEvent: {
    'lib/host.mjs': '主機接縫（#1763 F3）：全前端唯一向 Tauri 註冊事件、送事件的地方',
    'skin-boot.js': 'classic script：要早於 Vue 套好外觀、不能 import，只聽 asn:skin',
  },
  foreignListen: {
    'lib/tauri.mjs': '橋的出口：自己定義 listen（轉給 host.listen）並注入事件中心',
    'lib/host.mjs': '主機接縫：定義 listen（轉給 Tauri 的事件 API）',
    'skin-boot.js': 'classic script：直接聽 asn:skin（同 G2 的例外）',
  },
}
const checkRatchet = (rule, found, allow) => {
  const extra = found.filter((n) => !(n in allow))
  assert.deepEqual(extra, [], `[${rule}] 這些檔直接碰了事件 API：${extra.join('、')}（要收事件請走事件中心 core.hub／createWindowHub()）`)
  const stale = Object.keys(allow).filter((n) => !found.includes(n))
  assert.deepEqual(stale, [], `[${rule}] 白名單裡這些檔已經乾淨，請從 test/event-gate.test.mjs 的白名單刪掉：${stale.join('、')}`)
}

// ---------- 訂閱處分析（G4／G5／G6） ----------
// 接收者以 hub／Hub 結尾（hub、eventHub、props.hub、core?.hub…），或是 core、h
const HUB_ON_RECV = /^(?:core|h|[\w$.?]*(?:hub|Hub))$/
// 事件名引數：單引號／雙引號／反引號字面值（後面要緊接 , 或 )，不然是「'a' + b」這種運算式），其餘一律當運算式
const ARG = "(?:'([^'\\n]*)'(?=\\s*[,)])|\"([^\"\\n]*)\"(?=\\s*[,)])|`([^`]*)`(?=\\s*[,)])|([^,)]+))"
const QUOTED = /^(?:'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`)$/
const INFRA = new Set(['lib/event-hub.mjs', 'lib/rust-bridge.mjs', 'lib/core.mjs'])   // 事件中心本身：名字是參數，不是畫面檔
const isEntry = (n) => /^[^/]+\.js$/.test(n) && n !== 'skin-boot.js'
const resolveImports = (src) => [...src.matchAll(/from\s+['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1] ?? m[2])
const normName = (from, rel) => path.posix.normalize(path.posix.join(path.posix.dirname(from), rel))
export const closureOf = (files, entry) => {
  const byName = new Map(files.map((f) => [f.name, f]))
  const seen = new Set()
  const walk = (n) => {
    if (seen.has(n) || !byName.has(n)) return
    seen.add(n)
    for (const rel of resolveImports(stripComments(byName.get(n).src))) walk(normName(n, rel))
  }
  walk(entry)
  return seen
}
// 名字可能是字串，或同檔／import 來的常數（FRAME_EVENT 這種）
const constOf = (files, file, id) => {
  const re = new RegExp(`(?:export\\s+)?const\\s+${id}\\s*=\\s*(?:'([^']+)'|"([^"]+)"|\`([^\`$]+)\`)`)
  const own = re.exec(stripComments(file.src))
  if (own) return own[1] ?? own[2] ?? own[3]
  const im = new RegExp(`import\\s*\\{[^}]*\\b${id}\\b[^}]*\\}\\s*from\\s*['"](\\.[^'"]+)['"]`).exec(stripComments(file.src))
  const dep = im && files.find((f) => f.name === normName(file.name, im[1]))
  return dep ? constOf(files, dep, id) : null
}
// 事件名引數（ARG 抓到的四組）→ { evt, raw }：字面值直接用；識別字查常數；反引號帶 ${}、運算式 → evt 是 null（要被點名）
const evtOf = (files, file, [sq, dq, bt, loose]) => {
  const lit = sq ?? dq ?? bt
  if (lit !== undefined) return /\$\{/.test(lit) ? { evt: null, raw: `\`${lit}\`` } : { evt: lit, raw: lit }
  const raw = loose.trim()
  return { evt: /^[A-Za-z_$][\w$]*$/.test(raw) ? constOf(files, file, raw) : null, raw }
}
// 單一記號（readyFor 陣列的一項）的名字；認不出來是 null
const tokenName = (files, file, tok) => {
  const q = QUOTED.exec(tok)
  if (q) { const lit = q[1] ?? q[2] ?? q[3]; return /\$\{/.test(lit) ? null : lit }
  return /^[A-Za-z_$][\w$]*$/.test(tok) ? constOf(files, file, tok) : null
}
// 一個檔裡用 const X = createWindowHub() 單純寫法建的 hub 變數（其他寫法不算，入口檔另外點名）
const WIN_VAR_RE = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?createWindowHub\s*\(\s*\)\s*;?[ \t]*$/gm
// 「.」與「?.」、方法名與「(」之間都容許空白、換行與 ?.（eventHub\n  .subscribe(…)、eventHub?.on?.(…)）
const DOT = '\\s*(?:\\?\\.|\\.)\\s*'
const CALL_OPEN = '\\s*(?:\\?\\.)?\\s*\\('
const INLINE_RE = new RegExp(`createWindowHub\\s*\\(\\s*\\)${DOT}(subscribe|on)${CALL_OPEN}\\s*${ARG}`, 'g')
const RECV_TAIL = /((?:[\w$]+\s*\??\s*\.\s*)*[\w$]+)\s*$/
// 方法呼叫前面的接收者：{ recv, chain }。接在 )、]、}、引號後面（串接、看不出是哪座 hub）→ chain:true，recv 是 ')'
const receiverBefore = (s, idx) => {
  const before = s.slice(Math.max(0, idx - 300), idx).replace(/\s+$/, '')
  if (/createWindowHub\s*\(\s*\)$/.test(before)) return { recv: 'createWindowHub()', chain: false, inline: true }
  const m = RECV_TAIL.exec(before)
  if (!m || /[)\]}'"`]$/.test(before)) return { recv: ')', chain: true }
  return { recv: m[1].replace(/\s+/g, '').replace(/\?$/, ''), chain: false }
}
const winVarsOf = (s) => new Set([...s.matchAll(WIN_VAR_RE)].map((m) => m[1]))
// 入口檔裡 createWindowHub( 的用法：只認「const X = createWindowHub()」與「createWindowHub().subscribe／on(」，其他的一律點名
export const hubCreationProblems = (file) => stripComments(file.src).split('\n').filter((l) => /createWindowHub\s*\(/.test(l) && !/^\s*import\b/.test(l)).filter((l) => {
  if (new RegExp(WIN_VAR_RE.source).test(l)) return false
  return !(new RegExp(`createWindowHub\\s*\\(\\s*\\)${DOT}(?:subscribe|on)${CALL_OPEN}`).test(l) &&(l.match(/createWindowHub\s*\(/g) ?? []).length === 1)
}).map((l) => `${file.name}：createWindowHub() 的用法認不出來（${l.trim()}）——請寫成 const X = createWindowHub()，再用 X.subscribe／X.on`)
// 一個檔裡所有「這個接收者訂了這個事件」：{ recv, how, evt, id, inline }（evt 解不出來就是 null，id 是原始寫法）
export const sitesOf = (files, file) => {
  const s = stripComments(file.src)
  const winVars = winVarsOf(s)
  const out = []
  for (const m of s.matchAll(new RegExp(`${DOT}(subscribe|on)${CALL_OPEN}\\s*${ARG}`, 'g'))) {
    const { recv, chain, inline } = receiverBefore(s, m.index)
    if (inline) continue   // createWindowHub().subscribe(…) 由下面 INLINE_RE 處理
    // hub 類接收者（含這個檔自己 createWindowHub() 建出來的變數）的 .on／.subscribe 都算；
    // 其他接收者的 .subscribe 在入口檔也算（判不出是哪座 hub 要被點名），在 lib 檔不算（別的訂閱制物件，例如 recentShown，不是事件中心）；
    // 串接（接在 )、] 後面）看不出接收者，一律算、一律點名
    if (!chain && !(HUB_ON_RECV.test(recv) || winVars.has(recv)) && (m[1] === 'on' || !isEntry(file.name))) continue
    const { evt, raw } = evtOf(files, file, m.slice(2, 6))
    out.push({ recv, how: m[1], evt, id: raw, chain })
  }
  // createWindowHub().subscribe('x'…) 直接串的寫法：每一處都是獨立的一座 hub
  for (const m of s.matchAll(INLINE_RE)) {
    const { evt, raw } = evtOf(files, file, m.slice(2, 6))
    out.push({ recv: 'createWindowHub()', how: m[1], evt, id: raw, inline: true })
  }
  return out
}
// readyFor：.readyFor(、?.readyFor(、.readyFor?.(、readyFor ?. (（點、?.、空白、換行都容許）；裸的 readyFor?.( 也算（裸的 readyFor( 是函式宣告，不算）
const READY_FOR_RE = new RegExp(`(?:${DOT}readyFor${CALL_OPEN}|(?<![\\w$.])readyFor\\s*\\?\\.\\s*\\()\\s*(?:\\[([^\\]]*)\\]|([^)]*))`, 'g')
const readyForNames = (files, file) => [...stripComments(file.src).matchAll(READY_FOR_RE)].flatMap((m) => (m[1] === undefined ? [null] : m[1].split(',').map((x) => x.trim()).filter(Boolean).map((x) => tokenName(files, file, x))))

// tauri.mjs 自己的訂閱：模組層那座 hub、initFrame 預設那座 hub、以及直接 listen 的（relay-report-bell 走 listen 回呼）
const tauriSites = (file) => {
  const s = stripComments(file.src)
  const out = []
  const fi = s.indexOf('export async function initFrame')
  const frameBody = fi < 0 ? '' : s.slice(fi, s.indexOf('\n}', fi))
  const Q = '[\'"`]([^\'"`$]+)[\'"`]'
  for (const m of s.matchAll(new RegExp(`createWindowHub\\(\\)\\s*\\.subscribe\\(\\s*${Q}`, 'g'))) out.push({ evt: m[1], hub: 'tauri-module' })
  for (const m of frameBody.matchAll(new RegExp(`\\bhub\\.(?:on|subscribe)\\(\\s*${Q}`, 'g'))) out.push({ evt: m[1], hub: 'initFrame' })
  for (const m of s.matchAll(new RegExp(`(?<![\\w$.])listen\\(\\s*${Q}`, 'g'))) out.push({ evt: m[1], hub: 'tauri-direct-listen' })
  return out
}
// 視窗之間送出的事件名（emit／broadcast／sendTo）：同一套寫法規則，認不出來的 evt 是 null
export const emitSitesOf = (files, file) => {
  const s = stripComments(file.src)
  const out = []
  const push = (re, from) => { for (const m of s.matchAll(re)) out.push(evtOf(files, file, m.slice(from, from + 4))) }
  // 裸 emit( 要 import 自 tauri.mjs 才算（Vue 元件的 emit('pick') 不是視窗事件）
  if (importsOf(s).includes('emit')) push(new RegExp(`(?<![\\w$.])emit\\s*\\(\\s*${ARG}`, 'g'), 1)
  // 明寫了可選呼叫的（emit?.(、sendTo?.(、broadcast?.(：函式是別人傳進來、可能不存在）一律算
  push(new RegExp(`(?<![\\w$.])emit\\s*\\?\\.\\s*\\(\\s*${ARG}`, 'g'), 1)
  // x.emit?.(…)、x?.emit(…)：接收者不限（x.emit(…) 沒有 ?. 的不算，Vue 元件的 ctx.emit 太多）
  push(new RegExp(`(?:\\?\\.\\s*emit\\s*\\(|\\.\\s*emit\\s*\\?\\.\\s*\\()\\s*${ARG}`, 'g'), 1)
  push(new RegExp(`${DOT}broadcast${CALL_OPEN}\\s*${ARG}`, 'g'), 1)
  push(new RegExp(`${DOT}sendTo${CALL_OPEN}\\s*[^,]+,\\s*${ARG}`, 'g'), 1)
  push(new RegExp(`(?<![\\w$.])broadcast\\s*\\?\\.\\s*\\(\\s*${ARG}`, 'g'), 1)
  push(new RegExp(`(?<![\\w$.])sendTo\\s*\\?\\.\\s*\\(\\s*[^,]+,\\s*${ARG}`, 'g'), 1)
  return out
}

// 哪些 lib 檔的 hub 是呼叫端傳進來的：lib 檔 → { 視窗入口檔: 該視窗傳給它的 hub }。原因都寫在這裡；新增訂閱的 lib 檔沒登記就紅，登記了卻沒訂閱也紅（棘輪）
export const LIB_WIRING = {
  'lib/account-events.mjs': { 'list.js': 'core' },
  'lib/agent-install.mjs': { 'list.js': 'core' },
  'lib/notice-events.mjs': { 'list.js': 'core', 'm.js': 'core' },
  // chat.js 只經 voice-ui.mjs 借 sttProgressText（純函式），不呼叫 watchUpdateProgress／watchAndroidUpdateProgress
  'lib/progress-events.mjs': { 'list.js': 'core', 'm.js': 'core', 'chat.js': 'none:只經 voice-ui.mjs 借 sttProgressText 這個純函式，不呼叫會訂閱的 watch* 函式' },
  'lib/relogin-bar.mjs': { 'list.js': 'core', 'm.js': 'core' },
  'lib/voice-ui.mjs': { 'list.js': 'core', 'chat.js': 'win:eventHub' },
  'lib/term-view.mjs': { 'list.js': 'core', 'm.js': 'core', 'chat.js': 'win:eventHub' },
  'lib/term-remote.mjs': { 'list.js': 'core', 'm.js': 'core', 'chat.js': 'win:eventHub' },
  'lib/term-remote-input.mjs': { 'list.js': 'core', 'm.js': 'core', 'chat.js': 'win:eventHub' },
}
// 同一視窗同一事件名被兩座以上 hub 訂閱、但分析不精確或有正當理由的：'入口檔:事件名' → 原因。只准少、不准多
const HUB_DUP_ALLOW = {}

// 整個分析：回傳各視窗的 事件名 → hub 集合，以及不能判定的地方
export const analyze = (files, wiring = LIB_WIRING) => {
  const problems = []
  const tauriFile = files.find((f) => f.name === 'lib/tauri.mjs')
  const windows = {}
  const libSites = new Map()
  for (const f of files) {
    if (INFRA.has(f.name) || f.name === 'lib/tauri.mjs' || isEntry(f.name)) continue
    const all = sitesOf(files, f)
    for (const x of all.filter((y) => y.chain)) problems.push(`${f.name}：${x.recv}.${x.how}(${x.evt ?? x.id}) 接在別的呼叫後面，看不出是哪一座 hub（請拆成 const X = …，再用 X.subscribe／X.on）`)
    const ss = all.filter((x) => !x.chain && (x.how === 'subscribe' || HUB_ON_RECV.test(x.recv)))
    if (ss.length) libSites.set(f.name, ss)
  }
  for (const entry of files.filter((f) => isEntry(f.name))) {
    const close = closureOf(files, entry.name)
    const per = new Map()
    const add = (evt, hub) => { if (evt) per.set(evt, new Set([...(per.get(evt) ?? []), hub])) }
    const entrySrc = stripComments(entry.src)
    const winVars = winVarsOf(entrySrc)
    problems.push(...hubCreationProblems(entry))
    if (tauriFile && close.has('lib/tauri.mjs')) {
      for (const t of tauriSites(tauriFile)) if (t.hub !== 'initFrame' || /\binitFrame\s*\(/.test(entrySrc)) add(t.evt, t.hub)
    }
    let inline = 0   // 直接 createWindowHub().subscribe('x'…) 的寫法：每一處都是獨立的一座 hub
    for (const x of sitesOf(files, entry)) {
      const hub = x.inline ? `win:inline#${inline++}` : /^core(\??\.hub)?$/.test(x.recv) ? 'core' : winVars.has(x.recv) ? `win:${x.recv}` : null
      if (!hub) { problems.push(`${entry.name}：${x.recv}.${x.how}(${x.evt ?? x.id}) 的 hub 判定不出來（請改用 createWindowHub() 或 core.hub）`); continue }
      if (hub === 'core' && INTERNAL.has(x.evt)) continue
      add(x.evt, hub)
    }
    for (const [lib, ss] of libSites) {
      if (!close.has(lib)) continue
      const hub = wiring[lib]?.[entry.name]
      if (!hub) { problems.push(`${entry.name}：載入了會訂閱事件的 ${lib}，但 LIB_WIRING 沒登記它在這扇視窗拿到哪座 hub（只借純函式、不經 hub 訂閱的，登記 'none:原因'）`); continue }
      if (/^none\b/.test(hub)) {
        if (!/^none[:：]\s*\S/.test(hub)) problems.push(`${entry.name}：LIB_WIRING 的 ${lib} 寫了 'none' 卻沒附原因（寫成 'none:原因'）`)
        continue
      }
      for (const x of ss) add(x.evt, hub)
    }
    windows[entry.name] = per
  }
  return { windows, problems, libSites }
}
const dupsOf = (windows) => Object.entries(windows).flatMap(([w, per]) => [...per].filter(([, hubs]) => hubs.size > 1).map(([evt, hubs]) => `${w}:${evt}（${[...hubs].join('、')}）`))

// ---------- 載入真實檔案 ----------
const uiFiles = [...readDir(''), ...readDir('lib')]

test('掃描範圍不是空的（防假綠）：找得到入口檔、tauri.mjs、事件表與事件中心', () => {
  assert.ok(uiFiles.length > 50, `ui 檔太少（${uiFiles.length}），掃描範圍可能壞了`)
  for (const n of ['list.js', 'm.js', 'chat.js', 'panel.js', 'skin-boot.js', 'lib/tauri.mjs', 'lib/rust-events.mjs', 'lib/event-hub.mjs']) assert.ok(uiFiles.some((f) => f.name === n), `找不到 ${n}`)
  assert.ok(TABLE.size >= 30, '事件表讀不到')
  for (const sub of ['', 'lib']) {
    const dir = path.join(UI, sub)
    const subdirs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'vendor' && e.name !== 'img').map((e) => e.name)
    if (sub === 'lib') assert.deepEqual(subdirs, [], `lib/ 出現子目錄 ${subdirs.join('、')}：守門只掃一層，要放子目錄請先讓 readDir 遞迴`)
  }
})

// ---------- 偵測器自我測試（守門自己要有牙齒） ----------
test('偵測器：壞字每一條都抓得到、好字不誤抓、註解裡不算', () => {
  const bad = {
    importListen: ["import { listen } from './lib/tauri.mjs'", "import { emit, listen as l } from './tauri.mjs'", "import {\n  once,\n  invoke } from './lib/host.mjs'"],
    tauriEvent: ["window.__TAURI__.event.listen('x', f)", "T.event.once('x', f)", "const { listen } = window.__TAURI__.event", "import { listen } from '@tauri-apps/api/event'", "event.listen('x', f)", 'globalThis.__TAURI__?.event?.emit(1)'],
    foreignListen: ["props.api.listen('term-view-frame', f)", 'deps.listen(evt, fn)', "const u = await listen('relay-bell', f)", "api.listen('x', f)", "ev.listen('asn:skin', f)"],
  }
  const good = {
    importListen: ["import { invoke, emit } from './lib/tauri.mjs'", "import { listenAll } from './lib/x.mjs'", "// import { listen } from './lib/tauri.mjs'"],
    tauriEvent: ["window.addEventListener('focus', f)", "core.on('relay-bell', f)", "// T.event.listen('x')", 'const prevent = 1', "const s = 'a __TAURI__ here'"],
    foreignListen: ['native.listen(namesJson)', "window.addEventListener('focus', f)", "// listen('relay-bell') 只在註解", "core.on('relay-bell', f)", 'const unlistened = 1', 'stopListen()'],
  }
  for (const [rule, list] of Object.entries(bad)) for (const code of list) assert.equal(DETECT[rule](stripComments(code)), true, `${rule} 要抓得到：${code}`)
  for (const [rule, list] of Object.entries(good)) for (const code of list) assert.equal(DETECT[rule](stripComments(code)), false, `${rule} 不該誤抓：${code}`)
})

test('偵測器：G4／G6 的訂閱處抽取抓得到字串、常數、鏈式 core?.hub，並解得出常數名', () => {
  const files = [
    { name: 'lib/a.mjs', src: "export const FRAME_EVENT = 'term-view-frame'\n// hub.subscribe('x-in-comment', f)\nconst off = hub.subscribe(FRAME_EVENT, f)\nh.subscribe('relay-bell', g)\nprops.eventHub.subscribe('asn:state', g)" },
    { name: 'lib/b.mjs', src: "import { FRAME_EVENT } from './a.mjs'\ncore?.hub.on('relay-bell', f)\nother.on('not-a-hub', f)\nhub.subscribe(FRAME_EVENT, f)" },
  ]
  assert.deepEqual(sitesOf(files, files[0]).map((x) => x.evt), ['term-view-frame', 'relay-bell', 'asn:state'])
  assert.deepEqual(sitesOf(files, files[1]).map((x) => x.evt), ['relay-bell', 'term-view-frame'], '別人的 .on 不算、import 來的常數要解開')
  assert.deepEqual(readyForNames(files, { name: 'lib/a.mjs', src: "await hub.readyFor([FRAME_EVENT, 'asn:log'])\n" + files[0].src }), ['term-view-frame', 'asn:log'])
})

// ---------- G1～G3 ----------
test('G1 不 import tauri.mjs 的 listen／once', () => checkRatchet('G1 import listen', hits(uiFiles, 'importListen'), ALLOW.importListen))
test('G2 不直接碰 Tauri 事件 API（只有橋的出口與 skin-boot.js）', () => checkRatchet('G2 Tauri 事件 API', hits(uiFiles, 'tauriEvent'), ALLOW.tauriEvent))
test('G3 不呼叫別人傳進來的 listen（語音辨識的 native.listen 不是事件）', () => checkRatchet('G3 listen 呼叫', hits(uiFiles, 'foreignListen'), ALLOW.foreignListen))

// ---------- G4 事件名只能從表來 ----------
test('G4 hub 的 on／subscribe／readyFor 用到的事件名都在事件表裡', () => {
  const unknown = []
  const unresolved = []
  const chained = []
  for (const f of uiFiles) {
    if (INFRA.has(f.name)) continue
    for (const x of sitesOf(uiFiles, f)) {
      if (/^lib\/tauri\.mjs$/.test(f.name)) continue
      if (x.chain) { chained.push(`${f.name}:${x.recv}.${x.how}(${x.evt ?? x.id})`); continue }
      if (x.evt === null) { unresolved.push(`${f.name}:${x.recv}.${x.how}(${x.id})`); continue }
      const internal = INTERNAL.has(x.evt) && /^core$/.test(x.recv)
      if (!TABLE.has(x.evt) && !internal) unknown.push(`${f.name}:${x.evt}`)
    }
    for (const n of readyForNames(uiFiles, f)) if (n === null || !TABLE.has(n)) unknown.push(`${f.name}:readyFor ${n}`)
  }
  for (const t of tauriSites(uiFiles.find((f) => f.name === 'lib/tauri.mjs'))) if (!TABLE.has(t.evt)) unknown.push(`lib/tauri.mjs:${t.evt}`)
  assert.deepEqual(chained, [], `這些 .on／.subscribe 接在別的呼叫後面，看不出是哪一座 hub（請拆成 const X = …，再用 X.subscribe／X.on）：${chained.join('、')}`)
  assert.deepEqual(unresolved, [], `這些訂閱的事件名解不出來（請用字串或同檔／import 的常數）：${unresolved.join('、')}`)
  assert.deepEqual(unknown, [], `這些事件名不在 lib/rust-events.mjs 的表裡（先登記再用）：${unknown.join('、')}`)
})

test('G4 視窗之間送出的事件名（emit／broadcast／sendTo）都是表裡登記的 JS 事件', () => {
  const js = new Set(jsEventNames())
  const bad = []
  const unresolved = []
  for (const f of uiFiles) {
    if (INFRA.has(f.name) || f.name === 'lib/tauri.mjs') continue
    for (const { evt, raw } of emitSitesOf(uiFiles, f)) {
      if (evt === null) unresolved.push(`${f.name}:${raw}`)
      else if (!js.has(evt)) bad.push(`${f.name}:${evt}`)
    }
  }
  assert.deepEqual(unresolved, [], `這些送出的事件名解不出來（請用字串或同檔／import 的常數）：${unresolved.join('、')}`)
  assert.deepEqual(bad, [], `這些送出的事件沒有登記成 JS 事件（origin:'js'）：${bad.join('、')}`)
})

// ---------- G5 表裡的事件前端有人接 ----------
const NO_SUBSCRIBER_ALLOW = {
  'asn:skin': 'skin-boot.js 是 classic script，用 Tauri 事件直接聽，不經 hub',
}
test('G5 事件表裡登記的事件，前端真的有人接（listeners:0 與白名單除外）', () => {
  const got = new Set()
  for (const f of uiFiles) {
    if (INFRA.has(f.name) || f.name === 'lib/tauri.mjs') continue
    for (const x of sitesOf(uiFiles, f)) if (x.evt) got.add(x.evt)
    for (const n of readyForNames(uiFiles, f)) if (n) got.add(n)
  }
  for (const t of tauriSites(uiFiles.find((f) => f.name === 'lib/tauri.mjs'))) got.add(t.evt)
  const missing = [...TABLE].filter((n) => !got.has(n) && RUST_EVENTS[n].listeners !== 0 && !(n in NO_SUBSCRIBER_ALLOW))
  assert.deepEqual(missing, [], `表裡登記了、前端卻沒人接（要嘛補接收處，要嘛在表裡標 listeners:0）：${missing.join('、')}`)
  const stale = Object.keys(NO_SUBSCRIBER_ALLOW).filter((n) => got.has(n))
  assert.deepEqual(stale, [], `白名單裡這些事件其實已經有人接了，請刪掉：${stale.join('、')}`)
  const zero = Object.keys(RUST_EVENTS).filter((n) => RUST_EVENTS[n].listeners === 0 && got.has(n))
  assert.deepEqual(zero, [], `標了 listeners:0 卻有人接，請改表：${zero.join('、')}`)
})

// ---------- G6 同一個事件名，同一扇視窗只准在一座 hub 訂閱 ----------
test('G6 同一個事件名在同一扇視窗只被一座 hub 訂閱（tauri 模組層／initFrame／core.hub／createWindowHub 各算一座）', () => {
  const { windows, problems } = analyze(uiFiles)
  assert.deepEqual(problems, [])
  const found = dupsOf(windows)
  const keyOf = (s) => s.replace(/（.*$/, '')
  const extra = found.filter((d) => !(keyOf(d) in HUB_DUP_ALLOW))
  assert.deepEqual(extra, [], `同一視窗同一事件被兩座以上的 hub 訂閱（會註冊兩次、各收一份）：${extra.join('；')}`)
  const stale = Object.keys(HUB_DUP_ALLOW).filter((k) => !found.some((d) => keyOf(d) === k))
  assert.deepEqual(stale, [], `白名單裡這些已經沒有重複，請刪掉：${stale.join('、')}`)
  // 有掃到東西才算數（防假綠）
  assert.ok(Object.keys(windows).length >= 5, '視窗入口檔太少')
  assert.ok(windows['list.js'].size > 10 && windows['chat.js'].size > 5 && windows['m.js'].size > 5, '各視窗的訂閱表是空的，分析壞了')
  assert.ok(windows['chat.js'].has('term-view-frame') && windows['list.js'].has('asn:cmd'), '常數與 core.hub 的訂閱要解得出來')
})

test('G6 LIB_WIRING 棘輪：登記的 lib 檔真的有訂閱、真的被該視窗載入；有訂閱的 lib 檔都登記了', () => {
  const { libSites } = analyze(uiFiles)
  const unwired = [...libSites.keys()].filter((n) => !(n in LIB_WIRING))
  assert.deepEqual(unwired, [], `這些 lib 檔會訂閱事件、但沒登記它拿到哪座 hub（寫進 LIB_WIRING）：${unwired.join('、')}`)
  const noSites = Object.keys(LIB_WIRING).filter((n) => !libSites.has(n))
  assert.deepEqual(noSites, [], `LIB_WIRING 裡這些 lib 檔已經沒有訂閱，請刪掉：${noSites.join('、')}`)
  for (const [lib, per] of Object.entries(LIB_WIRING)) {
    for (const entry of Object.keys(per)) assert.ok(closureOf(uiFiles, entry).has(lib), `LIB_WIRING：${entry} 沒有載入 ${lib}，請刪掉這筆`)
  }
})

test('G6 注入式測試：餵假的 ui 檔，兩座 hub 訂同名事件要紅，移掉就轉綠', () => {
  const tauri = "export const createWindowHub = () => 1\nif (T?.event) createWindowHub().subscribe('relay-bell', f)\nexport async function initFrame(hub = createWindowHub()) {\n  hub.on('asn:frame', f)\n}\n"
  const entry = (extra) => `import { createWindowHub, initFrame } from './lib/tauri.mjs'\nawait initFrame()\nconst eventHub = createWindowHub()\neventHub.subscribe('asn:state', f)\n${extra}\n`
  const mk = (extra, libSrc = '') => [{ name: 'lib/tauri.mjs', src: tauri }, { name: 'w.js', src: entry(extra) + (libSrc ? "import './lib/x.mjs'\n" : '') }, { name: 'lib/x.mjs', src: libSrc }]
  // 壞：視窗自己的 hub 又訂了 tauri.mjs 模組層那座已經訂的事件
  assert.deepEqual(dupsOf(analyze(mk("eventHub.subscribe('relay-bell', g)")).windows), ['w.js:relay-bell（tauri-module、win:eventHub）'])
  // 壞：視窗另外直接 createWindowHub().subscribe 一座，訂了 initFrame 已訂的事件
  assert.deepEqual(dupsOf(analyze(mk("createWindowHub().subscribe('asn:frame', g)")).windows), ['w.js:asn:frame（initFrame、win:inline#0）'])
  // 壞：initFrame 那座與視窗的 hub 都訂 asn:frame
  assert.deepEqual(dupsOf(analyze(mk("eventHub.on('asn:frame', g)")).windows), ['w.js:asn:frame（initFrame、win:eventHub）'])
  // 壞：lib 檔收到的 hub 和入口自己的 hub 不同座、卻訂同名事件
  const wired = { 'lib/x.mjs': { 'w.js': 'core' } }
  assert.deepEqual(dupsOf(analyze(mk('', "export const w = (hub) => hub.subscribe('asn:state', f)"), wired).windows), ['w.js:asn:state（win:eventHub、core）'])
  // 好：移掉壞字就綠
  assert.deepEqual(dupsOf(analyze(mk('')).windows), [])
  assert.deepEqual(dupsOf(analyze(mk('', "export const w = (hub) => hub.subscribe('asn:log', f)"), wired).windows), [])
  // 好：同一座 hub 訂兩次同名不算（同一座底層只註冊一次）
  assert.deepEqual(dupsOf(analyze(mk("eventHub.subscribe('asn:state', g)")).windows), [])
  // 判不出 hub 的 subscribe 要被點名，不能悄悄略過
  assert.equal(analyze(mk("mystery.subscribe('asn:log', g)")).problems.length, 1)
})

test('G6 注入式測試：第二座 hub 改用 .on、createWindowHub 非單純用法、lib 沒登記，都要紅，移掉就轉綠', () => {
  const tauri = 'export const createWindowHub = () => 1\n'
  const entry = (extra) => `import { createWindowHub } from './lib/tauri.mjs'\nconst eventHub = createWindowHub()\neventHub.subscribe('asn:state', f)\n${extra}\n`
  const mk = (extra, libSrc = '') => [{ name: 'lib/tauri.mjs', src: tauri }, { name: 'w.js', src: entry(extra) + (libSrc ? "import './lib/x.mjs'\n" : '') }, { name: 'lib/x.mjs', src: libSrc }]
  const libSub = "export const w = (hub) => hub.subscribe('asn:log', f)"
  // 壞：第二座 hub 用 .on 訂同名事件（原本只有 .subscribe 才抓得到）
  assert.deepEqual(dupsOf(analyze(mk("const hub2 = createWindowHub()\nhub2.on('asn:state', g)")).windows), ['w.js:asn:state（win:eventHub、win:hub2）'])
  assert.deepEqual(dupsOf(analyze(mk("const hub2 = createWindowHub()\nhub2.subscribe('asn:state', g)")).windows), ['w.js:asn:state（win:eventHub、win:hub2）'])
  assert.deepEqual(dupsOf(analyze(mk("createWindowHub().on('asn:state', g)")).windows), ['w.js:asn:state（win:eventHub、win:inline#0）'])
  // 好：第二座 hub 訂別的事件、或移掉
  assert.deepEqual(dupsOf(analyze(mk("const hub2 = createWindowHub()\nhub2.on('asn:log', g)")).windows), [])
  // 壞：createWindowHub() 不是單純寫法（傳進函式、放進物件、三元、接在別的呼叫後面）要點名
  for (const bad of ["setup(createWindowHub())", "const o = { hub: createWindowHub() }", "const h3 = ok ? createWindowHub() : null", "const off = createWindowHub().readyFor(['asn:log'])"]) {
    assert.equal(analyze(mk(bad)).problems.length, 1, `要點名：${bad}`)
  }
  assert.equal(analyze(mk('')).problems.length, 0)
  assert.equal(analyze(mk("createWindowHub().subscribe('asn:log', g)")).problems.length, 0)
  // 壞：入口載入了會訂閱的 lib、LIB_WIRING 沒登記這扇視窗（原本直接略過）
  assert.equal(analyze(mk('', libSub), {}).problems.length, 1)
  assert.equal(analyze(mk('', libSub), { 'lib/x.mjs': { 'other.js': 'core' } }).problems.length, 1)
  // 好：登記了 hub、或登記 none 並附原因
  assert.equal(analyze(mk('', libSub), { 'lib/x.mjs': { 'w.js': 'core' } }).problems.length, 0)
  assert.equal(analyze(mk('', libSub), { 'lib/x.mjs': { 'w.js': 'none:只借純函式' } }).problems.length, 0)
  // 壞：none 沒附原因
  assert.equal(analyze(mk('', libSub), { 'lib/x.mjs': { 'w.js': 'none' } }).problems.length, 1)
  // 好：入口沒載入那個 lib，不需要登記
  assert.equal(analyze(mk('')).problems.length, 0)
})

test('G4 注入式測試：事件名三種引號都認、反引號帶 ${}／變數事件名要點名（訂閱端與 emit 一致）', () => {
  const files = (src) => [{ name: 'w.js', src: "import { emit } from './lib/tauri.mjs'\nconst eventHub = createWindowHub()\nconst NAME = `asn:state`\n" + src }]
  const evts = (src) => { const f = files(src); return sitesOf(f, f[0]).map((x) => x.evt) }
  assert.deepEqual(evts("eventHub.subscribe('a-x', f)\neventHub.subscribe(\"b-x\", f)\neventHub.on(`c-x`, f)\neventHub.on(NAME, f)"), ['a-x', 'b-x', 'c-x', 'asn:state'])
  assert.deepEqual(evts('createWindowHub().subscribe("d-x", f)'), ['d-x'])
  // 認不出來的：${}、運算式、沒宣告的變數、字面值串接
  for (const bad of ['eventHub.on(`a-${k}`, f)', "eventHub.on('a-' + k, f)", 'eventHub.subscribe(evtName, f)', 'eventHub.subscribe(pick(x), f)', 'eventHub.on(obj.name, f)']) assert.deepEqual(evts(bad), [null], `要認不出來：${bad}`)
  // emit／broadcast／sendTo 同一套規則
  const em = (src) => { const f = files(src); return emitSitesOf(f, f[0]).map((x) => x.evt) }
  assert.deepEqual(em("emit('a-x', 1)\nemit(\"b-x\", 1)\nemit(`c-x`, 1)\nhub.broadcast(\"d-x\", 1)\nhub.sendTo(w, `e-x`, 1)\nemit(NAME, 1)"), ['a-x', 'b-x', 'c-x', 'asn:state', 'd-x', 'e-x'])
  for (const bad of ['emit(`a-${k}`, 1)', 'emit(evtName, 1)', 'hub.broadcast(`a-${k}`, 1)', "hub.sendTo(w, 'a-' + k, 1)"]) assert.deepEqual(em(bad), [null], `要認不出來：${bad}`)
  // readyFor 同理
  const rf = (src) => { const f = files(src); return readyForNames(f, f[0]) }
  assert.deepEqual(rf("hub.readyFor(['a-x', \"b-x\", `c-x`, NAME])"), ['a-x', 'b-x', 'c-x', 'asn:state'])
  assert.deepEqual(rf('hub.readyFor([`a-${k}`, other])'), [null, null])
  assert.deepEqual(rf('hub.readyFor(list)'), [null])
  // .on 的接收者：hub／Hub 結尾與 .hub 屬性都算，別的 .on 不算
  assert.deepEqual(evts("props.hub.on('a-x', f)\nmyHub.on('b-x', f)\nstate.on('c-x', f)"), ['a-x', 'b-x'])
})

// ---------- G7 lib 檔不自己建 hub ----------
// lib 檔的 hub 都是呼叫端傳進來的（LIB_WIRING 登記的就是這個假設）；自己 createWindowHub() 會多出一座 hub，登記就失真。
// 本來就要建 hub 的只有 event-hub.mjs（定義）與 tauri.mjs（橋的出口）。其他例外寫在這張表（只准少、不准多）：檔名 → 原因
const LIB_HUB_BUILDERS = new Set(['lib/event-hub.mjs', 'lib/tauri.mjs'])
const LIB_CREATE_HUB_ALLOW = {
  'lib/core.mjs': 'AsnCore 建構時沒人傳 hub 才建預設那座（this.hub = hub ?? createEventHub(…)）；各視窗的 core.hub 就是這座，是 core.hub 的出處',
}
// createWindowHub( 與 createEventHub( 都算（後者是前者底下的建構函式，自己建一樣會多出一座）；?.( 的寫法也算
const libCreatesHub = (f) => f.name.startsWith('lib/') && !LIB_HUB_BUILDERS.has(f.name) && /\bcreate(?:Window|Event)Hub\s*(?:\?\.)?\s*\(/.test(stripComments(f.src))

test('G7 lib 檔不自己呼叫 createWindowHub()／createEventHub()（hub 由呼叫端傳進來）', () => {
  const found = uiFiles.filter(libCreatesHub).map((f) => f.name)
  const extra = found.filter((n) => !(n in LIB_CREATE_HUB_ALLOW))
  assert.deepEqual(extra, [], `這些 lib 檔自己建了 hub（請改成由呼叫端傳進來，LIB_WIRING 才準）：${extra.join('、')}`)
  const stale = Object.keys(LIB_CREATE_HUB_ALLOW).filter((n) => !found.includes(n))
  assert.deepEqual(stale, [], `白名單裡這些 lib 檔已經沒有自己建 hub，請刪掉：${stale.join('、')}`)
})

test('G7 注入式測試：lib 檔自己 createWindowHub() 要紅，改成收參數要綠', () => {
  assert.equal(libCreatesHub({ name: 'lib/voice-ui.mjs', src: "const h = createWindowHub()\nh.subscribe('asn:state', f)" }), true)
  assert.equal(libCreatesHub({ name: 'lib/voice-ui.mjs', src: "createWindowHub().subscribe('asn:state', f)" }), true)
  assert.equal(libCreatesHub({ name: 'lib/voice-ui.mjs', src: "export const w = (hub) => hub.subscribe('asn:state', f)" }), false)
  assert.equal(libCreatesHub({ name: 'lib/voice-ui.mjs', src: "// createWindowHub() 只在註解" }), false)
  assert.equal(libCreatesHub({ name: 'lib/tauri.mjs', src: 'const h = createWindowHub()' }), false)
  assert.equal(libCreatesHub({ name: 'w.js', src: 'const h = createWindowHub()' }), false)
  // createEventHub( 也算（自建 hub 的另一個入口）
  for (const bad of ["const h = createEventHub({ listen })", "createEventHub().subscribe('asn:state', f)", "const h = createEventHub ( { } )", "const h = createEventHub?.({})"]) {
    assert.equal(libCreatesHub({ name: 'lib/voice-ui.mjs', src: bad }), true, `要紅：${bad}`)
  }
  assert.equal(libCreatesHub({ name: 'lib/voice-ui.mjs', src: "import { createEventHub } from './event-hub.mjs'\nexport const w = (hub) => hub.subscribe('asn:state', f)" }), false, '只 import 沒呼叫不算')
  assert.equal(libCreatesHub({ name: 'lib/voice-ui.mjs', src: "// createEventHub() 只在註解" }), false)
  assert.equal(libCreatesHub({ name: 'lib/event-hub.mjs', src: 'const h = createEventHub()' }), false, 'event-hub.mjs 本身是定義處')
  assert.equal(libCreatesHub({ name: 'lib/tauri.mjs', src: 'const h = createEventHub()' }), false)
  assert.equal(libCreatesHub({ name: 'w.js', src: 'const h = createEventHub()' }), false, '入口檔不歸 G7 管')
  // 例外只有登記在 LIB_CREATE_HUB_ALLOW 的 core.mjs：它沒登記就紅（棘輪由上面的 G7 測試負責）
  assert.equal(libCreatesHub({ name: 'lib/core.mjs', src: 'this.hub = hub ?? createEventHub({})' }), true)
  assert.deepEqual(Object.keys(LIB_CREATE_HUB_ALLOW), ['lib/core.mjs'])
})

test('偵測器：?. 可選呼叫的 readyFor／emit／broadcast／sendTo 不能繞過（壞字抓得到、好字不誤抓）', () => {
  const files = (src) => [{ name: 'w.js', src: "import { emit } from './lib/tauri.mjs'\nconst NAME = 'asn:state'\n" + src }]
  const rf = (src) => { const f = files(src); return readyForNames(f, f[0]) }
  const em = (src) => { const f = files(src); return emitSitesOf(f, f[0]).map((x) => x.evt) }
  const badReady = ["x.readyFor?.(['not-in-table'])", "x?.readyFor(['not-in-table'])", "x.readyFor ?. (['not-in-table'])", "x\n  ?.readyFor?.(['not-in-table'])", "readyFor?.(['not-in-table'])"]
  for (const code of badReady) assert.deepEqual(rf(code), ['not-in-table'], `readyFor 要認得出名字：${code}`)
  assert.deepEqual(rf('x.readyFor?.(list)'), [null], '認不出來的要點名')
  assert.deepEqual(rf('x?.readyFor(`a-${k}`)'), [null])
  assert.deepEqual(rf("x.readyFor?.([NAME, 'asn:log'])"), ['asn:state', 'asn:log'])
  assert.deepEqual(rf("function readyFor(names) { return names }\nconst readyForm = 1"), [], '函式宣告、同字頭的名字不誤抓')
  const badEmit = ["emit?.('not-in-table', 1)", "x.emit?.('not-in-table', 1)", "x?.emit('not-in-table', 1)", "x?.broadcast('not-in-table', 1)", "x.broadcast?.('not-in-table', 1)", "sendTo?.(w, 'not-in-table', 1)", "x?.sendTo(w, 'not-in-table', 1)", "x.sendTo ?. (w, 'not-in-table', 1)", "x\n  ?.broadcast('not-in-table', 1)"]
  for (const code of badEmit) assert.deepEqual(em(code), ['not-in-table'], `送出端要認得出名字：${code}`)
  for (const code of ['emit?.(evtName, 1)', 'x.emit?.(`a-${k}`, 1)', 'x?.broadcast(pick(y), 1)', 'sendTo?.(w, name, 1)']) assert.deepEqual(em(code), [null], `認不出來的要點名：${code}`)
  assert.deepEqual(em("emit?.(NAME, 1)"), ['asn:state'], '常數要解得開')
  // 好：Vue 元件的 ctx.emit(…) 沒有 ?.、本地函式 sendTo(id, text) 不是視窗事件，都不誤抓
  assert.deepEqual(em("ctx.emit('pick', 1)\nsendTo(id, text, opts)\nconst sendTo2 = 1"), [])
})

test('G4 注入式測試：readyFor／emit 用 ?. 寫、事件名不在表就紅，改成表裡的名字就綠', () => {
  const table = new Set(TABLE)
  const js = new Set(jsEventNames())
  const check = (src) => {
    const f = [{ name: 'w.js', src }]
    const badReady = readyForNames(f, f[0]).filter((n) => n === null || !table.has(n))
    const badEmit = emitSitesOf(f, f[0]).filter(({ evt }) => evt === null || !js.has(evt))
    return badReady.length + badEmit.length
  }
  const okJs = jsEventNames()[0]
  const okAny = [...TABLE][0]
  assert.ok(okJs && okAny, '事件表要有可用的名字')
  for (const bad of ["hub.readyFor?.(['not-in-table'])", "hub?.readyFor(['not-in-table'])", "hub.readyFor ?. (['not-in-table'])", "hub.readyFor?.(list)"]) assert.equal(check(bad), 1, `要紅：${bad}`)
  for (const bad of ["emit?.('not-in-table', 1)", "x.emit?.('not-in-table', 1)", "x?.broadcast('not-in-table', 1)", "sendTo?.(w, 'not-in-table', 1)", 'x.emit?.(evtName, 1)']) assert.equal(check(bad), 1, `要紅：${bad}`)
  for (const good of [`hub.readyFor?.(['${okAny}'])`, `hub?.readyFor(['${okAny}'])`, `emit?.('${okJs}', 1)`, `x.emit?.('${okJs}', 1)`, `x?.broadcast('${okJs}', 1)`, `sendTo?.(w, '${okJs}', 1)`]) assert.equal(check(good), 0, `要綠：${good}`)
})

test('G4／G6 注入式測試：串接、換行、?. 三種寫法不能繞過（要紅），改成正常寫法要綠', () => {
  const tauri = 'export const createWindowHub = () => 1\n'
  const entry = (extra) => `import { createWindowHub } from './lib/tauri.mjs'\nconst eventHub = createWindowHub()\neventHub.subscribe('asn:state', f)\n${extra}\n`
  const mk = (extra, libSrc = '') => [{ name: 'lib/tauri.mjs', src: tauri }, { name: 'w.js', src: entry(extra) + (libSrc ? "import './lib/x.mjs'\n" : '') }, { name: 'lib/x.mjs', src: libSrc }]
  const w = (extra) => { const f = mk(extra); return sitesOf(f, f[1]) }
  // 事件名解析：三種寫法都要抓得到事件名
  assert.deepEqual(w("eventHub.on('asn:log', f).on('not-in-table', g)").map((x) => x.evt), ['asn:state', 'asn:log', 'not-in-table'])
  assert.deepEqual(w("eventHub\n  .subscribe('not-in-table', f)").map((x) => x.evt), ['asn:state', 'not-in-table'])
  assert.deepEqual(w("eventHub.on?.('not-in-table', f)").map((x) => x.evt), ['asn:state', 'not-in-table'])
  assert.deepEqual(w("eventHub?.subscribe('not-in-table', f)").map((x) => x.evt), ['asn:state', 'not-in-table'])
  // 串接：第二段的接收者看不出來 → chain，G4 會點名、G6 的 analyze 也有 problem
  const chained = w("eventHub.on('asn:log', f).on('not-in-table', g)")
  assert.deepEqual(chained.map((x) => x.chain), [false, false, true])
  assert.equal(w("eventHub.on('asn:log', f)\n  .on('not-in-table', g)").filter((x) => x.chain).length, 1, '串接換行也算')
  assert.equal(w("eventHub.on('asn:log', f)?.on('x-y', g)").filter((x) => x.chain).length, 1, '串接加 ?. 也算')
  assert.equal(w("list[0].on('x-y', g)").filter((x) => x.chain).length, 1, '] 後面接 .on 也算')
  assert.equal(analyze(mk("eventHub.on('asn:log', f).on('not-in-table', g)")).problems.length, 1)
  // 換行／?. 的第二座 hub 訂同名事件，G6 要抓得到
  assert.deepEqual(dupsOf(analyze(mk("const hub2 = createWindowHub()\nhub2\n  .on('asn:state', g)")).windows), ['w.js:asn:state（win:eventHub、win:hub2）'])
  assert.deepEqual(dupsOf(analyze(mk("const hub2 = createWindowHub()\nhub2.on?.('asn:state', g)")).windows), ['w.js:asn:state（win:eventHub、win:hub2）'])
  assert.deepEqual(dupsOf(analyze(mk("const hub2 = createWindowHub()\nhub2?.subscribe('asn:state', g)")).windows), ['w.js:asn:state（win:eventHub、win:hub2）'])
  assert.deepEqual(dupsOf(analyze(mk("createWindowHub()\n  .on('asn:state', g)")).windows), ['w.js:asn:state（win:eventHub、win:inline#0）'])
  // lib 檔裡的串接也要點名
  assert.equal(analyze(mk('', "export const w = (hub) => hub.on('asn:log', f).on('asn:cmd', g)"), { 'lib/x.mjs': { 'w.js': 'core' } }).problems.length, 1)
  // 好：拆成正常寫法就綠，且不誤抓別的 .on
  assert.equal(w("eventHub.on('asn:log', f)\neventHub.on('asn:cmd', g)").filter((x) => x.chain).length, 0)
  assert.equal(analyze(mk("eventHub.on('asn:log', f)\neventHub.on('asn:cmd', g)")).problems.length, 0)
  assert.equal(w("state\n  .on('c-x', f)").length, 1, '別人的 .on（換行）不算')
})

test('G1～G3 注入式測試：餵假檔，違規要紅，移掉轉綠', () => {
  const run = (src) => ['importListen', 'tauriEvent', 'foreignListen'].filter((r) => hits([{ name: 'fake.js', src }], r).length)
  assert.deepEqual(run("import { listen } from './lib/tauri.mjs'\nawait listen('relay-bell', f)\nT.event.once('x', f)"), ['importListen', 'tauriEvent', 'foreignListen'])
  assert.deepEqual(run("import { invoke } from './lib/tauri.mjs'\ncore.hub.on('relay-bell', f)\nnative.listen('[]')"), [])
})
