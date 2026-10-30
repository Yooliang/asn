// 守門：畫面上的用詞一律是「換班接手」（小良哥 2026-10-29 #1384）。舊說法「接班換手」「換手接班」不能再出現在畫面字串裡。
// 程式內部的動作代號（handover）不受影響，只看使用者會看到的檔案：ui 資料夾與 Rust 端寫進畫面的字串。
// 禁用詞用兩段拼起來，免得這個測試自己被自己擋住。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BANNED = ['接班' + '換手', '換手' + '接班']

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'vendor') walk(p, out) }   // vendor 是產生出來的（含過往更新紀錄），不在版本控制裡
    else if (/\.(mjs|js|html|css)$/.test(e.name)) out.push(p)
  }
  return out
}

test('畫面檔案（ui）裡沒有舊說法，只用「換班接手」', () => {
  const hits = []
  for (const f of walk(path.join(root, 'ui'))) {
    const text = fs.readFileSync(f, 'utf8')
    for (const w of BANNED) if (text.includes(w)) hits.push(`${path.relative(root, f)}：${w}`)
  }
  assert.deepEqual(hits, [])
})

// 歷史檔不掃：已套用的種子 migration 不再修改（改了也不會更新線上資料庫），而種子快照 seed-source/roadmap.html
// 是那支 migration 的來源，要跟它保持一致（tests/roadmap_page.test.mjs「種子 SQL 與產生腳本一致」）。
// 線上藍圖的字樣由領隊直接改 site item（asn_site_roadmap_items 等資料表）更新。其他檔照擋。
const repo = path.join(root, '..', '..')
const HISTORICAL = new Set([
  path.join(repo, 'supabase', 'migrations', '20261027100100_site_content_seed.sql'),
  path.join(repo, 'site', 'tools', 'seed-source', 'roadmap.html'),
])

test('官網（site 的頁面與種子檔）也不含舊說法', () => {
  const hits = []
  for (const f of walk(path.join(repo, 'site'))) {
    if (f.includes(path.sep + 'node_modules' + path.sep)) continue
    if (HISTORICAL.has(path.resolve(f))) continue
    const text = fs.readFileSync(f, 'utf8')
    for (const w of BANNED) if (text.includes(w)) hits.push(`${path.relative(root, f)}：${w}`)
  }
  assert.deepEqual(hits, [])
})

test('Rust 端寫進畫面的字串（動作名稱、橫幅）也不含舊說法，而且確實用了新說法', () => {
  const rs = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'bridge', 'partner_ops.rs'), 'utf8')
  for (const w of BANNED) assert.ok(!rs.includes(w), `partner_ops.rs 還有舊說法 ${w}`)
  assert.ok(rs.includes('換班接手'), 'partner_ops.rs 的動作名稱沒有「換班接手」')
})
