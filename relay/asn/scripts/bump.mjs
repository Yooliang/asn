// 版本號加一（預設第三段）：package.json、src-tauri/tauri.conf.json、src-tauri/Cargo.toml 三處一起改（test/version.test.mjs 會檢查一致）。
// 用法：node scripts/bump.mjs [patch|minor]；每次出要給人裝的版本前跑一次（npm run release 會先跑它再打包）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const part = process.argv[2] || 'patch'
const pkgFile = path.join(root, 'package.json')
const cur = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version
const [a, b, c] = cur.split('.').map(Number)
const next = part === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`
const sub = (file, re, rep) => {
  const s = fs.readFileSync(file, 'utf8')
  if (!re.test(s)) throw new Error(`${file} 找不到版本號`)
  fs.writeFileSync(file, s.replace(re, rep))
}
sub(pkgFile, /"version": "[^"]+"/, `"version": "${next}"`)
sub(path.join(root, 'src-tauri', 'tauri.conf.json'), /"version": "[^"]+"/, `"version": "${next}"`)
sub(path.join(root, 'src-tauri', 'Cargo.toml'), /^version = "[^"]+"/m, `version = "${next}"`)
// 隨安裝包帶出去的 Claude 外掛：版本號跟著 ASN（外掛本體程式不動，只改 plugin.json 的 version）
sub(path.join(root, '..', 'claude-mod', '.claude-plugin', 'plugin.json'), /"version": "[^"]+"/, `"version": "${next}"`)
console.log(`${cur} → ${next}`)
