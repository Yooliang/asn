// 線上核對（#1892 規格 2.5 第 9 步）：部署完以後，從網路上把這一版再看一遍，確認「真的上線」而不是 firebase 程序還在跑。
// 一律帶 ?t=（避開 CDN 快取）。核對項目：
//   1. update/latest.json 的 version、notes、signature、url 與預期一致
//   2. 安裝檔（官網路徑，跟著 302 轉到 GitHub 下載）的 sha256 與大小與預期一致；.sig 文字同
//   3. 首頁所有指向安裝檔的連結都指向這一版
//   4. skill/version.json 與預期一致，且線上技能說明檔換成 LF 之後的雜湊就是 version.json 記的
// CDN 慢：全部項目重試 attempts 次（預設 10）、每次隔 intervalMs（預設 15 秒）；sleep 與 fetch 都注入，測試不真的等。
// 純函式：不碰檔案系統（CLI 另外讀本機檔）；訊息只寫哪一項不符，不貼金鑰。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { INSTALLER_HREF_RE, PLATFORM, installerName, installerUrl } from '../../relay/asn/scripts/release-lib.mjs'
import { skillVersionInfo } from '../../site/make-skill-version.mjs'

export const DEFAULT_BASE = 'https://asnmessenger.web.app'
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')

/**
 * expected：{ version, notes, signature（latest.json 的 signature 欄）, sigText（.sig 原文）, exeSha256, exeSize, skill: { version, sha256 } }
 * 回 { ok, attempts, problems }（problems＝最後一輪沒過的項目；ok 時為空）
 */
export async function verifyOnline({ expected, base = DEFAULT_BASE, fetchFn = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, attempts = 10, intervalMs = 15000, log = () => {} }) {
  let problems = []
  for (let n = 1; n <= attempts; n++) {
    problems = await checkOnce({ expected, base, fetchFn, t: now() })
    if (problems.length === 0) return { ok: true, attempts: n, problems }
    log(`線上核對第 ${n}／${attempts} 次沒過（${problems.length} 項）：${problems[0]}`)
    if (n < attempts) await sleep(intervalMs)
  }
  return { ok: false, attempts, problems }
}

async function get(fetchFn, url, t, as) {
  const u = `${url}${url.includes('?') ? '&' : '?'}t=${t}`
  let res
  try { res = await fetchFn(u, { redirect: 'follow', headers: { 'accept-encoding': 'identity', 'cache-control': 'no-cache' } }) } catch (e) { return { err: `連不上 ${url}（${e.message}）` } }
  if (!res.ok) { await res.body?.cancel?.(); return { err: `${url} 回 HTTP ${res.status}` } }
  return as === 'text' ? { value: await res.text() } : { value: Buffer.from(await res.arrayBuffer()) }
}

export async function checkOnce({ expected: e, base, fetchFn, t }) {
  const problems = []
  const url = installerUrl(e.version)
  const siteUrl = `${base}/update/${encodeURIComponent(installerName(e.version))}`
  const push = m => problems.push(m)

  // 1. latest.json
  const lj = await get(fetchFn, `${base}/update/latest.json`, t, 'text')
  if (lj.err) push(lj.err)
  else {
    let j = null
    try { j = JSON.parse(lj.value) } catch { push('線上 latest.json 不是合法的 JSON') }
    if (j) {
      const p = j.platforms?.[PLATFORM]
      if (j.version !== e.version) push(`線上 latest.json 的 version 是 ${j.version}，預期 ${e.version}`)
      if (String(j.notes ?? '').trim() !== String(e.notes ?? '').trim()) push('線上 latest.json 的 notes 與預期不同')
      if (p?.signature !== e.signature) push('線上 latest.json 的 signature 與預期不同')
      if (p?.url !== url) push(`線上 latest.json 的 url 是 ${p?.url}，預期 ${url}`)
    }
  }
  // 2. 安裝檔與 .sig（官網路徑，fetch 跟著 302 走）
  const exe = await get(fetchFn, siteUrl, t, 'buffer')
  if (exe.err) push(exe.err)
  else {
    if (exe.value.length !== e.exeSize) push(`線上安裝檔大小 ${exe.value.length}，預期 ${e.exeSize}`)
    if (sha256(exe.value) !== e.exeSha256) push('線上安裝檔的 sha256 與預期不同')
  }
  const sig = await get(fetchFn, `${siteUrl}.sig`, t, 'text')
  if (sig.err) push(sig.err)
  else if (sig.value.trim() !== String(e.sigText).trim()) push('線上 .sig 與預期不同')
  // 3. 首頁連結
  const home = await get(fetchFn, `${base}/`, t, 'text')
  if (home.err) push(home.err)
  else {
    const hrefs = [...home.value.matchAll(INSTALLER_HREF_RE)].map(m => m[0])
    if (hrefs.length === 0) push('線上首頁找不到安裝檔連結')
    else for (const h of hrefs) if (h !== `href="${url}"`) push(`線上首頁有連結沒指向這一版：${h}`)
  }
  // 4. 技能說明檔
  const sv = await get(fetchFn, `${base}/skill/version.json`, t, 'text')
  if (sv.err) push(sv.err)
  else {
    let j = null
    try { j = JSON.parse(sv.value) } catch { push('線上 skill/version.json 不是合法的 JSON') }
    if (j && (j.version !== e.skill.version || j.sha256 !== e.skill.sha256)) push('線上 skill/version.json 與預期不同')
  }
  const md = await get(fetchFn, `${base}/skill/asn-cloud-agent.md`, t, 'text')
  if (md.err) push(md.err)
  else {
    let info = null
    try { info = skillVersionInfo(md.value) } catch (x) { push(`線上技能說明檔讀不出版本：${x.message}`) }
    if (info && info.sha256 !== e.skill.sha256) push('線上技能說明檔的雜湊與 version.json 記的不同')
  }
  return problems
}

// ---- Linux 版線上核對（附加在電腦版之後）：電腦版項不准被動到，Linux 項與檔案、首頁連結都要對
// expected：{ version, windows: { signature, url }, linux: { signature, url, sigText, appImage: { name, sha256, size }, deb: { name, sha256, size } } }
export async function verifyOnlineLinux({ expected, base = DEFAULT_BASE, fetchFn = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, attempts = 10, intervalMs = 15000, log = () => {} }) {
  let problems = []
  for (let n = 1; n <= attempts; n++) {
    problems = await checkLinuxOnce({ expected, base, fetchFn, t: now() })
    if (problems.length === 0) return { ok: true, attempts: n, problems }
    log(`線上核對（Linux）第 ${n}／${attempts} 次沒過（${problems.length} 項）：${problems[0]}`)
    if (n < attempts) await sleep(intervalMs)
  }
  return { ok: false, attempts, problems }
}

export async function checkLinuxOnce({ expected: e, base, fetchFn, t }) {
  const problems = []
  const push = m => problems.push(m)
  const L = e.linux
  const siteUrl = name => `${base}/update/${encodeURIComponent(name)}`
  const lj = await get(fetchFn, `${base}/update/latest.json`, t, 'text')
  if (lj.err) push(lj.err)
  else {
    let j = null
    try { j = JSON.parse(lj.value) } catch { push('線上 latest.json 不是合法的 JSON') }
    if (j) {
      if (j.version !== e.version) push(`線上 latest.json 的 version 是 ${j.version}，預期 ${e.version}`)
      const w = j.platforms?.['windows-x86_64']
      if (w?.signature !== e.windows.signature || w?.url !== e.windows.url) push('線上 latest.json 的電腦版項被動到了（與部署前不同）')
      const p = j.platforms?.['linux-x86_64']
      if (p?.signature !== L.signature) push('線上 latest.json 的 linux-x86_64 signature 與預期不同')
      if (p?.url !== L.url) push(`線上 latest.json 的 linux-x86_64 url 是 ${p?.url}，預期 ${L.url}`)
    }
  }
  for (const f of [L.appImage, L.deb]) {
    const r = await get(fetchFn, siteUrl(f.name), t, 'buffer')
    if (r.err) push(r.err)
    else {
      if (r.value.length !== f.size) push(`線上 ${f.name} 大小 ${r.value.length}，預期 ${f.size}`)
      if (sha256(r.value) !== f.sha256) push(`線上 ${f.name} 的 sha256 與預期不同`)
    }
  }
  const sig = await get(fetchFn, `${siteUrl(L.appImage.name)}.sig`, t, 'text')
  if (sig.err) push(sig.err)
  else if (sig.value.trim() !== String(L.sigText).trim()) push('線上 AppImage 的 .sig 與預期不同')
  const home = await get(fetchFn, `${base}/`, t, 'text')
  if (home.err) push(home.err)
  else {
    for (const f of [L.appImage, L.deb]) if (!home.value.includes(`href="${siteUrl(f.name)}"`)) push(`線上首頁找不到 ${f.name} 的連結`)
    for (const m of home.value.matchAll(INSTALLER_HREF_RE)) if (m[0] !== `href="${e.windows.url}"`) push(`線上首頁的電腦版連結被動到了：${m[0]}`)
  }
  return problems
}

// ---- 薄 CLI：node tools/release/verify_online.mjs --version <版本> --exe <安裝檔> --sig <.sig> [--site <site 資料夾>] [--base <網址>]
// 預期值取本機：site/public/update/latest.json（notes、signature）、安裝檔、.sig、site/public/skill/version.json
export async function main(argv = process.argv.slice(2), { readFile = p => fs.readFileSync(p), log = console.log, fetchFn = fetch, sleep } = {}) {
  const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const version = arg('--version'), exeFile = arg('--exe'), sigFile = arg('--sig')
  const site = arg('--site') ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'site')
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !exeFile || !sigFile) { log('用法：--version <版本> --exe <安裝檔> --sig <.sig> [--site <資料夾>] [--base <網址>]'); return 2 }
  try {
    const rd = p => readFile(p).toString('utf8')
    const latest = JSON.parse(rd(path.join(site, 'public', 'update', 'latest.json')))
    const exe = readFile(exeFile)
    const expected = {
      version, notes: latest.notes, signature: latest.platforms?.[PLATFORM]?.signature, sigText: rd(sigFile),
      exeSha256: sha256(exe), exeSize: exe.length, skill: JSON.parse(rd(path.join(site, 'public', 'skill', 'version.json'))),
    }
    const r = await verifyOnline({ expected, base: arg('--base') ?? DEFAULT_BASE, fetchFn, sleep, log })
    if (!r.ok) { log(`線上核對沒過（${r.attempts} 次後）：`); for (const p of r.problems) log(`- ${p}`); return 1 }
    log(`線上核對通過（第 ${r.attempts} 次）：v${version}`)
    return 0
  } catch (e) { log(`線上核對中止：${e.message}`); return 1 }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main())
