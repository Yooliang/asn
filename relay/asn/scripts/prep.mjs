// 把本機 node_modules 的第三方程式（不走 CDN）放進 ui/vendor，讓 Tauri 把它們一起打包：
//   vue → 直接複製；DiceBear（core＋shapes）→ 用 esbuild 打成單一 ESM 檔 dicebear.mjs（離線產生大頭貼）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'node_modules', 'vue', 'dist', 'vue.global.prod.js')
if (!fs.existsSync(src)) { console.error('找不到 node_modules/vue：先執行 npm install'); process.exit(1) }
if (!fs.existsSync(path.join(root, 'node_modules', '@dicebear', 'shapes'))) { console.error('找不到 node_modules/@dicebear：先執行 npm install'); process.exit(1) }
const vendor = path.join(root, 'ui', 'vendor')
fs.mkdirSync(vendor, { recursive: true })
fs.copyFileSync(src, path.join(vendor, 'vue.global.prod.js'))
buildSync({
  entryPoints: [path.join(root, 'scripts', 'dicebear-entry.mjs')],
  outfile: path.join(vendor, 'dicebear.mjs'),
  bundle: true, format: 'esm', minify: true, platform: 'browser', target: 'es2020', legalComments: 'none', logLevel: 'warning',
})
