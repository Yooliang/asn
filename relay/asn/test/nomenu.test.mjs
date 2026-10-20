import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keepNativeMenu, blockContextMenu } from '../ui/lib/nomenu.mjs'

const el = sel => ({ closest: q => (sel && q.split(',').map(s => s.trim()).includes(sel) ? {} : null) })

test('右鍵選單：輸入欄位保留，其他地方擋掉', () => {
  assert.equal(keepNativeMenu(el('input')), true)
  assert.equal(keepNativeMenu(el('textarea')), true)
  assert.equal(keepNativeMenu(el(null)), false)
  assert.equal(keepNativeMenu(null), false)
  let h
  blockContextMenu({ addEventListener: (t, f) => { assert.equal(t, 'contextmenu'); h = f } })
  let blocked = 0
  h({ target: el(null), preventDefault: () => blocked++ })
  h({ target: el('textarea'), preventDefault: () => blocked++ })
  assert.equal(blocked, 1)
})

test('三個視窗的進入點都有掛上', async () => {
  const fs = await import('node:fs')
  for (const f of ['chat', 'list', 'toast']) {
    const s = fs.readFileSync(new URL(`../ui/${f}.js`, import.meta.url), 'utf8')
    assert.match(s, /blockContextMenu\(document\)/, f)
  }
})
