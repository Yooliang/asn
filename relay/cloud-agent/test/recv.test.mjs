// 收信核心：寫成功才 ack、寫失敗不 ack、去重、roster、403 只記一次、整支常駐程式的煙霧測試
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createReceiver } from '../recv.mjs'
import { acquirePidLock, isOurProcess, readJsonl } from '../lib.mjs'
import { startFakeRelay, U } from './fake-relay.mjs'
import { apiFor, childEnv, rm, script, sleep, tmpEnv } from './helpers.mjs'

test('收信：先寫 inbox.jsonl（含內容）才 ack；ack 當下檔案裡已經有這封信', async () => {
  let seenAtAck = null
  let cfgRef
  const st = await startFakeRelay({ onAck: ids => { seenAtAck = ids.map(id => readJsonl(cfgRef.inboxFile).some(m => m.id === id)) } })
  const { root, cfg } = tmpEnv(st.url); cfgRef = cfg
  try {
    st.mail(1, { expects_reply: false }); st.mail(2, { body: '第二封', reply_to: U(77) })
    const rx = createReceiver({ api: apiFor(cfg), cfg, log: () => {} })
    await rx.pull('test')
    assert.deepEqual(seenAtAck, [true, true], 'ack 時信已在檔案裡')
    const rows = readJsonl(cfg.inboxFile)
    assert.deepEqual(rows.map(r => r.id), [U(1), U(2)])
    assert.equal(rows[1].body, '第二封'); assert.equal(rows[1].reply_to, U(77)); assert.equal(rows[0].expects_reply, false)
    assert.deepEqual(st.acks, [[U(1), U(2)]]); assert.ok(st.mails.every(m => m.acked))
  } finally { await st.close(); rm(root) }
})

test('寫檔失敗：不 ack、信留在收發室信箱；修好後下一次補拉就收到並 ack', async () => {
  const st = await startFakeRelay()
  const { root, cfg } = tmpEnv(st.url)
  const logs = []
  try {
    st.mail(1)
    fs.mkdirSync(cfg.mailDir, { recursive: true })
    const rx = createReceiver({ api: apiFor(cfg), cfg, log: m => logs.push(m) })
    fs.mkdirSync(cfg.inboxFile)   // 啟動後 inbox.jsonl 變成資料夾：開檔一定失敗，Windows 也一樣
    await rx.pull('test')
    assert.equal(st.acks.length, 0, '寫失敗不能 ack')
    assert.equal(st.mails[0].acked, false)
    assert.ok(logs.some(l => l.includes('inbox write failed')))
    fs.rmdirSync(cfg.inboxFile)   // 「修好」
    await rx.pull('retry')
    assert.deepEqual(readJsonl(cfg.inboxFile).map(m => m.id), [U(1)])
    assert.deepEqual(st.acks, [[U(1)]])
  } finally { await st.close(); rm(root) }
})

test('去重：同一封重複送到只寫一行；重啟後（從檔案重建）也不重寫，但照樣 ack', async () => {
  const st = await startFakeRelay()
  const { root, cfg } = tmpEnv(st.url)
  try {
    const m = st.mail(1)
    const rx = createReceiver({ api: apiFor(cfg), cfg, log: () => {} })
    await rx.pull('a')
    m.acked = false   // 假裝上次 ack 的回應遺失：信又出現在 inbox
    await rx.pull('b')
    assert.equal(readJsonl(cfg.inboxFile).length, 1)
    assert.equal(st.acks.length, 2, '重複的信仍要 ack，不然會永遠卡在信箱')
    m.acked = false
    const rx2 = createReceiver({ api: apiFor(cfg), cfg, log: () => {} })   // 模擬環境重置後重啟
    await rx2.pull('c')
    assert.equal(readJsonl(cfg.inboxFile).length, 1)
    assert.equal(st.acks.length, 3)
  } finally { await st.close(); rm(root) }
})

test('上次寫到一半被殺（檔尾沒換行）：下一封不會黏在半行後面', async () => {
  const st = await startFakeRelay()
  const { root, cfg } = tmpEnv(st.url)
  try {
    fs.mkdirSync(cfg.mailDir, { recursive: true })
    fs.writeFileSync(cfg.inboxFile, '{"id":"half')
    st.mail(1)
    const rx = createReceiver({ api: apiFor(cfg), cfg, log: () => {} })
    await rx.pull('t')
    assert.deepEqual(readJsonl(cfg.inboxFile).map(m => m.id), [U(1)])
  } finally { await st.close(); rm(root) }
})

test('roster 回報內容：一個視窗 Grok／idle／engine grok／cwd_label grok-cloud；名稱可用環境變數改', async () => {
  const st = await startFakeRelay()
  const a = tmpEnv(st.url), b = tmpEnv(st.url, { IRORI_CLOUD_ROSTER_NAME: 'Grok-2' })
  try {
    await createReceiver({ api: apiFor(a.cfg), cfg: a.cfg, log: () => {} }).rosterOnce()
    await createReceiver({ api: apiFor(b.cfg), cfg: b.cfg, log: () => {} }).rosterOnce()
    assert.deepEqual(st.rosters[0], { agents: [{ name: 'Grok', status: 'idle', engine: 'grok', cwd_label: 'grok-cloud' }], used_legacy_env: [] }, '沒傳就送空陣列（一律帶）')
    assert.equal(st.rosters[1].agents[0].name, 'Grok-2')
  } finally { await st.close(); rm(a.root); rm(b.root) }
})

test('roster 403：只記一次 log、期間不再重試；過了重試期才再試一次；恢復後記一行', async () => {
  const st = await startFakeRelay({ rosterStatus: 403 })
  const { root, cfg } = tmpEnv(st.url)
  const logs = []
  let t = 1_000_000
  try {
    const rx = createReceiver({ api: apiFor(cfg), cfg, log: m => logs.push(m), now: () => t })
    for (let i = 0; i < 5; i++) { await rx.rosterOnce(); t += 60_000 }   // 5 分鐘、每分鐘一次
    assert.equal(st.rosters.length, 1, '403 之後不再轟炸')
    assert.equal(logs.filter(l => l.includes('403')).length, 1)
    t += cfg.rosterRetryAfter403Ms
    await rx.rosterOnce()
    assert.equal(st.rosters.length, 2, '重試期過了才再試')
    assert.equal(logs.filter(l => l.includes('403')).length, 1, '再被拒也不重複記')
    st.rosterStatus = 200; t += cfg.rosterRetryAfter403Ms
    assert.equal(await rx.rosterOnce(), true)
    assert.ok(logs.some(l => l.includes('roster ok again')))
  } finally { await st.close(); rm(root) }
})

test('常駐程式煙霧測試：收到信寫進 inbox.jsonl 並 ack、回報 roster、第二個執行個體 exit 3；只關自己的 PID', async () => {
  const st = await startFakeRelay()
  const { root, env, cfg } = tmpEnv(st.url, { IRORI_RELAY_KEY: 'fake-grok-node-key', IRORI_RECV_POLL_MS: '200', IRORI_ROSTER_MS: '200' })
  // tmpEnv 已把舊名複製到新名；拿掉 ASN_ROSTER_MS 讓這一個只剩舊名，名單的 used_legacy_env 應該列出它
  const { ASN_ROSTER_MS: _dropped, ...legacyOnly } = env
  const spawnRecv = () => spawn(process.execPath, [script('recv.mjs')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv(legacyOnly) })
  const c = spawnRecv()
  let out = ''; c.stdout.on('data', d => (out += d)); c.stderr.on('data', d => (out += d))
  try {
    st.mail(1)
    for (let i = 0; i < 50 && !st.mails[0].acked; i++) await sleep(100)
    assert.equal(st.mails[0].acked, true, out)
    assert.deepEqual(readJsonl(cfg.inboxFile).map(m => m.id), [U(1)])
    assert.ok(st.rosters.length >= 1)
    // used_legacy_env（F4 PR-2）：只有舊名的 IRORI_ROSTER_MS 列出；新舊名都有的（IRORI_RECV_POLL_MS）不列；只有名字，不含值
    const used = st.rosters[0].used_legacy_env
    assert.deepEqual(used, ['IRORI_ROSTER_MS'], JSON.stringify(used))
    assert.ok(!JSON.stringify(st.rosters[0]).includes('fake-grok-node-key'), '名單不含金鑰值')
    assert.equal(Number(fs.readFileSync(cfg.pidFile, 'utf8')), c.pid)
    const second = spawnRecv()
    const code = await new Promise(r => second.on('close', r))
    assert.equal(code, 3)
    assert.ok(!out.includes('fake-grok-node-key'))
    assert.ok(!fs.readFileSync(cfg.logFile, 'utf8').includes('fake-grok-node-key'), 'log 不含金鑰')
  } finally {
    const closed = new Promise(r => c.on('close', r))
    c.kill()   // 只結束自己啟動的那個（記下的 PID）
    await closed
    await st.close(); rm(root)
  }
})

test('常駐啟動：新舊環境變數衝突寫入 recv.log（只記變數名、不含衝突值）', async () => {
  const st = await startFakeRelay()
  const secretOld = 'https://old-backend.example/functions/v1/relay'
  const { root, env, cfg } = tmpEnv(st.url, {
    ASN_RELAY_KEY: 'fake-grok-node-key',
    IRORI_RELAY_URL: secretOld,
    ASN_RECV_POLL_MS: '600000',
    ASN_ROSTER_MS: '600000',
  })
  const c = spawn(process.execPath, [script('recv.mjs')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv(env) })
  try {
    for (let i = 0; i < 30 && !fs.existsSync(cfg.logFile); i++) await sleep(50)
    const logText = fs.existsSync(cfg.logFile) ? fs.readFileSync(cfg.logFile, 'utf8') : ''
    assert.ok(logText.includes('ASN_RELAY_URL') && logText.includes('以 ASN_RELAY_URL 為準'))
    assert.ok(!logText.includes(secretOld))
  } finally {
    const closed = new Promise(r => c.on('close', r))
    c.kill()
    await closed
    await st.close()
    rm(root)
  }
})

test('pid 檔過期（同一個 pid 現在是無關程序）：視為沒人在跑，照常取得鎖', () => {
  if (!fs.existsSync(`/proc/${process.pid}/cmdline`)) return   // 沒有 /proc（Windows／macOS）只能看活不活，略過
  assert.equal(isOurProcess(process.pid, 'recv.mjs'), false)
  const { root } = tmpEnv('http://127.0.0.1:1')
  try {
    const f = path.join(root, 'recv.pid'); fs.writeFileSync(f, String(process.ppid))
    assert.equal(acquirePidLock(f, 'definitely-not-this-process.mjs'), true)
  } finally { rm(root) }
})

test('roster：usedLegacyEnv 排序去重後放頂層，不放每位代理；改傳入的陣列不影響已送內容', async () => {
  const st = await startFakeRelay()
  const { root, cfg } = tmpEnv(st.url)
  try {
    const names = ['IRORI_RELAY_URL', 'IRORI_RELAY_ID', 'IRORI_RELAY_URL']
    const rx = createReceiver({ api: apiFor(cfg), cfg, log: () => {}, usedLegacyEnv: names })
    names.push('IRORI_X')
    await rx.rosterOnce()
    assert.deepEqual(st.rosters[0].used_legacy_env, ['IRORI_RELAY_ID', 'IRORI_RELAY_URL'])
    assert.ok(st.rosters[0].agents.every(a => !('used_legacy_env' in a)))
  } finally { await st.close(); rm(root) }
})
