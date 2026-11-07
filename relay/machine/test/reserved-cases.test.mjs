// 寄件名保留字檢查的共用案例（supabase/functions/_shared/reserved_sender_cases.json）：Node 橋的 foldName／isReservedPartnerName 逐筆比對。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { foldName, isLegacyNoticeName, isReservedPartnerName } from '../system-notice.mjs'

const cases = JSON.parse(fs.readFileSync(new URL('../../../supabase/functions/_shared/reserved_sender_cases.json', import.meta.url), 'utf8'))

test('共用案例：reserved 都是保留名字、ordinary 都不是', () => {
  assert.ok(cases.reserved.length > 20 && cases.ordinary.length > 5)
  for (const n of cases.reserved) { assert.equal(isLegacyNoticeName(n), true, JSON.stringify(n)); assert.equal(isReservedPartnerName(n), true) }
  for (const n of cases.ordinary) assert.equal(isLegacyNoticeName(n), false, JSON.stringify(n))
})

test('共用案例：foldName 的預期結果', () => {
  for (const [input, expected] of cases.fold) assert.equal(foldName(input), expected, JSON.stringify(input))
})
