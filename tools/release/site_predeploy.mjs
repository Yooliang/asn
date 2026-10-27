// 官網部署前檢查（site/firebase.json 的 hosting.predeploy 會呼叫）。
// Firebase 每次部署都把整個網站換成「這台電腦」上的內容；安裝檔與下載檔不進 git，所以換一台電腦部署就會把別人發的檔案弄不見。
// 這裡先讀三份清單，指到本站的每個檔案：本機沒有就從線上目前的版本下載補上並核對，核對不符或下載失敗就讓部署失敗，不帶著缺檔部署。
//   update/latest.json       電腦版更新：platforms.*.url（沒有 sha256；下載時比對伺服器回的大小）
//   update/android.json      手機更新：url，帶 sha256 與 bytes
//   download/downloads.json  下載區：files.*.url，帶 sha256 與 size
// 用法：node tools/release/site_predeploy.mjs [--site <site 資料夾>] [--base <網站網址>]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_SITE = path.resolve(here, '..', '..', 'site')
export const DEFAULT_BASE = 'https://asnmessenger.web.app'

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')
const readJson = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

// 清單裡指到本站的檔案：[{ rel（相對 public/）、sha256?、size?、optional? }]
export function wantedFiles(siteDir, base = DEFAULT_BASE) {
  const pub = path.join(siteDir, 'public')
  const out = new Map()
  const add = (url, extra = {}) => {
    if (typeof url !== 'string' || !url.startsWith(`${base}/`)) return
    const rel = decodeURIComponent(new URL(url).pathname.slice(1))
    if (!rel || rel.split('/').includes('..')) return
    out.set(rel, { ...out.get(rel), ...extra, rel })
  }
  const latest = readJson(path.join(pub, 'update', 'latest.json'))
  for (const p of Object.values(latest?.platforms ?? {})) {
    add(p?.url)
    if (p?.url) add(`${p.url}.sig`, { optional: true })   // 簽章也放在旁邊；線上沒有就算了（更新用 latest.json 裡的簽章字串）
  }
  const android = readJson(path.join(pub, 'update', 'android.json'))
  if (android?.url) add(android.url, { sha256: android.sha256, size: android.bytes })
  const dl = readJson(path.join(pub, 'download', 'downloads.json'))
  for (const f of Object.values(dl?.files ?? {})) add(f?.url, { sha256: f?.sha256, size: f?.size })
  return [...out.values()]
}

function check(buf, want, label) {
  if (want.sha256 && sha256(buf) !== String(want.sha256).toLowerCase()) throw new Error(`${label}：sha256 對不起來`)
  if (Number.isInteger(want.size) && buf.length !== want.size) throw new Error(`${label}：大小 ${buf.length} 位元組，清單寫的是 ${want.size}`)
}

// 回傳 { present, fetched, skipped }；任何一個檔案補不起來就丟錯（訊息寫明是哪個檔）
export async function predeploy({ siteDir = DEFAULT_SITE, base = DEFAULT_BASE, fetchFn = fetch, log = () => {} } = {}) {
  const pub = path.join(siteDir, 'public')
  const result = { present: [], fetched: [], skipped: [] }
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
    try { res = await fetchFn(url) } catch (e) { throw new Error(`部署前檢查失敗：本機沒有 ${want.rel}，從線上下載也失敗（${e.message}）`) }
    if (!res.ok) {
      if (want.optional && res.status === 404) { result.skipped.push(want.rel); continue }
      throw new Error(`部署前檢查失敗：本機沒有 ${want.rel}，線上也拿不到（HTTP ${res.status}）`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const len = Number(res.headers?.get?.('content-length'))
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
