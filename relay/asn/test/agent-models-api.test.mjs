// #2355 P2：本機型號清單的前端包裝。電腦版呼叫 agent_models，手機沒有本機探測、回 { models: null }
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

async function load(invoke) {
  const prev = globalThis.__TAURI__
  globalThis.__TAURI__ = { core: { invoke } }
  try { return await import(`../ui/lib/tauri.mjs?t=${Math.random()}`) } finally { globalThis.__TAURI__ = prev }
}

test('電腦版：agentModels 帶 vendor／force 原樣交給 agent_models；不帶就是 null 與 false', async () => {
  const calls = []
  const m = await load(async (cmd, args) => { calls.push([cmd, args]); return { models: [] } })
  await m.transport.agentModels()
  await m.transport.agentModels({ vendor: 'pi', force: true })
  await m.transport.agentModels({ force: 'yes' })
  assert.deepEqual(calls, [
    ['agent_models', { vendor: null, force: false }],
    ['agent_models', { vendor: 'pi', force: true }],
    ['agent_models', { vendor: null, force: false }],
  ])
})

test('手機：沒有本機探測，agentModels 回 { models: null }（畫面端會判成 none）', async () => {
  const m = await load(async () => { throw new Error('手機不該叫任何指令') })
  assert.deepEqual(await m.mobileModelsApi.agentModels({ vendor: 'pi', force: true }), { models: null })
})

test('agent_models 在 lib.rs 註冊、且只有電腦版有（掛 cfg(desktop)）', () => {
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  assert.match(lib, /#\[cfg\(desktop\)\]\r?\n#\[tauri::command\]\r?\nasync fn agent_models\(/)
  const handlers = [...lib.matchAll(/generate_handler!\[([\s\S]*?)\]\)/g)].map(x => x[1])
  assert.ok(handlers.some(h => /\bagent_models\b/.test(h)), '電腦的指令清單要有 agent_models')
  const phone = /#\[cfg\(not\(desktop\)\)\]\r?\n\s*let builder = builder\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\);/.exec(lib)
  assert.doesNotMatch(phone[1], /\bagent_models\b/, '手機的清單不能有')
})
