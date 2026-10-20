// 把本機 node_modules 的 vue（不走 CDN）複製到 ui/vendor，讓 Tauri 把它一起打包。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'node_modules', 'vue', 'dist', 'vue.global.prod.js')
if (!fs.existsSync(src)) { console.error('找不到 node_modules/vue：先執行 npm install'); process.exit(1) }
fs.mkdirSync(path.join(root, 'ui', 'vendor'), { recursive: true })
fs.copyFileSync(src, path.join(root, 'ui', 'vendor', 'vue.global.prod.js'))
