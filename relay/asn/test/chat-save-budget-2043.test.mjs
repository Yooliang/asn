// #2043：聊天存檔超過 Rust 端 store_save 的 8,000,000 位元組上限就整筆不存（新訊息從此寫不進去）。
// 前端存檔前先量位元組（中文一字 3 位元組），超過預算就把每位夥伴留的列數往下縮；記憶體裡的往來記錄不動。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { AsnCore, LOG_KEEP_MIN, SAVE_BUDGET } from '../ui/lib/core.mjs'
import { memStore } from './helpers.mjs'

const RUST_LIMIT = 8_000_000   // relay/asn/src-tauri/src/lib.rs 的 store_save 上限
const bytes = o => new TextEncoder().encode(JSON.stringify(o)).length
const row = (n, text) => ({ k: 'them', text, t: 1_790_000_000_000 + n, id: `m-${n}` })

function mk(chats, perChat, text, log = () => {}) {
  const store = memStore()
  const core = new AsnCore({ transport: {}, store, selfNode: 'H', windowName: 'T', log })
  for (let c = 0; c < chats; c++) {
    const id = `H/夥伴${c}`
    core.friends.set(id, { id, node: 'H', agent: `夥伴${c}`, nick: `夥伴${c}`, status: 'online' })
    core.logs.set(id, Array.from({ length: perChat }, (_, i) => row(i, text)))
  }
  return { core, store }
}

test('#2043 存檔超過預算：縮到預算以內，送給 Rust 的字不會超過 8,000,000 位元組，而且留的是最新的', async () => {
  const logs = []
  const { core, store } = mk(10, 2000, '這是一段很長的中文訊息，用來把存檔撐大。'.repeat(8), m => logs.push(m))   // 約 10×2000×(3×160) ≈ 10MB
  assert.ok(bytes({ logs: Object.fromEntries([...core.logs]) }) > RUST_LIMIT, '前提：不處理的話會超過 Rust 上限')
  await core.flush()
  assert.equal(store.saves, 1, '有真的存進去')
  assert.ok(bytes(store.data) <= SAVE_BUDGET, `存檔 ${bytes(store.data)} 位元組要在預算 ${SAVE_BUDGET} 以內`)
  assert.ok(SAVE_BUDGET < RUST_LIMIT)
  const kept = store.data.logs['H/夥伴0']
  assert.ok(kept.length >= LOG_KEEP_MIN && kept.length < 2000)
  assert.equal(kept.at(-1).id, 'm-1999', '留下的是最新的一列')
  assert.equal(core.logs.get('H/夥伴0').length, 2000, '記憶體裡的往來記錄不動')
  assert.ok(logs.some(m => /save trimmed/.test(m)), '有寫進 log，不能無聲縮')
})

test('#2043 沒超過預算就照舊：每位夥伴存最近 2000 列，不多縮', async () => {
  const { core, store } = mk(3, 2500, '短訊息')
  await core.flush()
  assert.equal(store.data.logs['H/夥伴1'].length, 2000)
  assert.equal(store.data.logs['H/夥伴1'].at(-1).id, 'm-2499')
})

test('#2043 守門：預算與 Rust 上限的關係（改 Rust 上限時要一起看）', () => {
  const rs = fs.readFileSync(new URL('../src-tauri/src/settings/raw.rs', import.meta.url), 'utf8')
  const m = /pub const MAX_BYTES: usize = ([\d_]+)/.exec(rs)
  assert.ok(m, '找得到 store_save 的上限（settings/raw.rs，#2162 ⑥）')
  assert.match(rs, /text\.len\(\) > MAX_BYTES/)
  assert.equal(Number(m[1].replaceAll('_', '')), RUST_LIMIT)
  assert.ok(SAVE_BUDGET <= RUST_LIMIT - 1_000_000, '前端預算要比 Rust 上限至少小 1MB（友人資料等不在縮的範圍內）')
})

// 小悠一審（#2046）：縮到最少列數還是超過時，從最久沒往來的夥伴開始整個拿掉，不能照樣送出去讓 Rust 拒絕
test('#2043 夥伴很多、訊息很長：縮到最少列數還超過，就拿掉最久沒往來的夥伴，存檔仍在預算內', async () => {
  const logs = []
  const long = '很長的中文訊息，'.repeat(150)   // 約 3.6KB 一列
  const { core, store } = mk(300, 50, long, m => logs.push(m))
  // 夥伴 i 最後一則的時間隨 i 增加：編號小的最久沒往來
  for (let c = 0; c < 300; c++) for (const r of core.logs.get(`H/夥伴${c}`)) r.t = 1_790_000_000_000 + c * 1000
  assert.ok(bytes({ logs: Object.fromEntries([...core.logs]) }) > RUST_LIMIT, '前提：每位只留 50 列也超過 Rust 上限')
  await core.flush()
  assert.equal(store.saves, 1)
  assert.ok(bytes(store.data) <= SAVE_BUDGET, `存檔 ${bytes(store.data)} 位元組要在預算內`)
  assert.ok(bytes(store.data) <= RUST_LIMIT)
  assert.equal(store.data.logs['H/夥伴0'], undefined, '最久沒往來的先拿掉')
  assert.ok(store.data.logs['H/夥伴299'], '最近往來的還在')
  assert.equal(core.logs.get('H/夥伴0').length, 50, '記憶體保留')
  assert.equal(store.data.friends.length, 300, '夥伴名單本身不拿掉')
  assert.ok(logs.some(m => /save dropped/.test(m) && m.includes('H/夥伴0')), '寫進 log 記下拿掉了誰')
})
