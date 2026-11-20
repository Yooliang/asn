// 發版標籤守門（#1892 規格 2.1 job 0）：標籤格式、四處版本一致、標籤 commit 在 origin/main 上、CHANGELOG 最新一段合格。
// 注入式：檔案內容與 git 呼叫都由參數傳入，單元測試不真的跑 git；訊息只寫哪一項不符，不貼檔案內容。
// 這只是防呆，不是安全邊界（邊界是誰能建立 v* 標籤的 ruleset）。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { changelogSections, sectionItems } from './site_record_check.mjs'

export const TAG_RE = /^v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/
// 前綴：電腦版 'v'（預設，行為不變）；手機版 'android-v'（#1944，分開打標籤）；Linux 版 'linux-v'。只收這三個
export const TAG_PREFIXES = ['v', 'android-v', 'linux-v']
export const TAG_REGEX = { v: TAG_RE, 'android-v': /^android-v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/, 'linux-v': /^linux-v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/ }

// Cargo.lock 裡 name = "asn" 那一段的版本；找不到或不只一段回 null
export function cargoLockVersion(text) {
  const t = String(text ?? '').replace(/\r\n/g, '\n')
  const hits = [...t.matchAll(/\[\[package\]\]\nname = "asn"\nversion = "([^"\n]*)"/g)]
  return hits.length === 1 ? hits[0][1] : null
}

// Cargo.toml 的 [package] 區塊內的 version
export function cargoTomlVersion(text) {
  const t = String(text ?? '').replace(/\r\n/g, '\n')
  const m = /^\[package\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(t)
  if (!m) return null
  const v = /^version\s*=\s*"([^"\n]*)"/m.exec(m[1])
  return v ? v[1] : null
}

const jsonVersion = text => {
  try { const v = JSON.parse(String(text ?? '')).version; return typeof v === 'string' ? v : null } catch { return null }
}

// files：{ packageJson, cargoLock, cargoToml, tauriConf, changelog }（全是檔案文字）
// git：{ isAncestorOfMain(tag) → boolean }（呼叫端用 git merge-base --is-ancestor，失敗要拋或回 false）
// 回 { ok, version, problems }，problems 是中文字串清單
// prefix：'v'（預設）或 'android-v'；不認得的前綴直接判失敗
export function checkTag({ tag, files, git, prefix = 'v' }) {
  const problems = []
  const re = TAG_REGEX[prefix]
  if (!re) return { ok: false, version: null, problems: [`不認得的標籤前綴：${String(prefix)}`] }
  if (typeof tag !== 'string' || !re.test(tag)) {
    return { ok: false, version: null, problems: [`標籤格式不對：只收 ${prefix} 加三段數字（例如 ${prefix}0.2.37），不收四段、-rc 或缺前綴`] }
  }
  const version = tag.slice(prefix.length)
  const found = {
    'relay/asn/package.json': jsonVersion(files.packageJson),
    'relay/asn/src-tauri/Cargo.lock（asn 套件）': cargoLockVersion(files.cargoLock),
    'relay/asn/src-tauri/Cargo.toml': cargoTomlVersion(files.cargoToml),
    'relay/asn/src-tauri/tauri.conf.json': jsonVersion(files.tauriConf),
  }
  for (const [name, v] of Object.entries(found)) {
    if (v === null) problems.push(`讀不到 ${name} 的版本`)
    else if (v !== version) problems.push(`${name} 的版本是 ${v}，標籤是 ${version}`)
  }

  const sec = changelogSections(files.changelog)[0]
  if (!sec) problems.push('CHANGELOG 沒有任何「## 版本（日期）」段落')
  else if (sec.version === null) problems.push('CHANGELOG 第一段標題不是「## 版本（日期）」格式')
  else if (sec.version !== version) problems.push(`CHANGELOG 第一段是 ${sec.version}，標籤是 ${version}`)
  else if (sectionItems(sec.lines).length === 0) problems.push('CHANGELOG 第一段沒有條列內容')

  let ancestor = false
  try { ancestor = git.isAncestorOfMain(tag) === true } catch { ancestor = false }
  if (!ancestor) problems.push('標籤的 commit 不在 origin/main 上（標籤只能打在 main）')

  return { ok: problems.length === 0, version, problems }
}

// ---- 薄 CLI：在 repo 根目錄 node tools/release/tag_check.mjs v<版本>；成功時若有 GITHUB_OUTPUT 就寫 version=
export function main(argv = process.argv.slice(2), env = process.env, {
  readFile = p => fs.readFileSync(p, 'utf8'),
  appendFile = (p, t) => fs.appendFileSync(p, t),
  run = a => execFileSync('git', a, { stdio: 'ignore' }),
  log = console.log,
} = {}) {
  const pi = argv.indexOf('--prefix')
  const prefix = pi >= 0 ? argv[pi + 1] : 'v'
  const tag = (argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined) ?? env.GITHUB_REF_NAME
  const base = 'relay/asn'
  const rd = rel => { try { return readFile(path.join(base, rel)) } catch { return '' } }
  const files = {
    packageJson: rd('package.json'), cargoLock: rd('src-tauri/Cargo.lock'), cargoToml: rd('src-tauri/Cargo.toml'),
    tauriConf: rd('src-tauri/tauri.conf.json'), changelog: rd('CHANGELOG.md'),
  }
  const git = { isAncestorOfMain: t => { try { run(['merge-base', '--is-ancestor', `${t}^{commit}`, 'origin/main']); return true } catch { return false } } }
  const r = checkTag({ tag, files, git, prefix })
  if (!r.ok) {
    log(`標籤檢查沒過（${r.problems.length} 項）：`)
    for (const p of r.problems) log(`- ${p}`)
    return 1
  }
  if (env.GITHUB_OUTPUT) appendFile(env.GITHUB_OUTPUT, `version=${r.version}\n`)
  log(`標籤檢查通過：${tag}`)
  return 0
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main())
