// agy 驅動：解讀或檢查工具步驟的過程出任何錯，都當成沒通過、整輪中止（偏向擋），不能只記一行 log 就放行。
// 用假 agy（fake-agy.mjs）走真的行程與事件流程；檢查器用會丟例外的假的。
// 執行：node --test relay/machine/test/acp-driver-agy-failclosed.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgyDriver } from '../engines/acp-driver-agy.mjs'

const FAKE_AGY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agy.mjs')
const mk = (guard, logs) => createAgyDriver({
  cfg: { command: process.execPath, args: [FAKE_AGY], envPass: [], cwd: process.cwd(), model: '' },
  env: { PATH: process.env.PATH ?? '' }, log: m => logs.push(m), guard,
})

test('agy 驅動：檢查器丟例外 → 整輪中止（violation），log 只有工具名與例外類別', async () => {
  const logs = []
  const d = mk({ checkTool() { throw new TypeError('SECRET-PARAM-CONTENT') } }, logs)
  await d.start()
  try {
    await assert.rejects(d.turn('@@TOOL read_file {"Path":"/x/SECRET-PARAM-CONTENT"}', { timeoutMs: 5000, maxMs: 8000 }), e => e.code === 'violation')
    const line = logs.find(l => l.includes('出錯'))
    assert.ok(line, logs.join('\n'))
    assert.match(line, /read_file/)
    assert.match(line, /TypeError/)
    assert.ok(!logs.some(l => l.includes('SECRET-PARAM-CONTENT')), '記錄裡不放參數與例外訊息')
  } finally { d.stop() }
})

test('agy 驅動：檢查器正常放行時照常回覆（對照組）', async () => {
  const logs = []
  const d = mk({ checkTool: () => ({ ok: true }) }, logs)
  await d.start()
  try {
    const r = await d.turn('@@TOOL read_file {"Path":"/x/a"}', { timeoutMs: 5000, maxMs: 8000 })
    assert.match(r.text, /tool-done: read_file/)
  } finally { d.stop() }
})
