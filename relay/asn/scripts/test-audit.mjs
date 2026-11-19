// T0（issue #1763 階段 0）：盤點 test/*.test.mjs 每支測試「讀了哪些 ui 原始碼」與「有幾條原始碼字串斷言」，並分類。
// 純 node、無新依賴、不連網；預設只印表格，不寫任何檔（要寫才給 --out <路徑>）。
//   node scripts/test-audit.mjs            印表格（繁體中文）
//   node scripts/test-audit.mjs --json     印完整 JSON
//   node scripts/test-audit.mjs --out f    同時把輸出寫到 f（搭配 --json 寫 JSON，否則寫表格文字）
//
// ── 轉換規則（issue 3.1；這裡是機械判定，審查者再核對）──────────────────────────
//  先決條件：所有計數都是靜態文字分析的「粗估」，不執行測試；只用來排序與提醒，不是精確數字。
//  「讀 ui 原始碼」＝測試用字串字面值指到一個實際存在於 ui/ 底下的檔案（readFileSync／read()／new URL／path.join(…,'ui',…)）。
//     ・字面值含 ui/ 前綴（'../ui/list.js'、'ui/m.html'、join(root,'ui','m.html')）一律算。
//     ・不含 ui/ 前綴的字面值（'list.js'）只在該測試有「ui 目錄 helper」（出現 `ui/${`、'../ui/' 目錄字面值、'ui' 目錄字面值）時才算，避免誤抓。
//     ・含 ${…} 的動態路徑無法解析，不計入（只會少算，不會多算）。
//  「import ui 模組」＝ import … from '../ui/…'：當模組用，不算讀原始碼字串，另列欄位。
//  「字串斷言」（只有在讀了 ui 原始碼時才算；全檔粗估）＝ assert.match／assert.doesNotMatch／.match(／.includes(／.indexOf(／.split( 的出現次數。
//  分類（依序判定，第一個符合者為主分類）：
//   C 要真瀏覽器：出現 puppeteer、Runtime.evaluate、--headless、Page.navigate，或用 spawn／execFile 起 smoke-*.mjs。→ 轉成 scripts/smoke-probes 探測。
//   B 可渲染：出現 vue/server-renderer、renderToString、createSSRApp（含讀原始碼的混合，notes 註明另有 N 條字串斷言）。→ 用渲染結果查，三種 caps 各渲染。
//   D 原始碼字串：讀 ui 原始碼、無渲染、且字串斷言 >= 1。→ 只留架構守門類，其餘消滅或等該類搬家 PR 一併換成渲染測試。
//   A 純邏輯：其餘（只 import 模組、或不碰 ui）。保留。（讀了 ui 檔但沒有字串斷言者，notes 註明。）
//  「易假紅」欄：有讀 m.html／settings-panel／list.html／m.js 之任一（搬家最容易假紅的四個檔）。
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const UI_DIR = path.join(ROOT, 'ui')
const FRAGILE = ['ui/m.html', 'ui/lib/settings-panel.mjs', 'ui/list.html', 'ui/m.js']
export const CLASS_NAMES = { A: '純邏輯', B: '可渲染', C: '真瀏覽器', D: '原始碼字串' }

/** 列出 ui/ 底下所有檔（相對 ui 的 / 路徑），略過 vendor。 */
export function listUiFiles(uiDir = UI_DIR) {
  const out = new Set()
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'vendor' || e.name === 'node_modules') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
      else out.add(r)
    }
  }
  if (fs.existsSync(uiDir)) walk(uiDir, '')
  return out
}

const STR_RE = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g
const IMPORT_RE = /(?:^|\n)\s*import\s[^'"`\n]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

function normalizeUi(s) {
  // 回傳相對 ui 的路徑
  let t = s.replace(/\\/g, '/').replace(/^file:\/\/\/?/, '')
  const i = t.lastIndexOf('/ui/')
  if (i >= 0) t = t.slice(i + 4)
  else t = t.replace(/^(\.\.?\/)+/, '').replace(/^ui\//, '')
  return t
}

/**
 * 分析一支測試的原始碼。
 * @param {string} source 測試檔內容
 * @param {string} fileName 檔名（只用於回傳）
 * @param {Set<string>} [uiFiles] 實際存在的 ui 檔（相對 ui）；預設掃真實 ui/
 */
export function analyzeTest(source, fileName, uiFiles = listUiFiles()) {
  const src = source.replace(/\r\n/g, '\n')
  // 1) import（模組）：抽出 ui 的 import，之後把 import 行從字面值掃描中拿掉
  const importsUi = new Set()
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2] || m[3]
    if (spec && /(^|\/)ui\//.test(spec)) importsUi.add(`ui/${normalizeUi(spec)}`)
  }
  const code = src
    .replace(/(^|\n)[ \t]*import\s[^\n]*?from\s*['"][^'"]+['"][^\n]*/g, '$1')
    .replace(/(^|\n)[ \t]*import\s*['"][^'"]+['"][^\n]*/g, '$1')
    .replace(/import\(\s*['"][^'"]+['"]\s*\)/g, '')

  // 2) 是否有 ui 目錄 helper（才允許無 ui/ 前綴的字面值）
  const hasUiHelper = /ui\/\$\{|['"`]\.\.\/ui\/?['"`]|['"]ui['"]\s*[,)]|['"`]ui\/['"`]/.test(code)
  // 3) 字面值 → ui 檔
  const reads = new Set()
  const lits = []
  for (const m of code.matchAll(STR_RE)) lits.push(m[1] ?? m[2] ?? m[3] ?? '')
  // path.join(x, 'ui', 'a', 'b.html') 這類：把 'ui' 後面連續字面值接起來
  for (const m of code.matchAll(/['"]ui['"]\s*,\s*((?:['"][^'"]+['"]\s*,?\s*)+)/g)) {
    const parts = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1])
    lits.push(parts.join('/'))
  }
  for (const lit of lits) {
    if (!lit || lit.includes('${')) continue
    const hasPrefix = /(^|\/)ui\//.test(lit)
    if (!hasPrefix && !hasUiHelper) continue
    if (!/\.(mjs|js|html|css|json)$/.test(lit)) continue
    const rel = normalizeUi(lit)
    if (uiFiles.has(rel)) reads.add(`ui/${rel}`)
  }
  const dirScan = /readdirSync\(/.test(code) && (hasUiHelper || /readdirSync\([^)]*ui/.test(code))
  // 讀非 ui 的其他原始碼（Rust／workflow／scripts…）：只做備註
  const readsOther = /readFileSync|readFile\(/.test(code) && /src-tauri|\.github|scripts\/|\.kt|\.rs/.test(code)

  // 4) 字串斷言（粗估）
  const cnt = re => (code.match(re) || []).length
  const strAsserts = cnt(/assert\.(?:match|doesNotMatch)\(/g) + cnt(/(?<!assert)\.match\(/g)
    + cnt(/\.includes\(/g) + cnt(/\.indexOf\(/g) + cnt(/\.split\(/g)
  const effectiveAsserts = reads.size > 0 || dirScan ? strAsserts : 0

  // 5) 渲染／瀏覽器
  const render = /vue\/server-renderer|renderToString|createSSRApp/.test(src)
  const browser = /puppeteer|Runtime\.evaluate|--headless|Page\.navigate|(?:spawn|spawnSync|execFile|execFileSync|fork)\([^)]*smoke-[\w-]+\.mjs/.test(src)

  // 6) 分類
  const notes = []
  let cls
  if (browser) {
    cls = 'C'
    if (reads.size > 0 && effectiveAsserts > 0) notes.push(`另有約 ${effectiveAsserts} 條原始碼字串斷言`)
  } else if (render) {
    cls = 'B'
    if (reads.size > 0 && effectiveAsserts > 0) notes.push(`混合：另有約 ${effectiveAsserts} 條原始碼字串斷言（D 性質）`)
  } else if (reads.size > 0 && effectiveAsserts > 0) {
    cls = 'D'
  } else {
    cls = 'A'
    if (reads.size > 0) notes.push('讀了 ui 檔但無字串斷言')
  }
  if (/smoke-(?:lib|ui|gate)/.test(src) && !browser) notes.push('引用 smoke-lib（測探測定義，本身不開瀏覽器）')
  if (dirScan) notes.push('掃目錄')
  if (readsOther) notes.push('另讀非 ui 原始碼（Rust／CI／scripts）')

  const readList = [...reads].sort()
  return {
    file: fileName,
    class: cls,
    reads: readList,
    imports: [...importsUi].sort(),
    stringAsserts: effectiveAsserts,
    render,
    browser,
    fragile: readList.filter(r => FRAGILE.includes(r)),
    notes,
  }
}

/** 掃 test 目錄，回傳每支測試的分析結果。 */
export function auditDir(testDir = path.join(ROOT, 'test'), uiDir = UI_DIR) {
  const uiFiles = listUiFiles(uiDir)
  // 自己的測試裡有拿來當樣本的假原始碼（含 Runtime.evaluate 等字），掃進去會被誤判成真瀏覽器測試
  return fs.readdirSync(testDir).filter(f => f.endsWith('.test.mjs') && f !== 'test-audit.test.mjs').sort()
    .map(f => analyzeTest(fs.readFileSync(path.join(testDir, f), 'utf8'), f, uiFiles))
}

export function summarize(rows) {
  const c = { A: 0, B: 0, C: 0, D: 0 }
  for (const r of rows) c[r.class]++
  return {
    total: rows.length, byClass: c,
    readsUi: rows.filter(r => r.reads.length > 0).length,
    fragile: rows.filter(r => r.fragile.length > 0).length,
  }
}

export const RULES = [
  '分類規則（依序判定，第一個符合者為主分類；全部是靜態文字分析的粗估）：',
  '  C 真瀏覽器：出現 puppeteer／Runtime.evaluate／--headless／Page.navigate，或 spawn 起 smoke-*.mjs',
  '  B 可渲染：出現 vue/server-renderer／renderToString／createSSRApp（混合者於備註註明另有字串斷言）',
  '  D 原始碼字串：讀 ui 原始碼、無渲染、字串斷言（assert.match／.match(／.includes(／.indexOf(／.split() >= 1',
  '  A 純邏輯：其餘（只 import 模組或不碰 ui）',
  '  讀 ui 原始碼＝字串字面值指到實際存在的 ui 檔；import ui 模組另列、不算讀原始碼；含 ${} 的動態路徑不解析（只會少算）',
]

export function renderTable(rows) {
  const head = ['檔名', '分類', '讀的 ui 檔', '字串斷言(粗估)', '渲染/瀏覽器', '易假紅檔', '備註']
  const lines = [head.join(' | ')]
  for (const r of rows) {
    const shown = r.reads.slice(0, 3).map(x => x.replace(/^ui\//, ''))
    const more = r.reads.length > 3 ? ` +${r.reads.length - 3}` : ''
    const rb = [r.render ? '渲染' : '', r.browser ? '瀏覽器' : ''].filter(Boolean).join('+') || '-'
    lines.push([
      r.file, `${r.class} ${CLASS_NAMES[r.class]}`, (shown.join(', ') || '-') + more,
      String(r.stringAsserts), rb, r.fragile.map(x => x.replace(/^ui\//, '')).join(', ') || '-', r.notes.join('；') || '-',
    ].join(' | '))
  }
  const s = summarize(rows)
  lines.push('', ...RULES, '',
    `共 ${s.total} 支；讀 ui 原始碼 ${s.readsUi} 支；讀易假紅檔 ${s.fragile} 支`,
    `A 純邏輯 ${s.byClass.A}／B 可渲染 ${s.byClass.B}／C 真瀏覽器 ${s.byClass.C}／D 原始碼字串 ${s.byClass.D}`)
  return lines.join('\n')
}

function main(argv) {
  const json = argv.includes('--json')
  const oi = argv.indexOf('--out')
  const outPath = oi >= 0 ? argv[oi + 1] : null
  if (oi >= 0 && !outPath) { console.error('--out 需要一個路徑'); process.exit(2) }
  const rows = auditDir()
  const text = json
    ? JSON.stringify({ rules: RULES, classes: CLASS_NAMES, summary: summarize(rows), tests: rows }, null, 2)
    : renderTable(rows)
  if (outPath) fs.writeFileSync(outPath, text + '\n')
  console.log(text)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
