// 遠端開視窗（launcher.mjs）：設定檔檢查、執行前再驗、環境清理、流程（成功／失敗／卡信任確認後補成功／每小時上限），
// 以及 bridge.mjs 端到端（假仲介 launch_pending → 真的經 Start-Process 開「假視窗」→ launch_result、名單附摘要、第一句話經收發室送進新視窗）。
// 執行：node --test relay/machine/test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnTracked } from './spawn-tracked.mjs'
import { fileURLToPath } from 'node:url'
import { buildSpawn, canonicalLaunchCwd, check, childEnv, createLauncher, loadConfig, NAME_RE, quoteArg, summary, TRUST_HINT } from '../launcher.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const MACHINE = path.join(here, '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'irori-launcher-test-'))
const writeJson = (file, j) => { fs.writeFileSync(file, typeof j === 'string' ? j : JSON.stringify(j)); return file }
const uid = n => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`

const CONF = dir => ({
  profiles: { default: { label: '一般（含 Chrome）', command: '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoExit', '-Command', 'claude --dangerously-skip-permissions --chrome -n {name} --remote-control {name}'] } },
  cwd_allow: [dir], max_per_hour: 2,
})

// ------------------------------------------------------------------------ 設定檔
test('loadConfig：沒有檔案＝沒有功能；BOM 可；格式錯回原因', () => {
  const d = tmp()
  try {
    assert.deepEqual(loadConfig(path.join(d, 'nope.json')), { config: null })
    const ok = loadConfig(writeJson(path.join(d, 'a.json'), '\uFEFF' + JSON.stringify(CONF(d))))
    assert.equal(ok.config.max_per_hour, 2)
    assert.deepEqual(Object.keys(ok.config.profiles), ['default'])
    const bad = (j, re) => assert.match(loadConfig(writeJson(path.join(d, 'b.json'), j)).error, re)
    bad('{', /不是合法 JSON/)
    bad({ cwd_allow: [d] }, /缺 profiles/)
    bad({ profiles: {}, cwd_allow: [d] }, /沒有任何 profile/)
    bad({ profiles: { x: { command: 'a', args: ['{cwd}'] } }, cwd_allow: [d] }, /只能用 \{name\}/)
    bad({ profiles: { x: { command: '{name}.exe', args: [] } }, cwd_allow: [d] }, /command 不能含/)
    bad({ profiles: { x: { command: 'a', args: 'b' } }, cwd_allow: [d] }, /字串陣列/)
    bad({ profiles: { 'a b': { command: 'a', args: [] } }, cwd_allow: [d] }, /profile 名不合法/)
    bad({ profiles: { x: { command: 'a', args: [] } }, cwd_allow: [] }, /cwd_allow 是空的/)
    assert.equal(loadConfig(writeJson(path.join(d, 'c.json'), { ...CONF(d), max_per_hour: 999 })).config.max_per_hour, 20)
    assert.equal(loadConfig(writeJson(path.join(d, 'c.json'), { ...CONF(d), max_per_hour: undefined })).config.max_per_hour, 6)
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('summary：上傳給仲介的只有 profile 名／標籤、cwd 白名單、上限，沒有指令', () => {
  const d = tmp()
  try {
    const s = summary(loadConfig(writeJson(path.join(d, 'a.json'), CONF(d))).config)
    assert.deepEqual(s, { profiles: [{ id: 'default', label: '一般（含 Chrome）' }], cwd_allow: [d], max_per_hour: 2 })
    assert.doesNotMatch(JSON.stringify(s), /powershell|claude|skip-permissions/i)
    assert.equal(summary(null), null)
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('check：cwd 白名單會正規化（..）並比對 realpath（符號連結）', () => {
  const d = tmp()
  try {
    const sub = path.join(d, 'proj')
    fs.mkdirSync(sub)
    const link = path.join(d, 'link-proj')
    try { fs.symlinkSync(sub, link, 'dir') } catch { return } // 無權建立 symlink 就略過
    const c = loadConfig(writeJson(path.join(d, 'a.json'), { ...CONF(sub), cwd_allow: [sub] })).config
    assert.equal(check(c, { profile: 'default', name: 'H-英雄-2', cwd: link }), null)
    assert.equal(check(c, { profile: 'default', name: 'H-英雄-2', cwd: path.join(sub, '..', 'proj') }), null)
    assert.match(check(c, { profile: 'default', name: 'H-英雄-2', cwd: path.join(sub, '..') }), /不在允許清單/)
    assert.equal(canonicalLaunchCwd(link), canonicalLaunchCwd(sub))
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('check：執行前再驗 profile、名稱、cwd（白名單＋存在）、重名（不分大小寫）、每小時上限', () => {
  const d = tmp()
  try {
    const c = loadConfig(writeJson(path.join(d, 'a.json'), CONF(d))).config
    const req = { profile: 'default', name: 'H-英雄-2', cwd: d }
    assert.equal(check(c, req), null)
    assert.match(check(null, req), /啟動設定/)
    assert.match(check(c, { ...req, name: '-rf' }), /格式不對/)
    assert.match(check(c, { ...req, name: 'a b' }), /格式不對/)
    assert.match(check(c, { ...req, name: 'a&calc' }), /格式不對/)
    assert.match(check(c, { ...req, profile: 'evil' }), /沒有這個啟動設定/)
    assert.match(check(c, { ...req, profile: 'constructor' }), /沒有這個啟動設定/)
    assert.match(check(c, { ...req, cwd: 'C:\\Windows' }), /不在允許清單/)
    assert.match(check(c, { ...req, cwd: d + '\\..' }), /不在允許清單/)
    const gone = path.join(d, 'gone')
    assert.match(check({ ...c, cwd_allow: [gone] }, { ...req, cwd: gone }), /不存在/)
    assert.match(check(c, req, { names: new Set(['h-英雄-2']) }), /已經有/)
    const now = Date.now()
    assert.match(check(c, req, { recent: [now - 1000, now - 2000], now }), /超過上限/)
    assert.equal(check(c, req, { recent: [now - 3_700_000, now - 1000], now }), null)
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('名稱規則與仲介一致；buildSpawn 只替換 {name}、展開 %VAR%；childEnv 清 CLAUDE_*／NO_COLOR／仲介金鑰', () => {
  for (const ok of ['H-英雄-2', 'a', 'X'.repeat(40)]) assert.ok(NAME_RE.test(ok), ok)
  for (const bad of ['', '-x', 'a b', "a'b", 'a"b', 'a;b', 'a$b', 'a`b', 'X'.repeat(41), 'a{b}']) assert.ok(!NAME_RE.test(bad), bad)
  const env = { SystemRoot: 'C:\\Windows', PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', NO_COLOR: '1', IRORI_RELAY_KEY: 'k', IRORI_RELAY_ANON_KEY: 'a', ASN_RELAY_KEY: 'k2', ASN_RELAY_ANON_KEY: 'a2', IRORI_RELAY_ID: 'H' }
  // 金鑰新舊名都擋；非金鑰的改名變數新舊名都帶
  assert.deepEqual(childEnv(env), { SystemRoot: 'C:\\Windows', PATH: 'p', IRORI_RELAY_ID: 'H', ASN_RELAY_ID: 'H' })
  const d = tmp()
  try {
    const c = loadConfig(writeJson(path.join(d, 'a.json'), CONF(d))).config
    const s = buildSpawn(c, { profile: 'default', name: 'H-英雄-2', cwd: d }, env)
    assert.equal(s.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    assert.deepEqual(s.args, ['-NoExit', '-Command', 'claude --dangerously-skip-permissions --chrome -n H-英雄-2 --remote-control H-英雄-2'])
    assert.equal(s.cwd, d)
    assert.equal(s.env.CLAUDECODE, undefined)
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
  assert.equal(quoteArg('abc'), 'abc')
  assert.equal(quoteArg('a b'), '"a b"')
  assert.equal(quoteArg('say "hi"'), '"say \\"hi\\""')
  assert.equal(quoteArg('C:\\x y\\'), '"C:\\x y\\\\"')
  assert.equal(quoteArg(''), '""')
})

// ------------------------------------------------------------------------ 流程（假 api／假 start）
function harness({ appear = true, appearAfter = 0, names = [], startFails = false } = {}) {
  const d = tmp()
  const cfg = writeJson(path.join(d, 'launcher.json'), CONF(d))
  const results = [], starts = [], launched = [], logs = []
  let pending = []
  const live = new Set(names)
  const api = async (action, opts) => {
    if (action === 'launch_pending') { const out = pending; pending = []; return { launches: out } }
    if (action === 'launch_result') { results.push(opts.body); return { ok: true } }
    throw new Error('unexpected ' + action)
  }
  const start = async s => {
    if (startFails) throw new Error('找不到執行檔')
    starts.push(s)
    const name = s.args.at(-1).split(' ').at(-1)
    if (appear) setTimeout(() => live.add(name), appearAfter)
    return { pid: 4242 }
  }
  const L = createLauncher({
    api, log: m => logs.push(m), workDir: d, configPath: cfg, start, confirmMs: 150, lateMs: 600, pollMs: 20,
    listNames: async () => new Set(live), onLaunched: async l => { launched.push(l.name) },
  })
  return { d, L, results, starts, launched, logs, push: (...ls) => pending.push(...ls), done: () => fs.rmSync(d, { recursive: true, force: true }) }
}
const waitFor = async (f, ms = 3000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await sleep(20); assert.ok(f(), 'condition not reached') }
const req = (n, extra = {}) => ({ id: uid(n), requested_by: 'XISU', profile: 'default', name: `T-${n}`, cwd: null, ...extra })

test('流程：取走 → 開視窗 → 出現在名單 → 回報 ok、呼叫 onLaunched、留紀錄', async () => {
  const h = harness()
  try {
    h.push(req(1, { cwd: h.d }))
    await h.L.pull()
    await waitFor(() => h.results.length === 1)
    assert.deepEqual(h.results[0], { id: uid(1), status: 'ok', detail: 'T-1 已開啟' })
    assert.deepEqual(h.launched, ['T-1'])
    assert.equal(h.starts.length, 1)
    const lines = fs.readFileSync(path.join(h.d, 'launch.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.deepEqual(lines.map(l => l.status), ['spawned', 'ok'])
    assert.equal(lines[0].by, 'XISU')
  } finally { h.done() }
})

test('流程：驗不過就不開（cwd 不在白名單、重名、沒有這個 profile）；同一筆 id 只處理一次', async () => {
  const h = harness({ names: ['T-2'] })
  try {
    h.push(req(1, { cwd: 'C:\\Windows' }), req(2, { cwd: h.d }), req(3, { cwd: h.d, profile: 'evil' }), req(3, { cwd: h.d, profile: 'evil' }))
    await h.L.pull()
    await waitFor(() => h.results.length >= 3)
    await sleep(100)
    assert.equal(h.results.length, 3)
    assert.deepEqual(h.results.map(r => r.status), ['failed', 'failed', 'failed'])
    assert.match(h.results[0].detail, /不在允許清單/)
    assert.match(h.results[1].detail, /已經有/)
    assert.match(h.results[2].detail, /沒有這個啟動設定/)
    assert.equal(h.starts.length, 0)
  } finally { h.done() }
})

test('流程：開不起來回 failed', async () => {
  const h = harness({ startFails: true })
  try {
    h.push(req(1, { cwd: h.d }))
    await h.L.pull()
    await waitFor(() => h.results.length === 1)
    assert.deepEqual([h.results[0].status, h.results[0].detail], ['failed', '開不起來：找不到執行檔'])
  } finally { h.done() }
})

test('流程：太久沒出現先回 unconfirmed（可能卡信任確認），之後出現再補 ok', async () => {
  const h = harness({ appearAfter: 300 })
  try {
    h.push(req(1, { cwd: h.d }))
    await h.L.pull()
    await waitFor(() => h.results.length === 2)
    assert.deepEqual(h.results.map(r => r.status), ['unconfirmed', 'ok'])
    assert.equal(h.results[0].detail, TRUST_HINT)
    assert.deepEqual(h.launched, ['T-1'])
  } finally { h.done() }
})

test('流程：每小時上限（存在 launch-history.json，重啟也算）', async () => {
  const h = harness()
  try {
    fs.writeFileSync(path.join(h.d, 'launch-history.json'), JSON.stringify([Date.now() - 1000]))
    h.push(req(1, { cwd: h.d }), req(2, { cwd: h.d }))
    await h.L.pull()
    await waitFor(() => h.results.length === 2)
    const by = Object.fromEntries(h.results.map(r => [r.id, r]))
    const statuses = [by[uid(1)].status, by[uid(2)].status].sort()
    assert.deepEqual(statuses, ['failed', 'ok'])
    assert.match(h.results.find(r => r.status === 'failed').detail, /超過上限/)
    assert.equal(h.starts.length, 1)
  } finally { h.done() }
})

// ------------------------------------------------------------------------ bridge.mjs 端到端
async function fakeRelay(launches) {
  const st = { results: [], rosterPosts: [], acked: [], pendingCalls: 0 }
  let queue = [...launches]
  const readBody = r => new Promise(res => { let b = ''; r.on('data', c => b += c); r.on('end', () => res(b ? JSON.parse(b) : null)) })
  const srv = http.createServer(async (req, res) => {
    const a = new URL(req.url, 'http://x').searchParams.get('action')
    const out = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (a === 'whoami') return out(200, { node: 'T', bell_topic: 'bell-test' })
    if (a === 'inbox') return out(200, { messages: [] })
    if (a === 'ack') { st.acked.push(...(await readBody(req)).ids); return out(200, { acked: 0 }) }
    if (a === 'roster') { st.rosterPosts.push(await readBody(req)); return out(200, { ok: true, count: 0 }) }
    if (a === 'launch_pending') { st.pendingCalls++; const l = queue; queue = []; return out(200, { launches: l }) }
    if (a === 'launch_result') { st.results.push(await readBody(req)); return out(200, { ok: true }) }
    if (a === 'room_list') return out(200, { rooms: [] })
    out(404, { error: 'not_found' })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  st.port = srv.address().port
  st.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r) })
  return st
}

test('bridge 端到端：launch_pending → Start-Process 開假視窗（參數、資料夾、環境都對）→ ok → 名單附摘要 → 第一句話送進新視窗', { skip: process.platform !== 'win32' && '只在 Windows 跑（Start-Process）' }, async () => {
  const home = tmp()
  const work = path.join(home, 'proj'); fs.mkdirSync(work)
  const st = await fakeRelay([{ id: uid(7), requested_by: 'XISU', profile: 'fake', name: 'T-英雄-2', cwd: work, first_message: '先讀交接檔' }])
  const agentsFile = path.join(home, 'agents.json'), record = path.join(home, 'record.jsonl'), launchedFile = path.join(home, 'launched.jsonl')
  fs.writeFileSync(agentsFile, '[]'); fs.writeFileSync(record, ''); fs.writeFileSync(launchedFile, '')
  fs.mkdirSync(path.join(home, '.irori-relay'), { recursive: true })
  writeJson(path.join(home, '.irori-relay', 'launcher.json'), {
    profiles: { fake: { label: '測試', command: process.execPath, args: [path.join(here, 'fake-launched.mjs'), '{name}', 'claude -n {name} --remote-control {name}'] } },
    cwd_allow: [work], max_per_hour: 3,
  })
  const child = spawnTracked(process.execPath, [path.join(MACHINE, 'bridge.mjs')], {
    cwd: home, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
      IRORI_RELAY_ID: 'T', IRORI_RELAY_KEY: 'fake-test-key', IRORI_LAUNCH_NO_AUTO: '1', IRORI_RELAY_URL: `http://127.0.0.1:${st.port}/relay`,
      IRORI_RELAY_POLL_MS: '300', IRORI_ROSTER_MS: '400', IRORI_LAUNCH_WINDOW_STYLE: 'Hidden', IRORI_LAUNCH_CONFIRM_MS: '20000',
      IRORI_CLAUDE_SCRIPT: path.join(here, 'fake-claude.mjs'), FAKE_AGENTS: agentsFile, FAKE_RECORD: record, FAKE_LAUNCHED: launchedFile,
      CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', NO_COLOR: '1',
    },
  })
  let log = ''; child.stderr.on('data', d => log += d)
  const forwarded = () => fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  try {
    const t0 = Date.now()
    while (!(st.results.some(r => r.status === 'ok') && forwarded().length) && Date.now() - t0 < 25000) await sleep(100)
    assert.deepEqual(st.results.map(r => [r.id, r.status]), [[uid(7), 'ok']], log)
    const got = fs.readFileSync(launchedFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.deepEqual(got, [{ argv: ['T-英雄-2', 'claude -n T-英雄-2 --remote-control T-英雄-2'], cwd: work, leaked: [] }])
    const f = forwarded()
    assert.equal(f.length, 1)
    assert.equal(f[0].id, uid(7)); assert.equal(f[0].to, 'T-英雄-2')
    assert.match(f[0].text, /\[RELAY 來信\] trust=owner from=XISU\/ to=T-英雄-2/)
    assert.match(f[0].text, /先讀交接檔/)
    const withL = st.rosterPosts.filter(p => p.launcher)
    assert.ok(withL.length > 0)
    assert.deepEqual(withL.at(-1).launcher, { profiles: [{ id: 'fake', label: '測試' }], cwd_allow: [work], max_per_hour: 3 })
    assert.doesNotMatch(JSON.stringify(st.rosterPosts), /fake-launched|remote-control/)
    assert.ok(st.rosterPosts.at(-1).agents.some(a => a.name === 'T-英雄-2'), '新視窗要出現在名單上')
    assert.match(fs.readFileSync(path.join(home, '.irori-relay', 'machine-T', 'launch.log'), 'utf8'), /"status":"ok"/)
  } finally {
    child.kill()
    await new Promise(r => child.once('exit', r))
    await sleep(300)
    await st.close()
    try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
  }
})

test('bridge 端到端：沒有 launcher.json → 名單回報 launcher:null（仲介清掉），pending 驗不過回 failed', async () => {
  const home = tmp()
  const st = await fakeRelay([{ id: uid(8), requested_by: 'XISU', profile: 'default', name: 'T-x', cwd: home, first_message: null }])
  const agentsFile = path.join(home, 'agents.json'), record = path.join(home, 'record.jsonl')
  fs.writeFileSync(agentsFile, '[]'); fs.writeFileSync(record, '')
  const child = spawnTracked(process.execPath, [path.join(MACHINE, 'bridge.mjs')], {
    cwd: home, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
      IRORI_RELAY_ID: 'T', IRORI_RELAY_KEY: 'fake-test-key', IRORI_LAUNCH_NO_AUTO: '1', IRORI_RELAY_URL: `http://127.0.0.1:${st.port}/relay`,
      IRORI_RELAY_POLL_MS: '300', IRORI_ROSTER_MS: '300',
      IRORI_CLAUDE_SCRIPT: path.join(here, 'fake-claude.mjs'), FAKE_AGENTS: agentsFile, FAKE_RECORD: record,
    },
  })
  let log = ''; child.stderr.on('data', d => log += d)
  try {
    const t0 = Date.now()
    while (!(st.results.length && st.rosterPosts.length) && Date.now() - t0 < 10000) await sleep(100)
    assert.deepEqual(st.results.map(r => [r.status, r.detail]), [['failed', '這台電腦還沒有可用的啟動設定']], log)
    assert.ok('launcher' in st.rosterPosts[0] && st.rosterPosts[0].launcher === null)
  } finally {
    child.kill()
    await new Promise(r => child.once('exit', r))
    await sleep(300)
    await st.close()
    try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
  }
})
