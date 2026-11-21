// 三個平台都發完後，把官網版本紀錄的「平台」補齊（#1996）。
// 用法：node tools/release/site_record_platforms.mjs <版號> [--dry-run]
//   用 gh 唯讀查三個平台這一版實際發成功了沒：
//     官網（電腦版）：GitHub Release v<版號> 存在、不是草稿、有 Windows 安裝檔（ASN_<版號>_x64-setup.exe）
//     Linux：同一個 Release 上有 .AppImage 與 .deb 附件
//     Play（手機）：android-v<版號> 標籤的最新一次 workflow run，android-upload 這個 job 的 conclusion 是 success
//   沒打該平台標籤或失敗：不列，並在表裡寫明原因。
//   不帶 --dry-run 才用 asn-cli 寫入：asn-cli site release 對同版號是更新（後台 site_release_upsert，只改有帶的欄位，
//   platforms 是整份取代，見 supabase/migrations/20261027200000_site_write.sql），所以只帶 --version 與 --platform。
//   為避免取代掉紀錄裡原有的平台，寫入的清單＝原有平台與算出來平台的聯集（算出來的依官網、Linux、Play 排前）。
// 平台名稱與 local_sign_publish.mjs 的 buildRecord 相同（官網、Play），Linux 是 #1996 規定的第三個名稱。
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { makeAsnCli, asnCliFail } from './asn_cli.mjs'

export const REPO = 'Yooliang/asn'
export const PLATFORM_ORDER = ['官網', 'Linux', 'Play']
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/

// 純函式。desktop：{ exists, draft, hasInstaller }；linux：{ hasAppImage, hasDeb }；
// android：{ tagged, conclusion }（tagged 為 false 表示沒打標籤或找不到 run）
export function planPlatforms({ desktop, linux, android }) {
  const rows = []
  const d = desktop ?? {}
  const dOk = !!d.exists && !d.draft && !!d.hasInstaller
  rows.push({
    platform: '官網', listed: dOk,
    reason: dOk ? 'Release 已公開，且有 Windows 安裝檔'
      : !d.exists ? '找不到這一版的 GitHub Release'
        : d.draft ? 'Release 還是草稿' : 'Release 上沒有 Windows 安裝檔',
  })
  const l = linux ?? {}
  const lOk = !!l.hasAppImage && !!l.hasDeb
  rows.push({
    platform: 'Linux', listed: lOk,
    reason: lOk ? 'Release 上有 AppImage 與 deb 附件'
      : !l.hasAppImage && !l.hasDeb ? 'Release 上沒有 Linux 附件（這版沒發 Linux，或還沒附加）'
        : `Linux 附件不齊（缺 ${l.hasAppImage ? 'deb' : 'AppImage'}）`,
  })
  const a = android ?? {}
  const aOk = !!a.tagged && a.conclusion === 'success'
  rows.push({
    platform: 'Play', listed: aOk,
    reason: aOk ? 'android-upload 成功'
      : !a.tagged ? '這版沒打手機標籤（或找不到 workflow run）'
        : a.conclusion == null ? 'android-upload 找不到，或還沒跑完' : `android-upload 沒成功（${a.conclusion}）`,
  })
  return { platforms: rows.filter(r => r.listed).map(r => r.platform), rows }
}

// 原有平台與算出來的聯集：算出來的依固定順序在前，原有的其他名稱接在後面
export const mergePlatforms = (current, planned) => {
  const have = new Set([...(current ?? []), ...planned])
  return [...PLATFORM_ORDER.filter(p => have.has(p)), ...[...have].filter(p => !PLATFORM_ORDER.includes(p))]
}

const ghJson = (gh, args) => JSON.parse(gh(args))

// 用注入的 gh（唯讀查詢）取三個平台的原始結果
export function gatherFacts(version, gh) {
  let rel = null
  try { rel = ghJson(gh, ['release', 'view', `v${version}`, '--repo', REPO, '--json', 'isDraft,assets']) } catch (e) {
    if (!/release not found|not found/i.test(String(e.message ?? e))) throw e
  }
  const names = (rel?.assets ?? []).map(x => x.name)
  const desktop = { exists: !!rel, draft: !!rel?.isDraft, hasInstaller: names.includes(`ASN_${version}_x64-setup.exe`) }
  const linux = { hasAppImage: names.includes(`ASN_${version}_amd64.AppImage`), hasDeb: names.includes(`ASN_${version}_amd64.deb`) }
  const runs = (ghJson(gh, ['api', `repos/${REPO}/actions/runs?branch=android-v${version}&per_page=30`]).workflow_runs ?? [])
    .filter(r => r.head_branch === `android-v${version}`)
    .sort((x, y) => (y.run_number ?? 0) - (x.run_number ?? 0))
  let android = { tagged: false, conclusion: null }
  if (runs.length) {
    const run = runs[0]
    const jobs = ghJson(gh, ['api', `repos/${REPO}/actions/runs/${run.id}/attempts/${run.run_attempt ?? 1}/jobs?per_page=100`]).jobs ?? []
    const up = jobs.find(j => j.name === 'android-upload')
    android = { tagged: true, conclusion: up ? up.conclusion : null }
  }
  return { desktop, linux, android }
}

export function formatTable(rows) {
  return ['平台｜列入｜依據', ...rows.map(r => `${r.platform}｜${r.listed ? '列' : '不列'}｜${r.reason}`)].join('\n')
}

// 回傳結束碼：0 成功（含已是最新、dry-run）、1 失敗或三個平台都沒發成、2 用法錯
export async function run({ argv, gh, asnCli, readPlatforms, log = console.log }) {
  const dry = argv.includes('--dry-run')
  const rest = argv.filter(a => a !== '--dry-run')
  const version = rest[0]
  if (rest.length !== 1 || !VERSION_RE.test(version ?? '')) { log('用法：node tools/release/site_record_platforms.mjs <版號，例如 0.2.44> [--dry-run]'); return 2 }
  const { platforms, rows } = planPlatforms(gatherFacts(version, gh))
  log(`v${version} 三個平台的實際結果：`)
  log(formatTable(rows))
  if (!platforms.length) { log('三個平台都沒發成：停下，不寫入官網版本紀錄。'); return 1 }
  const current = await readPlatforms(version)
  if (current == null) { log(`官網還沒有 v${version} 的版本紀錄（要先由發版第 10 步寫入）：停下，不寫入。`); return 1 }
  const finalList = mergePlatforms(current, platforms)
  if (finalList.length === current.length && finalList.every(p => current.includes(p))) {
    log(`已是最新：紀錄的平台是「${current.join('、')}」，已包含算出來的「${platforms.join('、')}」，不重寫。`)
    return 0
  }
  log(`紀錄原本的平台：${current.length ? current.join('、') : '（空）'}；要改成：${finalList.join('、')}`)
  if (dry) { log('--dry-run：不寫入。'); return 0 }
  const r = await asnCli(['site', 'release', '--version', version, ...finalList.flatMap(p => ['--platform', p])])
  if (r?.status !== 0) { log(`asn-cli site release 失敗（原文只寫進發版機器的 log）`); console.error(`asn-cli site release 原文：${asnCliFail(r)}`); return 1 }
  log(`已更新 v${version} 的平台：${finalList.join('、')}`)
  return 0
}

// 真的 gh（只准唯讀查詢）與公開唯讀讀取：官網前端用的 anon 公開金鑰，取自 site/public/link/config.mjs
const realGh = args => { try { return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }) } catch (e) { throw new Error(String(e.stderr || e.message)) } }
const realReadPlatforms = async version => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const { AUTH_BASE, ANON_KEY } = await import(pathToFileURL(path.join(here, '../../site/public/link/config.mjs')).href)
  const res = await fetch(`${AUTH_BASE}/rest/v1/asn_site_releases?select=platforms&version=eq.${version}`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`讀版本紀錄失敗：HTTP ${res.status}`)
  const rows = await res.json()
  return rows.length ? (rows[0].platforms ?? []) : null
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run({ argv: process.argv.slice(2), gh: realGh, asnCli: makeAsnCli(), readPlatforms: realReadPlatforms })
    .then(c => { process.exitCode = c }, e => { console.error(`失敗：${String(e.message ?? e).slice(0, 300)}`); process.exitCode = 1 })
}
