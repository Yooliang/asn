import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultPartnerName, injectPendingGroups, pendingFriend, resolvePending } from '../ui/lib/partner.mjs'
import { bumpRecentCwd, cwdChoices, normalizeLaunchPrefs } from '../ui/lib/launch-prefs.mjs'

test('預設夥伴名字會遞增', () => {
  const friends = [{ nick: 'Gemini-1' }, { nick: 'Gemini-3' }]
  assert.equal(defaultPartnerName(friends, 'gemini'), 'Gemini-4')
})

test('啟動中列會插入名單分組', () => {
  const groups = [{ key: 'H', label: '家用', items: [] }]
  const p = pendingFriend({ node: 'H', device: '家用', name: 'Gemini-2', profileId: 'gemini', mode: 'background' })
  const out = injectPendingGroups(groups, [p])
  assert.equal(out[0].items[0].pending, true)
  assert.match(out[0].items[0].psm, /啟動中/)
})

test('上線後清掉啟動中', () => {
  const p = pendingFriend({ node: 'H', device: '家用', name: 'X', profileId: 'claude', mode: 'window' })
  const left = resolvePending([p], [{ id: 'H/X', nick: 'X' }])
  assert.equal(left.length, 0)
})

test('最近用過的工作資料夾', () => {
  const p = normalizeLaunchPrefs({ recentCwd: ['/a'], maxPerHour: 4 })
  const n = bumpRecentCwd(p, '/b')
  assert.deepEqual(n.recentCwd.slice(0, 2), ['/b', '/a'])
  assert.deepEqual(cwdChoices({ allow: ['/x'], recent: n.recentCwd }), ['/b', '/a', '/x'])
})

test('啟動設定記住顯示方式', () => {
  assert.equal(normalizeLaunchPrefs({ launchDisplay: 'background' }).launchDisplay, 'background')
  assert.equal(normalizeLaunchPrefs({ launchDisplay: 'weird' }).launchDisplay, 'foreground')
})
