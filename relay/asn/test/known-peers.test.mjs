import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TEXT, errorText, normalizeView } from '../ui/lib/known-peers.mjs'

test('認得的電腦：欄位壞的丟掉，名字清掉控制字元', () => {
  const v = normalizeView({ peers: [
    { node: 'hom7a1', name: '家用‮機', fingerprint: '0123456789abcdef', first_seen_ms: 1_800_000_000_000 },
    { node: '', name: 'x' }, { name: '沒節點' }, null,
    { node: 'wrk9b2', name: '', fingerprint: 'ff', first_seen_ms: 'x' },
  ] })
  assert.equal(v.peers.length, 2)
  assert.equal(v.peers[0].name, '家用 機')
  assert.ok(v.peers[0].firstSeen)
  assert.equal(v.peers[1].name, '某台電腦')
  assert.equal(v.peers[1].firstSeen, '')
  assert.deepEqual(normalizeView(null), { peers: [] })
})

test('認得的電腦：只能看和忘記，錯誤不露出內部訊息', () => {
  assert.equal(TEXT.forget, '忘記這台')
  assert.equal(errorText(new Error('/home/x/device_known.json 讀不到')), '操作沒有成功，請稍後再試。')
  assert.equal(errorText('認得的電腦紀錄壞了'), '認得的電腦紀錄壞了，請告訴開發團隊。')
})
