// 發版：bump 版本 → prep → tauri build（帶更新簽章環境變數）→ 產生 latest.json → 安裝檔與 .sig 複製到官網 update 目錄。
// 只在本機產檔，不部署（部署官網由人做）。用法：
//   npm run release -- --notes "這版改了什麼"      正式發版（版本加一、寫進 site/public/update/）
//   npm run release -- --dry-run                   演練：不改版本號，產物放 target/release-dry/，不碰官網目錄
// 更新簽章私鑰在 %USERPROFILE%\.asn\updater\（asn.key、asn.key.password）；這支腳本只把「檔案路徑」（TAURI_SIGNING_PRIVATE_KEY 可填路徑）與「密碼」交給 tauri 的環境變數，
// 不讀私鑰內容、不印密碼。環境變數 ASN_UPDATER_KEY_DIR 可改資料夾。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { smokeGate, splitSkipFlag } from './smoke-gate.mjs'
import { buildLatestJson, installerName, parseArgs, resolveNotes } from './release-lib.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const siteUpdate = path.join(root, '..', '..', 'site', 'public', 'update')
const fail = m => { console.error(`發版中止：${m}`); process.exit(1) }

let opts
const { skip: skipSmoke, rest: releaseArgv } = splitSkipFlag(process.argv.slice(2))
try { opts = parseArgs(releaseArgv) } catch (e) { fail(e.message) }

const changelogFile = path.join(root, 'CHANGELOG.md')
const readChangelog = () => (fs.existsSync(changelogFile) ? fs.readFileSync(changelogFile, 'utf8') : '')
const readVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const today = () => new Date().toLocaleDateString('sv-SE') // yyyy-mm-dd（本機日期）

// --print-notes：只印這版會用的更新說明就結束（不 bump、不打包、不讀金鑰）
if (opts.printNotes) {
  const nextVer = opts.dryRun || opts.noBump ? readVersion() : readVersion().replace(/\d+$/, n => String(Number(n) + 1))
  console.log(resolveNotes({ arg: opts.notes, changelog: readChangelog(), version: nextVer, date: today() }).notes)
  process.exit(0)
}

const keyDir = process.env.ASN_UPDATER_KEY_DIR || path.join(os.homedir(), '.asn', 'updater')
const keyFile = path.join(keyDir, 'asn.key')
const passFile = path.join(keyDir, 'asn.key.password')
if (!fs.existsSync(keyFile)) fail(`找不到更新簽章私鑰：${keyFile}`)
// 密碼檔只讀進子程序的環境變數（有就帶，沒有代表金鑰沒設密碼）；不印出
const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: keyFile }
if (fs.existsSync(passFile)) env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = fs.readFileSync(passFile, 'utf8').replace(/[\r\n]+$/, '')

const run = (cmd, args, extra = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env, ...extra })
  if (r.status !== 0) fail(`${path.basename(args[0] ?? cmd)} 失敗（結束碼 ${r.status}）`)
}
const node = process.execPath

// 打包前先過啟動冒煙測試（在改版本號之前；沒過就中止）
if (!smokeGate({ root, skip: skipSmoke }).ok) fail('啟動冒煙測試沒過（用 npm run smoke:ui 重現；確定要略過可加 --skip-smoke）')

if (!opts.dryRun && !opts.noBump) run(node, ['scripts/bump.mjs'])
const version = readVersion()
console.log(`版本 ${version}${opts.dryRun ? '（演練）' : ''}`)

// 更新說明：沒給 --notes 用 CHANGELOG 最新一段；給了就先寫進 CHANGELOG 的新段落（版本號用 bump 後的；演練不改檔）
const { notes, newChangelog } = resolveNotes({ arg: opts.notes, changelog: readChangelog(), version, date: today() })
if (newChangelog !== null) {
  if (opts.dryRun) console.log('演練：不改 CHANGELOG.md（正式發版會把 --notes 寫成新段落）。')
  else { fs.writeFileSync(changelogFile, newChangelog); console.log(`已把更新說明寫進 CHANGELOG.md（${version}）`) }
}

run(node, ['scripts/prep.mjs'])
run(node, ['scripts/fetch-wezterm.mjs'])   // 內建終端機用的 WezTerm（固定版本、核對雜湊；ASN_SKIP_WEZTERM=1 可略過）
run(node, [path.join('node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'build', '--bundles', 'nsis'])

const bundle = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis')
const name = installerName(version)
const exe = path.join(bundle, name)
const sigFile = `${exe}.sig`
if (!fs.existsSync(exe)) fail(`沒產出安裝檔：${exe}`)
if (!fs.existsSync(sigFile)) fail(`沒產出簽章檔：${sigFile}（確認 tauri.conf.json 的 createUpdaterArtifacts 與簽章環境變數）`)

const latest = buildLatestJson({ version, notes, pubDate: new Date(), signature: fs.readFileSync(sigFile, 'utf8') })

const out = opts.dryRun ? path.join(root, 'src-tauri', 'target', 'release-dry') : siteUpdate
fs.mkdirSync(out, { recursive: true })
fs.copyFileSync(exe, path.join(out, name))
fs.copyFileSync(sigFile, path.join(out, `${name}.sig`))
fs.writeFileSync(path.join(out, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`)
console.log(`已產生：${out}`)
console.log(`  ${name}、${name}.sig、latest.json`)
console.log(opts.dryRun ? '演練完成：沒有改版本號，也沒有動官網目錄。' : '下一步：提交版本號與 site/public/update/latest.json，再由人部署官網（firebase deploy --only hosting，在 site/ 底下）。')
