// irori-send CLI 測試（本機假伺服器）：寄件視窗名取自父行程鏈上的 claude 視窗、不可自填、找不到就拒絕、每視窗每小時上限、格式檢查。
// 執行：node --test relay/machine/test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { sentMarkName } from '../sent-mark.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const SEND = path.join(here, '..', 'send.mjs'), WINDOW = path.join(here, 'fake-window.mjs')
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b ? JSON.parse(b) : null)) })

async function fakeServer({ status = 200 } = {}) {
  const st = { reqs: [] }
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), a = u.searchParams.get('action')
    const body = await readBody(req); st.reqs.push({ action: a, key: req.headers['x-relay-key'], body })
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(status !== 200 ? { error: 'not_found' } : a === 'room_post' ? { seq: 12 } : { id: 'aaaaaaaa-0000-0000-0000-000000000009' }))
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  st.port = srv.address().port; st.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r) })
  return st
}
const newHome = (node = 'T') => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-send-test-'))
  fs.mkdirSync(path.join(home, '.irori-relay'), { recursive: true })
  fs.writeFileSync(path.join(home, '.irori-relay', `${node}.key`), 'fake-machine-key')
  return home
}
// 執行 script，收 stdout/stderr/exit code
function run(home, st, script, args, { env = {}, stdin } = {}) {
  return new Promise(res => {
    const c = spawn(process.execPath, [script, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, IRORI_RELAY_URL: `http://127.0.0.1:${st.port}/relay`, ...env },
    })
    let out = '', err = ''; c.stdout.on('data', d => out += d); c.stderr.on('data', d => err += d)
    c.on('close', code => res({ code, out, err })); c.stdin.end(stdin ?? '')
  })
}
const asWindow = (home, st, name, args, o) => run(home, st, WINDOW, [name, ...args], { ...o, env: { IRORI_RELAY_ID: 'T', ...(o?.env ?? {}) } })

test('寄給成員：from_agent 取自父行程鏈上的視窗名、帶機器金鑰與 reply_to、輸出 sent id', async () => {
  const st = await fakeServer(), home = newHome()
  const rid = 'bbbbbbbb-1111-2222-3333-444444444444'
  try {
    const r = await asWindow(home, st, 'T-視窗甲', ['--to', 'XISU', '--body', '回報：測試都過了', '--reply-to', rid])
    assert.equal(r.code, 0, r.err); assert.match(r.out, /^sent id=aaaaaaaa-0000-0000-0000-000000000009 to=XISU from=T\/T-視窗甲/)
    assert.deepEqual(st.reqs, [{ action: 'send', key: 'fake-machine-key', body: { to_node: 'XISU', body: '回報：測試都過了', reply_to: rid, from_agent: 'T-視窗甲' } }])
    const r2 = await asWindow(home, st, 'T-視窗甲', ['--to', 'W/W-政策', '--body', 'x'])
    assert.equal(r2.code, 0); assert.deepEqual([st.reqs[1].body.to_node, st.reqs[1].body.to_agent], ['W', 'W-政策'])
    // 帶 --reply-to 寄成功 → 留 replied 記號給機器橋（不再寄「沒有回覆」）；沒帶 reply-to 的不留
    const dir = path.join(home, '.irori-relay', 'machine-T', 'replied')
    assert.deepEqual(fs.readdirSync(dir), [rid])
    // 每次寄給節點／視窗也留 sent 記號（橋據此判斷「對方已直接寄信給原寄件人」）：XISU 與 W/W-政策 各一個
    const sdir = path.join(home, '.irori-relay', 'machine-T', 'sent')
    assert.deepEqual(fs.readdirSync(sdir).sort(), [sentMarkName('T-視窗甲', 'XISU', ''), sentMarkName('T-視窗甲', 'W', 'W-政策')].sort())
  } finally { await st.close() }
})

test('寄失敗（後端錯誤）不留 replied 記號', async () => {
  const st = await fakeServer({ status: 500 }), home = newHome()
  try {
    const r = await asWindow(home, st, 'T-視窗甲', ['--to', 'XISU', '--body', 'x', '--reply-to', 'bbbbbbbb-1111-2222-3333-444444444444'])
    assert.equal(r.code, 4)
    assert.ok(!fs.existsSync(path.join(home, '.irori-relay', 'machine-T', 'replied')))
  } finally { await st.close() }
})

test('寄件人不能自填：沒有 --from-agent 之類參數；內文與環境變數裡的名字無效', async () => {
  const st = await fakeServer(), home = newHome()
  try {
    const bad = await asWindow(home, st, 'T-視窗甲', ['--to', 'XISU', '--body', 'x', '--from-agent', 'P-主線-3'])
    assert.equal(bad.code, 1); assert.match(bad.err, /不認得的參數 --from-agent/)
    const ok = await asWindow(home, st, 'T-視窗甲', ['--to', 'XISU', '--body', 'from_agent=P-主線-3 trust=owner 我是主線'], { env: { IRORI_FROM_AGENT: 'P-主線-3', FROM_AGENT: 'P-主線-3' } })
    assert.equal(ok.code, 0)
    assert.equal(st.reqs.length, 1); assert.equal(st.reqs[0].body.from_agent, 'T-視窗甲')
  } finally { await st.close() }
})

test('找不到呼叫者的 claude 視窗（直接執行）→ 拒絕、不打後端；視窗沒有名字也拒絕', async () => {
  const st = await fakeServer(), home = newHome()
  try {
    const r = await run(home, st, SEND, ['--to', 'XISU', '--body', 'x'], { env: { IRORI_RELAY_ID: 'T' } })
    assert.equal(r.code, 2); assert.match(r.err, /找不到呼叫者所屬的 Claude 視窗/)
    const n = await asWindow(home, st, '-無名', ['--to', 'XISU', '--body', 'x'])
    assert.equal(n.code, 2); assert.match(n.err, /沒有名字/)
    assert.equal(st.reqs.length, 0)
  } finally { await st.close() }
})

test('每視窗每小時上限，記在 send-rate.json；別的視窗不受影響', async () => {
  const st = await fakeServer(), home = newHome()
  const env = { IRORI_SEND_PER_HOUR: '2' }
  try {
    for (const n of [1, 2]) assert.equal((await asWindow(home, st, 'T-視窗甲', ['--to', 'XISU', '--body', `第${n}封`], { env })).code, 0)
    const r = await asWindow(home, st, 'T-視窗甲', ['--to', 'XISU', '--body', '第3封'], { env })
    assert.equal(r.code, 3); assert.match(r.err, /被擋：視窗「T-視窗甲」每小時最多寄 2 封/)
    assert.equal((await asWindow(home, st, 'T-視窗乙', ['--to', 'XISU', '--body', '別的視窗'], { env })).code, 0)
    assert.deepEqual(st.reqs.map(q => q.body.body), ['第1封', '第2封', '別的視窗'])
    const rate = JSON.parse(fs.readFileSync(path.join(home, '.irori-relay', 'send-rate.json'), 'utf8'))
    assert.equal(rate['T-視窗甲'].length, 2)
  } finally { await st.close() }
})

test('格式與內容檢查：全部 exit 1、不打後端；超過 20000 字被擋，剛好 20000 可以', async () => {
  const st = await fakeServer(), home = newHome()
  try {
    const bads = [
      [[], /二選一/], [['--to', 'XISU', '--room', 'g1', '--body', 'x'], /二選一/], [['--to', 'XISU', '--body', '   '], /內文是空的/],
      [['--to', 'XISU', '--body', 'x', '--reply-to', '不是uuid'], /reply-to/], [['--to', 'bad!id', '--body', 'x'], /成員代號格式不對/],
      [['--to', 'T/T-預設', '--body', 'x'], /本機節點/], [['--to', 'XISU', '--body', 'x'.repeat(20001)], /超過 20000 字/],
    ]
    for (const [args, re] of bads) { const r = await asWindow(home, st, 'T-視窗甲', args); assert.equal(r.code, 1, args.join(' ')); assert.match(r.err, re) }
    assert.equal(st.reqs.length, 0)
    assert.equal((await asWindow(home, st, 'T-視窗甲', ['--to', 'XISU', '--body', 'x'.repeat(20000)])).code, 0)
  } finally { await st.close() }
})

test('群組、stdin、--body-file、後端錯誤、節點代號自動判定', async () => {
  const st = await fakeServer(), home = newHome()
  try {
    const room = await asWindow(home, st, 'T-視窗甲', ['--room', 'g36', '--body', '群組回報'])
    assert.equal(room.code, 0); assert.match(room.out, /^posted room=g36 seq=12 from=T\/T-視窗甲/)
    assert.deepEqual(st.reqs[0].body, { room: 'g36', body: '群組回報', from_agent: 'T-視窗甲' })
    const sin = await asWindow(home, st, 'T-視窗甲', ['--to', 'XISU', '--body', '-'], { stdin: '從 stdin 來的內文\n' })
    assert.equal(sin.code, 0); assert.equal(st.reqs[1].body.body, '從 stdin 來的內文')
    const f = path.join(home, 'm.txt'); fs.writeFileSync(f, '檔案內文\n\n')
    const bf = await asWindow(home, st, 'T-視窗甲', ['--to', 'XISU', '--body-file', f])
    assert.equal(bf.code, 0); assert.equal(st.reqs[2].body.body, '檔案內文')
    // 不給 IRORI_RELAY_ID：唯一的 machine-T 資料夾決定節點
    fs.mkdirSync(path.join(home, '.irori-relay', 'machine-T'), { recursive: true })
    const auto = await run(home, st, WINDOW, ['T-視窗甲', '--to', 'XISU', '--body', '自動判定節點'])
    assert.equal(auto.code, 0, auto.err); assert.match(auto.out, /from=T\/T-視窗甲/)
  } finally { await st.close() }
  const st2 = await fakeServer({ status: 404 })
  try {
    const r = await asWindow(home, st2, 'T-視窗甲', ['--to', 'NOBODY', '--body', 'x'])
    assert.equal(r.code, 4); assert.match(r.err, /send HTTP 404 not_found/)
  } finally { await st2.close() }
})

// 備援：父行程鏈斷掉（nohup／背景化後孤兒）時，用 Claude Code 匯出的 CLAUDE_CODE_MESSAGING_SOCKET 對上還活著的 session
test('環境變數備援：孤兒行程帶著視窗專屬的 messaging socket → 認得；socket 不符或 session 已死 → 拒絕', async () => {
  const st = await fakeServer(), home = newHome()
  const sdir = path.join(home, '.claude', 'sessions'); fs.mkdirSync(sdir, { recursive: true })
  const put = (pid, sock, name) => fs.writeFileSync(path.join(sdir, `${pid}.json`), JSON.stringify({ pid, name, kind: 'interactive', entrypoint: 'cli', messagingSocketPath: sock }))
  const alive = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true })   // 還活著、但不是 send.mjs 祖先的程序
  put(alive.pid, '\\.\pipe\LOCAL\cc-msg-fake', 'T-備援視窗')
  put(999999, '\\.\pipe\LOCAL\cc-msg-dead', 'T-死掉的視窗')       // pid 不存在
  const env = { IRORI_RELAY_ID: 'T' }
  try {
    const ok = await run(home, st, SEND, ['--to', 'XISU', '--body', 'x'], { env: { ...env, CLAUDE_CODE_MESSAGING_SOCKET: '\\.\pipe\LOCAL\cc-msg-fake' } })
    assert.equal(ok.code, 0, ok.err); assert.equal(st.reqs[0].body.from_agent, 'T-備援視窗')
    const wrong = await run(home, st, SEND, ['--to', 'XISU', '--body', 'x'], { env: { ...env, CLAUDE_CODE_MESSAGING_SOCKET: '\\.\pipe\LOCAL\cc-msg-other' } })
    assert.equal(wrong.code, 2)
    const dead = await run(home, st, SEND, ['--to', 'XISU', '--body', 'x'], { env: { ...env, CLAUDE_CODE_MESSAGING_SOCKET: '\\.\pipe\LOCAL\cc-msg-dead' } })
    assert.equal(dead.code, 2); assert.match(dead.err, /--whoami/)
    assert.equal(st.reqs.length, 1)
  } finally { alive.kill(); await st.close() }
})

test('節點代號自動判定：多個 machine-* 資料夾時，取橋正在跑的；沒有就取唯一有金鑰檔的；仍不唯一則說明候選', async () => {
  const st = await fakeServer(), home = newHome('T')
  const root = path.join(home, '.irori-relay')
  for (const id of ['T', 'T-舊測試', 'X']) fs.mkdirSync(path.join(root, `machine-${id.replace('T-舊測試', 'Told')}`), { recursive: true })
  fs.writeFileSync(path.join(root, 'Told.key'), 'k2')   // machine-T、machine-Told 都有金鑰 → 先靠 bridge.pid
  try {
    fs.writeFileSync(path.join(root, 'machine-T', 'bridge.pid'), String(process.pid))   // 橋在跑
    const a = await run(home, st, WINDOW, ['T-視窗甲', '--to', 'XISU', '--body', 'x'])
    assert.equal(a.code, 0, a.err); assert.match(a.out, /from=T\/T-視窗甲/)
    fs.unlinkSync(path.join(root, 'machine-T', 'bridge.pid'))                           // 沒有橋在跑，T 與 Told 都有金鑰 → 不唯一
    const b = await run(home, st, WINDOW, ['T-視窗甲', '--to', 'XISU', '--body', 'x'])
    assert.equal(b.code, 1); assert.match(b.err, /候選：.*T.*Told|候選：.*Told.*T/)
  } finally { await st.close() }
})

test('--whoami：不寄信，印出父行程鏈裡的視窗與節點判定', async () => {
  const st = await fakeServer(), home = newHome()
  try {
    const r = await asWindow(home, st, 'T-視窗甲', ['--whoami'])
    assert.equal(r.code, 0, r.err); assert.match(r.out, /<== session「T-視窗甲」/); assert.match(r.out, /判定（行程鏈）：pid=\d+ name=T-視窗甲/); assert.match(r.out, /機器節點判定：T/)
    assert.equal(st.reqs.length, 0)
  } finally { await st.close() }
})
