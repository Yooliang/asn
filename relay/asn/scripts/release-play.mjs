// 安卓「Google Play 版」建置：建 release AAB（arm64）→ 用上傳金鑰簽章 → 放到 src-tauri/target/play/，由人（或代理）在 Play Console 上傳。
// Play 版不含自動更新（不帶 --features sideload、不設 asnDist），更新一律交給 Play 商店。
// 上傳金鑰（upload key）放在 %USERPROFILE%\.asn\play\（upload.jks、upload.jks.password），不進 repo、不印出；
// 第一次執行時自動產生（RSA 4096、效期 10000 天）並把資料夾權限限縮成只有本人。遺失可以向 Play 申請重設上傳金鑰（正式簽章金鑰由 Play 保管）。
// 版本號沿用 package.json（先發電腦版 npm run release，再跑這個）。用法：npm run release:play
// 需要：JAVA_HOME（Android Studio 的 jbr）、ANDROID_HOME、NDK_HOME（同 release-android.mjs）。
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const fail = m => { console.error(`建置中止：${m}`); process.exit(1) }

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
if (conf.version !== version) fail(`package.json（${version}）與 tauri.conf.json（${conf.version}）版本不一致`)

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Android', 'Sdk')
if (!process.env.JAVA_HOME) fail('沒有設 JAVA_HOME（Android Studio 的 jbr 資料夾）')
const ndkDir = path.join(sdk, 'ndk')
const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk }
delete env.ORG_GRADLE_PROJECT_asnDist   // Play 版：外殼不帶安裝權限與安裝程式碼
if (!env.NDK_HOME && fs.existsSync(ndkDir)) env.NDK_HOME = path.join(ndkDir, fs.readdirSync(ndkDir).sort().at(-1))
const ext = process.platform === 'win32' ? '.exe' : ''
const jdk = tool => path.join(process.env.JAVA_HOME, 'bin', `${tool}${ext}`)
const run = (cmd, args) => { const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env, shell: false }); if (r.status !== 0) fail(`${path.basename(cmd)} 失敗（結束碼 ${r.status}）`) }

// ---- 上傳金鑰：沒有就產生（密碼隨機，只寫進檔案，經 :file 交給 keytool／jarsigner，不出現在命令列） ----
const keyDir = process.env.ASN_PLAY_KEY_DIR || path.join(os.homedir(), '.asn', 'play')
const keystore = path.join(keyDir, 'upload.jks')
const passFile = path.join(keyDir, 'upload.jks.password')
if (!fs.existsSync(keystore)) {
  fs.mkdirSync(keyDir, { recursive: true })
  if (process.platform === 'win32') {
    const who = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    run('icacls', [keyDir, '/inheritance:r', '/grant:r', `${who}:(OI)(CI)F`])
  }
  fs.writeFileSync(passFile, crypto.randomBytes(24).toString('hex'), { mode: 0o600 })
  run(jdk('keytool'), ['-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12', '-storepass:file', passFile, '-keypass:file', passFile,
    '-alias', 'upload', '-keyalg', 'RSA', '-keysize', '4096', '-validity', '10000', '-dname', 'CN=ASN, O=Yooliang, C=TW'])
  console.log(`已產生上傳金鑰：${keystore}（密碼檔在同一個資料夾，不要進 repo）`)
}
if (!fs.existsSync(passFile)) fail(`找不到上傳金鑰的密碼檔：${passFile}`)

run(process.execPath, ['scripts/prep.mjs'])
run(process.execPath, [path.join('node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'android', 'build', '--aab', '--target', 'aarch64', '--ci'])

const bundleDir = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'bundle')
const found = fs.existsSync(bundleDir) ? fs.readdirSync(bundleDir, { recursive: true }).filter(f => String(f).endsWith('.aab')).map(f => path.join(bundleDir, String(f))) : []
const unsigned = found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
if (!unsigned) fail(`沒產出 AAB（${bundleDir}）`)
const out = path.join(root, 'src-tauri', 'target', 'play')
fs.mkdirSync(out, { recursive: true })
const signed = path.join(out, `ASN_${version}_play.aab`)
run(jdk('jarsigner'), ['-keystore', keystore, '-storepass:file', passFile, '-keypass:file', passFile, '-sigalg', 'SHA256withRSA', '-digestalg', 'SHA-256', '-signedjar', signed, unsigned, 'upload'])
run(jdk('jarsigner'), ['-verify', signed])
console.log(`已產生：${signed}（${(fs.statSync(signed).size / 1048576).toFixed(1)} MB）\n下一步：在 Play Console 的測試版本上傳這個檔。`)
