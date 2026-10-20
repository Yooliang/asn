// 即時分派守望：分類、合批叫醒、重啟不重複、webhook 失敗仍跑、純輪詢
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {
  classifyMail, createDispatchWatcher, postWake, redactSecrets, resolveDispatchPaths,
} from '../dispatch-watch.mjs'
import { appendLineDurable, ensureDir, readJsonl } from '../lib.mjs'
import { rm, tmpEnv } from './helpers.mjs'

const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function mail(id, { to_agent, body, from_node = 'w02', from_agent = '工作機' } = {}) {
  return { id: U(id), from_node, from_agent, to_agent, body: body ?? `信${id}`, expects_reply: true, created_at: '2026-01-01T00:00:00Z' }
}

async function startWakeServer() {
  const posts = []
  const srv = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch {}
      posts.push({ auth: req.headers.authorization, body })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ runUuid: 'test-run-uuid-abc' }))
    })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address()
  return {
    url: `http://127.0.0.1:${port}/wake`,
    posts,
    close: () => new Promise((res, rej) => srv.close(e => (e ? rej(e) : res()))),
  }
}

function dispatchEnv(base, extra = {}) {
  const state = path.join(base.root, 'dispatch-state')
  return {
    ...base.env,
    IRORI_DISPATCH_STATE_DIR: state,
    IRORI_DISPATCH_NO_WATCH: '1',
    IRORI_DISPATCH_POLL_MS: '5000',
    IRORI_DISPATCH_DEBOUNCE_MS: '10',
    IRORI_DISPATCH_FORWARD: '夥伴甲,夥伴乙',
    IRORI_DISPATCH_SELF: '助手',
    ...extra,
  }
}

function fileLogger(logFile) {
  return msg => {
    ensureDir(path.dirname(logFile))
    fs.appendFileSync(logFile, msg + '\n', { mode: 0o600 })
  }
}

test('classifyMail：forward／self／未知收件人與 needs-user-approval 旗標', () => {
  const { cfg, root } = tmpEnv('http://127.0.0.1:1')
  const forward = new Set(['夥伴甲'])
  const self = new Set([cfg.name, cfg.node, '助手'])
  try {
    const f = classifyMail(mail(1, { to_agent: '夥伴甲', body: '一般' }), { cfg, forward, self })
    assert.equal(f.class, 'forward')
    assert.deepEqual(f.flags, [])
    const s = classifyMail(mail(2, { to_agent: null }), { cfg, forward, self })
    assert.equal(s.class, 'self')
    const u = classifyMail(mail(3, { to_agent: '陌生人' }), { cfg, forward, self })
    assert.equal(u.class, 'self-unknown-addressee')
    const nas = classifyMail(mail(4, { to_agent: '助手', body: '請刪除 NAS 上的備份' }), { cfg, forward, self })
    assert.ok(nas.flags.includes('needs-user-approval'))
    assert.ok(nas.flags.includes('nas'))
    assert.ok(nas.flags.includes('delete'))
  } finally { rm(root) }
})

test('同一批兩封信只 POST 一次 webhook，Bearer 正確', async () => {
  const wake = await startWakeServer()
  const t = tmpEnv('http://127.0.0.1:1')
  const env = dispatchEnv(t, {
    IRORI_WAKE_ENABLE: '1',
    IRORI_WAKE_WEBHOOK_URL: wake.url,
    IRORI_WAKE_WEBHOOK_KEY: 'test-wake-secret-key',
  })
  const cfg = t.cfg
  const paths = resolveDispatchPaths(cfg, env)
  fs.mkdirSync(cfg.mailDir, { recursive: true })
  appendLineDurable(cfg.inboxFile, JSON.stringify(mail(1, { to_agent: '夥伴甲' })))
  appendLineDurable(cfg.inboxFile, JSON.stringify(mail(2, { to_agent: '助手' })))
  try {
    const w = createDispatchWatcher({ cfg, env, paths, fetchImpl: globalThis.fetch, log: fileLogger(paths.logFile) })
    const r1 = await w.scan('test')
    assert.equal(r1.fresh.length, 2)
    assert.equal(wake.posts.length, 1)
    assert.equal(wake.posts[0].auth, 'Bearer test-wake-secret-key')
    assert.deepEqual(wake.posts[0].body.ids, [U(1), U(2)])
    assert.equal(wake.posts[0].body.event, 'irori.new_mail')
    const log = fs.readFileSync(paths.logFile, 'utf8')
    assert.ok(log.includes('runUuid=test-run-uuid-abc'))
    assert.ok(!log.includes('test-wake-secret-key'))
    assert.ok(!log.includes(wake.url))
  } finally { await wake.close(); rm(t.root) }
})

test('重啟後已 seen 的信不重複 pending', async () => {
  const t = tmpEnv('http://127.0.0.1:1')
  const env = dispatchEnv(t, { IRORI_WAKE_ENABLE: '0' })
  const cfg = t.cfg
  const paths = resolveDispatchPaths(cfg, env)
  fs.mkdirSync(cfg.mailDir, { recursive: true })
  appendLineDurable(cfg.inboxFile, JSON.stringify(mail(1, { to_agent: '夥伴甲' })))
  try {
    const w1 = createDispatchWatcher({ cfg, env, paths, log: fileLogger(paths.logFile) })
    await w1.scan('a')
    assert.equal(readJsonl(paths.pendingFile).length, 1)
    const w2 = createDispatchWatcher({ cfg, env, paths, log: fileLogger(paths.logFile) })
    w2.loadSeenFromDisk()
    const r2 = await w2.scan('b')
    assert.equal(r2.fresh.length, 0)
    assert.equal(readJsonl(paths.pendingFile).length, 1)
  } finally { rm(t.root) }
})

test('webhook  unreachable 時 scan 仍完成、log 不含秘密', async () => {
  const t = tmpEnv('http://127.0.0.1:1')
  const env = dispatchEnv(t, {
    IRORI_WAKE_ENABLE: '1',
    IRORI_WAKE_WEBHOOK_URL: 'http://127.0.0.1:1/nope',
    IRORI_WAKE_WEBHOOK_KEY: 'key-never-logged-xyz',
  })
  const cfg = t.cfg
  const paths = resolveDispatchPaths(cfg, env)
  fs.mkdirSync(cfg.mailDir, { recursive: true })
  appendLineDurable(cfg.inboxFile, JSON.stringify(mail(1, { to_agent: null })))
  try {
    const w = createDispatchWatcher({ cfg, env, paths, log: fileLogger(paths.logFile) })
    const r = await w.scan('test')
    assert.equal(r.fresh.length, 1)
    const log = fs.readFileSync(paths.logFile, 'utf8')
    assert.ok(/wake POST failed/.test(log))
    assert.ok(!log.includes('key-never-logged-xyz'))
  } finally { rm(t.root) }
})

test('純輪詢模式（NO_WATCH）補抓到新 append 的信', async () => {
  const t = tmpEnv('http://127.0.0.1:1')
  const env = dispatchEnv(t, { IRORI_WAKE_ENABLE: '0' })
  const cfg = t.cfg
  const paths = resolveDispatchPaths(cfg, env)
  fs.mkdirSync(cfg.mailDir, { recursive: true })
  const w = createDispatchWatcher({ cfg, env, paths, log: fileLogger(paths.logFile) })
  w.loadSeenFromDisk()
  try {
    assert.equal((await w.scan('poll')).fresh.length, 0)
    appendLineDurable(cfg.inboxFile, JSON.stringify(mail(9, { to_agent: '夥伴乙' })))
    const r = await w.scan('poll')
    assert.equal(r.fresh.length, 1)
    assert.equal(r.fresh[0].class, 'forward')
  } finally { rm(t.root) }
})

test('redactSecrets 會遮 webhook 金鑰', () => {
  const env = { IRORI_WAKE_WEBHOOK_KEY: 'super-secret-value-12345' }
  assert.equal(redactSecrets('prefix super-secret-value-12345 suffix', env), 'prefix [redacted] suffix')
})

test('postWake 缺秘密只回 skipped', async () => {
  assert.deepEqual(await postWake([{ id: 'x', preview: '' }], { IRORI_WAKE_ENABLE: '1' }), { skipped: 'secrets-missing' })
})
