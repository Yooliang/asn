// 純邏輯：跳脫與表情、roster→好友與狀態、來信→對話歸屬、震動判斷、介面不准 v-html 原文。
// 執行：node --test relay/asn/test/*.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { esc, emo, plain, initial, hasNudge, stripNudge, NUDGE_TAG, NUDGE_HINT, nudgeBody, hueOf } from '../ui/lib/text.mjs'
import { cleanPsm, buildFriends, mergeFriends, statusOf, isRelayRoom, friendId, groupByDevice } from '../ui/lib/roster.mjs'
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

test('震動標記：新格式整段內文才算、舊 [震動] 含有就算，內文拿掉標記', () => {
  assert.equal(NUDGE_TAG, '[震動]')
  assert.equal(nudgeBody('H-ASN'), '（H-ASN 傳送了一個震動）\n' + NUDGE_HINT)
  assert.ok(hasNudge(nudgeBody('H-ASN')) && stripNudge(nudgeBody('H-ASN')) === '', '帶提示的兩行震動要認得、整段不顯示')
  assert.ok(hasNudge('（H-ASN 傳送了一個震動）\n另外我想問一件事'), '震動加一段話：仍是震動')
  assert.equal(stripNudge('（H-ASN 傳送了一個震動）\n另外我想問一件事'), '另外我想問一件事', '只留那段話當文字訊息')
  assert.equal(stripNudge('（H-ASN 傳送了一個震動）\r\n\r\n第一行\n第二行'), '第一行\n第二行')
  assert.ok(hasNudge('（H-ASN 傳送了一個震動）\n想回應的話，就回一個震動：寄一封內文只有「（你的名字 傳送了一個震動）」的信，不用另外回信。'), '舊版提示的震動仍認得')
  // Rust 端組的第二行要跟前端同一句
  assert.ok(fs.readFileSync(new URL('../src-tauri/src/relay.rs', import.meta.url), 'utf8').includes(`pub const NUDGE_HINT: &str = "${NUDGE_HINT}";`))
  assert.ok(hasNudge('（H-ASN 傳送了一個震動）') && hasNudge('  （家用 ASN 傳送了一個震動）\n'))
  assert.equal(stripNudge('（H-ASN 傳送了一個震動）'), '')
  assert.ok(!hasNudge('他說（H-ASN 傳送了一個震動）然後走了') && !hasNudge('（傳送了一個震動）') && !hasNudge('（A）（B 傳送了一個震動）'), '一般訊息裡提到不算')
  assert.equal(stripNudge('他說（H-ASN 傳送了一個震動）然後走了'), '他說（H-ASN 傳送了一個震動）然後走了')
  assert.ok(hasNudge('[震動]') && hasNudge('欸 [震動] 看這裡'))
  assert.ok(!hasNudge('一般訊息') && !hasNudge(null))
  assert.equal(stripNudge('[震動]'), '')
  assert.equal(stripNudge('欸 [震動]'), '欸')
})

test('statusOf：busy／working／running＝忙碌，idle 之類＝線上', () => {
  for (const s of ['busy', 'WORKING', 'running']) assert.equal(statusOf(s), 'busy', s)
  for (const s of ['idle', '', null, undefined]) assert.equal(statusOf(s), 'online', String(s))
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
  assert.equal(f[0].psm, 'irori')
  assert.equal(f[0].nick, 'H-Irori')
  assert.equal(f[1].status, 'busy')
  assert.equal(f[2].psm, '')
  assert.equal(cleanPsm('H／irori', 'H'), 'irori')
  assert.equal(cleanPsm('X', 'X'), '')
  assert.equal(cleanPsm('irori', 'H'), 'irori')
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
test('守門：ChatPane 有寄件狀態圖示與 sent-status 模組', () => {
  const pane = fs.readFileSync(path.join(UI, 'lib', 'chatpane.mjs'), 'utf8')
  assert.ok(pane.includes("from './sent-status.mjs'"))
  assert.ok(pane.includes('class="msg-st"'))
  const css = fs.readFileSync(path.join(UI, 'style.css'), 'utf8')
  assert.ok(css.includes('.msg-st'))
})

test('守門：所有 v-html 都只用 emo(...)', () => {
  const files = [...fs.readdirSync(UI).filter(f => f.endsWith('.html')), 'lib/chatpane.mjs']   // 對話區的模板在 lib/chatpane.mjs
  assert.ok(files.length >= 4, `找不到介面檔：${files}`)
  let count = 0
  for (const f of files) {
    for (const m of fs.readFileSync(path.join(UI, f), 'utf8').matchAll(/v-html\s*=\s*"([^"]*)"/g)) {
      count++
      assert.match(m[1], /^(emo|vendorIcon|vendorIconSvg|renderMarkdown|bodyHtml)\(.+\)$/, `${f} 的 v-html 只准 emo(...)、vendorIcon(...)、vendorIconSvg(...)（自家模組的固定 SVG）、renderMarkdown(...) 或 bodyHtml(...)（它只是 renderMarkdown 加上群組 @ 小標記，見 markdown.test.mjs 的守門）：${m[1]}`)
    }
  }
  assert.ok(count >= 4, `v-html 數量異常：${count}`)
  for (const f of fs.readdirSync(UI).filter(f => f.endsWith('.js'))) assert.ok(!/innerHTML\s*=/.test(fs.readFileSync(path.join(UI, f), 'utf8')), `${f} 不准用 innerHTML`)
})

test('groupByDevice：一台設備一組、自己那台排第一、組內離線排後、標題用設備名', () => {
  const ms = [
    { id: 'w02', name: 'w02', agents: [{ name: 'claude-8b', status: 'idle' }] },
    { id: 'H', name: '家用機', agents: [{ name: '家用若莉', status: 'busy' }, { name: '家用收發室', status: 'idle' }] },
    { id: 'aegis', name: '牧陽 Aegis', agents: [{ name: '小牧', status: 'idle' }] },
  ]
  const live = buildFriends(ms, { selfNode: 'w02', selfName: 'w02-ASN' })
  const friends = mergeFriends([{ id: 'w02/舊視窗', node: 'w02', agent: '舊視窗', nick: '舊視窗' }], live)
  const g = groupByDevice(friends, { selfNode: 'w02' })
  assert.deepEqual(g.map(x => x.label), ['w02', ...['家用機', '牧陽 Aegis'].sort((a, b) => a.localeCompare(b, 'zh-Hant'))])
  assert.deepEqual(g[0].items.map(f => [f.nick, f.status]), [['claude-8b', 'online'], ['舊視窗', 'offline']])
  assert.deepEqual(g.find(x => x.key === 'H').items.map(f => f.nick), ['家用若莉'])
  const only = groupByDevice(friends, { selfNode: 'w02', match: f => f.nick === '小牧' })
  assert.deepEqual(only.map(x => x.label), ['牧陽 Aegis'])
})
