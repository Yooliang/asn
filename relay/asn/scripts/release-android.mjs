// 安卓「自行安裝版」（官網下載的 APK）發版：建 release APK（只含 arm64）→ zipalign → 用本機 debug 金鑰簽章 → 複製到官網 update 目錄並產生 android.json。
// 這是「測試通道」：用的是 Android 預設的 debug 金鑰（%USERPROFILE%\.android\debug.keystore，密碼是公開的 android），跟之後 Google Play 的正式簽章金鑰是兩回事。
// Play 版與自行安裝版簽章不同，裝了自行安裝版的手機要換成 Play 版時，必須先移除自行安裝版。見 docs/design/ANDROID.md。
// 版本號沿用 package.json（先發電腦版 npm run release，再跑這個）。只在本機產檔，不部署（官網由人部署）。
// 用法：npm run release:android [-- --notes "說明"] [-- --dry-run]（dry-run：產物放 src-tauri/target/release-dry/，不碰官網目錄）
// 需要：JAVA_HOME（Android Studio 的 jbr）、ANDROID_HOME、NDK_HOME，與 Rust 的四個安卓目標（見 ANDROID.md 第八節）。
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ANDROID_JSON, androidApkName, androidNotes, buildAndroidJson, parseAndroidArgs } from './release-android-lib.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const siteUpdate = path.join(root, '..', '..', 'site', 'public', 'update')
const fail = m => { console.error(`發版中止：${m}`); process.exit(1) }
let opts
try { opts = parseAndroidArgs(process.argv.slice(2)) } catch (e) { fail(e.message) }

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
if (conf.version !== version) fail(`package.json（${version}）與 tauri.conf.json（${conf.version}）版本不一致`)
const changelogFile = path.join(root, 'CHANGELOG.md')
const notes = androidNotes({ arg: opts.notes, changelog: fs.existsSync(changelogFile) ? fs.readFileSync(changelogFile, 'utf8') : '', version })

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Android', 'Sdk')
if (!process.env.JAVA_HOME) fail('沒有設 JAVA_HOME（Android Studio 的 jbr 資料夾）')
const ndkDir = path.join(sdk, 'ndk')
const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ORG_GRADLE_PROJECT_asnDist: 'sideload' }
if (!env.NDK_HOME && fs.existsSync(ndkDir)) env.NDK_HOME = path.join(ndkDir, fs.readdirSync(ndkDir).sort().at(-1))
const run = (cmd, args) => { const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env, shell: false }); if (r.status !== 0) fail(`${path.basename(cmd)} 失敗（結束碼 ${r.status}）`) }
const node = process.execPath

run(node, ['scripts/prep.mjs'])
// --features sideload：Rust 端編進自動更新；ORG_GRADLE_PROJECT_asnDist=sideload：外殼帶安裝權限與安裝程式碼（Play 版兩者都沒有）
run(node, [path.join('node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'android', 'build', '--apk', '--target', 'aarch64', '--features', 'sideload', '--ci'])

const unsigned = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk', 'universal', 'release', 'app-universal-release-unsigned.apk')
if (!fs.existsSync(unsigned)) fail(`沒產出 APK：${unsigned}`)
const btRoot = path.join(sdk, 'build-tools')
const bt = path.join(btRoot, fs.readdirSync(btRoot).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1))
const ext = process.platform === 'win32' ? { exe: '.exe', bat: '.bat' } : { exe: '', bat: '' }
const out = opts.dryRun ? path.join(root, 'src-tauri', 'target', 'release-dry') : siteUpdate
fs.mkdirSync(out, { recursive: true })
const name = androidApkName(version)
const aligned = path.join(out, `${name}.aligned`)
const finalApk = path.join(out, name)
run(path.join(bt, `zipalign${ext.exe}`), ['-f', '-p', '4', unsigned, aligned])
const keystore = path.join(os.homedir(), '.android', 'debug.keystore')
if (!fs.existsSync(keystore)) fail(`找不到 Android 預設的 debug 金鑰：${keystore}（不要另外產生正式金鑰，這個通道只用 debug 金鑰）`)
// debug 金鑰的密碼是公開的預設值 android（不是祕密）
// apksigner.bat 在 Windows 上 spawn（shell:false）會被 Node 拒絕執行，所以直接用 JDK 跑裡面的 apksigner.jar
const apksigner = args => run(path.join(process.env.JAVA_HOME, 'bin', `java${ext.exe}`), ['-jar', path.join(bt, 'lib', 'apksigner.jar'), ...args])
apksigner(['sign', '--ks', keystore, '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--ks-key-alias', 'androiddebugkey', '--out', finalApk, aligned])
apksigner(['verify', finalApk])
fs.rmSync(aligned, { force: true }); fs.rmSync(`${finalApk}.idsig`, { force: true })

const buf = fs.readFileSync(finalApk)
const json = buildAndroidJson({ version, notes, sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length })
fs.writeFileSync(path.join(out, ANDROID_JSON), `${JSON.stringify(json, null, 2)}\n`)
console.log(`已產生：${out}\n  ${name}（${(buf.length / 1048576).toFixed(1)} MB）、${ANDROID_JSON}（versionCode ${json.versionCode}）`)
console.log(opts.dryRun ? '演練完成：沒有動官網目錄。' : '下一步：提交 site/public/update/ 底下的兩個檔，再由人部署官網（firebase deploy --only hosting，在 site/ 底下）。')
