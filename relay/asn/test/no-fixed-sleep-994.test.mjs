// #994 系列「測試靠時間差」的棘輪守門：測試裡睡固定毫秒數（≥100ms）來等條件的寫法，只准減少、不准增加。
// 為什麼：固定等待在機器慢時等不夠（偶發紅）、機器快時白等（整套變慢）。#994 之後這類測試一再變成偶發紅燈。
//
// 正確做法：用 waitFor（test/helpers/wait-for.mjs）——每 10ms 檢查條件，成立就過、逾時（預設 2 秒）丟錯並說明：
//   import { waitFor } from './helpers/wait-for.mjs'
//   await waitFor(() => emitted('act').length === 1, { what: '送出 act' })
// 事件有明確訊號（Promise、emit、回呼）時，直接 await 那個訊號，連輪詢都不用。
//
// 基準：test/golden/fixed-sleeps-baseline.json（每個檔案現有幾處）。少了：把基準更新成新的數字（node scripts/fixed-sleeps.mjs --update）。
// 多了、或新檔案出現：紅燈；請改用 waitFor，不要更新基準。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countFixedSleeps, scanFixedSleeps, readBaseline } from '../scripts/fixed-sleeps.mjs'

test('#994 棘輪：測試裡睡固定毫秒數的處數，沒有任何檔案比基準多、沒有新檔案', t => {
  const base = readBaseline(), cur = scanFixedSleeps()
  const worse = [], better = []
  for (const [f, n] of Object.entries(cur)) {
    const allowed = base[f] ?? 0
    if (n > allowed) worse.push(`${f}：現在 ${n} 處，基準 ${allowed} 處${f in base ? '' : '（新檔案）'}`)
  }
  for (const [f, allowed] of Object.entries(base)) if ((cur[f] ?? 0) < allowed) better.push(`${f}：${allowed} → ${cur[f] ?? 0}`)
  if (better.length) t.diagnostic(`有檔案的固定等待減少了，請執行 node scripts/fixed-sleeps.mjs --update 更新基準：${better.join('；')}`)
  assert.deepEqual(worse, [], `測試不要用固定毫秒數睡著等條件：改用 test/helpers/wait-for.mjs 的 waitFor（輪詢條件、有上限），或直接 await 事件本身。\n${worse.join('\n')}`)
})

test('#994 掃描器：只算 ≥100ms 的「await 睡固定毫秒」，小的讓出、參數、註解、沒 await 的不算', () => {
  assert.equal(countFixedSleeps('await new Promise(r => setTimeout(r, 500))'), 1)
  assert.equal(countFixedSleeps('await new Promise(res => setTimeout(res, 100))'), 1)
  assert.equal(countFixedSleeps('await new Promise(r => setTimeout(r, 99))'), 0)
  assert.equal(countFixedSleeps('await new Promise(r => setTimeout(r, 0))'), 0)
  assert.equal(countFixedSleeps('await sleep(3300)'), 1)
  assert.equal(countFixedSleeps('await sleep(5)'), 0)
  assert.equal(countFixedSleeps('await sleep(1_000)'), 1)
  assert.equal(countFixedSleeps('const sleep = ms => new Promise(r => setTimeout(r, ms))'), 0, '參數不算')
  assert.equal(countFixedSleeps('const p = sleep(3000).then(() => 1)'), 0, '沒有 await＝逾時上限，不算')
  assert.equal(countFixedSleeps('// await sleep(500)'), 0)
  assert.equal(countFixedSleeps('const D = 50\nawait sleep(D + 60)'), 1, '常數解得出來：110')
  assert.equal(countFixedSleeps('const D = 10\nawait sleep(D + 60)'), 0, '常數解得出來：70')
  assert.equal(countFixedSleeps('await sleep(IMPORTED_MS + 60)'), 1, '解不出來保守地算')
  assert.equal(countFixedSleeps('await sleep(200); await sleep(300)'), 2)
})

test('#994 基準檔的形狀：鍵是 test/ 底下存在的檔案、數字是正整數、鍵排序固定', async () => {
  const fs = await import('node:fs')
  const base = readBaseline()
  const keys = Object.keys(base)
  assert.deepEqual(keys, [...keys].sort(), '基準檔的鍵要排序（node scripts/fixed-sleeps.mjs --update 產生）')
  for (const [f, n] of Object.entries(base)) {
    assert.ok(Number.isInteger(n) && n > 0, `${f}：次數要是正整數（0 的檔案不要留在基準裡）`)
    assert.ok(fs.existsSync(new URL(`../${f}`, import.meta.url)), `${f}：檔案已不存在，請更新基準`)
  }
})
