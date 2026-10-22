// send.mjs（後端欄位、旗標檢查）與 inbox.mjs（未讀／已處理）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { startFakeRelay, U } from './fake-relay.mjs'
import { run, rm, tmpEnv } from './helpers.mjs'

const KEY = { IRORI_RELAY_KEY: 'fake-grok-node-key' }

test('send：後端欄位（to_node／to_agent／body／reply_to／from_agent／expects_reply）、預設 from=Grok、stdin 內文', async () => {
  const st = await startFakeRelay()
  const { root, env } = tmpEnv(st.url, KEY)
  try {
    const r = await run('send.mjs', ['--to', 'W/W-政策', '--body', '-', '--reply', '--reply-to', U(5)], { env, stdin: '你好\n第二行\n\n' })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^sent id=\S+ to=W\/W-政策 from=grok\/Grok/)
    assert.deepEqual(st.sent[0], { to_node: 'W', to_agent: 'W-政策', body: '你好\n第二行', reply_to: U(5), from_agent: 'Grok', expects_reply: true })
    assert.equal(st.reqs.at(-1).key, 'fake-grok-node-key')
    const r2 = await run('send.mjs', ['--to', 'H', '--body', '告知', '--no-reply', '--from', 'Grok-2'], { env: { ...env, IRORI_CLOUD_AGENTS: 'Grok,Grok-2' } })
    assert.equal(r2.code, 0)
    assert.deepEqual(st.sent[1], { to_node: 'H', body: '告知', from_agent: 'Grok-2', expects_reply: false })
    assert.ok(!(r.stdout + r.stderr + r2.stdout + r2.stderr).includes('fake-grok-node-key'))
  } finally { await st.close(); rm(root) }
})

test('send：沒說要不要回信／兩個都給／--reply-to 不是 uuid／寄給自己／空內文 → exit 1 且不連線', async () => {
  const st = await startFakeRelay()
  const { root, env } = tmpEnv(st.url, KEY)
  try {
    for (const args of [
      ['--to', 'W', '--body', 'x'],
      ['--to', 'W', '--body', 'x', '--reply', '--no-reply'],
      ['--to', 'W', '--body', 'x', '--reply', '--reply-to', 'abc'],
      ['--to', 'grok', '--body', 'x', '--reply'],
      ['--to', 'W', '--body', '', '--reply'],
    ]) assert.equal((await run('send.mjs', args, { env })).code, 1, args.join(' '))
    assert.equal(st.sent.length, 0)
  } finally { await st.close(); rm(root) }
})

test('send：沒有金鑰 exit 2；後端拒絕 exit 4 且不印金鑰', async () => {
  const st = await startFakeRelay()
  const { root, env } = tmpEnv(st.url)
  try {
    assert.equal((await run('send.mjs', ['--to', 'W', '--body', 'x', '--no-reply'], { env })).code, 2)
    const bad = await run('send.mjs', ['--to', 'W', '--body', 'x', '--no-reply'], { env: { ...env, IRORI_RELAY_KEY: 'wrong' } })
    assert.equal(bad.code, 4); assert.ok(!bad.stderr.includes('wrong'))
  } finally { await st.close(); rm(root) }
})

test('inbox：預設只列未處理；--done 後消失；--all 還看得到；前綴、重複、找不到', async () => {
  const st = await startFakeRelay()
  const { root, env, cfg } = tmpEnv(st.url)
  try {
    fs.mkdirSync(cfg.mailDir, { recursive: true })
    const row = (n, extra = {}) => JSON.stringify({ id: U(n), from_node: 'W', from_agent: 'W-政策', body: `信${n}`, expects_reply: true, created_at: 'T', ...extra })
    fs.writeFileSync(cfg.inboxFile, [row(1), row(2, { expects_reply: false }), row(3)].join('\n') + '\n')
    let r = await run('inbox.mjs', ['--unread'], { env })
    assert.equal(r.code, 0)
    for (const n of [1, 2, 3]) assert.ok(r.stdout.includes(`信${n}`))
    assert.ok(r.stdout.includes('只是告知') && r.stdout.includes('要回信'))
    r = await run('inbox.mjs', ['--done', U(2)], { env })
    assert.equal(r.code, 0); assert.match(r.stdout, /done /)
    assert.equal(JSON.parse(fs.readFileSync(cfg.doneFile, 'utf8').trim()).id, U(2))
    r = await run('inbox.mjs', [], { env })
    assert.ok(!r.stdout.includes('信2') && r.stdout.includes('信1') && r.stdout.includes('信3'))
    r = await run('inbox.mjs', ['--all'], { env })
    assert.ok(r.stdout.includes('[已處理]') && r.stdout.includes('信2'))
    assert.equal((await run('inbox.mjs', ['--done', U(2)], { env })).stdout.includes('早就標過'), true)
    assert.equal(fs.readFileSync(cfg.doneFile, 'utf8').trim().split('\n').length, 1, '重複標記不重複寫')
    assert.equal((await run('inbox.mjs', ['--done', U(1).slice(0, 8)], { env })).code, 1, '前綴不唯一')
    assert.equal((await run('inbox.mjs', ['--done', U(9)], { env })).code, 1)
    r = await run('inbox.mjs', ['--json'], { env })
    assert.deepEqual(r.stdout.trim().split('\n').map(l => JSON.parse(l).id), [U(1), U(3)])
    await run('inbox.mjs', ['--done', U(1), U(3)], { env })
    assert.match((await run('inbox.mjs', ['--unread'], { env })).stdout, /沒有未處理/)
  } finally { await st.close(); rm(root) }
})

test('send：--to 本人位址 u:xxxxxxxxxxxx 放行（與節點無關）；格式不對的 u: 位址仍擋', async () => {
  const st = await startFakeRelay()
  const { root, env } = tmpEnv(st.url, KEY)
  try {
    const r = await run('send.mjs', ['--to', 'u:3cda66252c34', '--body', '收到', '--no-reply', '--reply-to', U(5)], { env })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(st.sent[0].to_node, 'u:3cda66252c34')
    for (const bad of ['u:3CDA66252C34', 'u:3cda6625', 'u:zzzzzzzzzzzz']) {
      assert.equal((await run('send.mjs', ['--to', bad, '--body', 'x', '--no-reply'], { env })).code, 1, bad)
    }
    assert.equal(st.sent.length, 1)
  } finally { await st.close(); rm(root) }
})

test('inbox：本人的信 from= 是人代號、第二行是寄件人說明；舊信（沒有說明欄位）照舊、不含節點代號 XISU', async () => {
  const st = await startFakeRelay()
  const { root, env, cfg } = tmpEnv(st.url)
  try {
    fs.mkdirSync(cfg.mailDir, { recursive: true })
    const rows = [
      { id: U(1), from_node: 'XISU', from_agent: 'u:3cda66252c34', trust: 'owner', body: '本人說', expects_reply: true, created_at: 'T', sender_display: '小良', sender_device: 'Oppo 手機' },
      { id: U(2), from_node: 'W', from_agent: 'W-政策', trust: 'member', body: '成員說', expects_reply: false, created_at: 'T' },
    ]
    fs.writeFileSync(cfg.inboxFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    const r = await run('inbox.mjs', ['--all'], { env })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /from=u:3cda66252c34 \(要回信\)[^\n]*\n寄件人：小良（本人，帳號簽章已驗證，從「Oppo 手機」寄出）\n本人說/)
    assert.match(r.stdout, /from=W\/W-政策 \(只是告知\)[^\n]*\n寄件人：W-政策（成員身分）\n成員說/)
    assert.ok(!r.stdout.includes('XISU'))
  } finally { await st.close(); rm(root) }
})
