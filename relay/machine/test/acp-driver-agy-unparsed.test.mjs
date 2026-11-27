// agy 驅動：輸出裡解析不了的行（截斷的 JSON、無效文字編碼）當成這一步沒通過檢查，整輪中止；log 不放行內容。
// 用假 agy（fake-agy.mjs）走真的行程與事件流程。
// 執行：node --test relay/machine/test/acp-driver-agy-unparsed.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgyDriver } from '../engines/acp-driver-agy.mjs'

const FAKE_AGY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agy.mjs')
const mk = (logs, extraEnv = {}) => createAgyDriver({
  cfg: { command: process.execPath, args: [FAKE_AGY], envPass: Object.keys(extraEnv), cwd: process.cwd(), model: '' },
  env: { PATH: process.env.PATH ?? '', ...extraEnv }, log: m => logs.push(m), guard: { checkTool: () => ({ ok: true }) },
})

for (const [name, cmd] of [['截斷的 JSON', '@@RAW_JSON'], ['無效文字編碼', '@@RAW_UTF8']]) {
  test(`agy 驅動：輸出有${name}的一行 → 整輪中止，log 有行號與長度、沒有行內容`, async () => {
    const logs = []
    const d = mk(logs)
    await d.start()
    try {
      await assert.rejects(d.turn(cmd, { timeoutMs: 5000, maxMs: 8000 }), e => e.code === 'violation' && /工具步驟無法解讀，這一輪已中止/.test(e.message))
      const line = logs.find(l => l.includes('無法解讀'))
      assert.ok(line, logs.join('\n'))
      assert.match(line, /第 \d+ 行/)
      assert.match(line, /長度 \d+/)
      assert.ok(!logs.some(l => l.includes('RAWSECRET')), '記錄裡不放行內容')
    } finally { d.stop() }
  })
}

test('agy 驅動：沒有進行中的一輪時收到無效編碼的行 → 只記 log、後面的正常行仍讀得到', async () => {
  const logs = []
  const d = mk(logs, { FAKE_AGY_RAW_ON_START: '1' })
  await d.start()
  try {
    const deadline = Date.now() + 5000   // 等那一行被讀到之後才開始一輪
    while (!logs.some(l => l.includes('無法解讀')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
    const r = await d.turn('@@TOOL read_file {"Path":"/x/a"}', { timeoutMs: 5000, maxMs: 8000 })
    assert.match(r.text, /tool-done: read_file/)
    const line = logs.find(l => l.includes('無法解讀'))
    assert.ok(line, logs.join('\n'))
    assert.match(line, /略過/)
    assert.ok(!logs.some(l => l.includes('RAWSECRET')), '記錄裡不放行內容')
  } finally { d.stop() }
})

test('agy 驅動：全部是正常行時照常回覆（對照組）', async () => {
  const logs = []
  const d = mk(logs)
  await d.start()
  try {
    const r = await d.turn('@@TOOL read_file {"Path":"/x/a"}', { timeoutMs: 5000, maxMs: 8000 })
    assert.match(r.text, /tool-done: read_file/)
    assert.ok(!logs.some(l => l.includes('無法解讀')), logs.join('\n'))
  } finally { d.stop() }
})
