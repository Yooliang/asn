// 官網技能說明（site/public/skill/asn-cloud-agent.md）的守門測試：文件不會腐爛、不含機密、不要代理拉 repo。
// 從文件抽出參考實作，寫進暫存資料夾，對本機假後端（127.0.0.1）真的跑一遍：寄信、收信後才 ack、金鑰失效時停下來。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

// 非同步執行（假後端跑在同一個程序，不能用 spawnSync 卡住事件迴圈）
const runNode = (args, env) => new Promise(res => {
  const c = spawn(process.execPath, args, { env, windowsHide: true })
  let stdout = '', stderr = ''
  c.stdout.on('data', x => (stdout += x)); c.stderr.on('data', x => (stderr += x))
  c.on('close', status => res({ status, stdout, stderr }))
})
import { fileURLToPath } from 'node:url'
import { startFakeRelay, FAKE_KEY, U } from './fake-relay.mjs'
import { skillVersionInfo } from '../../../site/make-skill-version.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const skillDir = path.join(here, '../../../site/public/skill')
const doc = fs.readFileSync(path.join(skillDir, 'asn-cloud-agent.md'), 'utf8').replace(/\r\n/g, '\n')

// 抽出所有 ```js 區塊；第一行註解的檔名（// lib.mjs：…）就是它要存成的檔
function blocks() {
  const out = {}
  for (const m of doc.matchAll(/```js\n([\s\S]*?)\n```/g)) {
    const name = /^\/\/ (\w+\.mjs)/.exec(m[1])?.[1]
    if (name) out[name] = m[1] + '\n'
  }
  return out
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'skill-doc-test-'))
const install = dir => { for (const [n, src] of Object.entries(blocks())) fs.writeFileSync(path.join(dir, n), src) }
const cleanEnv = extra => {
  const e = { ...process.env, ...extra }
  for (const k of Object.keys(e)) if (/^(ASN|IRORI)_/.test(k) && !(k in extra)) delete e[k]
  return e
}

test('文件：版本與 version.json 一致（改了文件要升版並重跑 node site/make-skill-version.mjs）', () => {
  const info = skillVersionInfo(fs.readFileSync(path.join(skillDir, 'asn-cloud-agent.md'), 'utf8'))
  const saved = JSON.parse(fs.readFileSync(path.join(skillDir, 'version.json'), 'utf8'))
  assert.deepEqual(saved, info)
  assert.match(doc, new RegExp(`\\*\\*版本：${info.version}　`))
  assert.match(doc, /canonical: https:\/\/asnmessenger\.web\.app\/skill\/asn-cloud-agent\.md/)
})

test('文件：金鑰讀 ASN_RELAY_KEY（舊名 IRORI_RELAY_KEY 也認），沒有任何機密樣子的字串', () => {
  assert.ok(doc.includes('ASN_RELAY_KEY') && doc.includes('IRORI_RELAY_KEY'))
  assert.match(doc, /process\.env\['ASN_' \+ n\] \|\| process\.env\['IRORI_' \+ n\]/, '新名優先、舊名照讀')
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(doc), '不放 JWT 樣子的字串')
  assert.ok(!/sb_(secret|publishable)_/.test(doc) && !/service_role['"]?\s*[:=]\s*['"]?[A-Za-z0-9]/.test(doc))
  assert.ok(!/(ASN|IRORI)_RELAY_KEY\s*=\s*['"]?[A-Za-z0-9_-]{8,}/.test(doc), '沒有把金鑰值寫在範例裡')
  assert.ok(!/https:\/\/[a-z0-9]{20}\.supabase\.co/.test(doc), '不內嵌特定後端網址（由邀請說明給）')
})

test('文件：不再要代理拉 repo、裝套件', () => {
  assert.ok(!/git (clone|pull|fetch)|npm (i|install|ci)\b|pip install|拉(取)? ?repo/i.test(doc.replace('不需要拉任何 repo', '')), '不該有拉 repo、裝套件的步驟')
  assert.ok(doc.includes('不需要拉任何 repo'))
  assert.ok(doc.includes('人貼給你的邀請說明怎麼讀') && doc.includes('ASN_RELAY_ID') && doc.includes('ASN_RELAY_URL'))
})

test('參考實作：每個 js 區塊語法正確，必要的檔都在', () => {
  const b = blocks()
  for (const n of ['lib.mjs', 'recv.mjs', 'send.mjs', 'inbox.mjs', 'room.mjs', 'watch.mjs', 'attach.mjs', 'check.mjs']) assert.ok(b[n], `文件裡找不到 ${n}`)
  const d = tmp()
  try {
    install(d)
    for (const n of Object.keys(b)) {
      const r = spawnSync(process.execPath, ['--check', path.join(d, n)], { encoding: 'utf8' })
      assert.equal(r.status, 0, `${n}: ${r.stderr}`)
    }
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('參考實作 send.mjs：用 ASN_ 或舊名 IRORI_ 的金鑰都能寄；金鑰不出現在輸出', async () => {
  const st = await startFakeRelay({ node: 'cloudx' })
  const d = tmp()
  try {
    install(d)
    for (const [prefix, to] of [['ASN_', 'W'], ['IRORI_', 'H']]) {
      const env = cleanEnv({ [prefix + 'CLOUD_HOME']: d, [prefix + 'RELAY_URL']: st.url, [prefix + 'RELAY_ID']: 'cloudx', [prefix + 'RELAY_KEY']: FAKE_KEY })
      const r = await runNode([path.join(d, 'send.mjs'), '--to', to, '--body', '你好', '--no-reply'], env)
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /^sent id=/)
      assert.ok(!(r.stdout + r.stderr).includes(FAKE_KEY))
    }
    assert.deepEqual(st.sent.map(s => [s.to_node, s.body, s.expects_reply]), [['W', '你好', false], ['H', '你好', false]])
    assert.ok(st.reqs.filter(q => q.action === 'send').every(q => q.key === FAKE_KEY))
    // 沒有金鑰：停下來（exit 2）、不連線
    const before = st.reqs.length
    const none = await runNode([path.join(d, 'send.mjs'), '--to', 'W', '--body', 'x', '--no-reply'], cleanEnv({ ASN_CLOUD_HOME: d, ASN_RELAY_URL: st.url, ASN_RELAY_ID: 'cloudx' }))
    assert.equal(none.status, 2)
    assert.equal(st.reqs.length, before)
  } finally { await st.close(); fs.rmSync(d, { recursive: true, force: true }) }
})

test('參考實作 recv.mjs：信先寫進 inbox.jsonl 才 ack；金鑰被撤銷（401）時停下來並留記號', async () => {
  const st = await startFakeRelay({ node: 'cloudx' })
  st.mails.push({ id: U(7), from_node: 'W', from_agent: 'W-政策', to_node: 'cloudx', to_agent: null, body: '測試信', reply_to: null, created_at: new Date().toISOString(), expects_reply: false, trust: 'member' })
  const d = tmp(), d2 = tmp()
  let child = null
  try {
    install(d); install(d2)
    const env = cleanEnv({ ASN_CLOUD_HOME: d, ASN_RELAY_URL: st.url, ASN_RELAY_ID: 'cloudx', ASN_RELAY_KEY: FAKE_KEY, ASN_RECV_POLL_MS: '300' })
    child = spawn(process.execPath, [path.join(d, 'recv.mjs')], { env, stdio: 'ignore', windowsHide: true })
    const inbox = path.join(d, 'inbox.jsonl')
    for (let i = 0; i < 60 && !(fs.existsSync(inbox) && st.acks.length); i++) await sleep(100)
    const rows = fs.readFileSync(inbox, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, U(7))
    assert.equal(rows[0].body, '測試信')
    assert.deepEqual(st.acks[0], [U(7)], '寫進檔案之後才 ack')
    assert.ok(!fs.readFileSync(inbox, 'utf8').includes(FAKE_KEY))
    child.kill()

    // 金鑰錯（例如被撤銷）：whoami 401 → 立刻停下來（exit 5）並留下 recv.halt，不狂打
    const bad = cleanEnv({ ASN_CLOUD_HOME: d2, ASN_RELAY_URL: st.url, ASN_RELAY_ID: 'cloudx', ASN_RELAY_KEY: 'revoked-key-value' })
    const code = await new Promise(res => {
      const c = spawn(process.execPath, [path.join(d2, 'recv.mjs')], { env: bad, stdio: 'ignore', windowsHide: true })
      const t = setTimeout(() => { c.kill(); res('逾時') }, 8000)
      c.on('exit', x => { clearTimeout(t); res(x) })
    })
    assert.equal(code, 5)
    assert.ok(fs.existsSync(path.join(d2, 'recv.halt')))
  } finally { try { child?.kill() } catch {} ; await st.close(); fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true }) }
})
