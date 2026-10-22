// 名單的 detail（Claude Code 外掛狀態說明）：接在資料夾後面當個人訊息；舊後台沒有 detail 時和以前一樣。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFriends, psmOf, statusOf } from '../ui/lib/roster.mjs'

test('psmOf：資料夾加說明用「・」連接，只有其一就單獨顯示，沒有就空', () => {
  assert.equal(psmOf({ cwd_label: 'proj', detail: '背景工作 2 件' }), 'proj・背景工作 2 件')
  assert.equal(psmOf({ cwd_label: 'proj' }), 'proj')
  assert.equal(psmOf({ cwd_label: 'proj', detail: null }), 'proj')
  assert.equal(psmOf({ detail: '等你回答' }), '等你回答')
  assert.equal(psmOf({ cwd_label: 'p', detail: '  a\nb  ' }), 'p・a b')
  assert.equal(psmOf({ cwd_label: 'p', detail: 5 }), 'p')
  assert.equal(psmOf({}), '')
  assert.equal(psmOf({ detail: '問'.repeat(200) }).length, 80)
})

test('buildFriends：waiting＝暫離且個人訊息帶說明；沒有 detail 的舊名單不變', () => {
  const f = buildFriends([{ id: 'H', agents: [
    { name: 'H-甲', status: 'waiting', cwd_label: 'proj', detail: '等你回答' },
    { name: 'H-乙', status: 'idle', cwd_label: 'proj' },
  ] }], { selfNode: 'X', selfName: 'X-ASN' })
  assert.equal(f[0].status, 'away')
  assert.equal(f[0].psm, 'proj・等你回答')
  assert.equal(f[1].psm, 'proj')
  assert.equal(statusOf('busy'), 'busy')
})
