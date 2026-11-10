// 把 ASN 自建的 WezTerm（固定版本，見 wezterm-pins.json 的 windows_bundle）取下來，只留 ASN 用得到的 7 個檔，放進 src-tauri/resources/wezterm/，
// 讓 Tauri 隨 Windows 安裝檔一起打包（內建終端機用；裝好後在安裝資料夾的 wezterm 底下，ASN 預設從那裡找）。
//   node scripts/fetch-wezterm.mjs           下載（有快取就用快取）→ 驗建置來源證明（attestation）→ 核對雜湊與大小 → 解出 7 個檔與授權文字
//   ASN_SKIP_WEZTERM=1                       略過（不打包 WezTerm；例如只想快速試別的）
// 來源是本 repo 的 wezterm-build.yml 建出來的 release（上游 20240203 加上上游 #7706，修 mux-server 的堆疊溢位）。
// 來源證明、雜湊、大小任何一項不符都讓建置失敗，不退回上游官方版。驗來源證明要用 gh CLI（發版機本來就有）。只在 Windows 上做。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 版本與雜湊的唯一來源是 scripts/wezterm-pins.json（Linux 的 Rust 程式與 CI 也讀同一份）
const PINS = JSON.parse(fs.readFileSync(new URL('./wezterm-pins.json', import.meta.url), 'utf8'))
const BUNDLE = PINS.windows_bundle
export const WEZTERM_VERSION = PINS.version
export const WEZTERM_BUNDLE_TAG = BUNDLE.tag
export const WEZTERM_BUNDLE_REPO = BUNDLE.repo
export const WEZTERM_SIGNER_WORKFLOW = BUNDLE.signer_workflow
export const WEZTERM_ZIP_SHA256 = BUNDLE.sha256
export const WEZTERM_ZIP_SIZE = BUNDLE.size
export const WEZTERM_LICENSE_SHA256 = PINS.license_sha256
// 只留這 7 個：視窗與命令列、mux-server（0.2.0 夥伴窗格改由它常駐）、終端機後端（conpty）、顯示用的 ANGLE。不附除錯檔、strip-ansi-escapes、mesa 軟體算圖
export const WEZTERM_FILES = ['wezterm-gui.exe', 'wezterm.exe', 'wezterm-mux-server.exe', 'conpty.dll', 'OpenConsole.exe', 'libEGL.dll', 'libGLESv2.dll']
const ZIP_NAME = BUNDLE.zip
export const WEZTERM_ZIP_URL = `https://github.com/${WEZTERM_BUNDLE_REPO}/releases/download/${WEZTERM_BUNDLE_TAG}/${ZIP_NAME}`

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'src-tauri', 'resources', 'wezterm')
const cacheDir = path.join(root, '.cache', 'wezterm')

const SOURCE_TEXT = `WezTerm ${WEZTERM_VERSION}（ASN 自行建置，只多套用上游 #7706）
來源：${WEZTERM_ZIP_URL}
壓縮檔 SHA-256：${WEZTERM_ZIP_SHA256}
建置來源證明：gh attestation verify <壓縮檔> -R ${WEZTERM_BUNDLE_REPO} --signer-workflow ${WEZTERM_SIGNER_WORKFLOW}
授權：MIT（見同資料夾的 LICENSE.md）。OpenConsole.exe 與 conpty.dll 來自 Microsoft Terminal（MIT）。
ASN 只取用其中 7 個檔（wezterm-gui.exe、wezterm.exe、wezterm-mux-server.exe、conpty.dll、OpenConsole.exe、libEGL.dll、libGLESv2.dll）；
各檔都出自上面那個壓縮檔，取用前先驗建置來源證明，再以壓縮檔的 SHA-256 與大小核對。這是固定版本，換版本前會重新驗證。
`

// SOURCE.txt 要寫著這次的 release 與雜湊才算就緒：舊的建置資料夾裡留著上游官方版的檔，不能被當成已就緒而沿用
function sourceMatches(dir) {
  try { return fs.readFileSync(path.join(dir, 'SOURCE.txt'), 'utf8') === SOURCE_TEXT } catch { return false }
}

export function wezTermReady(dir = outDir) {   // 空檔（建置時的占位）不算就緒
  const filled = [...WEZTERM_FILES, 'LICENSE.md', 'SOURCE.txt'].every(f => { try { return fs.statSync(path.join(dir, f)).size > 0 } catch { return false } })
  return filled && sourceMatches(dir)
}

export function checkBytes(buf, want, wantSize, label) {
  if (wantSize != null && buf.length !== wantSize) throw new Error(`大小不符：${label}\n  預期 ${wantSize}\n  實得 ${buf.length}`)
  const got = sha256(buf)
  if (got !== want) throw new Error(`雜湊不符：${label}\n  預期 ${want}\n  實得 ${got}`)
}

/** 用 gh 驗建置來源證明：一定要是本 repo、wezterm-build.yml 在 main 上建的。gh 不在或驗不過都丟錯（建置失敗），不提供略過 */
export function verifyAttestation(file, run = spawnSync) {
  const args = ['attestation', 'verify', file, '--repo', WEZTERM_BUNDLE_REPO, '--signer-workflow', WEZTERM_SIGNER_WORKFLOW, '--source-ref', 'refs/heads/main']
  const r = run('gh', args, { encoding: 'utf8' })
  if (r.error) throw new Error(`驗 WezTerm 建置來源證明需要 gh CLI（找不到 gh：${r.error.message}）`)
  if (r.status !== 0) throw new Error(`WezTerm 建置來源證明驗不過，不使用這個壓縮檔：${(r.stderr || r.stdout || '').trim()}`)
}

async function download(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下載失敗 ${res.status}：${url}`)
  return Buffer.from(await res.arrayBuffer())
}

export async function fetchWezTerm() {
  if (process.env.ASN_SKIP_WEZTERM === '1') { console.log('略過 WezTerm（ASN_SKIP_WEZTERM=1）'); return false }
  if (process.platform !== 'win32') { console.log('非 Windows，不附 WezTerm'); return false }
  if (wezTermReady()) { console.log('WezTerm 已就緒（沿用）'); return true }
  fs.mkdirSync(cacheDir, { recursive: true })
  const zipPath = path.join(cacheDir, ZIP_NAME)
  if (!fs.existsSync(zipPath)) {
    console.log(`下載 WezTerm ${WEZTERM_BUNDLE_TAG}（約 45 MB）…`)
    const tmpZip = `${zipPath}.part`
    fs.writeFileSync(tmpZip, await download(WEZTERM_ZIP_URL))
    fs.renameSync(tmpZip, zipPath)
  }
  // 快取裡的檔也每次重驗：先驗來源證明，再驗雜湊與大小；不符就刪掉快取，讓下次重新下載
  try {
    verifyAttestation(zipPath)
    checkBytes(fs.readFileSync(zipPath), WEZTERM_ZIP_SHA256, WEZTERM_ZIP_SIZE, WEZTERM_ZIP_URL)
  } catch (e) { fs.rmSync(zipPath, { force: true }); throw e }

  const tmp = path.join(cacheDir, 'extract')
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  // Windows 內建的 tar（bsdtar）讀得懂 zip；Git 附的 GNU tar 不行，所以指名系統那支。自建的壓縮檔沒有外層資料夾
  const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  const r = spawnSync(sysTar, ['-xf', zipPath, '-C', tmp, ...WEZTERM_FILES, 'LICENSE.md'], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`解壓縮失敗（壓縮檔裡缺其中一個檔也會這樣）：${(r.stderr || r.stdout || '').trim()}`)
  for (const f of [...WEZTERM_FILES, 'LICENSE.md']) {
    if (!fs.existsSync(path.join(tmp, f))) throw new Error(`壓縮檔裡找不到 ${f}`)
  }
  checkBytes(fs.readFileSync(path.join(tmp, 'LICENSE.md')), WEZTERM_LICENSE_SHA256, null, `${ZIP_NAME} 裡的 LICENSE.md`)
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  for (const f of [...WEZTERM_FILES, 'LICENSE.md']) fs.copyFileSync(path.join(tmp, f), path.join(outDir, f))
  fs.writeFileSync(path.join(outDir, 'SOURCE.txt'), SOURCE_TEXT)
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`WezTerm 就緒：${WEZTERM_FILES.length} 個檔 → ${path.relative(root, outDir)}（${WEZTERM_BUNDLE_TAG}）`)
  return true
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fetchWezTerm().catch(e => { console.error(String(e.message || e)); process.exit(1) })
}
