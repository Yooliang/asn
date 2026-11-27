// 架構守門（#1763 T5，規劃第 1.1 節與 3.1 節 D 類）：掃 ui/lib、ui/parts、ui/layouts、ui/shells 有沒有出現「這一層不該出現的字」。
// 這是少數允許留下的「原始碼字串」測試，因為它守的是架構規則，不是畫面內容。
//
// 規則（來源：issue #1763 1.1 三層規則）：
//  R1 功能層 lib/：不出現 AsnAndroid、__TAURI__、localStorage／sessionStorage、直接存取 document。
//     這些只能在「平台殼」出現；既有檔案先列白名單（原因寫在表裡），白名單是棘輪——
//     只准少、不准多；某檔已經乾淨了卻還在白名單裡，測試也會紅，逼你把名單改精確。
//  R2 介面元件層 parts/：不 import tauri.mjs、不呼叫 invoke、不讀寫 localStorage、不看平台（AsnAndroid、__TAURI__、userAgent）。
//     parts/ 目前還沒有（階段 1 才建）；沒有就只驗「規則本身抓得到壞字」，建好後自動套用。
//  R3 版面層 layouts/：不出現 invoke、tauri.mjs、localStorage（只決定怎麼擺）。同上，目前還沒有。
//  R4 快照＋指令的元件（現在已是這個形狀的檔案）：只收快照、只送 act，不 import tauri.mjs、不碰存檔與平台。
//  R5 lib 裡「有畫面樣板」的元件直接 import tauri.mjs 的，列白名單（棘輪，原因寫在表裡）。
// 不管「直接呼叫 invoke(」：已由 test/invoke-exit.test.mjs 守。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const UI = fileURLToPath(new URL('../ui', import.meta.url))
const readDir = (sub) => {
  const dir = path.join(UI, sub)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => /\.m?js$/.test(f)).sort().map((f) => ({ name: `${sub}/${f}`, src: fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n') }))
}

// 去掉註解再掃（註解裡提到這些字不算違規）。// 前面是冒號或引號的（網址）不當成註解。
export const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

// 每條規則一個偵測器（好讓下面也能拿壞字餵進去，證明規則抓得到）
export const DETECT = {
  android: (s) => /\bAsnAndroid\b/.test(s),
  tauriGlobal: (s) => /\b__TAURI(?:_[A-Z]+)*__\b/.test(s),   // __TAURI__、__TAURI_INTERNALS__、__TAURI_IPC__ 都算
  storage: (s) => /\b(localStorage|sessionStorage)\b/.test(s),
  // document.x、document?.x、document[x]、f(document)、= document、{ document }／(document, ...)（把整個 document 傳出去）
  document: (s) => /\bdocument\s*(?:\.|\?\.|\[|\))/.test(s) || /[=(,{:]\s*document\b(?![\w$])/.test(s),
  invoke: (s) => /(?<![\w.$])invoke\s*\(/.test(s),
  importsTauri: (s) => /from\s+['"][^'"]*\/tauri\.mjs['"]/.test(s),
  userAgent: (s) => /\bnavigator\s*\.\s*(userAgent|platform)\b/.test(s),
  hasTemplate: (s) => /\btemplate\s*:/.test(s),
}
const hits = (files, rule) => files.filter((f) => DETECT[rule](stripComments(f.src))).map((f) => f.name)

// 白名單：檔名 → 原因。只准少、不准多。
const LIB_ALLOW = {
  android: {
    // mobile-call.mjs 只在註解提到，不算
    'lib/mobile.mjs': '手機殼：androidBridge 的唯一定義處，階段 1 的 F3 會併入 shells/caps-android',
    'lib/mobile-confirm.mjs': '手機確認框的橋接呼叫，F3 併入 caps-android',
  },
  tauriGlobal: {
    'lib/host.mjs': '主機接縫（#1763 F3）：前端讀主機物件的唯一處（skin-boot.js 不在 lib 內；test/host-seam.test.mjs 守整個 ui/）',
  },
  storage: {
    'lib/local-prefs.mjs': '本機偏好的唯一存取處（鍵名由 prefs-keys 測試鎖住）',
  },
  document: {
    'lib/actionbar.mjs': '動作列：量測與焦點，屬 DOM 工具，非設定層',
    'lib/annotator.mjs': '圖片標註畫布',
    'lib/avatar-canvas.mjs': '大頭貼裁切畫布',
    'lib/chatpane.mjs': '聊天窗：捲動、焦點、選取',
    'lib/core.mjs': '核心 DOM 輔助（剪貼簿、焦點）',
    'lib/dialog.mjs': '彈出框：焦點陷阱',
    'lib/photo-canvas.mjs': '圖片畫布',
    'lib/report-bus.mjs': '回報匯流排：全域事件',
    'lib/report-reload.mjs': '回報重載：全域事件',
    'lib/tauri.mjs': '出口：拖曳、全域事件',
    'lib/term-remote-input.mjs': '遠端終端輸入：鍵盤事件',
    'lib/term-remote.mjs': '遠端終端：DOM',
    'lib/term-view.mjs': '終端畫面：DOM',
  },
}
// 現在已是「只收快照、只送 act」的元件檔（規則 R4）
const SNAPSHOT_COMPONENTS = ['lib/settings-panel.mjs', 'lib/task-tree-view.mjs']
// R5：lib 裡有畫面樣板、又直接 import tauri.mjs 的元件
const COMPONENT_TAURI_ALLOW = {
  'lib/chatpane.mjs': '聊天窗整個面板，尚未搬進 shells；階段 5 處理',
  'lib/login-panel.mjs': '登入／登出元件：設定「個人」頁的子元件，C 系列搬家時改成快照＋act',
  'lib/cloud-invite.mjs': '雲端代理邀請元件：設定「雲端」頁的子元件，C 系列搬家時改成快照＋act',
}

const lib = readDir('lib')
const parts = readDir('parts')
const layouts = readDir('layouts')
const shells = readDir('shells')

// 白名單與實際一致（棘輪）：多出來的違規 → 紅；名單裡的檔案其實已乾淨 → 也紅
const checkRatchet = (rule, found, allow) => {
  const extra = found.filter((n) => !(n in allow))
  assert.deepEqual(extra, [], `[${rule}] 這些檔出現了這一層不該出現的字：${extra.join('、')}（要用就搬進平台殼，不要加進功能層／元件層）`)
  const stale = Object.keys(allow).filter((n) => !found.includes(n))
  assert.deepEqual(stale, [], `[${rule}] 白名單裡這些檔已經乾淨，請把它們從 test/arch-guard.test.mjs 的白名單刪掉：${stale.join('、')}`)
}

test('規則偵測器抓得到壞字、不會誤抓註解與一般字（守門自己要有牙齒）', () => {
  const bad = { android: 'const a = window.AsnAndroid', tauriGlobal: 'const T = globalThis.__TAURI__', storage: "localStorage.getItem('x')", document: 'document.querySelector("a")', invoke: "await invoke('x')", importsTauri: "import { authApi } from './tauri.mjs'", userAgent: 'navigator.userAgent' }
  for (const [rule, code] of Object.entries(bad)) {
    assert.equal(DETECT[rule](stripComments(code)), true, `${rule} 要抓得到`)
    assert.equal(DETECT[rule](stripComments(`// ${code}`)), false, `${rule}：註解裡不算`)
    assert.equal(DETECT[rule](stripComments(`/* ${code} */`)), false, `${rule}：區塊註解裡不算`)
  }
  // 各種變形寫法也要抓到（繞過 `document.` 與 `__TAURI__` 的寫法）
  for (const code of ['const d = document', 'const el = document?.body', "document['body']", 'walk(document)', 'init(a, document)', 'const { body } = document', 'x = { document }']) assert.equal(DETECT.document(stripComments(code)), true, `document 變形要抓：${code}`)
  for (const code of ['const documentTitle = 1', 'const a = mydocument.x', 'doc.document = 1', "const s = 'a document here'"]) assert.equal(DETECT.document(stripComments(code)), false, `不誤抓：${code}`)
  for (const code of ['const T = globalThis.__TAURI_INTERNALS__', 'window.__TAURI_IPC__.x', "globalThis['__TAURI__']"]) assert.equal(DETECT.tauriGlobal(stripComments(code)), true, `__TAURI 變形要抓：${code}`)
  assert.equal(DETECT.tauriGlobal(stripComments('const x = my__TAURI__thing')), false)
  assert.equal(DETECT.invoke(stripComments('transport.invoke(1)')), false, '物件的 invoke 方法不是直接呼叫')
  assert.equal(DETECT.document(stripComments('const documentTitle = 1')), false)
  assert.equal(DETECT.android(stripComments("const u = 'https://x.test/AsnAndroidDoc'")), false, '網址裡包在別的字裡不算')
})

test('掃描範圍：lib／parts／layouts／shells 底下不能有子目錄（readDir 不遞迴，子目錄裡的檔案會漏掃）', () => {
  for (const sub of ['lib', 'parts', 'layouts', 'shells']) {
    const dir = path.join(UI, sub)
    if (!fs.existsSync(dir)) continue
    const subdirs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${sub}/${e.name}`)
    assert.deepEqual(subdirs, [], `${sub}/ 出現子目錄：${subdirs.join('、')}。守門只掃一層，要放子目錄請先讓 readDir 改成遞迴`)
  }
})

test('R1 功能層 lib：AsnAndroid 只在 mobile.mjs 與 mobile-confirm.mjs', () => checkRatchet('AsnAndroid', hits(lib, 'android'), LIB_ALLOW.android))
test('R1 功能層 lib：__TAURI__ 只在出口 tauri.mjs', () => checkRatchet('__TAURI__', hits(lib, 'tauriGlobal'), LIB_ALLOW.tauriGlobal))
test('R1 功能層 lib：localStorage／sessionStorage 只在 local-prefs.mjs', () => checkRatchet('localStorage', hits(lib, 'storage'), LIB_ALLOW.storage))
test('R1 功能層 lib：直接存取 document 的檔案只准少、不准多（既有的列白名單）', () => checkRatchet('document', hits(lib, 'document'), LIB_ALLOW.document))

test('R2 介面元件層 parts/：不 import tauri.mjs、不 invoke、不碰存檔與平台（目前還沒有 parts/，建好後自動套用）', () => {
  for (const rule of ['importsTauri', 'invoke', 'storage', 'android', 'tauriGlobal', 'userAgent']) assert.deepEqual(hits(parts, rule), [], `parts/ 出現 ${rule}`)
})

test('R3 版面層 layouts/ 與 R-shell：layouts 不 invoke、不 import tauri.mjs、不碰存檔（目前還沒有；shells/ 是唯一可以看平台的地方，不受限）', () => {
  for (const rule of ['importsTauri', 'invoke', 'storage']) assert.deepEqual(hits(layouts, rule), [], `layouts/ 出現 ${rule}`)
  assert.ok(Array.isArray(shells))
})

test('R4 快照＋指令的元件（設定頁、工作管理員樹）：不 import tauri.mjs、不 invoke、不碰存檔與平台', () => {
  const files = lib.filter((f) => SNAPSHOT_COMPONENTS.includes(f.name))
  assert.deepEqual(files.map((f) => f.name), SNAPSHOT_COMPONENTS, '檔案都在（改名搬家時同步更新這份清單）')
  for (const rule of ['importsTauri', 'invoke', 'storage', 'android', 'tauriGlobal', 'userAgent', 'document']) assert.deepEqual(hits(files, rule), [], `快照元件出現 ${rule}`)
})

test('R5 lib 裡有畫面樣板的元件直接 import tauri.mjs 的，只准少、不准多（既有的列白名單）', () => {
  const comps = lib.filter((f) => DETECT.hasTemplate(stripComments(f.src)))
  assert.ok(comps.length > 10, '有掃到元件檔')
  checkRatchet('元件 import tauri.mjs', hits(comps, 'importsTauri'), COMPONENT_TAURI_ALLOW)
})
