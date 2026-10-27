import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ADOPT_LABEL, ADOPT_TIP, adoptItem, managePanelItems } from '../ui/lib/actionbar.mjs'

const read = p => readFileSync(new URL(`../ui/${p}`, import.meta.url), 'utf8')

test('納入管理：本機的 AI 夥伴能選；不在這台或已經是 ASN 開的終端就反灰並寫原因', () => {
  const ok = adoptItem({ node: 'H', agent: 'g' }, 'H')
  assert.deepEqual([ok.key, ok.ok, ok.reason, ok.label], ['p:adopt', true, '', ADOPT_LABEL])
  assert.ok(ADOPT_TIP.includes('預設只能看'))
  assert.equal(adoptItem({ node: 'W', agent: 'g' }, 'H').ok, false)
  assert.match(adoptItem({ node: 'W', agent: 'g' }, 'H').reason, /那台電腦/)
  assert.equal(adoptItem({ node: 'H', entryKind: 'term' }, 'H').reason, '這個夥伴已經由 ASN 管理')
  assert.equal(adoptItem({ node: 'H' }, '').ok, false, '不知道自己是哪台就不給選')
})

test('納入管理放在夥伴管理那段、封存之前；群組沒有', () => {
  const f = { node: 'H', agent: 'claude-1', engine: 'claude', status: 'online', entryKind: null }
  const items = managePanelItems(f, { selfNode: 'H', signedIn: true, loaded: true }, [], { selfNode: 'H', console: { ok: true }, model: { ok: false, reason: 'x' } })
  const keys = items.map(i => i.key)
  if (keys.includes('p:archive') || keys.includes('p:unarchive')) {
    const a = keys.indexOf('p:adopt'), z = Math.max(keys.indexOf('p:archive'), keys.indexOf('p:unarchive'))
    assert.ok(a >= 0 && a < z, `納入管理要在封存之前：${keys}`)
  } else assert.ok(keys.includes('p:adopt'))
  assert.equal(managePanelItems({ room: true }, {}, [], {}).some(i => i.key === 'p:adopt'), false)
})

test('接線：點了經 group-menu 通道請名單視窗打開接手清單；「＋」選單不再有接手', () => {
  const bar = read('lib/actionbar.mjs'), js = read('list.js'), html = read('list.html')
  assert.ok(bar.includes("if (op === 'adopt') { emit('ops', 'adopt'); return }"))
  assert.ok(js.includes("if (what === 'adopt') { await adoptLoad(); return }"))
  const menu = html.slice(html.indexOf('class="av-menu launch-picker"'), html.indexOf('</ul>', html.indexOf('class="av-menu launch-picker"')))
  assert.ok(!menu.includes('adoptLoad'))
})
