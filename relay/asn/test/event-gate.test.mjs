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
// 例外名單只有兩個：tauri.mjs（橋的出口）與 skin-boot.js（classic script，要早於 Vue 套外觀）。
// 等 #1763 F3 的 host.mjs 落地、tauri.mjs 改走 host 之後，例外會改成 skin-boot.js 與 host.mjs；到時只改 ALLOW 表。
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
    'lib/tauri.mjs': '橋的出口：全前端唯一向 Tauri 註冊事件、送事件的地方（F3 host.mjs 落地後，例外改成 host.mjs）',
    'skin-boot.js': 'classic script：要早於 Vue 套好外觀、不能 import，只聽 asn:skin',
  },
  foreignListen: {
    'lib/tauri.mjs': '橋的出口：自己定義 listen 並注入事件中心（F3 host.mjs 落地後，例外改成 host.mjs）',
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
const HUB_ON_RECV = /^(core|core\??\.hub|hub|eventHub|props\.eventHub|deps\.hub|h)$/
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
  const re = new RegExp(`(?:export\\s+)?const\\s+${id}\\s*=\\s*'([^']+)'`)
  const own = re.exec(stripComments(file.src))
  if (own) return own[1]
  const im = new RegExp(`import\\s*\\{[^}]*\\b${id}\\b[^}]*\\}\\s*from\\s*['"](\\.[^'"]+)['"]`).exec(stripComments(file.src))
  const dep = im && files.find((f) => f.name === normName(file.name, im[1]))
  return dep ? constOf(files, dep, id) : null
}
// 一個檔裡所有「這個接收者訂了這個事件」：{ recv, evt, id }（evt 解不出來就是 null）
export const sitesOf = (files, file) => {
  const s = stripComments(file.src)
  const out = []
  for (const m of s.matchAll(/([\w$][\w$.?]*)\.(subscribe|on)\(\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))/g)) {
    const [, rawRecv, how, lit, id] = m
    const recv = rawRecv.replace(/\?$/, '')   // h?.subscribe → h
    // .on 只算 hub 類接收者；.subscribe 在入口檔一律算（判不出是哪座 hub 要被點名），在 lib 檔要是 hub 類接收者（別的訂閱制物件，例如 recentShown，不是事件中心）
    if ((how === 'on' || !isEntry(file.name)) && !HUB_ON_RECV.test(recv)) continue
    out.push({ recv, how, evt: lit ?? (id ? constOf(files, file, id) : null), id })
  }
  return out
}
const readyForNames = (files, file) => [...stripComments(file.src).matchAll(/\.readyFor\(\s*\[([^\]]*)\]/g)].flatMap((m) => m[1].split(',').map((x) => x.trim()).filter(Boolean).map((x) => (/^'[^']+'$/.test(x) ? x.slice(1, -1) : constOf(files, file, x))))

// tauri.mjs 自己的訂閱：模組層那座 hub、initFrame 預設那座 hub、以及直接 listen 的（relay-report-bell 走 listen 回呼）
const tauriSites = (file) => {
  const s = stripComments(file.src)
  const out = []
  const fi = s.indexOf('export async function initFrame')
  const frameBody = fi < 0 ? '' : s.slice(fi, s.indexOf('\n}', fi))
  for (const m of s.matchAll(/createWindowHub\(\)\s*\.subscribe\(\s*'([^']+)'/g)) out.push({ evt: m[1], hub: 'tauri-module' })
  for (const m of frameBody.matchAll(/\bhub\.(?:on|subscribe)\(\s*'([^']+)'/g)) out.push({ evt: m[1], hub: 'initFrame' })
  for (const m of s.matchAll(/(?<![\w$.])listen\(\s*'([^']+)'/g)) out.push({ evt: m[1], hub: 'tauri-direct-listen' })
  return out
}

// 哪些 lib 檔的 hub 是呼叫端傳進來的：lib 檔 → { 視窗入口檔: 該視窗傳給它的 hub }。原因都寫在這裡；新增訂閱的 lib 檔沒登記就紅，登記了卻沒訂閱也紅（棘輪）
export const LIB_WIRING = {
  'lib/account-events.mjs': { 'list.js': 'core' },
  'lib/agent-install.mjs': { 'list.js': 'core' },
  'lib/notice-events.mjs': { 'list.js': 'core', 'm.js': 'core' },
  'lib/progress-events.mjs': { 'list.js': 'core', 'm.js': 'core' },
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
    const ss = sitesOf(files, f).filter((x) => x.how === 'subscribe' || HUB_ON_RECV.test(x.recv))
    if (ss.length) libSites.set(f.name, ss)
  }
  for (const entry of files.filter((f) => isEntry(f.name))) {
    const close = closureOf(files, entry.name)
    const per = new Map()
    const add = (evt, hub) => { if (evt) per.set(evt, new Set([...(per.get(evt) ?? []), hub])) }
    const entrySrc = stripComments(entry.src)
    const winVars = new Set([...entrySrc.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*createWindowHub\s*\(/g)].map((m) => m[1]))
    if (tauriFile && close.has('lib/tauri.mjs')) {
      for (const t of tauriSites(tauriFile)) if (t.hub !== 'initFrame' || /\binitFrame\s*\(/.test(entrySrc)) add(t.evt, t.hub)
    }
    // 直接 createWindowHub().subscribe('x'…) 的寫法：每一處都是獨立的一座 hub
    ;[...entrySrc.matchAll(/createWindowHub\s*\(\s*\)\s*\.(?:subscribe|on)\(\s*'([^']+)'/g)].forEach((m, i) => add(m[1], `win:inline#${i}`))
    for (const x of sitesOf(files, entry)) {
      const hub = /^core(\??\.hub)?$/.test(x.recv) ? 'core' : winVars.has(x.recv) ? `win:${x.recv}` : null
      if (!hub) { if (x.how === 'subscribe') problems.push(`${entry.name}：${x.recv}.subscribe(${x.evt ?? x.id}) 的 hub 判定不出來（請改用 createWindowHub() 或 core.hub）`); continue }
      if (hub === 'core' && INTERNAL.has(x.evt)) continue
      add(x.evt, hub)
    }
    for (const [lib, ss] of libSites) {
      const hub = wiring[lib]?.[entry.name]
      if (!hub || !close.has(lib)) continue
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
  for (const f of uiFiles) {
    if (INFRA.has(f.name)) continue
    for (const x of sitesOf(uiFiles, f)) {
      if (x.how === 'on' && !HUB_ON_RECV.test(x.recv)) continue
      if (/^lib\/tauri\.mjs$/.test(f.name)) continue
      if (x.evt === null) { unresolved.push(`${f.name}:${x.recv}.${x.how}(${x.id})`); continue }
      const internal = INTERNAL.has(x.evt) && /^core$/.test(x.recv)
      if (!TABLE.has(x.evt) && !internal) unknown.push(`${f.name}:${x.evt}`)
    }
    for (const n of readyForNames(uiFiles, f)) if (n === null || !TABLE.has(n)) unknown.push(`${f.name}:readyFor ${n}`)
  }
  for (const t of tauriSites(uiFiles.find((f) => f.name === 'lib/tauri.mjs'))) if (!TABLE.has(t.evt)) unknown.push(`lib/tauri.mjs:${t.evt}`)
  assert.deepEqual(unresolved, [], `這些訂閱的事件名解不出來（請用字串或同檔／import 的常數）：${unresolved.join('、')}`)
  assert.deepEqual(unknown, [], `這些事件名不在 lib/rust-events.mjs 的表裡（先登記再用）：${unknown.join('、')}`)
})

test('G4 視窗之間送出的事件名（emit／broadcast／sendTo）都是表裡登記的 JS 事件', () => {
  const js = new Set(jsEventNames())
  const bad = []
  for (const f of uiFiles) {
    if (INFRA.has(f.name) || f.name === 'lib/tauri.mjs') continue
    const s = stripComments(f.src)
    const names = []
    if (importsOf(s).includes('emit')) for (const m of s.matchAll(/(?<![\w$.])emit\(\s*'([^']+)'/g)) names.push(m[1])
    for (const m of s.matchAll(/\.(?:broadcast)\(\s*'([^']+)'/g)) names.push(m[1])
    for (const m of s.matchAll(/\.sendTo\(\s*[^,]+,\s*'([^']+)'/g)) names.push(m[1])
    for (const n of names) if (!js.has(n)) bad.push(`${f.name}:${n}`)
  }
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

test('G1～G3 注入式測試：餵假檔，違規要紅，移掉轉綠', () => {
  const run = (src) => ['importListen', 'tauriEvent', 'foreignListen'].filter((r) => hits([{ name: 'fake.js', src }], r).length)
  assert.deepEqual(run("import { listen } from './lib/tauri.mjs'\nawait listen('relay-bell', f)\nT.event.once('x', f)"), ['importListen', 'tauriEvent', 'foreignListen'])
  assert.deepEqual(run("import { invoke } from './lib/tauri.mjs'\ncore.hub.on('relay-bell', f)\nnative.listen('[]')"), [])
})
