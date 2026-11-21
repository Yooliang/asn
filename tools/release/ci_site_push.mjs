// CI 發版（#2022 ②-3）：把官網檔（latest.json、index.html）提交並推回 main。觸發官網部署由 workflow 的下一步做（gh workflow run site-deploy.yml）。
// 為什麼要另外觸發：用 GITHUB_TOKEN 推上去的提交不會觸發其他 workflow。
// 流程（每一輪都重做，最多 MAX_TRIES＝3 輪）：fetch main → 讓工作樹等於 origin/main → 版本不退檢查（不低於 main 上的、不低於線上的）
//   → 覆蓋兩個檔 → 內容沒變就不提交（重跑情形，回 pushed:false，由 workflow 照常觸發部署）→ 提交 → 推 main。
//   推被拒（non-fast-forward）就進下一輪：重新 fetch、重新覆蓋、重做版本檢查。3 輪都被拒就丟錯，不強推。
// 只推 HEAD:main：不 --force、不推標籤。版本退步（低於 main 或線上）一律丟錯停下；等於放行（重跑同一版）。
// token：只從環境變數 GH_TOKEN 進來，不放在命令列與網址；以 git 的 GIT_CONFIG_* 環境變數帶 http.extraheader，並先對 base64 後的值印 ::add-mask::，
//   所有 git 的錯誤訊息印出前都會把 token 與其 base64 抹掉。
// 用法：node tools/release/ci_site_push.mjs --version <版本> --files <放 latest.json 與 index.html 的資料夾>
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SiteFilesError, SITE_BASE, compareVersions, fetchOnlineLatest, versionNotBackProblem } from './site_files.mjs'

export const MAX_TRIES = 3
export const SITE_FILES = ['site/public/update/latest.json', 'site/public/index.html']
const SRC_NAMES = { 'site/public/update/latest.json': 'latest.json', 'site/public/index.html': 'index.html' }
const BOT = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' }
const VERSION_RE = /^\d+\.\d+\.\d+$/

export function parseArgs(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (!['--version', '--files'].includes(k)) throw new Error(`不認得的參數：${k}`)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${k} 後面要有值`)
    o[k.slice(2)] = v
    i++
  }
  for (const k of ['version', 'files']) if (!o[k]) throw new Error(`要給 --${k}`)
  if (!VERSION_RE.test(o.version)) throw new Error(`版本格式不對：${o.version}`)
  return o
}

/** 讀 main 工作樹上的 latest.json 版本；檔案不存在回 null；有檔但讀不出版本丟錯（不猜） */
const mainVersion = (readFile, exists, file) => {
  if (!exists(file)) return null
  let v
  try { v = JSON.parse(readFile(file))?.version } catch { throw new SiteFilesError('main 上的 latest.json 不是合法 JSON，無法確認版本不退') }
  if (!VERSION_RE.test(v ?? '')) throw new SiteFilesError('main 上的 latest.json 的 version 格式不對')
  return v
}

/**
 * deps 全部可注入：git(args, { auth })、fetchFn、readFile、writeFile、exists、log、now。
 * git 回標準輸出字串；失敗丟錯。auth:true 的呼叫由真正的 git 實作帶上 token。
 * 回 { pushed, attempts, reason? }；任何一項不對（版本退步、推 3 次都被拒）丟錯。
 */
export async function run(opts, { git, fetchFn = fetch, readFile = p => fs.readFileSync(p, 'utf8'), writeFile = (p, t) => fs.writeFileSync(p, t), exists = p => fs.existsSync(p), now = () => Date.now(), log = () => {} }) {
  const { version, files } = opts
  const src = {}
  for (const f of SITE_FILES) {
    const p = path.join(files, SRC_NAMES[f])
    if (!exists(p)) throw new SiteFilesError(`artifact 裡少了 ${SRC_NAMES[f]}`)
    src[f] = readFile(p)
  }
  let incoming
  try { incoming = JSON.parse(src[SITE_FILES[0]])?.version } catch { throw new SiteFilesError('artifact 的 latest.json 不是合法 JSON') }
  if (incoming !== version) throw new SiteFilesError(`artifact 的 latest.json 版本是 ${incoming}，不是這次的 ${version}`)

  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    git(['fetch', 'origin', 'main'], { auth: true })
    git(['reset', '--hard', 'origin/main'])
    // 版本不退：不低於 main 上現有的、也不低於線上的（等於＝重跑，放行）
    const onMain = mainVersion(readFile, exists, SITE_FILES[0])
    if (onMain !== null && compareVersions(version, onMain) < 0) throw new SiteFilesError(`版本會倒退：這次 ${version}，main 上的 latest.json 已是 ${onMain}`)
    const online = await fetchOnlineLatest({ fetchFn, now, base: SITE_BASE })
    const problem = versionNotBackProblem({ version, online: online.version, allowSame: true })
    if (problem) throw new SiteFilesError(problem)

    for (const f of SITE_FILES) writeFile(f, src[f])
    git(['add', '--', ...SITE_FILES])
    if (!git(['diff', '--cached', '--name-only']).trim()) {
      log(`main 上的兩個網站檔已是 v${version} 的內容，不需要提交（照常觸發官網部署）`)
      return { pushed: false, attempts: attempt, reason: 'same' }
    }
    git(['-c', `user.name=${BOT.name}`, '-c', `user.email=${BOT.email}`, 'commit', '-m', `發版 v${version}：更新 latest.json 與首頁下載連結`, '--', ...SITE_FILES])
    try {
      git(['push', 'origin', 'HEAD:main'], { auth: true })
      log(`已推 main（第 ${attempt} 次）：v${version}`)
      return { pushed: true, attempts: attempt }
    } catch (e) {
      log(`推送被拒（第 ${attempt} 次）：${String(e?.message ?? e).split('\n')[0].slice(0, 200)}${attempt < MAX_TRIES ? '，重新 fetch 重做' : ''}`)
    }
  }
  throw new SiteFilesError(`推送回 main 連續被拒 ${MAX_TRIES} 次（有人一直在推 main）：不強推，請重跑 Re-run failed jobs`)
}

// ---- 真的接線（只有直接執行才用到；測試不碰）
export function realGit({ token, cwd = process.cwd(), env = process.env, out = s => console.log(s) } = {}) {
  const b64 = token ? Buffer.from(`x-access-token:${token}`).toString('base64') : ''
  if (b64) out(`::add-mask::${b64}`)
  const scrub = s => { let t = String(s); for (const x of [token, b64]) if (x) t = t.split(x).join('***'); return t }
  return (args, { auth = false } = {}) => {
    const e = { ...env, GIT_TERMINAL_PROMPT: '0' }
    if (auth && b64) Object.assign(e, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${b64}` })
    try { return execFileSync('git', args, { cwd, env: e, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }) }
    catch (err) { throw new Error(scrub(err.stderr || err.message)) }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const token = process.env.GH_TOKEN
    if (!token) throw new Error('沒有 GH_TOKEN')
    await run(parseArgs(process.argv.slice(2)), { git: realGit({ token }), log: m => console.log(m) })
  } catch (e) { console.error(`推官網檔中止：${e.message}`); process.exit(1) }
}
