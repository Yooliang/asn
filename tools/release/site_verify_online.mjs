// 官網部署後的線上核對（#1947 ④）：部署完從網路上再看一遍，確認這一版真的上線。
// 核對：1. 線上 update/latest.json 的 JSON 內容等於 repo 的 site/public/update/latest.json
//       2. 首頁裡所有指向 /update/ASN_*（安裝檔）的連結，跟著轉址之後回 200
// 一律帶 ?t= 與 cache-control: no-cache；CDN 慢，整批重試 attempts 次。fetch／sleep 皆可注入，測試不真的等。
// 訊息只寫哪一項不符，不貼內容。
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'

export const DEFAULT_BASE = 'https://asnmessenger.web.app'
export const UPDATE_HREF_RE = /href="([^"]*\/update\/ASN_\d+\.\d+\.\d+_[^"]+)"/g
const HEADERS = { 'accept-encoding': 'identity', 'cache-control': 'no-cache' }
const withT = (url, t) => `${url}${url.includes('?') ? '&' : '?'}t=${t}`

async function call(fetchFn, url, t, method) {
  try {
    const res = await fetchFn(withT(url, t), { method, redirect: 'follow', headers: HEADERS })
    return { res }
  } catch (e) { return { err: `連不上 ${url}（${e.message}）` } }
}

/** 一輪核對，回問題陣列（空＝通過） */
export async function checkOnce({ expectedLatest, base, fetchFn, t }) {
  const problems = []
  const lj = await call(fetchFn, `${base}/update/latest.json`, t, 'GET')
  if (lj.err) problems.push(lj.err)
  else if (!lj.res.ok) problems.push(`${base}/update/latest.json 回 HTTP ${lj.res.status}`)
  else {
    let j = null
    try { j = JSON.parse(await lj.res.text()) } catch { problems.push('線上 latest.json 不是合法的 JSON') }
    if (j && !isDeepStrictEqual(j, expectedLatest)) problems.push(`線上 latest.json 與 repo 的不同（線上 version=${j?.version}，repo version=${expectedLatest?.version}）`)
  }
  const home = await call(fetchFn, `${base}/`, t, 'GET')
  if (home.err) problems.push(home.err)
  else if (!home.res.ok) problems.push(`${base}/ 回 HTTP ${home.res.status}`)
  else {
    const links = [...new Set([...(await home.res.text()).matchAll(UPDATE_HREF_RE)].map(m => m[1]))]
    if (links.length === 0) problems.push('線上首頁找不到安裝檔連結')
    for (const link of links) {
      const r = await call(fetchFn, link, t, 'HEAD')
      if (r.err) problems.push(r.err)
      else {
        await r.res.body?.cancel?.()
        if (r.res.status !== 200) problems.push(`安裝檔連結 ${link} 轉址後回 HTTP ${r.res.status}，預期 200`)
      }
    }
  }
  return problems
}

/** 回 { ok, attempts, problems } */
export async function verifySiteOnline({ expectedLatest, base = DEFAULT_BASE, fetchFn = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, attempts = 10, intervalMs = 15000, log = () => {} }) {
  let problems = []
  for (let n = 1; n <= attempts; n++) {
    problems = await checkOnce({ expectedLatest, base, fetchFn, t: now() })
    if (problems.length === 0) return { ok: true, attempts: n, problems }
    log(`官網線上核對第 ${n}／${attempts} 次沒過（${problems.length} 項）：${problems[0]}`)
    if (n < attempts) await sleep(intervalMs)
  }
  return { ok: false, attempts, problems }
}

// 薄 CLI：node tools/release/site_verify_online.mjs [--site site] [--base 網址] [--attempts N] [--interval 毫秒]
export async function main(argv = process.argv.slice(2), { readFile = p => fs.readFileSync(p, 'utf8'), log = console.log, fetchFn = fetch, sleep } = {}) {
  const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const site = arg('--site') ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'site')
  try {
    const expectedLatest = JSON.parse(readFile(path.join(site, 'public', 'update', 'latest.json')))
    const r = await verifySiteOnline({
      expectedLatest, base: arg('--base') ?? DEFAULT_BASE, fetchFn, sleep, log,
      ...(arg('--attempts') ? { attempts: Number(arg('--attempts')) } : {}),
      ...(arg('--interval') ? { intervalMs: Number(arg('--interval')) } : {}),
    })
    if (!r.ok) { log(`官網線上核對沒過（${r.attempts} 次後）：`); for (const p of r.problems) log(`- ${p}`); return 1 }
    log(`官網線上核對通過（第 ${r.attempts} 次）：v${expectedLatest.version}`)
    return 0
  } catch (e) { log(`官網線上核對中止：${e.message}`); return 1 }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main())
