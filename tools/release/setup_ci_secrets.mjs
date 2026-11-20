// 一鍵把發版用的四個 secret 寫進 GitHub environment `release`（#1892，規格 4.2）。
// 用法（repo 根目錄，在持有金鑰檔的那台電腦上）：
//   node tools/release/setup_ci_secrets.mjs --dry-run                 只檢查本機檔案，一次 gh 都不呼叫
//   node tools/release/setup_ci_secrets.mjs                           檢查全過後逐一寫入
//   node tools/release/setup_ci_secrets.mjs --only ASN_PLAY_SA_JSON_B64,ASN_PLAY_UPLOAD_PASSWORD
//   node tools/release/setup_ci_secrets.mjs --setup-env               只建 environment `release` 與 v* 標籤規則（不寫 secret）
//   node tools/release/setup_ci_secrets.mjs --dry-run --setup-env     只印會做什麼，不呼叫 gh
// 輸入檔路徑：旗標 --play-sa-json、--upload-jks、--upload-password-file、--google-services；
//   沒給就用本機慣例位置：服務帳戶＝ASN_PLAY_SA_FILE 或 ~/.asn/play/play-service-account.json（同 scripts/play-upload.mjs），
//   上傳金鑰與密碼＝ASN_PLAY_KEY_DIR 或 ~/.asn/play 底下的 upload.jks、upload.jks.password（同 scripts/release-play.mjs），
//   google-services.json＝relay/asn/src-tauri/gen/android/app/google-services.json（同 release-android-lib 的 GOOGLE_SERVICES_REL）。
// 不輪替金鑰、不刪舊 secret、不寫本機檔案；檔案內容只在記憶體，輸出只有名稱、大小、通過與否。
// gh、fs、輸出都由參數傳入（測試不靠 PATH 放假 gh）；值只走 stdin，不進 gh 的參數。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const DEFAULT_REPO = 'Yooliang/asn'
export const ENV_NAME = 'release'
export const TAG_PATTERN = 'v*'
export const SECRET_NAMES = ['ASN_PLAY_SA_JSON_B64', 'ASN_PLAY_UPLOAD_JKS', 'ASN_PLAY_UPLOAD_PASSWORD', 'ASN_GOOGLE_SERVICES_JSON']
export const GOOGLE_SERVICES_REL = 'relay/asn/src-tauri/gen/android/app/google-services.json'

const FLAG_TO_KEY = { '--play-sa-json': 'playSa', '--upload-jks': 'jks', '--upload-password-file': 'passFile', '--google-services': 'gs', '--repo': 'repo', '--only': 'only' }

/** 解析旗標；有錯回 { error } */
export function parseArgs(argv) {
  const o = { dryRun: false, setupEnv: false, repo: DEFAULT_REPO, only: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--setup-env') o.setupEnv = true
    else if (FLAG_TO_KEY[a]) {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) return { error: `${a} 要接一個值` }
      o[FLAG_TO_KEY[a]] = v
    } else return { error: `不認得的參數：${a}` }
  }
  if (o.repo !== DEFAULT_REPO) return { error: `--repo 只接受 ${DEFAULT_REPO}（收到：${o.repo}）` }
  if (o.only !== null) {
    const names = o.only.split(',').map(s => s.trim()).filter(Boolean)
    const bad = names.filter(n => !SECRET_NAMES.includes(n))
    if (!names.length || bad.length) return { error: `--only 的名稱要是：${SECRET_NAMES.join('、')}（不認得：${bad.join('、') || '（空）'}）` }
    o.only = [...new Set(names)]
  }
  return { opts: o }
}

/** 四個輸入檔的路徑：旗標優先，否則本機慣例位置 */
export function resolvePaths(opts, { env, home, root }) {
  const keyDir = env.ASN_PLAY_KEY_DIR || path.join(home, '.asn', 'play')
  return {
    ASN_PLAY_SA_JSON_B64: opts.playSa || env.ASN_PLAY_SA_FILE || path.join(home, '.asn', 'play', 'play-service-account.json'),
    ASN_PLAY_UPLOAD_JKS: opts.jks || path.join(keyDir, 'upload.jks'),
    ASN_PLAY_UPLOAD_PASSWORD: opts.passFile || path.join(keyDir, 'upload.jks.password'),
    ASN_GOOGLE_SERVICES_JSON: opts.gs || path.join(root, GOOGLE_SERVICES_REL),
  }
}

// 每個 secret 的檢查：回 { value } 或 { problem }。problem 不得帶檔案內容（含 JSON.parse 的錯誤訊息，它會夾內容片段）
const CHECKS = {
  ASN_PLAY_SA_JSON_B64(buf) {
    let j
    try { j = JSON.parse(buf.toString('utf8')) } catch { return { problem: '不是合法的 JSON' } }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { problem: '不是 JSON 物件' }
    const missing = []
    if (j.type !== 'service_account') missing.push('type 必須是 service_account')
    for (const k of ['client_email', 'private_key']) if (typeof j[k] !== 'string' || !j[k]) missing.push(`缺 ${k}`)
    if (missing.length) return { problem: `服務帳戶欄位不符：${missing.join('、')}` }
    return { value: buf.toString('base64') }
  },
  ASN_PLAY_UPLOAD_JKS(buf) {
    if (!buf.length) return { problem: '檔案是空的' }
    return { value: buf.toString('base64') }
  },
  ASN_PLAY_UPLOAD_PASSWORD(buf) {
    const s = buf.toString('utf8').replace(/(\r?\n)+$/, '')
    if (!s) return { problem: '密碼是空的' }
    return { value: s }
  },
  ASN_GOOGLE_SERVICES_JSON(buf) {
    try { JSON.parse(buf.toString('utf8')) } catch { return { problem: '不是合法的 JSON' } }
    return { value: buf.toString('base64') }
  },
}

/** 全部先檢查（記憶體內）。回 { rows: [{name, file, size, ok, problem}], values: Map(名稱 → 要寫的值) } */
export function checkInputs(names, paths, readFile) {
  const rows = []
  const values = new Map()
  for (const name of names) {
    const file = paths[name]
    let buf
    try { buf = readFile(file) } catch { rows.push({ name, file, size: null, ok: false, problem: '找不到或讀不到這個檔案' }); continue }
    const r = CHECKS[name](buf)
    if (r.problem) rows.push({ name, file, size: buf.length, ok: false, problem: r.problem })
    else { rows.push({ name, file, size: buf.length, ok: true }); values.set(name, r.value) }
  }
  return { rows, values }
}

const rowText = r => `${r.ok ? '通過' : '失敗'}  ${r.name}  檔案：${r.file}${r.size === null ? '' : `（${r.size} 位元組）`}${r.ok ? '' : `  原因：${r.problem}`}`
const notFound = e => /\b404\b|not found/i.test(String(e?.message ?? e))

/** 把輸出裡不小心夾到的祕密值擋掉（gh 的錯誤訊息理論上不會有，這是最後一道） */
function makeRedactor(values) {
  const secrets = [...values.values()].filter(v => v.length >= 4)
  return s => secrets.reduce((acc, v) => acc.split(v).join('***'), String(s))
}

/** PUT environment 的內容：只改部署規則；environment 已存在（existing 是 GET 的結果）就把原有保護設定一起帶回 */
export function putBody(existing) {
  const body = { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }
  if (!existing) return body
  if (typeof existing.can_admins_bypass === 'boolean') body.can_admins_bypass = existing.can_admins_bypass
  const rules = Array.isArray(existing.protection_rules) ? existing.protection_rules : []
  const wait = rules.find(r => r.type === 'wait_timer')
  if (wait && Number.isInteger(wait.wait_timer)) body.wait_timer = wait.wait_timer
  const rev = rules.find(r => r.type === 'required_reviewers')
  if (rev) {
    const reviewers = (rev.reviewers ?? []).map(x => ({ type: x.type, id: x.reviewer?.id })).filter(x => x.type && Number.isInteger(x.id))
    if (reviewers.length) body.reviewers = reviewers
    if (typeof rev.prevent_self_review === 'boolean') body.prevent_self_review = rev.prevent_self_review
  }
  return body
}

/** 建 environment 並限定 v* 標籤；標籤 ruleset 只讀檢查。回結束碼 */
export function setupEnvironment({ repo, dryRun, gh, log, warn }) {
  const base = `repos/${repo}/environments/${ENV_NAME}`
  if (dryRun) {
    log(`（演練，不呼叫 gh）會做：建立 environment ${ENV_NAME}，deployment_branch_policy 設 custom_branch_policies: true；再加標籤規則 ${TAG_PATTERN}；唯讀檢查 v* 標籤 ruleset 是否已設。不設 required reviewers。`)
    return 0
  }
  // 先建並設成自訂規則（API 要這樣才接受 type: tag 的規則）。這支 API 是「建立或更新」：environment 已存在時，
  // 沒帶的保護設定（等待時間、必要審核者、禁止自己核准、管理員可否略過）會被重置，所以先讀出來原樣帶回去。
  // 不存在就只帶部署規則（本腳本不新增 required reviewers）
  let existing = null
  try { existing = JSON.parse(gh(['api', base]) || '{}') } catch (e) {
    if (!notFound(e)) throw e
  }
  gh(['api', '-X', 'PUT', base, '--input', '-'], { input: JSON.stringify(putBody(existing)) })
  log(`已${existing ? '更新' : '建立'} environment ${ENV_NAME}：自訂部署規則${existing ? '（原有的等待時間與審核者設定原樣保留）' : ''}`)
  const listed = JSON.parse(gh(['api', `${base}/deployment-branch-policies`]) || '{}')
  const has = (listed.branch_policies ?? []).some(p => p.name === TAG_PATTERN && p.type === 'tag')
  if (has) log(`標籤規則 ${TAG_PATTERN} 已存在`)
  else {
    gh(['api', '-X', 'POST', `${base}/deployment-branch-policies`, '--input', '-'], { input: JSON.stringify({ name: TAG_PATTERN, type: 'tag' }) })
    log(`已加標籤規則 ${TAG_PATTERN}`)
  }
  // 只讀：誰能建立 v* 標籤的 ruleset 沒設就警告（沒設好不開 ASN_RELEASE_AUTO）
  const list = JSON.parse(gh(['api', `repos/${repo}/rulesets`]) || '[]')
  let ok = false
  for (const rs of list.filter(r => r.target === 'tag' && r.enforcement === 'active')) {
    const d = JSON.parse(gh(['api', `repos/${repo}/rulesets/${rs.id}`]) || '{}')
    const inc = d.conditions?.ref_name?.include ?? []
    const covers = inc.some(x => x === '~ALL' || x === 'refs/tags/*' || x === `refs/tags/${TAG_PATTERN}`)
    if (covers && (d.rules ?? []).some(r => r.type === 'creation')) ok = true
  }
  if (!ok) { warn(`警告：沒找到限制建立 ${TAG_PATTERN} 標籤的 ruleset（作用在標籤、已啟用、含「限制建立」）。這是上線前提，沒設好不要開 ASN_RELEASE_AUTO。`); return 1 }
  log(`ruleset：已有限制建立 ${TAG_PATTERN} 標籤的規則`)
  return 0
}

/**
 * 主流程。注入：gh(args, {input}) → 輸出字串（失敗拋錯）、readFile(path) → Buffer、log／warn、env、home、root。
 * 回結束碼：0 成功、1 失敗、2 用法錯。
 */
export function run({ argv, gh, readFile, log, warn, env, home, root }) {
  const p = parseArgs(argv)
  if (p.error) { warn(p.error); return 2 }
  const opts = p.opts
  try {
    if (opts.setupEnv) {
      if (opts.only || opts.playSa || opts.jks || opts.passFile || opts.gs) { warn('--setup-env 只建 environment 與標籤規則，不能和 --only 或輸入檔旗標一起用'); return 2 }
      if (!opts.dryRun) { gh(['auth', 'status']); }
      return setupEnvironment({ repo: opts.repo, dryRun: opts.dryRun, gh, log, warn })
    }
    const names = opts.only ?? SECRET_NAMES
    const { rows, values } = checkInputs(names, resolvePaths(opts, { env, home, root }), readFile)
    const redact = makeRedactor(values)
    for (const r of rows) (r.ok ? log : warn)(rowText(r))
    const bad = rows.filter(r => !r.ok)
    if (bad.length) { warn(`檢查沒過（${bad.map(r => r.name).join('、')}）：一個都沒寫。`); return 1 }
    if (opts.dryRun) { log(`（演練，不呼叫 gh）檢查全過；實際執行會依序寫入：${names.join('、')}`); return 0 }

    gh(['auth', 'status'])
    let admin
    try { admin = gh(['api', `repos/${opts.repo}`, '--jq', '.permissions.admin']).trim() } catch (e) { warn(`查不到 ${opts.repo} 的權限：${redact(String(e.message).split('\n')[0])}`); return 1 }
    if (admin !== 'true') { warn(`這個 gh 登入對 ${opts.repo} 沒有管理權限，寫不了 secret。`); return 1 }
    try { gh(['api', `repos/${opts.repo}/environments/${ENV_NAME}`]) } catch (e) {
      if (notFound(e)) { warn(`environment ${ENV_NAME} 還不存在：先跑 --setup-env 再重跑本指令。一個都沒寫。`); return 1 }
      warn(`查 environment 失敗：${redact(String(e.message).split('\n')[0])}`); return 1
    }
    const written = []
    for (const name of names) {
      try { gh(['secret', 'set', name, '--env', ENV_NAME, '--repo', opts.repo], { input: values.get(name) }) } catch (e) {
        warn(`寫入 ${name} 失敗：${redact(String(e.message).split('\n')[0])}`)
        warn(`已寫入：${written.join('、') || '（無）'}`)
        warn(`未寫入：${names.slice(written.length).join('、')}`)
        return 1
      }
      written.push(name)
      log(`已寫入：${name}`)
    }
    const listed = JSON.parse(gh(['secret', 'list', '--env', ENV_NAME, '--repo', opts.repo, '--json', 'name']) || '[]').map(x => x.name)
    const missing = names.filter(n => !listed.includes(n))
    if (missing.length) { warn(`寫完後 secret list 找不到：${missing.join('、')}`); return 1 }
    log(`完成：${names.join('、')} 都在 environment ${ENV_NAME}（只比對名稱）`)
    return 0
  } catch (e) {
    warn(`中止：${String(e?.message ?? e).split('\n')[0]}`)
    return 1
  }
}

const realGh = (args, { input } = {}) => {
  try { return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }) } catch (e) { throw new Error(String(e.stderr || e.message)) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const code = run({
    argv: process.argv.slice(2),
    gh: realGh,
    readFile: f => fs.readFileSync(f),
    log: m => console.log(m),
    warn: m => console.error(m),
    env: process.env,
    home: os.homedir(),
    root,
  })
  process.exit(code)
}
