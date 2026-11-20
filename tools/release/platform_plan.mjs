// #1979：依這一版改到哪些檔，判斷要打哪幾個平台的標籤。只判斷，不打標籤。
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const PLATFORMS = ['desktop', 'linux', 'android']
export const PLATFORM_LABEL = { desktop: '電腦', linux: 'Linux', android: '手機' }
export const TAG_PATTERN = { desktop: 'v*', linux: 'linux-v*', android: 'android-v*' }
const RULES_PATH = new URL('./platform-rules.json', import.meta.url)

export function loadRules(path = RULES_PATH) {
  return JSON.parse(readFileSync(path, 'utf8')).rules
}

// glob：** 跨目錄、* 不跨目錄；沒有斜線的樣式只比根目錄的檔
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
      } else re += '[^/]*'
    } else re += c.replace(/[.+^${}()|[\]\\?]/g, '\\$&')
  }
  return new RegExp('^' + re + '$')
}

export function planPlatforms({ changes, rules }) {
  const compiled = rules.map(r => ({ r, re: globToRegExp(r.glob), content: r.androidIfContent ? new RegExp(r.androidIfContent) : null }))
  const basis = { desktop: [], linux: [], android: [] }
  const unknown = []
  const skipped = []
  for (const ch of changes) {
    const file = ch.file.replace(/\\/g, '/')
    const hit = compiled.find(c => c.re.test(file))
    if (!hit) { unknown.push(file); continue }
    const plats = new Set(hit.r.platforms)
    if (hit.content && (hit.content.test(file) || (ch.diff && hit.content.test(ch.diff)))) plats.add('android')
    if (plats.size === 0) { skipped.push(file); continue }
    for (const p of plats) basis[p].push(file)
  }
  const all = unknown.length > 0
  const result = {}
  for (const p of PLATFORMS) result[p] = { tag: all || basis[p].length > 0, files: basis[p] }
  const reason = all ? `有 ${unknown.length} 個檔判斷不出來（對照表沒列），三個平台都打` : ''
  return { platforms: result, unknown, skipped, reason }
}

// ---- CLI ----
function versionKey(tag) {
  const m = /(\d+)\.(\d+)\.(\d+)$/.exec(tag)
  return m ? m.slice(1).map(Number) : null
}
function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

export function latestTag(git, pattern) {
  const tags = git(['tag', '--list', pattern]).split('\n').map(s => s.trim()).filter(Boolean)
    .map(t => ({ t, k: versionKey(t) })).filter(x => x.k)
  if (!tags.length) return null
  return tags.sort((a, b) => cmpVersion(a.k, b.k)).at(-1).t
}

// 版號提交（release: x.y.z）只改版號與 CHANGELOG，不算這一版的改動：
// 否則某平台上一版沒發時，別的平台的版號提交（動到 package.json、tauri.conf.json…）會把它拖成「要發」
export const RELEASE_COMMIT = /^release: \d+\.\d+\.\d+/

// 上一個標籤之後改到的檔：逐個提交列出，跳過合併提交與版號提交
export function changedFilesSince(git, tag) {
  const out = git(['log', '--no-merges', '--format=%x1e%s', '--name-only', `${tag}..HEAD`])
  const files = new Set()
  for (const rec of out.split('\x1e').slice(1)) {
    const [subject, ...rest] = rec.split('\n')
    if (RELEASE_COMMIT.test(subject.trim())) continue
    for (const f of rest.map(s => s.trim()).filter(Boolean)) files.add(f)
  }
  return [...files]
}

// git：(args) => stdout 字串；測試時注入
export function collectFromTags(git, rules) {
  const tagOf = {}
  const perPlatform = {}
  for (const p of PLATFORMS) {
    const tag = latestTag(git, TAG_PATTERN[p])
    tagOf[p] = tag
    if (!tag) { perPlatform[p] = { missing: true }; continue }
    const files = changedFilesSince(git, tag)
    const changes = files.map(file => {
      const rule = rules.find(r => globToRegExp(r.glob).test(file))
      const diff = rule?.androidIfContent ? git(['diff', `${tag}..HEAD`, '--', file]) : undefined
      return { file, diff }
    })
    perPlatform[p] = { plan: planPlatforms({ changes, rules }) }
  }
  return { tagOf, perPlatform }
}

function fmtFiles(files) {
  if (!files.length) return '—'
  return files.length > 10 ? `${files.slice(0, 10).join('、')} 等 ${files.length} 個` : files.join('、')
}

export function renderTable({ tagOf, perPlatform }) {
  const lines = ['平台｜打或不打｜上次標籤｜依據的檔案']
  const notes = []
  for (const p of PLATFORMS) {
    const label = PLATFORM_LABEL[p]
    const e = perPlatform[p]
    if (e.missing) { lines.push(`${label}｜打（找不到舊標籤）｜無｜—`); continue }
    const r = e.plan.platforms[p]
    let basis = fmtFiles(r.files)
    if (e.plan.unknown.length) {
      basis = `判斷不出來：${fmtFiles(e.plan.unknown)}`
      notes.push(`${label}：${e.plan.reason}`)
    }
    lines.push(`${label}｜${r.tag ? '打' : '不打'}｜${tagOf[p]}｜${basis}`)
  }
  return lines.join('\n') + (notes.length ? '\n' + notes.join('\n') : '')
}

const realGit = args => execFileSync('git', ['-c', 'core.quotepath=off', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

export function main(argv, { git = realGit, out = s => console.log(s) } = {}) {
  if (!argv.includes('--dry-run')) { out('目前只支援 --dry-run（只印判斷結果，不打標籤）'); return 2 }
  out(renderTable(collectFromTags(git, loadRules())))
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2))
}
