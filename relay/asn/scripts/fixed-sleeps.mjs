// 測試裡「睡固定毫秒數等條件」的掃描器（#994 系列：測試靠時間差，機器一慢就偶發紅）。純 node。
// 用法：
//   node scripts/fixed-sleeps.mjs            列出現況（每個檔案幾處）
//   node scripts/fixed-sleeps.mjs --update   把現況寫成基準 test/golden/fixed-sleeps-baseline.json（只在「減少」時更新；增加要改成 waitFor）
// 守門在 test/no-fixed-sleep-994.test.mjs：任何檔案的次數增加、或出現新的檔案就紅。
//
// 算進去的寫法（毫秒數 ≥ 100 才算；字面數字，或同檔 const 大寫常數（可加減乘一個字面數字）解得出來的值）：
//   await new Promise(r => setTimeout(r, N))
//   await sleep(N) ／ await delay(N)
// 不算：小於 100 的讓出事件迴圈（0、5、10、20、50）；sleep(ms) 這種參數；沒有 await 的（例如 Promise.race 的逾時上限）；註解。
// 大寫常數解不出來（來自別的檔案）時保守地算進去。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MIN_MS = 100
const SELF_TEST = 'no-fixed-sleep-994.test.mjs'   // 守門測試自己的樣本字串含有被掃的寫法，不掃它
const HERE = path.dirname(fileURLToPath(import.meta.url))
export const TEST_DIR = path.join(HERE, '..', 'test')
export const BASELINE = path.join(TEST_DIR, 'golden', 'fixed-sleeps-baseline.json')

const ARG = String.raw`(\d[\d_]*|[A-Z][A-Z0-9_]*(?:\s*[-+*]\s*\d[\d_]*)?)`
const PROMISE_RE = new RegExp(String.raw`\bawait\s+new\s+Promise\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*setTimeout\(\s*\1\s*,\s*` + ARG + String.raw`\s*\)`, 'g')
const SLEEP_RE = new RegExp(String.raw`\bawait\s+(?:sleep|delay)\(\s*` + ARG + String.raw`\s*\)`, 'g')

function constsOf(text) {
  const m = new Map()
  for (const x of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*(\d[\d_]*)\s*(?:;|$|\/\/)/gm)) m.set(x[1], Number(x[2].replace(/_/g, '')))
  return m
}
// 算出毫秒數；解不出來回 null
function valueOf(arg, consts) {
  const m = arg.match(/^(\d[\d_]*|[A-Z][A-Z0-9_]*)(?:\s*([-+*])\s*(\d[\d_]*))?$/)
  if (!m) return null
  const base = /^\d/.test(m[1]) ? Number(m[1].replace(/_/g, '')) : consts.get(m[1])
  if (base === undefined) return null
  if (!m[2]) return base
  const n = Number(m[3].replace(/_/g, ''))
  return m[2] === '+' ? base + n : m[2] === '-' ? base - n : base * n
}

/** 一份檔案內容裡有幾處「睡固定毫秒數」（≥ MIN_MS；解不出來的算進去） */
export function countFixedSleeps(text) {
  const consts = constsOf(text)
  let n = 0
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
    for (const re of [PROMISE_RE, SLEEP_RE]) {
      re.lastIndex = 0
      for (const m of line.matchAll(re)) {
        const v = valueOf(m[m.length - 1], consts)
        if (v === null || v >= MIN_MS) n++
      }
    }
  }
  return n
}

/** 掃 test/*.test.mjs、test/helpers.mjs、test/helpers/*.mjs；回 { 'test/xxx.test.mjs': 次數 }（只列次數 > 0，鍵排序固定） */
export function scanFixedSleeps(testDir = TEST_DIR) {
  const files = []
  for (const f of fs.readdirSync(testDir)) if ((/\.test\.mjs$/.test(f) && f !== SELF_TEST) || f === 'helpers.mjs') files.push(f)
  const hd = path.join(testDir, 'helpers')
  if (fs.existsSync(hd)) for (const f of fs.readdirSync(hd)) if (f.endsWith('.mjs')) files.push(`helpers/${f}`)
  const out = {}
  for (const f of files.sort()) {
    const n = countFixedSleeps(fs.readFileSync(path.join(testDir, f), 'utf8'))
    if (n > 0) out[`test/${f}`] = n
  }
  return out
}

export function readBaseline(file = BASELINE) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).files
}

export function baselineText(files) {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return JSON.stringify({ note: '測試裡睡固定毫秒數（≥100ms）的處數。只准減少；增加請改用 test/helpers/wait-for.mjs 的 waitFor。重新產生：node scripts/fixed-sleeps.mjs --update', files: sorted }, null, 2) + '\n'
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cur = scanFixedSleeps()
  if (process.argv.includes('--update')) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
    fs.writeFileSync(BASELINE, baselineText(cur))
    console.log(`已更新 ${path.relative(process.cwd(), BASELINE)}：${Object.keys(cur).length} 個檔案，共 ${Object.values(cur).reduce((a, b) => a + b, 0)} 處`)
  } else {
    for (const [f, n] of Object.entries(cur)) console.log(String(n).padStart(3), f)
    console.log(`共 ${Object.keys(cur).length} 個檔案，${Object.values(cur).reduce((a, b) => a + b, 0)} 處`)
  }
}
