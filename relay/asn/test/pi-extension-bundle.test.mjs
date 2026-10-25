// pi 擴充（relay/pi-extension）隨安裝包帶出去：開新夥伴選 pi 時用安裝資料夾裡的路徑載入。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const extDir = path.join(root, '..', 'pi-extension')
const res = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')).bundle.resources

// 擴充執行需要的檔：index.ts 與它（遞移）import 的相對檔 + package.json
function runtimeFiles() {
  const seen = new Set(['package.json'])
  const todo = ['index.ts']
  while (todo.length) {
    const f = todo.pop()
    if (seen.has(f)) continue
    seen.add(f)
    const src = fs.readFileSync(path.join(extDir, f), 'utf8')
    for (const m of src.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)) todo.push(m[1])
  }
  return [...seen].sort()
}

test('打包：pi 擴充執行需要的檔都列進 bundle.resources，放在安裝資料夾的 pi-extension\\', () => {
  const want = runtimeFiles()
  assert.deepEqual(want, ['control.mjs', 'inbox.mjs', 'index.ts', 'lib.mjs', 'package.json'])
  for (const f of want) assert.equal(res[`../../pi-extension/${f}`], `pi-extension/${f}`, `${f} 沒列進 bundle.resources`)
  const got = Object.entries(res).filter(([, d]) => d.startsWith('pi-extension/'))
  assert.equal(got.length, want.length, '只帶執行需要的檔（不帶測試與 README）')
  for (const [src] of got) assert.ok(fs.existsSync(path.join(root, 'src-tauri', src)), `來源不存在：${src}`)
  assert.doesNotMatch(JSON.stringify(got), /test|README/)
})

test('啟動端：先找安裝資料夾旁的 pi-extension，開發環境退回 repo；找不到有明確說明', () => {
  const rs = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'launch', 'pi.rs'), 'utf8')
  assert.match(rs, /find_pi_extension/)
  assert.match(rs, /找不到 pi 擴充/)
  assert.match(rs, /pi install/)
})
