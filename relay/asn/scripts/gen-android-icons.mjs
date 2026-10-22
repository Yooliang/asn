// 用 ui/img/logo.svg（ASN 的機器人）產生安卓 App 圖示：自適應圖示的前景（透明底機器人，縮在安全區內）與舊版（Android 7 以下）的方形、圓形圖示，
// 各密度都產出到 src-tauri/gen/android/app/src/main/res/mipmap-*。背景色與 adaptive-icon 的 xml 是手寫檔（已進 git），不在這裡產生。
// 不動電腦版的圖示（src-tauri/icons）。需要先在任一資料夾 `npm i --no-save @resvg/resvg-js`，再用 NODE_PATH 指到它的 node_modules：
//   cd relay/asn && npm i --no-save @resvg/resvg-js && node scripts/gen-android-icons.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { Resvg } = createRequire(path.join(root, 'package.json'))('@resvg/resvg-js')
const logo = fs.readFileSync(path.join(root, 'ui', 'img', 'logo.svg'), 'utf8').replace(/<\?xml[^>]*>/, '')
const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(logo)[1]
const res = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res')
const BG = '#DCEBFA'

// 把機器人放進 size×size 的畫布中央，邊長佔 frac
const nested = (size, frac) => {
  const s = size * frac
  return `<svg x="${(size - s) / 2}" y="${(size - s) / 2}" width="${s}" height="${s}" viewBox="120 112 260 260">${inner}</svg>`
}
const wrap = (size, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`
const png = (svg, px) => new Resvg(svg, { fitTo: { mode: 'width', value: px } }).render().asPng()

// 密度 → 倍率（mdpi＝1）
const DENSITY = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
for (const [d, k] of Object.entries(DENSITY)) {
  const dir = path.join(res, `mipmap-${d}`)
  fs.mkdirSync(dir, { recursive: true })
  // 自適應圖示前景：108dp 畫布，系統只顯示中間 66dp 的圓或圓角方形——機器人（約 60% 邊長）放在安全區內
  fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), png(wrap(108, nested(108, 0.6)), 108 * k))
  // 舊版圖示：48dp，方形圓角與圓形各一
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), png(wrap(48, `<rect width="48" height="48" rx="10" fill="${BG}"/>${nested(48, 0.8)}`), 48 * k))
  fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), png(wrap(48, `<circle cx="24" cy="24" r="24" fill="${BG}"/>${nested(48, 0.72)}`), 48 * k))
}
console.log('已產生各密度的 ic_launcher／ic_launcher_round／ic_launcher_foreground')
