// CI 用的電腦版建置入口（#1892 演練與日後正式發版共用）：只建「未簽章」安裝檔，產出 SHA256SUMS.txt。
// 與 release.mjs 的差別：不 bump 版本、不讀任何簽章金鑰、不寫 latest.json 與官網首頁、不略過冒煙與 WezTerm。
// release.mjs 有頂層副作用不能 import，所以這支只 import 已匯出的函式：wezTermReleaseGuard／wezTermReady（fetch-wezterm.mjs）、smokeGate（smoke-gate.mjs）、installerName（release-lib.mjs）。
// 用法：node scripts/release-ci.mjs [--out <資料夾>]（預設 src-tauri/target/release-ci/）
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { smokeGate, SKIP_FLAG } from './smoke-gate.mjs'
import { wezTermReady, wezTermReleaseGuard } from './fetch-wezterm.mjs'
import { installerName } from './release-lib.mjs'

export const NOSIGN_CONFIG = path.join('src-tauri', 'tauri.nosign.conf.json')
export const SUMS_NAME = 'SHA256SUMS.txt'

/** 參數檢查：CI 入口不接受 --skip-smoke（也不接受不認得的旗標）；有問題回 { error }，否則回 { out } */
export const parseCiArgs = argv => {
  if (argv.includes(SKIP_FLAG)) return { error: `CI 建置不准用 ${SKIP_FLAG}` }
  let out = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = argv[++i]
      if (!out) return { error: '--out 後面要接資料夾' }
    } else return { error: `不認得的參數：${argv[i]}` }
  }
  return { out }
}

/** tauri build 的參數：只出 NSIS、用不簽章設定、Cargo 帶 --locked（Cargo.lock 與 Cargo.toml 不一致就失敗） */
export const tauriBuildArgs = tauriJs => [tauriJs, 'build', '--bundles', 'nsis', '--config', NOSIGN_CONFIG, '--', '--locked']

/** sha256sum 相容格式（雜湊、兩個空白、檔名），依檔名排序、結尾換行 */
export const sha256SumsText = entries =>
  [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(e => `${e.sha256}  ${e.name}\n`).join('')

/** 正式安裝檔的建置環境：ASN_SHIPPING_BUILD=1，build.rs 看到它又帶了 test-hooks 就直接 panic（#2163 PR-3b 第二道證明） */
export const shippingEnv = env => ({ ...env, ASN_SHIPPING_BUILD: '1' })

export const sha256OfFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** 安裝檔必須存在且非空；回錯誤訊息或 null */
export const installerProblem = (exe, stat = f => fs.statSync(f)) => {
  try { return stat(exe).size > 0 ? null : `安裝檔是空的：${exe}` } catch { return `沒產出安裝檔：${exe}` }
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const fail = m => { console.error(`CI 建置中止：${m}`); process.exit(1) }
  const parsed = parseCiArgs(argv)
  if (parsed.error) fail(parsed.error)
  const run = (cmd, args, runEnv = env) => {
    const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: runEnv })
    if (r.status !== 0) fail(`${path.basename(args[0] ?? cmd)} 失敗（結束碼 ${r.status}）`)
  }
  const node = process.execPath

  const wezGuard = wezTermReleaseGuard(env)
  if (wezGuard) fail(wezGuard)
  if (!smokeGate({ root, skip: false }).ok) fail('啟動冒煙測試沒過（用 npm run smoke:ui 重現）')

  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  run(node, ['scripts/prep.mjs'])
  run(node, ['scripts/fetch-wezterm.mjs'])
  if (!wezTermReady()) fail('resources/wezterm 不是這次取得的自建版 WezTerm（SOURCE.txt 與樣板不一致或缺檔），不打包')
  // e2e 專用的 test-hooks 版（要在正式建置之前建：正式建置會覆蓋 target/release/asn.exe；第三方依賴共用，只多編 asn 本體）。絕不進安裝檔
  run(node, ['scripts/build-hooks-exe.mjs'])
  run(node, tauriBuildArgs(path.join('node_modules', '@tauri-apps', 'cli', 'tauri.js')), shippingEnv(env))

  const name = installerName(version)
  const exe = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis', name)
  const problem = installerProblem(exe)
  if (problem) fail(problem)
  // 證明正式 exe（tauri 改寫後、會被包進安裝檔的那個）沒有測試掛鉤：標記掃描＋行為探針，兩者都帶 hooks 版當對照組
  run(node, ['scripts/hooks-proof.mjs'])

  const out = parsed.out ? path.resolve(parsed.out) : path.join(root, 'src-tauri', 'target', 'release-ci')
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })
  fs.copyFileSync(exe, path.join(out, name))
  fs.writeFileSync(path.join(out, SUMS_NAME), sha256SumsText([{ name, sha256: sha256OfFile(path.join(out, name)) }]))

  // 除錯檔（閃退對行號用）放另一個資料夾；沒有就印警告，不讓建置因此失敗
  const debugDir = path.join(path.dirname(out), `${path.basename(out)}-debug`)
  fs.rmSync(debugDir, { recursive: true, force: true })
  fs.mkdirSync(debugDir, { recursive: true })
  for (const f of ['asn.exe', 'asn.pdb']) {
    const src = path.join(root, 'src-tauri', 'target', 'release', f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(debugDir, f))
    else console.warn(`警告：找不到除錯檔 ${f}（${src}）`)
  }
  console.log(`已產生（未簽章）：${out}\n  ${name}、${SUMS_NAME}\n除錯檔：${debugDir}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
