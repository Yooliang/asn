// CI 發版：產官網要用的 latest.json 與 index.html（#2022 ②-2）。只寫到 --out 資料夾，不推 main、不部署官網（那是 ②-3 的事）。
// 邏輯與本機版（local_sign_publish.mjs 第 5、6 步）共用 site_files.mjs：signature 取 .sig 原文、更新說明取 CHANGELOG 最新一段、
// 電腦版只帶 windows-x86_64（#1964）、版本不得低於線上。
// 與本機版唯一的行為差異：線上版本「等於」這一版時 CI 放行（重跑同一個標籤 Re-run failed jobs 是正常情形）；低於一律擋。
// 用法：node tools/release/ci_site_files.mjs --version <版本> --sig <.sig> --changelog <CHANGELOG.md> --index <site/public/index.html> --out <資料夾> --notes-out <更新說明檔>
//   --notes-out 給 github_release.mjs 的 --notes-file 用（Release 說明與 latest.json 的 notes 同一個來源）。
// 不讀任何金鑰或權杖；唯一的網路動作是讀線上 latest.json（公開網址）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SiteFilesError, SITE_BASE, buildSiteFiles, fetchOnlineLatest, versionNotBackProblem } from './site_files.mjs'

const KEYS = ['--version', '--sig', '--changelog', '--index', '--out', '--notes-out']

export function parseArgs(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (!KEYS.includes(k)) throw new Error(`不認得的參數：${k}`)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${k} 後面要有值`)
    o[k.slice(2).replace('notes-out', 'notesOut')] = v
    i++
  }
  for (const k of ['version', 'sig', 'changelog', 'index', 'out', 'notesOut']) if (!o[k]) throw new Error(`要給 --${k === 'notesOut' ? 'notes-out' : k}`)
  return o
}

/** 回 { latest, notes }；寫檔到 out 與 notesOut。任何一項不對就丟錯、不寫任何檔 */
export async function run(opts, { fetchFn = fetch, now = () => Date.now(), readFile = p => fs.readFileSync(p, 'utf8'), writeFile = (p, t) => fs.writeFileSync(p, t), mkdir = d => fs.mkdirSync(d, { recursive: true }), log = () => {} } = {}) {
  const built = buildSiteFiles({
    version: opts.version,
    sigText: readFile(opts.sig),
    changelog: readFile(opts.changelog),
    indexHtml: readFile(opts.index),
    pubDate: new Date(now()),
    date: new Date(now()).toISOString().slice(0, 10),
  })
  const online = await fetchOnlineLatest({ fetchFn, now, base: SITE_BASE })
  const problem = versionNotBackProblem({ version: opts.version, online: online.version, allowSame: true })
  if (problem) throw new SiteFilesError(problem)
  mkdir(opts.out)
  writeFile(path.join(opts.out, 'latest.json'), built.latestText)
  writeFile(path.join(opts.out, 'index.html'), built.indexText)
  writeFile(opts.notesOut, built.notes)
  log(`已產 latest.json 與 index.html（版本 ${opts.version}，線上目前 ${online.version}）`)
  return { latest: built.latest, notes: built.notes }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await run(parseArgs(process.argv.slice(2)), { log: m => console.log(m) }) } catch (e) { console.error(`產官網檔中止：${e.message}`); process.exit(1) }
}
