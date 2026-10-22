// 產生「下載區」的檔案到 %TEMP%\asn-downloads\（不上傳、不部署；上傳步驟見 docs/DOWNLOADS.md）：
//   asn-windows.zip     Windows 小程式（收發室橋 + 安裝／解除安裝程式）
//   irori-windows.zip   舊檔名：內容與 asn-windows.zip 完全相同，只為了舊網址與舊連結仍可下載（D10）
//   downloads.json      各檔版本（git 短 sha + 日期）、大小、sha256
// 用法：node tools/release/build_downloads.mjs [--out <資料夾>] [--include <其他要列進 downloads.json 的檔案，例如 apk>]...
// 同一個 commit 產出的 zip 內容固定（時間戳取 commit 日期），sha256 也會一樣。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildZip } from './zip_lite.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(here, '..', '..')
export const PUBLIC_BASE = 'https://irori.web.app/download'
export const WINDOWS_ZIP = 'asn-windows.zip'
export const LEGACY_WINDOWS_ZIP = 'irori-windows.zip'

const MACHINE = path.join('relay', 'machine')
const INSTALLER = path.join(MACHINE, 'installer')

// relay/machine 底下「不進 app」的東西：測試、開發工具、安裝程式本身（放 zip 根目錄）、Linux/Aegis 專用、金鑰／紀錄／執行狀態
const EXCLUDE_DIRS = new Set(['test', 'installer', 'node_modules'])
const EXCLUDE_FILE = name =>
  /^tools-.*\.mjs$/.test(name) || /\.(key|log|pid|tmp)$/i.test(name) || name === 'pending.json' ||
  name.startsWith('.') || name === 'bridge-aegis.mjs' || name.endsWith('.service')
// 打包完再檢查一次：zip 裡不能出現的路徑（金鑰、測試、紀錄、執行狀態）
export const FORBIDDEN_IN_ZIP = /(^|\/)(test|node_modules|\.git)\/|\.(key|log|pid|tmp)$|(^|\/)pending\.json$|(^|\/)tools-[^/]*$|(^|\/)\.env/i

// 文字檔（.ps1／.cmd／.txt）：統一 CRLF；.ps1 與 .txt 加 UTF-8 BOM（Windows PowerShell 5.1／記事本才不會把中文讀成亂碼）
function normalizeText(name, buf) {
  if (!/\.(ps1|cmd|txt)$/i.test(name)) return buf
  let s = buf.toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
  if (/\.(ps1|txt)$/i.test(name)) s = '﻿' + s
  return Buffer.from(s, 'utf8')
}

function walk(dir, rel = '') {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(ent.name) || ent.name.startsWith('.')) continue
      out.push(...walk(path.join(dir, ent.name), `${rel}${ent.name}/`))
    } else if (ent.isFile() && !EXCLUDE_FILE(ent.name)) {
      out.push(`${rel}${ent.name}`)
    }
  }
  return out
}

const git = (args, repo = REPO) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()

export function versionInfo(repo = REPO) {
  let sha = 'unknown', date = new Date().toISOString().slice(0, 10), dirty = false
  try {
    sha = git(['rev-parse', '--short', 'HEAD'], repo)
    date = git(['log', '-1', '--format=%cs'], repo)
    dirty = git(['status', '--porcelain', '--', 'relay/machine'], repo) !== ''
  } catch { /* 不在 git 底下：版本標 unknown */ }
  return { sha: dirty ? `${sha}-dirty` : sha, date }
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')

// 組出 Windows 小程式 zip 的項目：[{ name, data }]
export function windowsEntries(repo = REPO, version = versionInfo(repo)) {
  const entries = []
  const machineDir = path.join(repo, MACHINE)
  for (const rel of walk(machineDir)) {
    entries.push({ name: `app/${rel}`, data: normalizeText(rel, fs.readFileSync(path.join(machineDir, rel))) })
  }
  const instDir = path.join(repo, INSTALLER)
  for (const name of fs.readdirSync(instDir).filter(n => fs.statSync(path.join(instDir, n)).isFile())) {
    entries.push({ name, data: normalizeText(name, fs.readFileSync(path.join(instDir, name))) })
  }
  entries.push({ name: 'app/VERSION.json', data: Buffer.from(JSON.stringify({ sha: version.sha, date: version.date }, null, 2) + '\n') })
  for (const e of entries) {
    if (FORBIDDEN_IN_ZIP.test(e.name)) throw new Error(`zip 不該包含：${e.name}`)
  }
  return entries
}

export function buildDownloads({ outDir = path.join(os.tmpdir(), 'asn-downloads'), repo = REPO, include = [], now = new Date() } = {}) {
  fs.mkdirSync(outDir, { recursive: true })
  const version = versionInfo(repo)
  const zip = buildZip(windowsEntries(repo, version), `${version.date}T00:00:00Z`)
  const zipPath = path.join(outDir, WINDOWS_ZIP)
  fs.writeFileSync(zipPath, zip)
  fs.writeFileSync(path.join(outDir, LEGACY_WINDOWS_ZIP), zip)

  const files = {
    [WINDOWS_ZIP]: {
      version: `${version.sha} (${version.date})`, size: zip.length, sha256: sha256(zip),
      url: `${PUBLIC_BASE}/${WINDOWS_ZIP}`, use: 'Windows 小程式（收發室橋）',
    },
    [LEGACY_WINDOWS_ZIP]: {
      version: `${version.sha} (${version.date})`, size: zip.length, sha256: sha256(zip),
      url: `${PUBLIC_BASE}/${LEGACY_WINDOWS_ZIP}`, use: '舊檔名，內容與 asn-windows.zip 相同（讓舊網址仍可下載）',
    },
  }
  for (const f of include) {
    const buf = fs.readFileSync(f)
    const name = path.basename(f)
    files[name] = { version: null, size: buf.length, sha256: sha256(buf), url: `${PUBLIC_BASE}/${name}` }
  }
  // skill 不打包：Claude 照 INSTALL.txt 的話自己下載 SKILL.md，這裡只記指紋，方便對照
  const skill = path.join(repo, 'web', 'relay', 'SKILL.md')
  if (fs.existsSync(skill)) {
    const buf = fs.readFileSync(skill)
    files['SKILL.md'] = { version: null, size: buf.length, sha256: sha256(buf), url: 'https://irori.web.app/relay/SKILL.md', use: 'Claude Code skill（不打包，見 INSTALL.txt）' }
  }
  const manifest = { generated: now.toISOString(), files }
  fs.writeFileSync(path.join(outDir, 'downloads.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { outDir, zipPath, manifest }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const opt = { include: [] }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') opt.outDir = path.resolve(args[++i])
    else if (args[i] === '--include') opt.include.push(path.resolve(args[++i]))
    else { console.error(`不認得的參數：${args[i]}`); process.exit(2) }
  }
  const r = buildDownloads(opt)
  console.log(`輸出：${r.outDir}`)
  for (const [name, f] of Object.entries(r.manifest.files)) console.log(`  ${name}  ${f.size} bytes  sha256=${f.sha256.slice(0, 12)}…${f.version ? `  ${f.version}` : ''}`)
}
