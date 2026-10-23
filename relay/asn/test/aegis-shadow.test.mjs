import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as dep from '../scripts/aegis/deploy-shadow.mjs'
import * as cmp from '../scripts/aegis/compare-shadow.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const unit = fs.readFileSync(path.join(here, '..', 'scripts', 'aegis', 'asn-bridge-shadow.service'), 'utf8')

test('單元：必要設定都在，且不與舊單元互斥', () => {
  assert.ok(!/^\s*Conflicts=/m.test(unit), '不得有 Conflicts=')
  assert.match(unit, /^User=cwen0708$/m)
  assert.match(unit, /^ExecStart=\/home\/cwen0708\/asn-bridge\/asn-bridge run --engine-only$/m)
  assert.match(unit, /^Environment=ASN_HOME=\/home\/cwen0708\/\.asn-rs$/m)
  assert.match(unit, /^Environment=ASN_ENGINES=aegis$/m)
  assert.match(unit, /^Environment=ASN_RELAY_ID=aegis-rs$/m)
  assert.match(unit, /^Restart=on-failure$/m)
  assert.ok(!unit.includes('\r'), '要是 LF')
  assert.ok(!/KEY=/.test(unit), '單元裡不放金鑰')
  assert.ok(!unit.includes('.irori-relay'.concat('/aegis')), '不共用舊資料夾')
})

test('單元：白名單與正式單元的成員相同', () => {
  const m = unit.match(/^Environment=ASN_AEGIS_ALLOW=(.+)$/m)
  assert.deepEqual(m[1].split(','), ['aegis', 'xiao-liang', 'xiao-yin', 'xiao-mu', 'hen', 'li-li', 'xiao-hui', 'xiao-wen', 'xiao-zhen', 'xi-xu'])
})

test('部署參數：預設與覆寫、拒絕危險值', () => {
  const d = dep.parseArgs([])
  assert.equal(d.instance, 'aegis-tokyo')
  assert.equal(d.dryRun, false)
  const o = dep.parseArgs(['--dry-run', '--skip-build', '--restart', '--zone', 'z1', '--project', 'p1'])
  assert.ok(o.dryRun && o.skipBuild && o.restart)
  assert.equal(o.zone, 'z1')
  assert.throws(() => dep.parseArgs(['--instance', 'a;rm -rf /']))
  assert.throws(() => dep.parseArgs(['--node', 'aegis']), /正式節點/)
  assert.throws(() => dep.parseArgs(['--nope']))
  assert.throws(() => dep.parseArgs(['--zone']))
})

test('部署計畫：步驟順序與指令組法', () => {
  const o = dep.parseArgs([])
  const plan = dep.buildPlan(o, { binary: '/b/asn-bridge', sha: 'abc123' })
  assert.deepEqual(plan.map(s => s.cmd), ['npm', 'gcloud', 'gcloud', 'gcloud', 'gcloud'])
  assert.deepEqual(plan[0].args, ['run', 'build:linux-bridge'])
  const scp = plan[2].args
  assert.deepEqual(scp.slice(0, 3), ['compute', 'scp', '/b/asn-bridge'])
  assert.equal(scp[3], 'aegis-tokyo:/tmp/asn-bridge.new')
  for (const s of plan.slice(1)) {
    assert.ok(s.args.includes('--tunnel-through-iap'))
    assert.ok(s.args.includes('--zone') && s.args.includes('asia-northeast1-a'))
  }
  const last = plan[4].args[plan[4].args.indexOf('--command') + 1]
  for (const frag of ['sudo test -f /home/cwen0708/.asn-rs/aegis-rs.key', 'sha256sum', 'abc123', 'install -o cwen0708 -g cwen0708 -m 755', 'systemctl daemon-reload', 'systemctl enable --now asn-bridge-shadow.service']) {
    assert.ok(last.includes(frag), frag)
  }
  assert.ok(!last.includes('restart'))
})

test('部署計畫：--skip-build 省略建置、--restart 加重啟、--project 帶入', () => {
  const o = dep.parseArgs(['--skip-build', '--restart', '--project', 'proj'])
  const plan = dep.buildPlan(o, { binary: '/b' })
  assert.equal(plan.length, 4)
  assert.ok(plan.every(s => s.cmd === 'gcloud' && s.args.includes('proj')))
  assert.ok(plan[3].args.join(' ').includes('systemctl restart asn-bridge-shadow.service'))
})

test('部署計畫：安全守則（不動舊單元、不碰金鑰內容）', () => {
  const text = dep.buildPlan(dep.parseArgs(['--restart']), { binary: '/b' }).map(s => dep.formatCmd(s.cmd, s.args)).join('\n')
  assert.ok(!text.includes('irori-relay-aegis'))
  assert.ok(!/\b(cat|head|tail|less|cp|scp)\b[^\n]*\.key/.test(text.replace(/test -f \S+\.key/g, '')), '不得讀或傳金鑰檔')
  assert.ok(!/stop|disable|Conflicts/.test(text))
})

test('formatCmd：含空白或特殊字元的參數加雙引號', () => {
  assert.equal(dep.formatCmd('gcloud', ['a', 'b c', '$x']), 'gcloud a "b c" "\\$x"')
})

test('對照參數：預設、覆寫、拒絕不合理組合', () => {
  const d = cmp.parseArgs([])
  assert.deepEqual([d.a, d.b, d.tester, d.agent], ['aegis', 'aegis-rs', 'asn-tester', 'aegis'])
  assert.equal(cmp.parseArgs(['--rounds', '3', '--timeout-ms', '1000']).rounds, 3)
  assert.throws(() => cmp.parseArgs(['--a', 'x', '--b', 'x']))
  assert.throws(() => cmp.parseArgs(['--tester', 'aegis']))
  assert.throws(() => cmp.parseArgs(['--rounds', '0']))
  assert.throws(() => cmp.parseArgs(['--b', 'a b']))
})

test('金鑰檔預設路徑只組路徑', () => {
  assert.equal(cmp.defaultKeyFile('t', { ASN_HOME: '/h' }, '/u'), path.join('/h', 't.key'))
  assert.equal(cmp.defaultKeyFile('t', {}, '/u'), path.join('/u', '.asn', 't.key'))
})

test('寄信內容兩邊相同、只有收件節點不同', () => {
  const x = cmp.buildSend('aegis', 'aegis', '問題'), y = cmp.buildSend('aegis-rs', 'aegis', '問題')
  assert.equal(x.expects_reply, true)
  assert.deepEqual({ ...x, to_node: 0 }, { ...y, to_node: 0 })
})

const summ = (replies, sentAt = 0) => cmp.summarize({ sentAt, replies })
const rep = (t, who = 'Aegis', body = 'x' + t) => ({ from_agent: who, body, t })

test('結構比對：一致、封數不同、顯示名不同、沒回、重複回、耗時差太多', () => {
  assert.ok(cmp.compareSummaries(summ([rep(8000)]), summ([rep(9000)])).ok)
  assert.match(cmp.compareSummaries(summ([rep(8000)]), summ([rep(9000), rep(9100)])).diffs.join(), /封數/)
  assert.match(cmp.compareSummaries(summ([rep(8000)]), summ([rep(9000, '別人')])).diffs.join(), /顯示名/)
  assert.match(cmp.compareSummaries(summ([rep(8000)]), summ([])).diffs.join(), /有沒有回/)
  assert.match(cmp.compareSummaries(summ([rep(8000, 'A', 'same'), rep(8100, 'A', 'same')]), summ([rep(8000, 'A', 'same'), rep(8100, 'A', 'other')])).diffs.join(), /重複/)
  assert.match(cmp.compareSummaries(summ([rep(5000)]), summ([rep(200000)])).diffs.join(), /耗時/)
  assert.ok(cmp.sameScale(60000, 150000))
  assert.ok(!cmp.sameScale(null, 1))
})

test('收回覆：只收 reply_to 對得上的、ack、等安靜後結束', async () => {
  let t = 0
  const acked = []
  const inboxes = [
    { messages: [{ id: 'm1', reply_to: 'S1', from_agent: 'Aegis', body: 'a' }, { id: 'zz', reply_to: 'other', body: 'no' }] },
    { messages: [{ id: 'm2', reply_to: 'S2', from_agent: 'Aegis', body: 'b' }] },
    { messages: [] },
    { messages: [] },
  ]
  const api = async (action, body) => {
    if (action === 'ack') { acked.push(...body.ids); return { ok: true } }
    return inboxes.shift() ?? { messages: [] }
  }
  const got = await cmp.collect({ api, sent: { S1: 'aegis', S2: 'aegis-rs' }, sentAt: 0, timeoutMs: 100000, settleMs: 3000, pollMs: 1000, sleep: async ms => { t += ms }, now: () => t })
  assert.deepEqual(acked.sort(), ['m1', 'm2'])
  assert.equal(got.aegis.replies.length, 1)
  assert.equal(got['aegis-rs'].replies.length, 1)
  assert.ok(t < 100000, '安靜後就結束，不必等到逾時')
})

test('收回覆：沒人回會在逾時結束', async () => {
  let t = 0
  const got = await cmp.collect({ api: async () => ({ messages: [] }), sent: { S1: 'aegis' }, sentAt: 0, timeoutMs: 5000, settleMs: 1000, pollMs: 2000, sleep: async ms => { t += ms }, now: () => t })
  assert.equal(got.aegis.replies.length, 0)
  assert.equal(cmp.summarize(got.aegis).replied, false)
})

test('整體對照：寄兩邊、輸出對照表', async () => {
  let t = 0, n = 0
  const sentTo = {}
  const api = async (action, body) => {
    if (action === 'send') { const id = 'S' + ++n; sentTo[id] = body.to_node; return { id } }
    if (action === 'ack') return { ok: true }
    return { messages: Object.entries(sentTo).map(([id, node]) => ({ id: 'r' + id, reply_to: id, from_agent: 'Aegis', from_node: node, body: '好' })) }
  }
  const rows = await cmp.runCompare({ ...cmp.DEFAULTS, rounds: 1 }, { api, sleep: async ms => { t += ms }, now: () => t, log: () => {} })
  assert.equal(rows.length, cmp.DEFAULT_QUESTIONS.length)
  assert.ok(rows.every(r => r.result.ok))
  const table = cmp.renderTable(rows, cmp.DEFAULTS)
  assert.match(table, /共 3 題，一致 3，不一致 0/)
})
