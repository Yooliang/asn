// 官網部署前檢查（site/firebase.json 的 hosting.predeploy 會呼叫）。
// 安裝檔（電腦版 exe、.sig、手機 APK）從 #1585 起不放官網：放在 GitHub Release v<版本>，官網的 update/ASN_<版本>_… 由 firebase.json 302 轉過去
// （Firebase 免費方案不准再上傳新的 .exe）。所以這裡：
//   1. 官網目錄的 update/ 底下不准有安裝檔（exe、sig、apk），有就擋：會被轉址蓋過、白佔空間，新的 exe 也上傳不了
//   2. 這次的 update/latest.json、update/android.json 指的安裝檔，轉到 GitHub 之後真的下載得到：
//      電腦版的 .sig 要等於 latest.json 裡的簽章、安裝檔要回 200；手機 APK 要回 200、大小等於 android.json 記的。下載不到就擋（不帶著壞連結部署）
//   2b. 舊版安裝檔（tools/release/legacy-installers.json 的 41 個）也要都在 GitHub 上：firebase.json 一部署，所有舊的 exe、sig、apk 連結都轉到 GitHub，
//      還沒搬就全部 404。每個檔送一次 HEAD（跟著轉址走），全部 200、大小也對才放行；不然擋，請先跑 github_legacy --apply、--verify
//   3. 下載區（download/downloads.json：收發室橋的 zip，不是安裝檔）照舊：Firebase 每次部署都把整個網站換成這台電腦上的內容，
//      zip 不進 git，本機沒有就從線上目前的版本補上並核對，核對不符或下載失敗就擋
// 安裝檔清單（update/latest.json、update/android.json）的網址一律要寫官網 update/ 底下（#1585 甲案：檔案放 GitHub Release，
// 官網路徑由 firebase.json 轉址過去）。以前遇到別的主機會靜默略過、不補也不核對，等於帶著沒檢查的網址部署；現在直接擋下。
// android.json 還要過舊版 App 的白名單（relay/asn/src-tauri/src/android_update.rs 的 url_allowed）：不然舊的自行安裝版會整份拒絕。
// android.json 的 git 歷史改不了：歷史上有不合格的只記警告（skipped），不擋部署。下載區（downloads.json）本來就有別站的檔（SKILL.md），不在此限。
// 用法：node tools/release/site_predeploy.mjs [--site <site 資料夾>] [--base <網站網址>]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { INSTALLER_FILE_RE, githubUrl, githubUrlForSite } from './github_release.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_SITE = path.resolve(here, '..', '..', 'site')
export const DEFAULT_BASE = 'https://asnmessenger.web.app'

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')
const readJson = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

// 清單裡指到本站的檔案：[{ rel（相對 public/）、sha256?、size?、optional? }]
// 以前的 android.json 指過的 APK：[{ url, sha256, bytes }]。不是 git 倉庫或沒有歷史就回空陣列。
export function androidHistory(siteDir) {
  try {
    const git = args => execFileSync('git', ['-C', siteDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
    const rel = 'public/update/android.json'
    const out = []
    for (const h of git(['log', '--format=%H', '--', rel]).split(/\s+/).filter(Boolean)) {
      try { const j = JSON.parse(git(['show', `${h}:./${rel}`])); if (j?.url) out.push({ url: j.url, sha256: j.sha256, bytes: j.bytes }) } catch { /* 那一版讀不出來就略過 */ }
    }
    return out
  } catch { return [] }
}

// 跟 android_update.rs 的 url_allowed 逐條對齊：長度看 UTF-8 位元組（Rust 的 url.len()）；控制字元照 Rust 的 char::is_control，
// 也就是 U+0000～U+001F、U+007F～U+009F；另外擋空白 \ " ' < >，update/ 後面不能有 .. @ ? #
const RUST_CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const androidAllowed = url => Buffer.byteLength(url, 'utf8') <= 300 && !RUST_CONTROL.test(url) && !/[ \\"'<>@?#]/.test(url)

/** 安裝檔清單的網址不合格的原因；合格回空字串。android＝要過舊版 App 白名單（跟 android_update.rs 的 url_allowed 同一套） */
export function installerUrlProblem(url, base = DEFAULT_BASE, { android = false } = {}) {
  if (typeof url !== 'string' || !url) return '沒有網址'
  const prefix = `${base}/update/`
  if (!url.startsWith(prefix)) return `不是官網 update/ 底下的網址（安裝檔一律寫官網路徑，轉到 GitHub Release 交給 firebase.json）：${url}`
  const rest = url.slice(prefix.length)
  if (!rest || rest.includes('..')) return `路徑不對：${url}`
  if (android && !androidAllowed(url)) return `舊版 App 的白名單不收這個網址（不能有 @ ? # 空白、引號、角括號、反斜線與控制字元，最長 300 位元組）：${url}`
  return ''
}

/** 安裝檔清單逐一檢查：errors＝這次的清單（要擋部署）；warnings＝android.json 歷史上的（改不了，只記下來） */
export function installerUrlProblems(siteDir, base = DEFAULT_BASE, history = androidHistory(siteDir)) {
  const pub = path.join(siteDir, 'public')
  const errors = [], warnings = []
  const latest = readJson(path.join(pub, 'update', 'latest.json'))
  // 檔名也要是轉址認得的那幾種（firebase.json 的 redirects、github_release.mjs 的 INSTALLER_FILE_RE），不然轉不到 GitHub
  const nameWhy = url => (INSTALLER_FILE_RE.test(decodeURIComponent(String(url).slice(`${base}/update/`.length))) ? '' : `檔名不是 ASN_<版本>_x64-setup.exe／ASN_<版本>_android.apk（firebase.json 的轉址只認這兩種）：${url}`)
  for (const [k, p] of Object.entries(latest?.platforms ?? {})) {
    const why = installerUrlProblem(p?.url, base) || nameWhy(p?.url)
    if (why) errors.push(`update/latest.json 的 ${k}：${why}`)
  }
  const android = readJson(path.join(pub, 'update', 'android.json'))
  if (android) {
    const why = installerUrlProblem(android.url, base, { android: true }) || nameWhy(android.url)
    if (why) errors.push(`update/android.json：${why}`)
  }
  for (const h of history) {
    const why = installerUrlProblem(h.url, base, { android: true })
    if (why) warnings.push(`update/android.json 的歷史：${why}`)
  }
  return { errors, warnings }
}

// 要從線上補回的檔：只剩下載區（安裝檔改放 GitHub，不補）。[{ rel（相對 public/）、sha256?、size? }]
export function wantedFiles(siteDir, base = DEFAULT_BASE) {
  const pub = path.join(siteDir, 'public')
  const out = new Map()
  const add = (url, extra = {}) => {
    if (typeof url !== 'string' || !url.startsWith(`${base}/`)) return   // 下載區本來就有別站的檔（SKILL.md），不管
    const rel = decodeURIComponent(new URL(url).pathname.slice(1))
    if (!rel || rel.split('/').includes('..')) return
    out.set(rel, { ...out.get(rel), ...extra, rel })
  }
  const dl = readJson(path.join(pub, 'download', 'downloads.json'))
  for (const f of Object.values(dl?.files ?? {})) add(f?.url, { sha256: f?.sha256, size: f?.size })
  return [...out.values()]
}

/** 官網目錄 update/ 底下的安裝檔（不該有）：相對 public/ 的路徑 */
export function installersInPublic(siteDir) {
  const dir = path.join(siteDir, 'public', 'update')
  let names = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  return names.filter(n => /\.(exe|sig|apk)$/i.test(n)).map(n => `update/${n}`).sort()
}

/** 這次的清單指的安裝檔，轉到 GitHub 之後真的下載得到：回錯誤說明的陣列（空＝都在） */
export async function githubProblems(siteDir, { fetchFn = fetch } = {}) {
  const pub = path.join(siteDir, 'public')
  const errors = []
  const get = async (url, method = 'GET') => {
    try { return await fetchFn(url, { method, redirect: 'follow', headers: { 'accept-encoding': 'identity' } }) } catch (e) { return { ok: false, status: `連不上（${e.message}）` } }
  }
  const latest = readJson(path.join(pub, 'update', 'latest.json'))
  for (const [k, p] of Object.entries(latest?.platforms ?? {})) {
    const exe = githubUrlForSite(p?.url), sig = githubUrlForSite(`${p?.url}.sig`)
    if (!exe || !sig) { errors.push(`update/latest.json 的 ${k}：認不得的安裝檔網址 ${p?.url}`); continue }
    const r = await get(sig)
    if (!r.ok) { await r.body?.cancel?.(); errors.push(`GitHub 上沒有 ${sig}（HTTP ${r.status}）：新版先用 tools/release/github_release.mjs 發；舊版（legacy-installers.json 裡的）先跑 tools/release/github_legacy.mjs --apply`); continue }
    const text = Buffer.from(await r.arrayBuffer()).toString('utf8').trim()
    if (text !== String(p.signature ?? '').trim()) errors.push(`GitHub 上的 ${sig} 跟 latest.json 的簽章不一樣`)
    const h = await get(exe, 'HEAD')
    await h.body?.cancel?.()
    if (!h.ok) errors.push(`GitHub 上沒有 ${exe}（HTTP ${h.status}）`)
  }
  const android = readJson(path.join(pub, 'update', 'android.json'))
  if (android?.url) {
    const apk = githubUrlForSite(android.url)
    if (!apk) errors.push(`update/android.json：認不得的安裝檔網址 ${android.url}`)
    else {
      const h = await get(apk, 'HEAD')
      await h.body?.cancel?.()
      const len = Number(h.headers?.get?.('content-length'))
      if (!h.ok) errors.push(`GitHub 上沒有 ${apk}（HTTP ${h.status}）`)
      else if (Number.isInteger(android.bytes) && Number.isInteger(len) && len > 0 && len !== android.bytes) errors.push(`GitHub 上的 ${apk} 大小 ${len}，android.json 記的是 ${android.bytes}`)
    }
  }
  return errors
}

function check(buf, want, label) {
  if (want.sha256 && sha256(buf) !== String(want.sha256).toLowerCase()) throw new Error(`${label}：sha256 對不起來`)
  if (Number.isInteger(want.size) && buf.length !== want.size) throw new Error(`${label}：大小 ${buf.length} 位元組，清單寫的是 ${want.size}`)
}

export const LEGACY_MANIFEST = path.join(here, 'legacy-installers.json')
export const loadLegacy = (file = LEGACY_MANIFEST) => JSON.parse(fs.readFileSync(file, 'utf8'))

/** 舊版安裝檔都已經在 GitHub 上：每個檔 HEAD 一次（跟著轉址），回錯誤說明的陣列（空＝都在）；同時最多問 limit 個 */
export async function legacyProblems(legacy, { fetchFn = fetch, limit = 6 } = {}) {
  const jobs = legacy.flatMap(r => (r.assets ?? []).map(a => ({ url: githubUrl(r.version, a.name), size: a.size })))
  const errors = []
  let i = 0
  const worker = async () => {
    while (i < jobs.length) {
      const j = jobs[i++]
      let res
      try { res = await fetchFn(j.url, { method: 'HEAD', redirect: 'follow', headers: { 'accept-encoding': 'identity' } }) } catch (e) { errors.push(`${j.url}：連不上（${e.message}）`); continue }
      await res.body?.cancel?.()
      const raw = res.headers?.get?.('content-length')
      const len = raw == null || raw === '' ? NaN : Number(raw)   // 沒有大小＝不明，不當成 0
      if (!res.ok) errors.push(`${j.url}：HTTP ${res.status}`)
      else if (!Number.isInteger(len) || len !== j.size) errors.push(`${j.url}：大小 ${Number.isInteger(len) ? len : '不明'}，清單是 ${j.size}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker))
  return errors.sort()
}

// 回傳 { present, fetched, skipped }；官網目錄有安裝檔、GitHub 上找不到這版、下載區的檔補不起來，都丟錯（訊息寫明是哪個檔）
export async function predeploy({ siteDir = DEFAULT_SITE, base = DEFAULT_BASE, fetchFn = fetch, log = () => {}, history, legacy = loadLegacy() } = {}) {
  const pub = path.join(siteDir, 'public')
  const result = { present: [], fetched: [], skipped: [] }
  const hist = history ?? androidHistory(siteDir)
  const urls = installerUrlProblems(siteDir, base, hist)
  if (urls.errors.length) throw new Error(`部署前檢查失敗：安裝檔清單的網址不對\n${urls.errors.map(e => `  - ${e}`).join('\n')}`)
  for (const w of urls.warnings) { result.skipped.push(w); log(`注意：${w}`) }
  const local = installersInPublic(siteDir)
  if (local.length) throw new Error(`部署前檢查失敗：官網目錄不該再放安裝檔（改放 GitHub Release，官網路徑由 firebase.json 轉址）：\n${local.map(r => `  - ${r}`).join('\n')}`)
  const gh = await githubProblems(siteDir, { fetchFn })
  if (gh.length) throw new Error(`部署前檢查失敗：安裝檔在 GitHub Release 上找不到或對不上\n${gh.map(e => `  - ${e}`).join('\n')}`)
  const old = await legacyProblems(legacy, { fetchFn })
  if (old.length) throw new Error(`部署前檢查失敗：舊版安裝檔還沒全部搬到 GitHub（firebase.json 一部署，舊連結都會轉過去，沒搬的會 404）。先跑 node tools/release/github_legacy.mjs --apply，再跑 --verify：\n${old.map(e => `  - ${e}`).join('\n')}`)
  for (const want of wantedFiles(siteDir, base)) {
    const file = path.join(pub, ...want.rel.split('/'))
    if (fs.existsSync(file)) {
      // 本機有：有 sha／大小的就核對，不符就擋（不覆蓋，免得把別人的檔案換掉）
      try { check(fs.readFileSync(file), want, want.rel) } catch (e) { throw new Error(`部署前檢查失敗：本機的 ${e.message}`) }
      result.present.push(want.rel)
      continue
    }
    const url = `${base}/${want.rel.split('/').map(encodeURIComponent).join('/')}`
    let res
    try { res = await fetchFn(url, { headers: { 'accept-encoding': 'identity' } }) } catch (e) { throw new Error(`部署前檢查失敗：本機沒有 ${want.rel}，從線上下載也失敗（${e.message}）`) }
    if (!res.ok) {
      await res.body?.cancel?.() // 不讀的回應要丟棄，否則連線一直開著，程序結束不了、部署卡住
      throw new Error(`部署前檢查失敗：本機沒有 ${want.rel}，線上也拿不到（HTTP ${res.status}）`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    // 要求不壓縮；伺服器還是回了壓縮（content-encoding 不是 identity）時，content-length 是壓縮後的大小，跟解壓後的 body 比對一定不符，所以略過這個比對
    // （有 sha256 或清單大小的照樣比，見 check）
    const enc = String(res.headers?.get?.('content-encoding') ?? 'identity').trim().toLowerCase()
    const len = enc === 'identity' ? Number(res.headers?.get?.('content-length')) : NaN
    try {
      check(buf, want, want.rel)
      if (Number.isInteger(len) && len > 0 && buf.length !== len) throw new Error(`${want.rel}：下載到 ${buf.length} 位元組，伺服器說 ${len}`)
    } catch (e) { throw new Error(`部署前檢查失敗：從線上補 ${e.message}`) }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, buf)
    result.fetched.push(want.rel)
    log(`已從線上補回 ${want.rel}（${buf.length} 位元組）`)
  }
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const opt = { log: m => console.log(m) }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--site') opt.siteDir = path.resolve(args[++i])
    else if (args[i] === '--base') opt.base = args[++i]
    else { console.error(`不認得的參數：${args[i]}`); process.exit(2) }
  }
  try {
    const r = await predeploy(opt)
    console.log(`部署前檢查通過：本機已有 ${r.present.length} 個、從線上補回 ${r.fetched.length} 個${r.skipped.length ? `、略過 ${r.skipped.length} 個（線上沒有）` : ''}`)
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
