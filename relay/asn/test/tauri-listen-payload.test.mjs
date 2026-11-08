// #1031：lib/tauri.mjs 的 listen 已經把事件的 payload 拆好才交給回呼；回呼再讀一次 .payload 會拿到 undefined
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('真的 listen：回呼拿到的是事件內容本身，不是整個事件', async () => {
  const got = []
  const prev = globalThis.__TAURI__
  globalThis.__TAURI__ = { event: { listen: async (evt, h) => { h({ event: evt, id: 1, payload: { song: '晴天' } }); return () => {} } } }
  try {
    const { listen } = await import(`../ui/lib/tauri.mjs?t=${Date.now()}`)
    await listen('asn:now-playing', p => got.push(p))
  } finally {
    globalThis.__TAURI__ = prev
  }
  assert.deepEqual(got, [{ song: '晴天' }])
})

test('list.js 每個 listen 回呼都不再讀 .payload', () => {
  const src = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  const calls = [...src.matchAll(/listen\('([^']+)',\s*(\w+)\s*=>([^\n]*)/g)]
  assert.ok(calls.length >= 5, `list.js 找到的 listen 數不對（${calls.length}），檢查規則可能失效`)
  const bad = calls
    .filter(([, , arg, rest]) => rest.replace(/\/\/.*$/, '').includes(`${arg}.payload`))
    .map(([, evt]) => evt)
  assert.deepEqual(bad, [])
})
