// #1031：lib/tauri.mjs 的 listen 已經把事件的 payload 拆好才交給回呼；回呼再讀一次 .payload 會拿到 undefined
import test from 'node:test'
import assert from 'node:assert/strict'

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
