// 在 Windows／macOS／Linux 本機交叉編譯 Linux x86_64 靜態的 asn-bridge（無視窗橋）。
// 做法：x86_64-unknown-linux-musl 目標＋cargo-zigbuild（zig 當連結器，ring 的 C 程式也能編）。
// 用法：npm run build:linux-bridge [-- --target <三元組>] [-- --skip-build] [-- --target-dir <路徑>]
// 產物：<src-tauri>/target/linux/asn-bridge（在 .gitignore 內，不進 git）。
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.join(here, '..')
export const DEFAULT_TARGET = 'x86_64-unknown-linux-musl'
const FORBIDDEN = ['webkit', 'gtk', 'libsoup', 'libssl']

/** 解析命令列參數。 */
export function parseArgs(argv) {
  const o = { target: DEFAULT_TARGET, skipBuild: false, targetDir: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--skip-build') o.skipBuild = true
    else if (a === '--target' || a === '--target-dir') {
      const v = argv[++i]
      if (!v) throw new Error(`${a} 需要一個值`)
      if (a === '--target') o.target = v
      else o.targetDir = v
    } else throw new Error(`不認得的參數：${a}`)
  }
  return o
}

/** 路徑組法：cargo 目標資料夾、編出來的檔、最後放的檔。 */
export function resolvePaths({ target = DEFAULT_TARGET, targetDir = null, env = process.env, root = ROOT } = {}) {
  const manifest = path.join(root, 'src-tauri', 'Cargo.toml')
  const cargoTarget = path.resolve(targetDir || env.CARGO_TARGET_DIR || path.join(root, 'src-tauri', 'target'))
  const built = path.join(cargoTarget, target, 'release', 'asn-bridge')
  const outDir = path.join(root, 'src-tauri', 'target', 'linux')
  return { manifest, cargoTarget, built, outDir, out: path.join(outDir, 'asn-bridge') }
}

/** cargo zigbuild 的參數。 */
export function buildArgs({ manifest, target }) {
  return ['zigbuild', '--manifest-path', manifest, '--release', '--no-default-features', '--bin', 'asn-bridge', '--target', target]
}

/** 讀 ELF 標頭，確認是 x86-64、靜態（沒有 PT_INTERP／PT_DYNAMIC）、不含視窗函式庫字串。 */
export function verifyElf(buf) {
  const problems = []
  const info = {}
  if (buf.length < 64 || buf.readUInt32BE(0) !== 0x7f454c46) return { ok: false, problems: ['不是 ELF 檔'], info }
  info.class64 = buf[4] === 2
  info.little = buf[5] === 1
  if (!info.class64 || !info.little) return { ok: false, problems: ['不是 64 位元小端 ELF'], info }
  info.machine = buf.readUInt16LE(18)
  if (info.machine !== 62) problems.push(`機器型別不是 x86-64（${info.machine}）`)
  const phoff = Number(buf.readBigUInt64LE(32))
  const phentsize = buf.readUInt16LE(54)
  const phnum = buf.readUInt16LE(56)
  const types = []
  for (let i = 0; i < phnum; i++) types.push(buf.readUInt32LE(phoff + i * phentsize))
  info.hasInterp = types.includes(3)
  info.hasDynamic = types.includes(2)
  if (info.hasInterp) problems.push('含 PT_INTERP（動態連結器）')
  if (info.hasDynamic) problems.push('含 PT_DYNAMIC（動態段）')
  const lower = buf.toString('latin1').toLowerCase()
  info.forbidden = FORBIDDEN.filter(s => lower.includes(s))
  if (info.forbidden.length) problems.push(`含不該有的字串：${info.forbidden.join('、')}`)
  return { ok: problems.length === 0, problems, info }
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 找 PyPI ziglang 套件的資料夾（裡面有 zig 執行檔）；找不到回 null。 */
export function findPyZigDir() {
  const code = 'import ziglang,os;print(os.path.dirname(ziglang.__file__))'
  for (const [cmd, args] of [['py', ['-3.12']], ['python3', []], ['python', []]]) {
    const r = spawnSync(cmd, [...args, '-I', '-c', code], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
  }
  return null
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const p = resolvePaths(opts)
  if (!opts.skipBuild) {
    // zig 在 PyPI 的 ziglang 套件裡：把它所在資料夾補進 PATH（已有 zig 就不動）
    const env = { ...process.env, CARGO_TARGET_DIR: p.cargoTarget }
    if (spawnSync('zig', ['version'], { env }).status !== 0) {
      const dir = findPyZigDir()
      if (dir) env.PATH = dir + path.delimiter + (env.PATH || env.Path || '')
    }
    const r = spawnSync('cargo', buildArgs({ manifest: p.manifest, target: opts.target }), { stdio: 'inherit', env })
    if (r.error || r.status !== 0) {
      console.error('建置失敗。需要：rustup target add ' + opts.target + '、cargo install cargo-zigbuild、zig（pip install ziglang 後把 site-packages/ziglang 放進 PATH）')
      process.exit(r.status || 1)
    }
  }
  if (!fs.existsSync(p.built)) { console.error(`找不到編譯產物：${p.built}`); process.exit(1) }
  const buf = fs.readFileSync(p.built)
  const v = verifyElf(buf)
  if (!v.ok) { console.error('ELF 驗證失敗：' + v.problems.join('；')); process.exit(1) }
  fs.mkdirSync(p.outDir, { recursive: true })
  fs.copyFileSync(p.built, p.out)
  console.log(`產物：${p.out}`)
  console.log(`大小：${buf.length} 位元組`)
  console.log(`sha256：${sha256(buf)}`)
  console.log('驗證：x86-64 ELF、靜態連結、不含視窗函式庫字串')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()
