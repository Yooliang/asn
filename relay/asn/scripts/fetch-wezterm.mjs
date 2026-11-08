// 把 WezTerm 官方正式版（固定版本，見 wezterm-pins.json）取下來，只留 ASN 用得到的 7 個檔，放進 src-tauri/resources/wezterm/，
// 讓 Tauri 隨 Windows 安裝檔一起打包（內建終端機用；裝好後在安裝資料夾的 wezterm 底下，ASN 預設從那裡找）。
//   node scripts/fetch-wezterm.mjs           下載（有快取就用快取）→ 核對雜湊 → 解出 7 個檔與授權文字
//   ASN_SKIP_WEZTERM=1                       略過（不打包 WezTerm；例如只想快速試別的）
// 版本與雜湊寫在 wezterm-pins.json：換版本要同時改雜湊，並重新做真機驗證。只在 Windows 上做。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 版本與雜湊的唯一來源是 scripts/wezterm-pins.json（Linux 的 Rust 程式與 CI 也讀同一份）
const PINS = JSON.parse(fs.readFileSync(new URL('./wezterm-pins.json', import.meta.url), 'utf8'))
export const WEZTERM_VERSION = PINS.version
export const WEZTERM_ZIP_SHA256 = PINS.windows_zip_sha256
export const WEZTERM_LICENSE_SHA256 = PINS.license_sha256
export const WEZTERM_ZIP_SIZE = PINS.windows_zip_size
// 只留這 7 個：視窗與命令列、mux-server（0.2.0 夥伴窗格改由它常駐）、終端機後端（conpty）、顯示用的 ANGLE。不附除錯檔、strip-ansi-escapes、mesa 軟體算圖
export const WEZTERM_FILES = ['wezterm-gui.exe', 'wezterm.exe', 'wezterm-mux-server.exe', 'conpty.dll', 'OpenConsole.exe', 'libEGL.dll', 'libGLESv2.dll']
const BASE = `${PINS.release_base}/${WEZTERM_VERSION}`
const ZIP_NAME = `WezTerm-windows-${WEZTERM_VERSION}.zip`
const LICENSE_URL = `${PINS.raw_base}/${WEZTERM_VERSION}/LICENSE.md`

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'src-tauri', 'resources', 'wezterm')
const cacheDir = path.join(root, '.cache', 'wezterm')

const SOURCE_TEXT = `WezTerm ${WEZTERM_VERSION}
來源：${BASE}/${ZIP_NAME}
官方壓縮檔 SHA-256：${WEZTERM_ZIP_SHA256}
授權：MIT（見同資料夾的 LICENSE.md）。OpenConsole.exe 與 conpty.dll 來自 Microsoft Terminal（MIT）。
ASN 只取用其中 7 個檔（wezterm-gui.exe、wezterm.exe、wezterm-mux-server.exe、conpty.dll、OpenConsole.exe、libEGL.dll、libGLESv2.dll），未修改；
各檔都出自上面那個壓縮檔，以壓縮檔的 SHA-256 核對（官方沒有逐檔雜湊）。這是固定版本，換版本前會重新驗證。
`

async function download(url, want, wantSize) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下載失敗 ${res.status}：${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (wantSize != null && buf.length !== wantSize) throw new Error(`大小不符：${url}\n  預期 ${wantSize}\n  實得 ${buf.length}`)
  const got = sha256(buf)
  if (got !== want) throw new Error(`雜湊不符：${url}\n  預期 ${want}\n  實得 ${got}`)
  return buf
}

export function wezTermReady(dir = outDir) {   // 空檔（建置時的占位）不算就緒
  return [...WEZTERM_FILES, 'LICENSE.md', 'SOURCE.txt'].every(f => { try { return fs.statSync(path.join(dir, f)).size > 0 } catch { return false } })
}

export async function fetchWezTerm() {
  if (process.env.ASN_SKIP_WEZTERM === '1') { console.log('略過 WezTerm（ASN_SKIP_WEZTERM=1）'); return false }
  if (process.platform !== 'win32') { console.log('非 Windows，不附 WezTerm'); return false }
  if (wezTermReady()) { console.log('WezTerm 已就緒（沿用）'); return true }
  fs.mkdirSync(cacheDir, { recursive: true })
  const zipPath = path.join(cacheDir, ZIP_NAME)
  let zipOk = fs.existsSync(zipPath) && sha256(fs.readFileSync(zipPath)) === WEZTERM_ZIP_SHA256
  if (!zipOk) {
    console.log(`下載 WezTerm ${WEZTERM_VERSION}（約 63 MB）…`)
    fs.writeFileSync(zipPath, await download(`${BASE}/${ZIP_NAME}`, WEZTERM_ZIP_SHA256, WEZTERM_ZIP_SIZE))
  }
  const licPath = path.join(cacheDir, 'LICENSE.md')
  if (!(fs.existsSync(licPath) && sha256(fs.readFileSync(licPath)) === WEZTERM_LICENSE_SHA256)) {
    fs.writeFileSync(licPath, await download(LICENSE_URL, WEZTERM_LICENSE_SHA256))
  }
  const tmp = path.join(cacheDir, 'extract')
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  // Windows 內建的 tar（bsdtar）讀得懂 zip；Git 附的 GNU tar 不行，所以指名系統那支
  const sysTar = path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe')
  const members = WEZTERM_FILES.map(f => `WezTerm-windows-${WEZTERM_VERSION}/${f}`)
  const r = spawnSync(sysTar, ['-xf', zipPath, '-C', tmp, ...members], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`解壓縮失敗（壓縮檔裡缺其中一個檔也會這樣）：${(r.stderr || r.stdout || '').trim()}`)
  for (const f of WEZTERM_FILES) {
    if (!fs.existsSync(path.join(tmp, `WezTerm-windows-${WEZTERM_VERSION}`, f))) throw new Error(`壓縮檔裡找不到 ${f}`)
  }
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  for (const f of WEZTERM_FILES) fs.copyFileSync(path.join(tmp, `WezTerm-windows-${WEZTERM_VERSION}`, f), path.join(outDir, f))
  fs.copyFileSync(licPath, path.join(outDir, 'LICENSE.md'))
  fs.writeFileSync(path.join(outDir, 'SOURCE.txt'), SOURCE_TEXT)
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`WezTerm 就緒：${WEZTERM_FILES.length} 個檔 → ${path.relative(root, outDir)}`)
  return true
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fetchWezTerm().catch(e => { console.error(String(e.message || e)); process.exit(1) })
}
