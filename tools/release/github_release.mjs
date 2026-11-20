// 發一版電腦版安裝檔到 GitHub Release（#1585）：官網不再放安裝檔（Firebase 免費方案不准再上傳新的 .exe），
// latest.json 與首頁照舊寫官網路徑 https://asnmessenger.web.app/update/ASN_<版本>_x64-setup.exe，由 site/firebase.json 302 轉到這裡。
// 順序（任何一步失敗就停，不寫也不部署 latest.json）：
//   1. 建草稿 Release v<版本>（指向目前的 commit，這個 commit 要已經推上 GitHub）
//   2. 上傳安裝檔與 .sig（不覆蓋：同名已存在且大小不同就停）
//   3. 用這台電腦的 gh 登入把草稿裡的檔下載回來比對 sha256（草稿不公開，匿名下載不到）
//   4. 轉正式、設成 Latest
//   5. 不登入、匿名從公開網址下載比對 sha256；不一致就退回草稿並報錯
// 用法（repo 根目錄，發版腳本產完檔、提交並推上去之後）：
//   node tools/release/github_release.mjs --version 0.2.26 --exe <安裝檔> --sig <.sig> [--notes-file <更新說明>]
// 不讀也不印任何權杖：gh 用這台電腦現有的登入。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const REPO = 'Yooliang/asn'
export const SITE_UPDATE = 'https://asnmessenger.web.app/update/'
export const tagOf = v => `v${v}`
export const githubUrl = (v, name) => `https://github.com/${REPO}/releases/download/${tagOf(v)}/${encodeURIComponent(name)}`
export const installerFiles = v => [`ASN_${v}_x64-setup.exe`, `ASN_${v}_x64-setup.exe.sig`]
export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')

// 官網 update/ 底下的安裝檔路徑 → GitHub Release 的網址（跟 site/firebase.json 的轉址規則同一套；認不得的回 null）
// 檔名：ASN_<版本>_x64-setup.exe、ASN_<版本>_x64-setup.exe.sig、ASN_<版本>_android.apk、
//       Linux：ASN_<版本>_amd64.AppImage、ASN_<版本>_amd64.AppImage.sig、ASN_<版本>_amd64.deb
export const INSTALLER_FILE_RE = /^ASN_(\d+\.\d+\.\d+)_(?:x64-setup\.exe(?:\.sig)?|android\.apk|amd64\.(?:AppImage(?:\.sig)?|deb))$/
export function githubUrlForSite(url) {
  if (typeof url !== 'string' || !url.startsWith(SITE_UPDATE)) return null
  const name = decodeURIComponent(url.slice(SITE_UPDATE.length))
  const m = INSTALLER_FILE_RE.exec(name)
  return m ? githubUrl(m[1], name) : null
}

/** GitHub 上這一版的現況：沒有回 null；有就回 { draft, assets: Map(檔名 → 大小) } */
export function releaseState(gh, version) {
  let out
  try { out = gh(['release', 'view', tagOf(version), '--repo', REPO, '--json', 'tagName,isDraft,assets']) } catch (e) {
    if (/release not found|not found/i.test(String(e?.message ?? e))) return null
    throw e
  }
  const j = JSON.parse(out)
  return { draft: j.isDraft === true, assets: new Map((j.assets ?? []).map(a => [a.name, a.size])) }
}

/**
 * 附加檔案到「已存在」的 v<版本> Release（Linux 版用：電腦版已發好、Release 已公開是預期狀態）。
 * 不建 Release、不轉正式、不改 Latest；同名檔已存在就停（不覆蓋）；上傳後下載回來比對 sha256
 * （公開版匿名下載、草稿版用 gh 登入下載）。驗證不一致只報錯，不自動刪檔（刪除要人工確認）。
 */
export async function attachToRelease({ version, files, gh, ghDownload, fetchFn = fetch, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-gh-attach-')), log = () => {} }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`版本號格式不對：${version}`)
  const tag = tagOf(version)
  const want = files.map(f => { const buf = fs.readFileSync(f.file); return { name: f.name, size: buf.length, sha256: sha256(buf), file: f.file } })
  const st = releaseState(gh, version)
  if (!st) throw new Error(`${tag} 的 Release 不存在：Linux 版只附加到已發的電腦版 Release，請先發電腦版`)
  for (const w of want) if (st.assets.has(w.name)) throw new Error(`${tag} 上已經有 ${w.name}：不覆蓋，請人工確認`)
  for (const w of want) { gh(['release', 'upload', tag, w.file, '--repo', REPO]); log(`已附加 ${w.name}（${w.size} 位元組）`) }
  for (const w of want) {
    let got
    if (st.draft) {
      const dir = fs.mkdtempSync(path.join(tmp, 'dl-'))
      ghDownload(version, w.name, dir)
      got = fs.readFileSync(path.join(dir, w.name))
    } else got = await download(fetchFn, githubUrl(version, w.name))
    if (sha256(got) !== w.sha256) throw new Error(`${tag} 上附加的 ${w.name} 下載回來的 sha256 跟本機的不一樣：檔已上傳、沒有自動刪除，請人工處理，不要部署官網`)
  }
  log(`${tag} 附加完成並下載比對一致：${want.map(w => w.name).join('、')}`)
  return { attached: want.map(w => w.name), draft: st.draft }
}

async function download(fetchFn, url) {
  const res = await fetchFn(url, { headers: { 'accept-encoding': 'identity' } })
  if (!res.ok) { await res.body?.cancel?.(); throw new Error(`下載失敗（HTTP ${res.status}）：${url}`) }
  return Buffer.from(await res.arrayBuffer())
}

/**
 * 發一版。files＝[{ name, file }]（本機檔案）；target＝要掛 tag 的 commit（完整 40 位，要已推上 GitHub）。
 * gh(args) 跑 gh 指令回傳標準輸出（測試用假的）；ghDownload(version, name, dir) 用 gh 登入把草稿的檔下載到 dir。
 * 已經是正式版、檔案都在而且一致：什麼都不做（可以重跑）。
 */
export async function publishRelease({ version, files, notes = '', target, gh, ghDownload, fetchFn = fetch, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-gh-release-')), log = () => {} }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`版本號格式不對：${version}`)
  if (!/^[0-9a-f]{40}$/.test(target ?? '')) throw new Error('commit 要是完整的 40 位')
  const want = files.map(f => { const buf = fs.readFileSync(f.file); return { name: f.name, size: buf.length, sha256: sha256(buf), file: f.file } })
  const tag = tagOf(version)
  let st = releaseState(gh, version)
  if (st && !st.draft) {
    // 已經是正式版：檔案都在、匿名下載一致就當作做過了；缺檔或不一致就停（正式版不再動）
    for (const w of want) {
      if (st.assets.get(w.name) !== w.size) throw new Error(`${tag} 已經是正式版，但 ${w.name} ${st.assets.has(w.name) ? '大小不一樣' : '不在上面'}：不動正式版，請人工確認`)
      const buf = await download(fetchFn, githubUrl(version, w.name))
      if (sha256(buf) !== w.sha256) throw new Error(`${tag} 已經是正式版，但 ${w.name} 內容跟這次的不一樣：不動正式版，請人工確認`)
    }
    log(`${tag} 已經是正式版、檔案一致，不用再做`)
    return { created: false, published: false }
  }
  if (!st) {
    const nf = path.join(tmp, `notes-${version}.md`)
    fs.writeFileSync(nf, notes || `ASN ${version}`)
    gh(['release', 'create', tag, '--repo', REPO, '--draft', '--target', target, '--title', `ASN ${version}`, '--notes-file', nf])
    log(`建好草稿 ${tag}`)
    st = { draft: true, assets: new Map() }
  }
  for (const w of want) {
    const size = st.assets.get(w.name)
    if (size === undefined) { gh(['release', 'upload', tag, w.file, '--repo', REPO]); log(`已上傳 ${w.name}（${w.size} 位元組）`) }
    else if (size !== w.size) throw new Error(`草稿 ${tag} 上已經有 ${w.name}，大小 ${size} 跟這次的 ${w.size} 不一樣：不覆蓋，請人工確認`)
  }
  // 草稿不公開：用 gh 登入下載回來比對
  for (const w of want) {
    const dir = fs.mkdtempSync(path.join(tmp, 'dl-'))
    ghDownload(version, w.name, dir)
    const buf = fs.readFileSync(path.join(dir, w.name))
    if (sha256(buf) !== w.sha256) throw new Error(`草稿 ${tag} 的 ${w.name} 下載回來的 sha256 跟本機的不一樣：不轉正式`)
  }
  gh(['release', 'edit', tag, '--repo', REPO, '--draft=false', '--latest'])
  log(`${tag} 轉成正式版、設為 Latest`)
  // 公開以後匿名下載再比一次；不一致就退回草稿（latest.json 還沒部署，使用者不受影響）
  for (const w of want) {
    let ok = false, why = ''
    try { ok = sha256(await download(fetchFn, githubUrl(version, w.name))) === w.sha256; if (!ok) why = 'sha256 不一樣' } catch (e) { why = e.message }
    if (!ok) {
      const first = `${tag} 公開後匿名下載 ${w.name} 不對（${why}）`
      // 退回草稿也失敗時，兩個錯都要報（原本的不能被蓋掉）
      try { gh(['release', 'edit', tag, '--repo', REPO, '--draft=true']) } catch (e) { throw new Error(`${first}；而且退回草稿也失敗（${e?.message ?? e}）：${tag} 現在還是正式版，請人工退回草稿，不要部署官網`) }
      throw new Error(`${first}：已退回草稿，不要部署官網`)
    }
  }
  log(`${tag} 匿名下載比對一致：${want.map(w => w.name).join('、')}`)
  return { created: true, published: true }
}

const realGh = args => { try { return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { throw new Error(String(e.stderr || e.message)) } }
const realGhDownload = (version, name, dir) => realGh(['release', 'download', tagOf(version), '--repo', REPO, '--pattern', name, '--dir', dir])

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2)
  const opt = {}
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--version') opt.version = a[++i]
    else if (a[i] === '--exe') opt.exe = a[++i]
    else if (a[i] === '--sig') opt.sig = a[++i]
    else if (a[i] === '--notes-file') opt.notes = fs.readFileSync(a[++i], 'utf8')
    else { console.error(`不認得的參數：${a[i]}`); process.exit(2) }
  }
  try {
    if (!opt.version || !opt.exe || !opt.sig) throw new Error('要給 --version、--exe、--sig')
    const [exeName, sigName] = installerFiles(opt.version)
    if (path.basename(opt.exe) !== exeName || path.basename(opt.sig) !== sigName) throw new Error(`檔名要是 ${exeName} 與 ${sigName}`)
    const target = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    // tag 要掛在 GitHub 上找得到的 commit：目前的 commit 一定要已經推上去
    if (!execFileSync('git', ['branch', '-r', '--contains', target], { encoding: 'utf8' }).trim()) throw new Error(`目前的 commit ${target.slice(0, 8)} 還沒推上 GitHub：先提交並推上去再發`)
    await publishRelease({ version: opt.version, files: [{ name: exeName, file: opt.exe }, { name: sigName, file: opt.sig }], notes: opt.notes, target, gh: realGh, ghDownload: realGhDownload, log: m => console.log(m) })
    console.log(`完成：${githubUrl(opt.version, exeName)}。接著才部署官網（latest.json 與首頁）。`)
  } catch (e) { console.error(`發到 GitHub 中止：${e.message}`); process.exit(1) }
}
