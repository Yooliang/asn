// #1979 第二項：一個指令發版。改版號（五處）＋寫 CHANGELOG 段＋提交＋依 ① 的判斷打標籤＋守門檢查＋推 main＋推標籤。
// 用法：node tools/release/release-tag.mjs <版號> --items-file <json> [--allow-skip] [--dry-run]
//   版號：x.y.z，必須正好是目前版號的 patch 加一；要跳號才加 --allow-skip。
//   --items-file：與 local_sign_publish.mjs 同格式（含 items 的 JSON 物件，或只有條目的字串陣列）。沒給就停，不自動編。
//   --dry-run：只印計畫（平台表、新版號、CHANGELOG 段全文、會改的檔、會打的標籤、步驟），不改檔、不做 git 寫入。
// 固定順序：前置檢查 → 改檔 → 提交 → 本機打標籤 → 官網紀錄預檢 → 版本測試 → 推 main → 每個標籤跑 tag_check → 推標籤。
// 任一步失敗：停下、不推任何東西，印出已完成的步驟與還原指令（只印，不自動執行）。
// 設計：所有外部動作（git、檔案、子程序、時間、log）由 deps 注入；只有直接執行時才接上真的。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PLATFORMS, PLATFORM_LABEL, loadRules, collectFromTags, renderTable } from './platform_plan.mjs'
import { changelogSections, draftFromChangelog } from './site_record_check.mjs'

export const FILES = {
  packageJson: 'relay/asn/package.json',
  tauriConf: 'relay/asn/src-tauri/tauri.conf.json',
  cargoToml: 'relay/asn/src-tauri/Cargo.toml',
  pluginJson: 'relay/claude-mod/.claude-plugin/plugin.json',
  cargoLock: 'relay/asn/src-tauri/Cargo.lock',
  changelog: 'relay/asn/CHANGELOG.md',
}
export const COMMIT_PATHS = Object.values(FILES)
export const TAG_PREFIX = { desktop: 'v', linux: 'linux-v', android: 'android-v' }
export const ITEM_RE = /^(修正|改善|新功能)(?:（([^）]*)）)?[：:]/
export const MARK_ANDROID_ONLY = '只有手機版'
export const MARK_DESKTOP_LINUX = '電腦版與 Linux'
const VERSION_RE = /^\d+\.\d+\.\d+$/

class Stop extends Error {}
const stop = msg => { throw new Stop(msg) }
const firstLine = s => String(s ?? '').trim()

export function parseArgs(argv) {
  const o = { version: null, itemsFile: null, allowSkip: false, dryRun: false, error: null }
  for (let i = 0; i < argv.length && !o.error; i++) {
    const a = argv[i]
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--allow-skip') o.allowSkip = true
    else if (a === '--items-file') {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) o.error = '--items-file 後面要有檔案路徑'
      else { o.itemsFile = v; i++ }
    } else if (a.startsWith('--')) o.error = `不認得的參數：${a}`
    else if (o.version === null) o.version = a
    else o.error = `多給了一個參數：${a}`
  }
  if (!o.error && o.version === null) o.error = '要給版號（例如 0.2.43）'
  return o
}

export const nextPatch = v => { const [a, b, c] = v.split('.').map(Number); return `${a}.${b}.${c + 1}` }
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0 }

// 台北時間（UTC+8）的日期 YYYY-MM-DD
export const taipeiDate = d => new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)

// ---- 純函式：各檔的版本讀寫（寫法參考 relay/asn/scripts/bump.mjs，但不 import 它：它一載入就執行）----
const JSON_RE = /"version": "([^"]+)"/
const TOML_RE = /^version = "([^"]+)"/m
const LOCK_RE = /(\[\[package\]\]\r?\nname = "asn"\r?\nversion = ")([^"\r\n]*)(")/g

export function readVersions(texts) {
  const lock = [...String(texts.cargoLock).matchAll(LOCK_RE)]
  return {
    packageJson: JSON_RE.exec(texts.packageJson)?.[1] ?? null,
    tauriConf: JSON_RE.exec(texts.tauriConf)?.[1] ?? null,
    cargoToml: TOML_RE.exec(texts.cargoToml)?.[1] ?? null,
    pluginJson: JSON_RE.exec(texts.pluginJson)?.[1] ?? null,
    cargoLock: lock.length === 1 ? lock[0][2] : null,
  }
}

export function writeVersions(texts, next) {
  const out = { ...texts }
  out.packageJson = texts.packageJson.replace(JSON_RE, `"version": "${next}"`)
  out.tauriConf = texts.tauriConf.replace(JSON_RE, `"version": "${next}"`)
  out.cargoToml = texts.cargoToml.replace(TOML_RE, `version = "${next}"`)
  out.pluginJson = texts.pluginJson.replace(JSON_RE, `"version": "${next}"`)
  out.cargoLock = texts.cargoLock.replace(LOCK_RE, `$1${next}$3`)
  return out
}

// CHANGELOG：標題用全形括號；插在第一個「## 」標題正上方；段落後空一行；換行沿用檔案原本的（有 CRLF 就 CRLF，否則 LF）
export function buildSection(version, date, items, eol = '\n') {
  return [`## ${version}（${date}）`, ...items.map(i => `- ${i}`), '', ''].join(eol)
}
export function insertSection(text, section) {
  const m = /^## /m.exec(text)
  if (!m) return null
  return text.slice(0, m.index) + section + text.slice(m.index)
}
export const eolOf = text => (/\r\n/.test(text) ? '\r\n' : '\n')

// 平台標註與 ① 判斷是否一致；回問題清單（空＝一致）
export function checkMarks(items, tags) {
  const set = PLATFORMS.filter(p => tags[p])
  const key = set.join('+')
  const problems = []
  items.forEach((it, i) => {
    const m = ITEM_RE.exec(it)
    if (!m) problems.push(`第 ${i + 1} 條開頭要是「修正」「改善」或「新功能」（可接「（平台）」再加冒號）`)
  })
  if (problems.length) return problems
  let need = null
  if (key === 'android') need = MARK_ANDROID_ONLY
  else if (key === 'desktop+linux') need = MARK_DESKTOP_LINUX
  else if (key === 'desktop+linux+android') {
    // 三個平台都打：條目不該標成只有某幾個平台
    items.forEach((it, i) => {
      const mark = ITEM_RE.exec(it)[2] ?? ''
      for (const bad of [MARK_ANDROID_ONLY, MARK_DESKTOP_LINUX]) {
        if (mark.includes(bad)) problems.push(`第 ${i + 1} 條標了「${bad}」，但 ① 判斷這版三個平台都打，標註與判斷不符；請拿掉平台標註或改成實際範圍`)
      }
    })
    return problems
  }
  else return [`① 判斷這版只打「${set.map(p => PLATFORM_LABEL[p]).join('、')}」，這種組合沒有標註規則，請人工處理`]
  items.forEach((it, i) => {
    const mark = ITEM_RE.exec(it)[2] ?? ''
    if (!mark.includes(need)) problems.push(`第 ${i + 1} 條要標「${need}」，例如「${it.match(/^(修正|改善|新功能)/)[1]}（${need}）：」；現在標的是${mark ? `「${mark}」` : '沒有標'}`)
  })
  return problems
}

function loadItems(readFile, file) {
  let text
  try { text = readFile(file) } catch (e) { stop(`--items-file 讀不到：${file}（原因：${e?.message ?? e}）`) }
  let given
  try { given = JSON.parse(text) } catch (e) { stop(`--items-file 不是合法的 JSON：${file}（原因：${e?.message ?? e}）`) }
  const items = Array.isArray(given) ? given : given?.items
  if (!Array.isArray(items) || items.length === 0 || items.some(s => typeof s !== 'string' || s.trim() === '')) stop('--items-file 裡要有至少一條條目（字串陣列，或含 items 的物件），每條不可空白')
  return items.map(s => s.trim())
}

/**
 * opts＝parseArgs 的結果。deps（全部注入）：
 *   git(args, { input }?) → 字串（失敗要拋）；readFile(相對 repo 根的路徑或絕對路徑) → 文字；writeFile(路徑, 文字)；
 *   run(指令, 參數陣列) → { ok, output }（跑子程序，工作目錄是 repo 根）；now() → Date；log(字串)；rules（選用，平台對照表）
 * 回 { ok, dryRun, failedStep, completed, version, tags }
 */
export async function releaseTag(opts, deps) {
  const { git, readFile, writeFile, run } = deps
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => new Date())
  const completed = []
  const state = { tags: [], tagList: [], mainPushed: false, committed: false, edited: false }
  let step = '前置檢查'
  const warns = [] // dry-run 時，前置檢查的問題只提醒、不停

  const problem = msg => { if (opts.dryRun) warns.push(msg); else stop(msg) }

  // 推 main 之後才失敗：講清楚遠端現況與接續／撤回指令（只印，不執行）
  const reportAfterMainPushed = () => {
    let remote = []
    let lsErr = null
    try {
      const out = git(['ls-remote', '--tags', 'origin'])
      const refs = new Set(String(out ?? '').split('\n').map(l => l.trim().split(/\s+/)[1]).filter(Boolean).map(r => r.replace(/\^\{\}$/, '')))
      remote = state.tagList.filter(t => refs.has(`refs/tags/${t}`))
    } catch (e) { lsErr = e?.message ?? String(e) }
    log(`遠端現況：main 已經含「release: ${opts.version}」這個提交。`)
    if (lsErr) {
      log(`  查不到遠端標籤（git ls-remote --tags origin 失敗：${lsErr}）；請自己執行 git ls-remote --tags origin 確認這一版的標籤 ${state.tagList.join('、')} 哪些已在遠端。`)
      log('  若要接續，請對還沒在遠端的標籤逐一執行 git push origin <標籤>；若要撤掉遠端標籤，執行 git push origin :refs/tags/<標籤>。')
    } else {
      const left = state.tagList.filter(t => !remote.includes(t))
      log(`  遠端已有的標籤：${remote.length ? remote.join('、') : '（無）'}`)
      log(`  還沒推的標籤：${left.length ? left.join('、') : '（無）'}`)
      if (left.length) {
        log('接續指令（只列出來，不會自動執行，請人工確認 tag_check 的問題處理好後再下）：')
        for (const t of left) log(`  git push origin ${t}`)
      }
      if (remote.length) {
        log('若要撤掉遠端已有的標籤（只列出來，不會自動執行）：')
        for (const t of remote) log(`  git push origin :refs/tags/${t}`)
      }
    }
    log(`注意：同一個版號（${opts.version}）不能再跑這個指令：前置檢查會因為標籤已存在、版號又不是目前版號加一而停下。請照上面的指令手動接續；不要強制推 main，要補修請找領隊決定。`)
  }

  const fail = msg => {
    log(`停下：第「${step}」步沒過：${msg}`)
    log(`已完成的步驟：${completed.length ? completed.join(' → ') : '（無）'}`)
    if (state.mainPushed) {
      reportAfterMainPushed()
      return { ok: false, dryRun: !!opts.dryRun, failedStep: step, completed, version: opts.version, tags: state.tags }
    }
    log('沒有推任何東西；還原方式（只列出來，不會自動執行，請人工確認後再下）：')
    const undo = []
    for (const t of [...state.tags].reverse()) undo.push(`git tag -d ${t}`)
    if (state.committed && !state.mainPushed) undo.push('git reset --hard HEAD~1')
    else if (state.edited && !state.committed) undo.push(`git restore -- ${COMMIT_PATHS.join(' ')}`)
    if (undo.length) for (const u of undo) log(`  ${u}`)
    else log('  （不需要還原）')
    return { ok: false, dryRun: !!opts.dryRun, failedStep: step, completed, version: opts.version, tags: state.tags }
  }

  try {
    // ---------- 1 前置檢查 ----------
    const ver = opts.version
    if (!VERSION_RE.test(ver ?? '')) stop(`版號格式不對：${ver}（要是 x.y.z）`)
    const texts = {}
    for (const [k, rel] of Object.entries(FILES)) texts[k] = readFile(rel)
    const cur = readVersions(texts)
    for (const [k, v] of Object.entries(cur)) if (v === null) stop(`讀不到 ${FILES[k]} 的版本`)
    const curVer = cur.packageJson
    const mismatched = Object.entries(cur).filter(([, v]) => v !== curVer).map(([k, v]) => `${FILES[k]}＝${v}`)
    if (mismatched.length) stop(`五處版本目前就不一致（package.json 是 ${curVer}）：${mismatched.join('、')}`)
    const expect = nextPatch(curVer)
    if (ver !== expect && !(opts.allowSkip && cmp(ver, curVer) > 0)) {
      stop(opts.allowSkip ? `版號 ${ver} 必須大於目前版號 ${curVer}` : `版號要正好是目前版號 ${curVer} 加一（${expect}）；要跳號請加 --allow-skip`)
    }

    // 不要求分支名：工作機的發版工作樹是分離的 HEAD（雯 11-21）；要求的是 HEAD 等於最新 origin/main、工作樹乾淨，推送用 HEAD:main
    if (firstLine(git(['status', '--porcelain']))) problem('工作樹不乾淨：先提交或處理掉')
    if (!opts.dryRun) git(['fetch', 'origin', 'main', '--tags', '--quiet'])
    const head = firstLine(git(['rev-parse', 'HEAD']))
    const originMain = firstLine(git(['rev-parse', 'origin/main']))
    if (head !== originMain) problem(`HEAD（${head.slice(0, 8)}）不是最新的 origin/main（${originMain.slice(0, 8)}）${opts.dryRun ? '（dry-run 不 fetch，這是本機記得的 origin/main）' : ''}`)
    for (const p of PLATFORMS) {
      const t = `${TAG_PREFIX[p]}${ver}`
      if (firstLine(git(['tag', '--list', t]))) problem(`標籤 ${t} 已經存在`)
    }

    if (!opts.itemsFile) stop('沒給 --items-file：條目要由人寫，這支程式不自動編')
    const items = loadItems(readFile, path.resolve(deps.cwd ?? process.cwd(), opts.itemsFile))

    // ① 平台判斷
    const rules = deps.rules ?? loadRules()
    const plan = collectFromTags(git, rules)
    const table = renderTable(plan)
    const tags = {}
    for (const p of PLATFORMS) tags[p] = !!(plan.perPlatform[p].missing || plan.perPlatform[p].plan.platforms[p].tag)
    const tagList = PLATFORMS.filter(p => tags[p]).map(p => `${TAG_PREFIX[p]}${ver}`)
    state.tagList = tagList
    if (tagList.length === 0) stop('① 判斷三個平台都不打：不佔版本的改動不該走到發版這一步')
    const markProblems = checkMarks(items, tags)
    if (markProblems.length) stop(`條目與平台判斷對不上：${markProblems.join('；')}`)

    const date = taipeiDate(now())
    const eol = eolOf(texts.changelog)
    if (changelogSections(texts.changelog).some(s => s.version === ver)) stop(`CHANGELOG 已經有 ${ver} 這一段`)
    const section = buildSection(ver, date, items, eol)
    const newChangelog = insertSection(texts.changelog, section)
    if (newChangelog === null) stop('CHANGELOG 找不到任何「## 」標題，不知道插在哪')
    const draftCheck = draftFromChangelog({ changelog: newChangelog, commit: '0000000', version: ver })
    if (!draftCheck.ok) stop(`官網紀錄預檢沒過：${draftCheck.problems.map(p => p.message).join('；')}`)

    const steps = ['前置檢查', '改檔（五處版號＋CHANGELOG）', `提交（release: ${ver}，只含六個檔）`, `本機打標籤：${tagList.join('、')}`,
      '官網紀錄預檢（site_record_check）', '版本測試（relay/asn/test/version.test.mjs）', '推 main（git push origin HEAD:main）',
      `每個標籤跑 tag_check：${tagList.join('、')}`, `推標籤：${tagList.join('、')}`]

    if (opts.dryRun) {
      log('【dry-run】只印計畫，不改檔、不做 git 寫入')
      log('')
      log('① 平台判斷：')
      log(table)
      log('')
      log(`新版號：${curVer} → ${ver}`)
      log('')
      log('要寫進 CHANGELOG 的段落：')
      log(section.replace(/\r/g, '').replace(/\n+$/, ''))
      log('')
      log('會改的六個檔：')
      for (const f of COMMIT_PATHS) log(`  ${f}`)
      log('')
      log(`會打的標籤：${tagList.join('、')}`)
      log('')
      log('步驟：')
      steps.forEach((s, i) => log(`  ${i + 1}. ${s}`))
      if (warns.length) {
        log('')
        log('提醒：以下前置檢查實際執行時會停下：')
        for (const w of warns) log(`  - ${w}`)
      }
      return { ok: true, dryRun: true, failedStep: null, completed: [], version: ver, tags: tagList, warnings: warns }
    }
    completed.push('前置檢查')
    log(table)

    // ---------- 2 改檔 ----------
    step = '改檔'
    const next = writeVersions(texts, ver)
    next.changelog = newChangelog
    state.edited = true
    for (const [k, rel] of Object.entries(FILES)) writeFile(rel, next[k])
    completed.push('改檔')

    // ---------- 3 提交 ----------
    step = '提交'
    git(['commit', '-F', '-', '--', ...COMMIT_PATHS], { input: `release: ${ver}\n` })
    state.committed = true
    completed.push('提交')

    // ---------- 4 本機打標籤 ----------
    step = '本機打標籤'
    for (const t of tagList) { git(['tag', t]); state.tags.push(t) }
    completed.push('本機打標籤')

    // ---------- 5 官網紀錄預檢 ----------
    step = '官網紀錄預檢'
    const siteArgs = ['tools/release/site_record_check.mjs', '--changelog', FILES.changelog, '--tag', `v${ver}`]
    if (tags.desktop) {
      const r = run('node', siteArgs)
      if (!r.ok) throw new Stop(`site_record_check 沒過：${String(r.output ?? '').trim()}`)
    } else {
      // 這版不打電腦版標籤，site_record_check 的 --tag 只收 v*，改在程式內用同一支的檢查函式
      const commit = firstLine(git(['rev-parse', '--short=8', 'HEAD']))
      const r = draftFromChangelog({ changelog: readFile(FILES.changelog), commit, version: ver })
      if (!r.ok) throw new Stop(`官網紀錄預檢沒過：${r.problems.map(p => p.message).join('；')}`)
    }
    completed.push('官網紀錄預檢')

    // ---------- 6 版本測試 ----------
    step = '版本測試'
    {
      const r = run('node', ['--test', 'relay/asn/test/version.test.mjs'])
      if (!r.ok) throw new Stop(`版本測試沒過：${String(r.output ?? '').trim().split('\n').slice(-8).join('\n')}`)
    }
    completed.push('版本測試')

    // ---------- 7 推 main ----------
    step = '推 main'
    git(['push', 'origin', 'HEAD:main'])
    state.mainPushed = true
    completed.push('推 main')

    // ---------- 8 tag_check ----------
    step = '標籤檢查'
    for (const p of PLATFORMS) {
      if (!tags[p]) continue
      const t = `${TAG_PREFIX[p]}${ver}`
      const args = ['tools/release/tag_check.mjs', t]
      if (p !== 'desktop') args.push('--prefix', TAG_PREFIX[p])
      const r = run('node', args)
      if (!r.ok) throw new Stop(`tag_check（${t}）沒過：${String(r.output ?? '').trim()}`)
    }
    completed.push('標籤檢查')

    // ---------- 9 推標籤 ----------
    step = '推標籤'
    for (const t of tagList) git(['push', 'origin', t]) // 一個一個推，失敗時才分得清已推和未推
    completed.push('推標籤')
    log(`發版完成：${ver}；已推標籤 ${tagList.join('、')}`)
    return { ok: true, dryRun: false, failedStep: null, completed, version: ver, tags: tagList }
  } catch (e) {
    if (e instanceof Stop) return fail(e.message)
    return fail(`意外錯誤：${e?.message ?? e}`)
  }
}

// ---- 真的接線（只有直接執行時才用）----
export function realDeps(repoRoot) {
  const abs = p => path.resolve(repoRoot, p)
  return {
    git: (args, o = {}) => execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: repoRoot, encoding: 'utf8', input: o.input, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }),
    readFile: p => fs.readFileSync(abs(p), 'utf8'),
    writeFile: (p, t) => fs.writeFileSync(abs(p), t),
    run: (cmd, args) => {
      const r = spawnSync(cmd === 'node' ? process.execPath : cmd, args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
    },
    now: () => new Date(),
    log: s => console.log(s),
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.error) {
    console.error(`${opts.error}\n用法：node tools/release/release-tag.mjs <版號> --items-file <json> [--allow-skip] [--dry-run]`)
    process.exit(2)
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const r = await releaseTag(opts, realDeps(repoRoot))
  process.exit(r.ok ? 0 : 1)
}
