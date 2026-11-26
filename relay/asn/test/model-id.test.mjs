// #2353 R3：模型代號統一格式的前端這一份。Rust 那份（agent_tools/models/parse.rs）讀同一份向量，兩邊答案一樣。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { MODEL_ID_PATTERN, isValidModelId } from '../ui/lib/model-id.mjs'

const V = JSON.parse(fs.readFileSync(new URL('../../shared/test-vectors/model-id.json', import.meta.url), 'utf8'))

test('規則字串與共用向量逐字相同', () => {
  assert.equal(MODEL_ID_PATTERN, V.pattern)
})

test('合法與不合法的都照共用向量', () => {
  for (const s of V.valid) assert.equal(isValidModelId(s), true, `應該合法：${JSON.stringify(s)}`)
  for (const s of V.invalid) assert.equal(isValidModelId(s), false, `應該不合法：${JSON.stringify(s)}`)
  assert.equal(isValidModelId(undefined), false)
  assert.equal(isValidModelId(null), false)
})

test('pi 的 SAFE 規則與統一規則是同一條（pi-models.mjs 裡的字面值）', () => {
  const src = fs.readFileSync(new URL('../ui/lib/pi-models.mjs', import.meta.url), 'utf8')
  assert.ok(src.includes(`const SAFE = /${MODEL_ID_PATTERN}/`), 'pi-models.mjs 的 SAFE 與統一規則不同')
})
