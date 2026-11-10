// 自己帳號的電腦之間打字，預設不用每次問（0.2.15）：設定頁的顯示
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { normalizeView, TEXT as KNOWN } from '../ui/lib/known-peers.mjs'

test('列表：按過允許才算 confirmed；只有明確的 true', () => {
  const v = normalizeView({ peers: [{ node: 'a', input_no_ask: true, input_confirmed: true }, { node: 'b', input_no_ask: true }, { node: 'c', input_confirmed: 'yes' }] })
  assert.deepEqual(v.peers.map(p => [p.inputNoAsk, p.inputConfirmed]), [[true, true], [true, false], [false, false]])
})

test('設定頁：預設勾著時，還沒按過允許的那台寫「第一次還是會問」；按過的寫紅條照樣會出現', () => {
  const src = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  assert.match(src, /v-if="p\.inputNoAsk && !p\.inputConfirmed">\{\{ KNOWN\.inputFirstAsk \}\}/)
  assert.match(src, /v-if="p\.inputNoAsk && p\.inputConfirmed" class="pair-warn">\{\{ KNOWN\.inputNoAskWarn \}\}/)
  assert.match(KNOWN.inputFirstAsk, /第一次/)
  assert.match(KNOWN.inputNoAskWarn, /紅條/)
  assert.match(KNOWN.inputNoAskWarn, /結束/)
})
