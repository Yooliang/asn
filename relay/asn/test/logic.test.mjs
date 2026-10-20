// 純邏輯：跳脫與表情、roster→好友與狀態、來信→對話歸屬、震動判斷、介面不准 v-html 原文。
// 執行：node --test relay/asn/test/*.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { esc, emo, plain, initial, hasNudge, stripNudge, NUDGE_TAG, hueOf } from '../ui/lib/text.mjs'
import { buildFriends, mergeFriends, statusOf, isRelayRoom, friendId } from '../ui/lib/roster.mjs'
import { routeMail } from '../ui/lib/routing.mjs'

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')

test('esc／emo：標籤與引號一律跳脫，表情代碼換成圖示', () => {
  assert.equal(esc('<img src=x onerror="a()">&\''), '&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;')
  const out = emo('<script>alert(1)</script> (L) :D')
  assert.ok(!out.includes('<script'), out)
  assert.ok(out.includes('&lt;script&gt;'))
  assert.ok(out.includes('❤️') && out.includes('😄'))
  assert.equal(emo(null), '')
  assert.equal(plain('hi :)'), 'hi 🙂')
  assert.equal(initial('~*小美*~'), '小')
})

test('震動標記：含 [震動] 就算，內文拿掉標記', () => {
  assert.equal(NUDGE_TAG, '[震動]')
  assert.ok(hasNudge('[震動]') && hasNudge('欸 [震動] 看這裡'))
  assert.ok(!hasNudge('一般訊息') && !hasNudge(null))
  assert.equal(stripNudge('[震動]'), '')
  assert.equal(stripNudge('欸 [震動]'), '欸')
})

test('statusOf：busy／working／running＝忙碌，idle 之類＝線上', () => {
  for (const s of ['busy', 'WORKING', 'running']) assert.equal(statusOf(s), 'busy', s)
  for (const s of ['idle', 'waiting', '', null, undefined]) assert.equal(statusOf(s), 'online', String(s))
})

const members = [
  { id: 'H', agents: [{ name: 'H-Irori', status: 'idle', cwd_label: 'irori', engine: 'claude' }, { name: 'H-ASN', status: 'idle', cwd_label: 'asn' }, { name: '家用收發室', status: 'idle', cwd_label: 'x' }] },
  { id: 'W', agents: [{ name: 'W-政策', status: 'busy', cwd_label: 'policy-tw' }, { name: 'W-空', status: null, cwd_label: null }] },
  { id: 'Q', agents: [] },
  { bad: true },
]

test('buildFriends：一視窗一列、略過收發室與自己、個人訊息＝節點／資料夾', () => {
  const f = buildFriends(members, { selfNode: 'H', selfName: 'H-ASN' })
  assert.deepEqual(f.map(x => x.id), ['H/H-Irori', 'W/W-政策', 'W/W-空'])
  assert.equal(f[0].psm, 'H／irori')
  assert.equal(f[0].nick, 'H-Irori')
  assert.equal(f[1].status, 'busy')
  assert.equal(f[2].psm, 'W')
  assert.ok(isRelayRoom('家用收發室') && !isRelayRoom('收發室甲'))
  assert.deepEqual(buildFriends(undefined), [])
})

test('mergeFriends：記得的好友不在名單＝離線；在名單的取名單狀態', () => {
  const live = buildFriends(members, { selfNode: 'H', selfName: 'H-ASN' })
  const known = [{ id: 'W/W-政策', node: 'W', agent: 'W-政策', nick: 'W-政策', psm: '' }, { id: 'X/X-老友', node: 'X', agent: 'X-老友', nick: 'X-老友', psm: 'X' }]
  const m = mergeFriends(known, live)
  const by = Object.fromEntries(m.map(x => [x.id, x]))
  assert.equal(by['X/X-老友'].status, 'offline')
  assert.equal(by['W/W-政策'].status, 'busy')
  assert.equal(by['H/H-Irori'].status, 'online')
  assert.equal(by['H/H-Irori'].hue, hueOf('H/H-Irori'))
})

test('routeMail：對到好友就歸他；對不到標為新增；沒有視窗名＝總機', () => {
  const friends = new Map([['W/W-政策', {}]])
  assert.deepEqual(routeMail(friends, { from_node: 'W', from_agent: 'W-政策' }), { id: 'W/W-政策', node: 'W', agent: 'W-政策', isNew: false })
  assert.equal(routeMail(friends, { from_node: 'Q', from_agent: 'Q-新朋友' }).isNew, true)
  const sw = routeMail(friends, { from_node: 'Q', from_agent: null })
  assert.equal(sw.id, friendId('Q', ''))
  assert.equal(sw.agent, '')
  assert.equal(routeMail(friends, { from_node: '<b>', from_agent: 'x' }).node, '?')
})

// 守門：介面模板裡的 v-html 只准吃 emo(...) 的輸出（先跳脫），不准直接放原文
test('守門：所有 v-html 都只用 emo(...)', () => {
  const files = fs.readdirSync(UI).filter(f => f.endsWith('.html'))
  assert.ok(files.length >= 3, `找不到介面檔：${files}`)
  let count = 0
  for (const f of files) {
    for (const m of fs.readFileSync(path.join(UI, f), 'utf8').matchAll(/v-html\s*=\s*"([^"]*)"/g)) {
      count++
      assert.match(m[1], /^emo\(.+\)$/, `${f} 的 v-html 不是 emo(...)：${m[1]}`)
    }
  }
  assert.ok(count >= 4, `v-html 數量異常：${count}`)
  for (const f of fs.readdirSync(UI).filter(f => f.endsWith('.js'))) assert.ok(!/innerHTML\s*=/.test(fs.readFileSync(path.join(UI, f), 'utf8')), `${f} 不准用 innerHTML`)
})
