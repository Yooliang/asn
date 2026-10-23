// 守門：Rust 命令列（asn-cli send／recv／room／attach）要認得 Node 版（relay/machine）的每一個參數，
// 結束碼、輸出格式與記號檔名也不能悄悄分家。Node 版還在（雲端代理、Linux 無畫面節點），所以兩邊要一起改。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const node = f => fs.readFileSync(path.join(here, '..', '..', 'machine', f), 'utf8')
const rust = f => fs.readFileSync(path.join(here, '..', 'src-tauri', 'src', 'cli', f), 'utf8')

// 取出 Node 版 parseArgs 比對的參數（k === '--xxx'）
const flagsOf = src => [...src.matchAll(/k === '(--[a-z-]+|-h)'/g)].map(m => m[1])

for (const [name, nodeFile, rustFile] of [['send', 'send.mjs', 'send.rs'], ['recv', 'recv.mjs', 'recv.rs'], ['room', 'room.mjs', 'room.rs'], ['attach', 'attach.mjs', 'attach_cmd.rs']]) {
  test(`asn-cli ${name}：Node 版的每個參數 Rust 版都認得`, () => {
    const flags = flagsOf(node(nodeFile))
    assert.ok(flags.length >= 3, `${nodeFile} 讀到參數`)
    const r = rust(rustFile)
    for (const f of flags) assert.ok(r.includes(`"${f}"`), `${rustFile} 少了 ${f}`)
  })
}

test('結束碼與關鍵訊息兩邊一致', () => {
  const s = rust('send.rs')
  for (const t of ['請說明要不要回信：等對方回就加 --reply，只是告知就加 --no-reply', '--reply 與 --no-reply 不能同時給', '收件人就是你自己', '每小時最多寄', '--reply-to 要是信件 id（uuid）', '被擋：視窗「']) {
    assert.ok(s.includes(t) || s.includes(t.replace('被擋：視窗「', '被擋：視窗「')), `send.rs 少了「${t}」`)
    assert.ok(node('send.mjs').includes(t.replace('被擋：視窗「', '被擋：視窗「')), `send.mjs 少了「${t}」`)
  }
  assert.ok(rust('caller.rs').includes('找不到呼叫者所屬的 Claude 視窗（只有在 Claude 視窗裡執行才能'))
  assert.ok(node('identity.mjs').includes('找不到呼叫者所屬的 Claude 視窗（只有在 Claude 視窗裡執行才能'))
})

test('橋讀的記號檔名：sent/ 的 sha1 與 Node 的 sentMarkName 同一個算法（Rust 測試內有 Node 算出的向量）', async () => {
  const { sentMarkName } = await import(new URL('../../machine/sent-mark.mjs', import.meta.url))
  const sha1 = JSON.stringify(['T-視窗甲', 'PC1', ''])
  assert.equal(sentMarkName('T-視窗甲', 'PC1', ''), crypto.createHash('sha1').update(sha1).digest('hex'))
  const t = rust('tests/send_tests.rs'.replace('tests/', 'tests/'))
  assert.ok(t.includes(sentMarkName('T-視窗甲', 'PC1', '')) && t.includes(sentMarkName('T-視窗甲', 'W', 'W-政策')))
})
