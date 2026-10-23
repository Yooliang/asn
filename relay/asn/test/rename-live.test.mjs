// 改設備名就地更新、不重載頁面。
// 從前改名後 location.reload()：因為視窗名在啟動時讀一次，核心／畫面各處都拿著舊值。現在由 applyRename 一次換掉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AsnCore } from '../ui/lib/core.mjs'
import { applyRename, renamedInfo } from '../ui/lib/rename.mjs'
import { memStore } from './helpers.mjs'

const ui = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')

test('renamedInfo：舊名進清單最前、新名不留在清單、不重複、不改傳入物件', () => {
  const src = { window_name: 'A', old_names: ['Z', 'B'] }
  assert.deepEqual(renamedInfo(src, 'B'), { window_name: 'B', old_names: ['A', 'Z'] })
  assert.deepEqual(renamedInfo({ window_name: 'A', old_names: ['A'] }, 'C'), { window_name: 'C', old_names: ['A'] })
  assert.deepEqual(renamedInfo({ window_name: 'A' }, 'A'), { window_name: 'A', old_names: [] })
  assert.deepEqual(src, { window_name: 'A', old_names: ['Z', 'B'] })
})

function mkCore() {
  const members = [{ id: 'T', agents: [{ name: 'T-ASN', status: 'idle' }, { name: '小希', status: 'idle' }, { name: '夥伴', status: 'idle' }] }]
  const transport = { list: async () => ({ members }), inbox: async () => ({ messages: [] }), ack: async () => ({}), send: async () => ({ ok: true, id: 'x' }) }
  return new AsnCore({ transport, store: memStore(), selfNode: 'T', windowName: 'T-ASN', pollMs: 60_000, rosterMs: 60_000 })
}

test('setWindowName：核心換名、舊名進收信別名、通知畫面、名單裡自己的新名那筆被濾掉', async () => {
  const core = mkCore()
  await core.refreshRoster()
  assert.ok(core.friends.has('T/小希'), '改名前小希是別人')
  let states = 0
  core.on('state', () => { states++ })
  core.setWindowName('小希')
  assert.equal(core.windowName, '小希')
  assert.ok(core.aliases.has('T-ASN') && !core.aliases.has('小希'))
  assert.ok(states >= 1)
  assert.equal(core.snapshot().windowName, '小希')
  await new Promise(r => setTimeout(r, 20))
  assert.ok(!core.friends.has('T/小希'), '新名是自己，不能出現在好友裡')
})

test('applyRename：info、核心、暱稱一起換，不需要重載', () => {
  const core = mkCore()
  const info = { window_name: 'T-ASN', old_names: [] }
  const me = { nick: 'T-ASN' }
  assert.equal(applyRename({ info, core, me }, '小希'), '小希')
  assert.deepEqual(info, { window_name: '小希', old_names: ['T-ASN'] })
  assert.equal(me.nick, '小希')
  assert.equal(core.windowName, '小希')
})

test('守門：改名流程不得 location.reload()，且走 applyRename、info 是響應式', () => {
  for (const f of ['list.js', 'm.js']) {
    const src = fs.readFileSync(path.join(ui, f), 'utf8')
    const lines = src.split(/\r?\n/)
    const i = lines.findIndex(l => l.includes("invoke('set_window_name', { name: want })"))
    assert.ok(i >= 0, `${f} 找不到改名呼叫`)
    assert.ok(!/reload/.test(lines.slice(Math.max(0, i - 1), i + 3).join('\n')), `${f} 改名後不得重載頁面`)
    assert.ok(lines[i].includes('applyRename('), `${f} 改名成功後要走 applyRename`)
    assert.match(src, /const info = reactive\(await invoke\('startup_info'\)\)/, `${f} 的 info 要是響應式`)
  }
})
