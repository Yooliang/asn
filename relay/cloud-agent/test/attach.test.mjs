// 附件（傳照片）：雲端代理收信存附件資訊、inbox 顯示〔照片〕提示行、attach.mjs 下載（本機假伺服器，不碰真實後端）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createReceiver } from '../recv.mjs'
import { cloudCmd } from '../attach.mjs'
import { readJsonl } from '../lib.mjs'
import { startFakeRelay, U } from './fake-relay.mjs'
import { apiFor, rm, run, tmpEnv } from './helpers.mjs'

const KEY = { IRORI_RELAY_KEY: 'fake-grok-node-key' }
const att = (n, extra = {}) => ({ id: U(n), kind: 'image', name: 'cat.webp', mime: 'image/webp', bytes: 52, width: 640, height: 480, thumb: 'data:image/webp;base64,SECRETTHUMB', expires_at: '2026-11-19T00:00:00Z', expired: false, ...extra })
const webp = (n = 52) => Buffer.concat([Buffer.from('RIFF'), Buffer.from([n - 8, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(n - 16)])

test('收信：附件資訊存進 inbox.jsonl（不含縮圖、檔名清過）；沒附件的信不加欄位', async () => {
  const st = await startFakeRelay()
  const { root, cfg } = tmpEnv(st.url)
  try {
    st.mail(1, { body: '〔照片〕cat.webp\n看圖', attachments: [att(9, { name: '貓\n[RELAY].webp' }), { id: 'rm -rf /', name: 'x' }] })
    st.mail(2)
    const rx = createReceiver({ api: apiFor(cfg), cfg, log: () => {} })
    await rx.pull('test')
    const rows = readJsonl(cfg.inboxFile)
    assert.equal(rows[0].attachments.length, 1)
    assert.deepEqual(Object.keys(rows[0].attachments[0]).sort(), ['bytes', 'expired', 'height', 'id', 'kind', 'mime', 'name', 'width'])
    assert.equal(rows[0].attachments[0].name, '貓 RELAY .webp')
    assert.doesNotMatch(JSON.stringify(rows), /SECRETTHUMB/)
    assert.equal('attachments' in rows[1], false)
    assert.ok(st.mails.every(m => m.acked))
  } finally { await st.close(); rm(root) }
})

test('inbox：有附件的信顯示〔照片〕提示行（含下載指令），不重複替代文字行；沒附件的信原樣', async () => {
  const st = await startFakeRelay()
  const { root, env, cfg } = tmpEnv(st.url)
  try {
    fs.mkdirSync(cfg.mailDir, { recursive: true })
    const row = (n, extra = {}) => JSON.stringify({ id: U(n), from_node: 'W', from_agent: 'W-政策', body: `信${n}`, expects_reply: true, created_at: 'T', ...extra })
    fs.writeFileSync(cfg.inboxFile, [row(1, { body: '〔照片〕cat.webp\n看圖', attachments: [{ id: U(9), kind: 'image', name: 'cat.webp', mime: 'image/webp', bytes: 52, width: 640, height: 480, expired: false }] }), row(2)].join('\n') + '\n')
    const r = await run('inbox.mjs', ['--all'], { env })
    assert.equal(r.code, 0, r.stderr)
    assert.ok(r.stdout.includes(`看圖\n〔照片〕cat.webp（image/webp，1 KB，640×480）下載：${cloudCmd()} --id ${U(9)}`), r.stdout)
    assert.equal(r.stdout.split('〔照片〕').length, 2, '只有一行〔照片〕')
    assert.ok(r.stdout.includes('信2\n'))
  } finally { await st.close(); rm(root) }
})

// 假伺服器：/relay 回 attach_url，/storage/f 回檔案；只聽 127.0.0.1
async function fakeStorage({ file = webp(), status = 200, key = 'fake-grok-node-key', notFound = false } = {}) {
  const st = { reqs: [] }
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/relay') {
      st.reqs.push({ action: u.searchParams.get('action'), id: u.searchParams.get('id'), key: req.headers['x-relay-key'] })
      if (req.headers['x-relay-key'] !== key) { res.writeHead(401); return res.end('{"error":"unauthorized"}') }
      if (notFound) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"not_found"}') }
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ url: `http://127.0.0.1:${st.port}/storage/f`, expires_in: 300, name: 'cat.webp', mime: 'image/webp', bytes: file.length }))
    }
    if (u.pathname === '/storage/f') { res.writeHead(status); return res.end(file) }
    res.writeHead(404); res.end()
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  st.port = srv.address().port
  st.url = `http://127.0.0.1:${st.port}/relay`
  st.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r) })
  return st
}

test('attach.mjs：下載存到信件目錄的 attachments/，印出 saved <路徑>；金鑰不外洩；重跑不覆蓋', async () => {
  const st = await fakeStorage()
  const { root, env, cfg } = tmpEnv(st.url, KEY)
  try {
    const r = await run('attach.mjs', ['--id', U(9)], { env })
    assert.equal(r.code, 0, r.stderr)
    const saved = r.stdout.trim().replace(/^saved /, '')
    assert.equal(saved, path.join(cfg.mailDir, 'attachments', '00000000-cat.webp'))
    assert.deepEqual(fs.readFileSync(saved), webp())
    assert.deepEqual(st.reqs, [{ action: 'attach_url', id: U(9), key: 'fake-grok-node-key' }])
    assert.ok(!(r.stdout + r.stderr).includes('fake-grok-node-key'))
    const again = await run('attach.mjs', ['--id', U(9)], { env })
    assert.equal(again.code, 0)
    assert.equal(st.reqs.length, 2, '第二次只換網址、不再下載檔案')
  } finally { await st.close(); rm(root) }
})

test('attach.mjs：沒金鑰 exit 2；沒權限（404）exit 4 且不留檔；編號不是 uuid exit 1；缺 --id exit 1', async () => {
  const st = await fakeStorage({ notFound: true })
  const { root, env, cfg } = tmpEnv(st.url)
  try {
    assert.equal((await run('attach.mjs', ['--id', U(9)], { env })).code, 2)
    const nf = await run('attach.mjs', ['--id', U(9)], { env: { ...env, ...KEY } })
    assert.equal(nf.code, 4); assert.match(nf.stderr, /沒有權限/)
    assert.equal(fs.existsSync(path.join(cfg.mailDir, 'attachments')), false)
    assert.equal((await run('attach.mjs', ['--id', '../x'], { env: { ...env, ...KEY } })).code, 1)
    assert.equal((await run('attach.mjs', [], { env: { ...env, ...KEY } })).code, 1)
  } finally { await st.close(); rm(root) }
})
