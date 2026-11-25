// #2163 PR-4 前端旗標守門。
// 規則一：ui/（vendor 除外）底下，flags.mjs 以外的檔案不准宣告旗標常數，也不准讀冒煙掛勾 globalThis.__smoke*。
//   「旗標常數」＝頂層的 const／let／var，名字全大寫加底線，而且符合其中一個：
//   a) 值是 true／false；b) 名字以 _UI、_BTN、_READY、_ENABLED、_ON、_OFF 結尾；c) 名字含 _VIA_；d) 名字以 ENABLE_ 開頭。
//   只看行首（頂層宣告），註解行與縮排的區域變數不算。
// 規則二：flags.mjs 登記表的每一項，都要在 docs/設定值清單.md 的「前端旗標」一節有一列，名稱、值、用途一致，反過來也一樣。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as flagsMod from '../ui/lib/flags.mjs'

const { FLAGS } = flagsMod
const ROOT = new URL('../', import.meta.url)
const UI = new URL('ui/', ROOT)
const DOC = new URL('../../../docs/設定值清單.md', import.meta.url)
const FLAGS_FILE = 'ui/lib/flags.mjs'

const DECL = /^(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*=\s*([^\n]*)/gm
const FLAG_NAME = /(?:_UI|_BTN|_READY|_ENABLED|_ON|_OFF)$|^ENABLE_/
const VIA_NAME = /_VIA_/   // 名字含 _VIA_：值是字串、陣列、物件的是一般常數（例如 PI_VIA_LABEL），其餘一律當旗標
const PLAIN_VALUE = /^(?:['"`\[{]|\d)/
const SMOKE_HOOK = /(?:globalThis|window|self)\s*\.\s*__smoke\w*|(?:globalThis|window|self)\s*\[\s*['"]__smoke/g

/** 掃一段原始碼，回傳違規清單（宣告旗標常數、讀冒煙掛勾）。純函式，給守門與自我測試共用 */
export function scanFlagViolations(text) {
  const out = []
  for (const m of text.replace(/\r\n/g, '\n').matchAll(DECL)) {
    const [, name, rhs] = m
    const isBool = /^(?:true|false)\b/.test(rhs.trim())
    const via = VIA_NAME.test(name) && !PLAIN_VALUE.test(rhs.trim())
    if (isBool || via || FLAG_NAME.test(name)) out.push(`旗標常數 ${name}`)
  }
  for (const m of text.matchAll(SMOKE_HOOK)) out.push(`冒煙掛勾 ${m[0].replace(/\s+/g, '')}`)
  return out
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'node_modules') walk(p, acc) } else if (/\.(mjs|js)$/.test(e.name)) acc.push(p)
  }
  return acc
}

const uiFiles = walk(fileURLToPath(UI))
const rel = f => path.relative(fileURLToPath(ROOT), f).split(path.sep).join('/')

test('#2163 自我測試：掃描規則抓得到各種旗標寫法，也不誤抓一般常數', () => {
  const bad = [
    'export const NEW_THING_UI = false',
    'const SOMETHING = true',
    'export const FOO_BTN = 1',
    'const PI_VIA_X = someFn()',
    'const ENABLE_DARK = 0',
    'let HELLO_READY = null',
    "const x = globalThis.__smokeSomething === true",
    "if (window.__smokeInput) {}",
  ]
  for (const s of bad) assert.ok(scanFlagViolations(s).length > 0, `應該抓到：${s}`)
  const ok = [
    'export const MAX_ITEMS = 50',
    'const PAGE_SIZE = 20',
    "export const KEY = 'asnX'",
    '// export const OLD_UI = false',
    ' * const DOC_UI = true',
    '  const LOCAL_FLAG = true',   // 縮排＝區域變數，不是頂層旗標
    'const isReady = true',
    "const PI_VIA_LABEL = '經 pi'",
  ]
  for (const s of ok) assert.deepEqual(scanFlagViolations(s), [], `不該抓到：${s}`)
})

test('#2163 ui/（vendor 除外）flags.mjs 以外沒有旗標常數，也沒有冒煙掛勾', () => {
  assert.ok(uiFiles.length > 50, `掃到的檔案太少（${uiFiles.length}）`)
  const bad = []
  for (const f of uiFiles) {
    if (rel(f) === FLAGS_FILE) continue
    for (const v of scanFlagViolations(fs.readFileSync(f, 'utf8'))) bad.push(`${rel(f)}：${v}`)
  }
  assert.deepEqual(bad, [], '旗標要宣告在 ui/lib/flags.mjs（並登記在 FLAGS 與設定值清單），不能散在別處')
})

test('#2163 flags.mjs：每個旗標常數都登記在 FLAGS，登記的值跟常數一致、有用途與讀者', () => {
  const src = fs.readFileSync(new URL(FLAGS_FILE, ROOT), 'utf8')
  const declared = [...src.matchAll(/^export const ([A-Z][A-Z0-9_]*)\s*=/gm)].map(m => m[1]).filter(n => n !== 'FLAGS')
  assert.ok(declared.length >= 3)
  assert.deepEqual([...FLAGS.map(f => f.name)].sort(), [...declared].sort(), '宣告的旗標常數跟 FLAGS 登記不一致')
  for (const f of FLAGS) {
    assert.equal(f.value, flagsMod[f.name], `${f.name} 登記的值跟常數不同`)
    assert.equal(typeof f.value, 'boolean')
    assert.ok(f.purpose, `${f.name} 缺用途`)
    assert.ok(f.readers.length > 0, `${f.name} 缺讀者`)
    for (const r of f.readers) {
      const t = fs.readFileSync(new URL(r, ROOT), 'utf8')
      assert.ok([f.name, ...(f.via ?? [])].some(n => t.includes(n)), `${f.name} 登記的讀者 ${r} 沒有用到它`)
    }
  }
})

/** 解析文件「前端旗標」一節的表格：回傳 [{ name, value, purpose }] */
export function parseFlagDoc(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(l => l.trim() === '## 前端旗標')
  assert.ok(start >= 0, '設定值清單缺「## 前端旗標」一節')
  const rows = []
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('## '); i++) {
    if (!lines[i].startsWith('|')) continue
    const cells = lines[i].split(/(?<!\\)\|/).slice(1, -1).map(c => c.trim())
    const m = cells[0]?.match(/^`([A-Z][A-Z0-9_]*)`$/)
    if (m) rows.push({ name: m[1], value: cells[1], purpose: cells[2] })
  }
  return rows
}

test('#2163 設定值清單「前端旗標」一節跟 FLAGS 逐列一致（名稱、值、用途）', () => {
  const rows = parseFlagDoc(fs.readFileSync(DOC, 'utf8'))
  assert.deepEqual(rows.map(r => r.name).sort(), FLAGS.map(f => f.name).sort(), '文件的旗標列跟 FLAGS 不一致（少列或多列）')
  for (const f of FLAGS) {
    const r = rows.find(x => x.name === f.name)
    assert.equal(r.value, f.value ? '開' : '關', `${f.name} 值跟文件不一致（翻旗標要改文件）`)
    assert.equal(r.purpose, f.purpose, `${f.name} 用途跟文件不一致`)
  }
})

test('#2163 自我測試：文件解析抓得到少一列與值不同', () => {
  const sample = '## 前端旗標\n\n| 名稱 | 值 | 用途 | 讀 |\n|---|---|---|---|\n| `A_UI` | 關 | 甲 | x |\n\n## 下一節\n| `B_UI` | 開 | 乙 | y |\n'
  assert.deepEqual(parseFlagDoc(sample), [{ name: 'A_UI', value: '關', purpose: '甲' }])
})
