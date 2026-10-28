// 從手機關閉這台機器橋用 tmux 開的夥伴（#457）：只關記錄裡有、而且 has-session 對得上的；其他一律不動，結果一定回報。
// 用假的 tmux（記錄收到的指令、模擬哪些 session 存在），不碰真的 tmux。執行：node --test relay/machine/test/tmux-partners.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CLOSED, CONSENT_OFF, GONE, NOT_OURS, PROTECTED, REGISTRY_BAD, UNSUPPORTED,
  createTmuxPartners, readRegistry, recordOpened, writeRegistry,
} from '../tmux-partners.mjs'
import { createLauncher } from '../launcher.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'asn-tmux-partners-'))

// 假 tmux：sessions＝目前存在的 session 名；killFails＝kill-session 不會真的關掉
function fakeTmux(sessions, { killFails = false } = {}) {
  const calls = []
  const run = async (_tmux, args) => {
    calls.push(args)
    if (args[0] === 'has-session') return { code: sessions.has(args[2].replace(/^=/, '')) ? 0 : 1, stdout: '' }
    if (args[0] === 'kill-session') { if (!killFails) sessions.delete(args[2].replace(/^=/, '')); return { code: 0, stdout: '' } }
    return { code: 1, stdout: '' }
  }
  return { run, calls, kills: () => calls.filter(a => a[0] === 'kill-session').map(a => a[2]) }
}

function setup({ sessions = [], recorded = [], allowed = true, killFails = false, pending = [] } = {}) {
  const dir = tmp()
  const file = path.join(dir, 'tmux-opened.json')
  for (const n of recorded) recordOpened(file, n, 1)
  const live = new Set(sessions)
  const tmux = fakeTmux(live, { killFails })
  const posted = [], logs = []
  let ops = pending
  const api = async (action, opts) => {
    if (action === 'partner_op_pending') { const o = ops; ops = []; return { ops: o } }
    if (action === 'partner_op_result') { posted.push(opts.body); return { ok: true } }
    throw new Error(`unexpected ${action}`)
  }
  let t = 1_000_000
  const p = createTmuxPartners({ api, log: m => logs.push(m), file, mailboxName: 'T-收發室', allowed: () => allowed, findTmux: () => '/usr/bin/tmux', run: tmux.run, now: () => (t += 120_000) })
  return { p, file, live, tmux, posted, logs, set: v => { allowed = v } }
}
const op = (id, name, o = 'close') => ({ id, name, op: o, requested_by_label: '手機' })

test('記錄裡有、tmux 裡也有：用 kill-session -t =asn-名字 關掉，回報 ok，並從記錄拿掉；不碰別的 session', async () => {
  const s = setup({ sessions: ['asn-甲', 'asn-乙'], recorded: ['甲', '乙'], pending: [op('1', '甲')] })
  await s.p.pull()
  assert.deepEqual(s.tmux.kills(), ['=asn-甲'])
  assert.deepEqual([...s.live].sort(), ['asn-乙'])
  assert.deepEqual(s.posted, [{ id: '1', status: 'ok', detail: CLOSED }])
  assert.deepEqual(Object.keys(readRegistry(s.file).sessions), ['asn-乙'])
})

test('使用者自己開的 asn- 開頭 session 不在記錄裡：不關，回報不是這台橋開的', async () => {
  const s = setup({ sessions: ['asn-外'], recorded: ['甲'], pending: [op('1', '外')] })
  await s.p.pull()
  assert.deepEqual(s.tmux.kills(), [])
  assert.ok(s.live.has('asn-外'))
  assert.deepEqual(s.posted, [{ id: '1', status: 'failed', detail: NOT_OURS }])
})

test('記錄裡有但 tmux 裡已經沒有：不下 kill，回報已經不在了，並從記錄拿掉', async () => {
  const s = setup({ sessions: [], recorded: ['甲'], pending: [op('1', '甲')] })
  await s.p.pull()
  assert.deepEqual(s.tmux.kills(), [])
  assert.deepEqual(s.posted, [{ id: '1', status: 'ok', detail: GONE }])
  assert.deepEqual(readRegistry(s.file).sessions, {})
})

test('這台沒有開放遠端管理：不動，回報原因；動手前才被關掉也不動', async () => {
  const s = setup({ sessions: ['asn-甲'], recorded: ['甲'], allowed: false, pending: [op('1', '甲')] })
  await s.p.pull()
  assert.deepEqual(s.tmux.kills(), [])
  assert.deepEqual(s.posted, [{ id: '1', status: 'failed', detail: CONSENT_OFF }])
  // 第二次檢查：has-session 之後才關掉開關
  const s2 = setup({ sessions: ['asn-甲'], recorded: ['甲'] })
  let n = 0
  const p2 = createTmuxPartners({ api: async () => ({}), log: () => {}, file: s2.file, mailboxName: 'T-收發室', allowed: () => ++n < 2, findTmux: () => 't', run: s2.tmux.run })
  assert.deepEqual(await p2.execute({ op: 'close', name: '甲' }), { status: 'failed', detail: CONSENT_OFF })
  assert.deepEqual(s2.tmux.kills(), [])
})

test('不支援的操作一律回報不支援（info、rename、restart…），不下 kill', async () => {
  const s = setup({ sessions: ['asn-甲'], recorded: ['甲'], pending: ['info', 'rename', 'model', 'handover', 'resume', 'restart', 'remove', '亂寫'].map((o, i) => op(String(i), '甲', o)) })
  await s.p.pull()
  assert.equal(s.posted.length, 8)
  for (const r of s.posted) assert.deepEqual({ status: r.status, detail: r.detail }, { status: 'failed', detail: UNSUPPORTED })
  assert.deepEqual(s.tmux.kills(), [])   // 順手清理只問 has-session，不會下 kill
})

test('收發室視窗不動（就算有人把它寫進記錄）', async () => {
  const s = setup({ sessions: ['asn-T-收發室'], recorded: ['T-收發室'], pending: [op('1', 'T-收發室')] })
  await s.p.pull()
  assert.deepEqual(s.tmux.kills(), [])
  assert.deepEqual(s.posted, [{ id: '1', status: 'failed', detail: PROTECTED }])
})

test('記錄檔壞了：一律不關，照實說；不會因此把檔案蓋掉', async () => {
  for (const bad of ['{不是 json', '[]', '{"sessions":[]}', '{"v":1}']) {
    const s = setup({ sessions: ['asn-甲'], pending: [op('1', '甲')] })
    fs.writeFileSync(s.file, bad)
    await s.p.pull()
    assert.deepEqual(s.tmux.kills(), [], bad)
    assert.deepEqual(s.posted, [{ id: '1', status: 'failed', detail: REGISTRY_BAD }], bad)
    assert.equal(fs.readFileSync(s.file, 'utf8'), bad)
  }
})

test('記錄裡的 session 名和名字對不上（被人手改過）不算數', async () => {
  const s = setup({ sessions: ['asn-甲', 'asn-乙'], pending: [op('1', '乙')] })
  writeRegistry(s.file, { 'asn-乙': { name: '甲', at: 1 }, 'asn-甲': { name: '甲', at: 1 } })
  await s.p.pull()
  assert.deepEqual(s.tmux.kills(), [])
  assert.equal(s.posted[0].detail, NOT_OURS)
})

test('kill 後 tmux 裡還在：回報失敗，記錄不拿掉', async () => {
  const s = setup({ sessions: ['asn-甲'], recorded: ['甲'], killFails: true, pending: [op('1', '甲')] })
  await s.p.pull()
  assert.equal(s.posted[0].status, 'failed')
  assert.match(s.posted[0].detail, /沒有關掉/)
  assert.deepEqual(Object.keys(readRegistry(s.file).sessions), ['asn-甲'])
})

test('同一個待辦不重複處理；同一個視窗同時兩個操作，後一個回報忙', async () => {
  const s = setup({ sessions: ['asn-甲'], recorded: ['甲'], pending: [op('1', '甲'), op('1', '甲')] })
  await s.p.pull()
  assert.equal(s.posted.length, 1)
})

test('後台沒有這個動作（404）：停用，之後不再問；其他錯誤不停用', async () => {
  let calls = 0
  const e404 = Object.assign(new Error('x'), { status: 404 })
  const p = createTmuxPartners({ api: async () => { calls++; throw e404 }, log: () => {}, file: path.join(tmp(), 'f.json'), mailboxName: 'm', allowed: () => true })
  await p.pull(); await p.pull()
  assert.equal(calls, 1)
  let c2 = 0
  const p2 = createTmuxPartners({ api: async () => { c2++; throw Object.assign(new Error('x'), { status: 500 }) }, log: () => {}, file: path.join(tmp(), 'f.json'), mailboxName: 'm', allowed: () => true })
  await p2.pull(); await p2.pull()
  assert.equal(c2, 2)
})

test('每輪順手把已經不存在的 session 從記錄拿掉；活著的留著；記錄壞了不動', async () => {
  const s = setup({ sessions: ['asn-甲'], recorded: ['甲', '乙'] })
  await s.p.pull()
  assert.deepEqual(Object.keys(readRegistry(s.file).sessions), ['asn-甲'])
  assert.deepEqual(s.tmux.kills(), [])
  const bad = setup({ sessions: [] })
  fs.writeFileSync(bad.file, 'xx')
  await bad.p.pull()
  assert.equal(fs.readFileSync(bad.file, 'utf8'), 'xx')
})

test('記錄檔原子寫入（不留暫存檔）、檔案不存在視為空', () => {
  const dir = tmp()
  const file = path.join(dir, 'nested', 'tmux-opened.json')
  assert.deepEqual(readRegistry(file), { ok: true, sessions: {} })
  recordOpened(file, '甲', 5)
  recordOpened(file, '乙', 6)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['tmux-opened.json'])
  assert.deepEqual(readRegistry(file).sessions, { 'asn-甲': { name: '甲', at: 5 }, 'asn-乙': { name: '乙', at: 6 } })
})

test('開 tmux 視窗成功時，launcher 會把 session 名交給 onTmuxOpened；不是 tmux 開的不記', async () => {
  const dir = tmp()
  const cfg = path.join(dir, 'launcher.json')
  fs.writeFileSync(cfg, JSON.stringify({ profiles: { p: { engine: 'claude', command: 'claude', args: [] } }, cwd_allow: [dir], max_per_hour: 5 }))
  const run = async startRet => {
    const opened = []
    let asked = 0
    const launcher = createLauncher({
      api: async (action) => (action === 'launch_pending' ? { launches: [{ id: 'L1', name: '新夥伴', profile: 'p', cwd: dir, requested_by: 'W' }] } : { ok: true }),
      log: () => {}, workDir: dir, configPath: cfg, listNames: async () => new Set(++asked > 1 ? ['新夥伴'] : []), start: async () => startRet,
      onTmuxOpened: (n, s) => opened.push([n, s]), confirmMs: 50, lateMs: 500, pollMs: 10,
    })
    await launcher.pull()
    await new Promise(r => setTimeout(r, 200))
    return opened
  }
  assert.deepEqual(await run({ pid: 5, tmux: 'asn-新夥伴' }), [['新夥伴', 'asn-新夥伴']])
  assert.deepEqual(await run({ pid: 5 }), [])
})
