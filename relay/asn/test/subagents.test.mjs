// 子代理按鈕（#27）：純邏輯、按鈕接線、前後端指令名稱一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUBAGENT_POLL_MS, canOfferSubagents, subagentView } from '../ui/lib/subagents.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = f => fs.readFileSync(path.join(root, f), 'utf8')

test('只有本機的 Claude 視窗會出現子代理按鈕', () => {
  const ok = { node: 'H' }
  assert.equal(canOfferSubagents(ok, { selfNode: 'H', engine: 'claude' }), true)
  assert.equal(canOfferSubagents(ok, { selfNode: 'H', engine: 'codex' }), false)
  assert.equal(canOfferSubagents({ node: 'W' }, { selfNode: 'H', engine: 'claude' }), false, '別台設備')
  assert.equal(canOfferSubagents({ node: 'H', engine: 'acp' }, { selfNode: 'H', engine: 'claude' }), false)
  assert.equal(canOfferSubagents({ node: 'H', pending: true }, { selfNode: 'H', engine: 'claude' }), false)
  assert.equal(canOfferSubagents(null, { selfNode: 'H', engine: 'claude' }), false)
})

test('畫面資料：幾個、各自在做什麼、超過列出數會提示、查不到當 0 個', () => {
  const v = subagentView({ count: 2, items: [{ id: 'a', description: '查登入', kind: 'Explore' }, { id: 'b', description: '' }] })
  assert.equal(v.count, 2)
  assert.equal(v.label, '子代理 2')
  assert.deepEqual(v.items.map(i => i.text), ['查登入', '（沒有描述）'])
  assert.equal(v.items[0].kind, 'Explore')
  assert.equal(v.more, 0)
  assert.equal(subagentView({ count: 25, items: [{ id: 'a', description: 'x' }] }).more, 24)
  for (const bad of [null, undefined, {}, { items: 'x' }]) {
    const e = subagentView(bad)
    assert.equal(e.count, 0)
    assert.equal(e.label, '子代理')
    assert.match(e.empty, /沒有子代理/)
  }
  for (const s of [v.tip, v.label, v.empty]) assert.match(s, /[一-鿿]/)
})

test('輪詢間隔不會太密也不會太慢', () => {
  assert.ok(SUBAGENT_POLL_MS >= 2000 && SUBAGENT_POLL_MS <= 15000)
})

test('功能列接上子代理按鈕：用 canOfferSubagents 把關、圖示存在、關閉視窗時停止輪詢', () => {
  const t = read('ui/lib/actionbar.mjs')
  assert.match(t, /const showSubs = computed\(\(\) => slot\.value\.subs\.ok\)/, '#539：子代理那一格由 barSlots 把關，固定顯示、用不到就反灰')
  assert.match(t, /data-slot="subs"[^>]*:disabled="!slot\.subs\.ok"/)
  assert.match(t, /src="img\/ab-agent\.svg"/)
  assert.match(read('ui/img/ab-agent.svg'), /^<svg/)
  assert.match(t, /onBeforeUnmount\(\(\) => \{[^\n]*stopSubs\(\)/)
  assert.ok(!/v-html|innerHTML/.test(t))
})

test('前端指令名稱和後端一致，且註冊進 invoke_handler；後端只讀記錄檔、不啟動子程序', () => {
  assert.match(read('ui/lib/tauri.mjs'), /subagentsQuery: req => invoke\('subagents_query', \{ req \}\)/)
  const lib = read('src-tauri/src/lib.rs')
  assert.match(lib, /async fn subagents_query\(/)
  assert.match(lib, /model_switch_run, subagents_query,/)
  const rs = read('src-tauri/src/launch/subagents.rs')
  assert.ok(!/Command::new|spawn\(/.test(rs.split('#[cfg(test)]')[0]), '不啟動子程序')
})
