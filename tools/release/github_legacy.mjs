// 官網上的舊安裝檔搬到 GitHub Release（#1585 第 2 張；一次性，只上傳、不刪）。
// 清單在 legacy-installers.json：每一版的 tag 指向那一版第一次出現在 latest.json／android.json 的 commit，
// 每個檔都記了大小與 sha256（從官網下載算的，並跟 git 歷史交叉核對過：.sig 的內容＝當時 latest.json 的簽章、APK 的 sha256＝當時 android.json 記的）。
//
// 用法（在 repo 根目錄）：
//   node tools/release/github_legacy.mjs            預覽：只讀 GitHub 現況，列出要建哪些 Release、要傳哪些檔，什麼都不改
//   node tools/release/github_legacy.mjs --apply    照預覽做：缺的 Release 建起來（不設 Latest）、缺的檔從官網下載＋核對 sha256 後上傳
//   node tools/release/github_legacy.mjs --verify   不登入、匿名從 GitHub 下載每個檔比對 sha256，全部一致才算完成
// 規則：
//   - 只上傳、不刪：不呼叫 gh release delete，也不用 --clobber。GitHub 上已經有同名的檔：大小一樣就略過，不一樣就停下來報錯，不覆蓋
//   - 上傳前一定先核對：從官網下載的檔 sha256 或大小跟清單不符，那一版不傳
//   - 不碰任何權杖：gh 用這台電腦現有的登入（gh auth），這裡不讀也不印
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO = 'Yooliang/asn'
export const SITE = 'https://asnmessenger.web.app/update/'
export const MANIFEST = path.join(here, 'legacy-installers.json')
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')

export const tagOf = v => `v${v}`
export const siteUrl = name => `${SITE}${encodeURIComponent(name)}`
export const githubUrl = (v, name) => `https://github.com/${REPO}/releases/download/${tagOf(v)}/${encodeURIComponent(name)}`

/** 清單檢查：版本、commit、檔名、大小、sha256 都要像樣；檔名只能是那一版的三種安裝檔 */
export function checkManifest(m) {
  if (!Array.isArray(m) || !m.length) throw new Error('清單是空的')
  const seen = new Set()
  for (const r of m) {
    if (!/^\d+\.\d+\.\d+$/.test(r?.version ?? '')) throw new Error(`版本號不對：${JSON.stringify(r?.version)}`)
    if (seen.has(r.version)) throw new Error(`版本重複：${r.version}`)
    seen.add(r.version)
    if (!/^[0-9a-f]{40}$/.test(r.target ?? '')) throw new Error(`${r.version}：commit 要是完整的 40 位`)
    if (typeof r.notes !== 'string') throw new Error(`${r.version}：缺少說明`)
    if (!Array.isArray(r.assets) || !r.assets.length) throw new Error(`${r.version}：沒有檔案`)
    const allowed = [`ASN_${r.version}_x64-setup.exe`, `ASN_${r.version}_x64-setup.exe.sig`, `ASN_${r.version}_android.apk`]
    for (const a of r.assets) {
      if (!allowed.includes(a?.name)) throw new Error(`${r.version}：不認得的檔名 ${a?.name}`)
      if (!Number.isInteger(a.size) || a.size <= 0) throw new Error(`${a.name}：大小不對`)
      if (!/^[0-9a-f]{64}$/.test(a.sha256 ?? '')) throw new Error(`${a.name}：sha256 不對`)
    }
  }
  return m
}

/** GitHub 上這一版的現況：沒有這個 Release 回 null；有就回 { assets: Map(檔名 → 大小) } */
export function releaseState(gh, version) {
  let out
  try { out = gh(['release', 'view', tagOf(version), '--repo', REPO, '--json', 'tagName,assets']) } catch (e) {
    if (/release not found|not found/i.test(String(e?.message ?? e))) return null
    throw e
  }
  const j = JSON.parse(out)
  return { assets: new Map((j.assets ?? []).map(a => [a.name, a.size])) }
}

/** 要做的事：[{ version, create, upload: [asset], skip: [檔名] }]；GitHub 上同名檔大小不同就丟錯（不覆蓋） */
export function plan(manifest, gh) {
  return manifest.map(r => {
    const st = releaseState(gh, r.version)
    const upload = [], skip = []
    for (const a of r.assets) {
      const size = st?.assets.get(a.name)
      if (size === undefined) upload.push(a)
      else if (size === a.size) skip.push(a.name)
      else throw new Error(`${tagOf(r.version)} 上已經有 ${a.name}，大小 ${size} 跟清單的 ${a.size} 不一樣：不覆蓋，請人工確認`)
    }
    return { version: r.version, target: r.target, notes: r.notes, create: !st, upload, skip }
  })
}

async function download(fetchFn, url) {
  const res = await fetchFn(url, { headers: { 'accept-encoding': 'identity' } })
  if (!res.ok) { await res.body?.cancel?.(); throw new Error(`下載失敗（HTTP ${res.status}）：${url}`) }
  return Buffer.from(await res.arrayBuffer())
}
function verifyBuf(buf, a, where) {
  if (buf.length !== a.size) throw new Error(`${where} 的 ${a.name}：大小 ${buf.length}，清單是 ${a.size}`)
  if (sha256(buf) !== a.sha256) throw new Error(`${where} 的 ${a.name}：sha256 對不起來`)
}

/** 照計畫做：先建 Release（不設 Latest），再一個個從官網下載、核對、上傳 */
export async function apply(steps, { gh, fetchFn = fetch, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-legacy-')), log = () => {} }) {
  for (const s of steps) {
    if (s.create) {
      const notes = path.join(tmp, `notes-${s.version}.md`)
      fs.writeFileSync(notes, s.notes)
      gh(['release', 'create', tagOf(s.version), '--repo', REPO, '--target', s.target, '--title', `ASN ${s.version}`, '--notes-file', notes, '--latest=false'])
      log(`建好 ${tagOf(s.version)}（指向 ${s.target.slice(0, 8)}）`)
    }
    for (const a of s.upload) {
      const buf = await download(fetchFn, siteUrl(a.name))
      verifyBuf(buf, a, '官網')
      const dir = fs.mkdtempSync(path.join(tmp, 'f-'))
      const file = path.join(dir, a.name)
      fs.writeFileSync(file, buf)
      gh(['release', 'upload', tagOf(s.version), file, '--repo', REPO])
      fs.rmSync(dir, { recursive: true, force: true })
      log(`已上傳 ${tagOf(s.version)}/${a.name}（${buf.length} 位元組）`)
    }
  }
}

/** 匿名從 GitHub 下載每個檔比對；回 { ok: [檔名], bad: [說明] } */
export async function verify(manifest, { fetchFn = fetch, log = () => {} } = {}) {
  const ok = [], bad = []
  for (const r of manifest) {
    for (const a of r.assets) {
      try { verifyBuf(await download(fetchFn, githubUrl(r.version, a.name)), a, 'GitHub'); ok.push(`${tagOf(r.version)}/${a.name}`); log(`一致 ${tagOf(r.version)}/${a.name}`) } catch (e) { bad.push(e.message) }
    }
  }
  return { ok, bad }
}

const realGh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? ''
  if (!['', '--apply', '--verify'].includes(mode)) { console.error(`不認得的參數：${mode}`); process.exit(2) }
  try {
    const manifest = checkManifest(JSON.parse(fs.readFileSync(MANIFEST, 'utf8')))
    if (mode === '--verify') {
      const r = await verify(manifest, { log: m => console.log(m) })
      if (r.bad.length) { console.error(`有 ${r.bad.length} 個不一致：\n${r.bad.join('\n')}`); process.exit(1) }
      console.log(`全部一致：${r.ok.length} 個檔`)
    } else {
      const gh = args => { try { return realGh(args) } catch (e) { throw new Error(String(e.stderr || e.message)) } }
      const steps = plan(manifest, gh)
      for (const s of steps) console.log(`${tagOf(s.version)}：${s.create ? '要建 Release、' : ''}要上傳 ${s.upload.length} 個${s.skip.length ? `、已經有 ${s.skip.length} 個` : ''}`)
      if (mode === '--apply') {
        await apply(steps, { gh, log: m => console.log(m) })
        console.log('做完了。接著跑 --verify 確認 GitHub 上的檔全部一致')
      } else console.log('這是預覽，什麼都沒改；加 --apply 才會照做')
    }
  } catch (e) { console.error(e.message); process.exit(1) }
}
