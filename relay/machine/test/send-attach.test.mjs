// send.mjs --file 與 attach-upload.mjs 測試（只連 127.0.0.1 假後端）：attach_init／PUT 上傳／attach_commit／send 全程模擬，
// 含超過上限、副檔名不在白名單、非 webp 照片、內容與副檔名不符、上傳失敗與後端拒收時都不寄信。
// 執行：node --test relay/machine/test/send-attach.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnTracked } from './spawn-tracked.mjs'
import { fileURLToPath } from 'node:url'
import { AttachFail } from '../attach-download.mjs'
import { attachmentText, cleanUploadName, prepareFile, prepareFiles, uploadItems } from '../attach-upload.mjs'
import { parseArgs } from '../send.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const WINDOW = path.join(here, 'fake-window.mjs')
const ID1 = '11111111-0000-0000-0000-000000000001'

const webp = n => { const b = Buffer.alloc(n); b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(n - 8, 4); b.write('WEBPVP8 ', 8, 'latin1'); return b }
const pdf = n => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(n - 9, 0x20)])
const zip = () => Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0])
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'send-attach-'))
const put = (dir, name, buf) => { const p = path.join(dir, name); fs.writeFileSync(p, buf); return p }

const readRaw = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))) })

// 假後端：記下每個請求；upload 路徑收 PUT 位元組。opts：putStatus、initError（{status,error}）、commitError
async function fakeServer(opts = {}) {
  const st = { reqs: [], puts: [], n: 0 }
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), raw = await readRaw(req)
    const reply = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (req.method === 'PUT' && u.pathname.startsWith('/upload/')) {
      st.puts.push({ id: u.pathname.slice(8), type: req.headers['content-type'], bytes: raw, key: req.headers['x-relay-key'] })
      res.writeHead(opts.putFailNth === st.puts.length ? 500 : (opts.putStatus ?? 200)); return res.end()
    }
    const a = u.searchParams.get('action'), body = raw.length ? JSON.parse(raw.toString()) : null
    st.reqs.push({ action: a, key: req.headers['x-relay-key'], body })
    if (a === 'attach_init') {
      if (opts.initError) return reply(opts.initError.status, { error: opts.initError.error })
      const id = `11111111-0000-0000-0000-00000000000${++st.n}`
      return reply(200, { id, upload_url: `http://127.0.0.1:${st.port}/upload/${id}?token=SECRET-SIGNED`, expires_in: 7200 })
    }
    if (a === 'attach_commit') return opts.commitError ? reply(opts.commitError.status, { error: opts.commitError.error }) : reply(200, { ok: true, id: body.id })
    if (a === 'room_post') return reply(200, { seq: 7 })
    return reply(200, { id: 'aaaaaaaa-0000-0000-0000-000000000009' })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  st.port = srv.address().port; st.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r) })
  return st
}
const newHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-send-attach-'))
  fs.mkdirSync(path.join(home, '.irori-relay'), { recursive: true })
  fs.writeFileSync(path.join(home, '.irori-relay', 'T.key'), 'fake-machine-key')
  return home
}
function runSend(home, st, args, stdin = '') {
  return new Promise(res => {
    const c = spawnTracked(process.execPath, [WINDOW, 'T-視窗甲', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, IRORI_RELAY_ID: 'T', IRORI_RELAY_URL: `http://127.0.0.1:${st.port}/relay` },
    })
    let out = '', err = ''; c.stdout.on('data', d => out += d); c.stderr.on('data', d => err += d)
    c.on('close', code => res({ code, out, err })); c.stdin.end(stdin)
  })
}
const actions = st => st.reqs.map(r => r.action)

test('parseArgs：--file 可重複', () => {
  assert.deepEqual(parseArgs(['--to', 'X', '--file', 'a.pdf', '--file', 'b.webp']).files, ['a.pdf', 'b.webp'])
  assert.equal(parseArgs(['--to', 'X']).files, undefined)
})

test('prepareFile：白名單檔案與 webp 照片通過，種類與型別正確', () => {
  const d = tmpDir()
  try {
    const r = prepareFile(put(d, '報告(最終).PDF', pdf(100)))
    assert.deepEqual([r.kind, r.mime, r.name, r.bytes.length], ['file', 'application/pdf', '報告 最終.pdf', 100])
    const w = prepareFile(put(d, 'cat.webp', webp(64)))
    assert.deepEqual([w.kind, w.mime, w.name], ['image', 'image/webp', 'cat.webp'])
    assert.equal(prepareFile(put(d, 'a.zip', zip())).mime, 'application/zip')
    assert.equal(prepareFile(put(d, 'n.md', Buffer.from('# hi'))).mime, 'text/markdown')
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('prepareFile：擋可執行檔、不在白名單、png／jpg 照片、內容與副檔名不符、空檔、超過上限', () => {
  const d = tmpDir()
  try {
    const bad = (p, re) => assert.throws(() => prepareFile(p), e => e instanceof AttachFail && e.code === 1 && re.test(e.message), p)
    for (const n of ['a.exe', 'a.bat', 'a.ps1', 'a.sh', 'a.js', 'a.msi', 'a.dll', 'noext']) bad(put(d, n, Buffer.from('MZ')), /不能寄/)
    bad(put(d, 'a.png', Buffer.from('\x89PNG')), /只收 webp/)
    bad(put(d, 'a.jpg', Buffer.from('xx')), /只收 webp/)
    bad(put(d, 'fake.pdf', Buffer.from('MZ\x90\0')), /對不上/)       // 改了副檔名的執行檔
    bad(put(d, 'fake.webp', Buffer.from('not webp at all')), /對不上/)
    bad(put(d, 'fake.zip', Buffer.from('plain')), /對不上/)
    bad(put(d, 'bin.txt', Buffer.from([65, 0, 66])), /對不上/)          // 文字檔含 NUL
    bad(put(d, 'empty.txt', Buffer.alloc(0)), /空的/)
    bad(path.join(d, 'missing.pdf'), /找不到檔案/)
    bad(d, /不是檔案/)
    bad(put(d, 'big.webp', webp(5 * 1024 * 1024 + 1)), /超過上限/)
    bad(put(d, 'big.pdf', pdf(25 * 1024 * 1024 + 1)), /超過上限/)
    // 剛好在上限內
    assert.equal(prepareFile(put(d, 'ok.pdf', pdf(25 * 1024 * 1024))).bytes.length, 25 * 1024 * 1024)
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('prepareFiles：超過 4 個擋掉；檔名清理保留副檔名', () => {
  const d = tmpDir()
  try {
    const fs5 = Array.from({ length: 5 }, (_, i) => put(d, `f${i}.txt`, Buffer.from('x')))
    assert.throws(() => prepareFiles(fs5), e => e instanceof AttachFail && /最多 4 個/.test(e.message))
    assert.equal(prepareFiles(fs5.slice(0, 4)).length, 4)
    const n = cleanUploadName('../' + '長'.repeat(200) + '.pdf', 'pdf')
    assert.ok(n.endsWith('.pdf') && n.length <= 80, n)
    assert.equal(cleanUploadName('///', 'pdf'), 'file.pdf')
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('attachmentText：只有附件時給清單，有說明接在後面', () => {
  const items = [{ kind: 'file', name: 'a.pdf' }, { kind: 'image', name: 'b.webp' }]
  assert.equal(attachmentText(items, ''), '〔檔案〕a.pdf\n〔照片〕b.webp')
  assert.equal(attachmentText(items, '看一下\n'), '〔檔案〕a.pdf\n〔照片〕b.webp\n看一下')
})

test('uploadItems：不在收發室主機的上傳網址被拒絕、不上傳', async () => {
  const calls = []
  const api = async a => { calls.push(a); return { id: ID1, upload_url: 'https://evil.example.com/x' } }
  const fetchFn = async () => { throw new Error('不該連線') }
  await assert.rejects(uploadItems({ api, baseUrl: 'http://127.0.0.1:1/relay', items: [{ kind: 'file', mime: 'text/plain', name: 'a.txt', bytes: Buffer.from('x') }], fetchFn }), /不在收發室的主機上/)
})

test('寄單一 pdf（內文空）：init → PUT → commit → send，帶 attachment_ids，內文是附件清單', async () => {
  const st = await fakeServer(), home = newHome(), d = tmpDir()
  try {
    const f = put(d, '報告.pdf', pdf(300))
    const r = await runSend(home, st, ['--to', 'XISU', '--file', f, '--no-reply'])
    assert.equal(r.code, 0, r.err); assert.match(r.out, /^sent id=aaaaaaaa-0000-0000-0000-000000000009 to=XISU from=T\/T-視窗甲/)
    assert.deepEqual(actions(st), ['attach_init', 'attach_commit', 'send'])
    assert.deepEqual(st.reqs[0].body, { kind: 'file', mime: 'application/pdf', name: '報告.pdf', bytes: 300 })
    assert.equal(st.puts.length, 1); assert.equal(st.puts[0].type, 'application/pdf'); assert.ok(st.puts[0].bytes.equals(fs.readFileSync(f)))
    assert.equal(st.puts[0].key, undefined, '上傳網址自己帶簽名，不送金鑰')
    assert.deepEqual(st.reqs[1].body, { id: ID1.replace('0001', '0001') })
    const send = st.reqs[2].body
    assert.equal(send.body, '〔檔案〕報告.pdf'); assert.deepEqual(send.attachment_ids, [ID1]); assert.equal(send.expects_reply, false); assert.equal(send.from_agent, 'T-視窗甲')
    for (const q of st.reqs) assert.equal(q.key, 'fake-machine-key')
  } finally { await st.close(); fs.rmSync(d, { recursive: true, force: true }) }
})

test('照片＋檔案＋說明文字：兩個附件依序上傳，內文＝清單＋說明；room_post 也帶 attachment_ids', async () => {
  const st = await fakeServer(), home = newHome(), d = tmpDir()
  try {
    const a = put(d, 'cat.webp', webp(200)), b = put(d, 'data.csv', Buffer.from('a,b\n1,2\n'))
    const r = await runSend(home, st, ['--to', 'W/W-政策', '--file', a, '--file', b, '--body', '看這個', '--reply'])
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(actions(st), ['attach_init', 'attach_commit', 'attach_init', 'attach_commit', 'send'])
    assert.deepEqual([st.reqs[0].body.kind, st.reqs[2].body.kind], ['image', 'file'])
    assert.equal(st.puts[0].type, 'image/webp'); assert.equal(st.puts[1].type, 'text/csv')
    const send = st.reqs[4].body
    assert.equal(send.body, '〔照片〕cat.webp\n〔檔案〕data.csv\n看這個')
    assert.deepEqual(send.attachment_ids, [ID1, ID1.replace('0001', '0002')]); assert.equal(send.expects_reply, true)
    assert.deepEqual([send.to_node, send.to_agent], ['W', 'W-政策'])
    st.reqs.length = 0; st.puts.length = 0
    const r2 = await runSend(home, st, ['--room', 'proj', '--file', b])
    assert.equal(r2.code, 0, r2.err); assert.match(r2.out, /^posted room=proj seq=7/)
    assert.deepEqual(actions(st), ['attach_init', 'attach_commit', 'room_post'])
    assert.equal(st.reqs[2].body.body, '〔檔案〕data.csv'); assert.equal(st.reqs[2].body.attachment_ids.length, 1)
  } finally { await st.close(); fs.rmSync(d, { recursive: true, force: true }) }
})

test('沒有附件的寄信不帶 attachment_ids；沒內文也沒附件仍報錯', async () => {
  const st = await fakeServer(), home = newHome()
  try {
    const r = await runSend(home, st, ['--to', 'XISU', '--body', '純文字', '--no-reply'])
    assert.equal(r.code, 0, r.err); assert.equal('attachment_ids' in st.reqs[0].body, false)
    const e = await runSend(home, st, ['--to', 'XISU', '--no-reply'])
    assert.equal(e.code, 1); assert.match(e.err, /內文是空的/)
  } finally { await st.close() }
})

test('本機檢查不過（超過上限、白名單外、png、偽裝、第 5 個）：不連後端、不寄信', async () => {
  const st = await fakeServer(), home = newHome(), d = tmpDir()
  try {
    const cases = [
      [put(d, 'big.pdf', pdf(25 * 1024 * 1024 + 1)), /超過上限/],
      [put(d, 'x.exe', Buffer.from('MZ')), /不能寄/],
      [put(d, 'x.png', Buffer.from('\x89PNG')), /只收 webp/],
      [put(d, 'x.pdf', Buffer.from('MZ')), /對不上/],
    ]
    for (const [f, re] of cases) {
      const r = await runSend(home, st, ['--to', 'XISU', '--file', f, '--body', '附上', '--no-reply'])
      assert.equal(r.code, 1, r.err); assert.match(r.err, re)
    }
    // 一個好的加一個壞的：好的也不能先傳
    const good = put(d, 'ok.txt', Buffer.from('ok'))
    const r = await runSend(home, st, ['--to', 'XISU', '--file', good, '--file', path.join(d, 'x.exe'), '--no-reply'])
    assert.equal(r.code, 1); assert.deepEqual(st.reqs, []); assert.deepEqual(st.puts, [])
    const files = Array.from({ length: 5 }, (_, i) => put(d, `f${i}.txt`, Buffer.from('x'))).flatMap(f => ['--file', f])
    const r5 = await runSend(home, st, ['--to', 'XISU', ...files, '--no-reply'])
    assert.equal(r5.code, 1); assert.match(r5.err, /最多 4 個/); assert.deepEqual(st.reqs, [])
  } finally { await st.close(); fs.rmSync(d, { recursive: true, force: true }) }
})

test('上傳失敗（PUT 回 500）：不 commit、不 send，exit 4，錯誤訊息不含簽名網址', async () => {
  const st = await fakeServer({ putStatus: 500 }), home = newHome(), d = tmpDir()
  try {
    const r = await runSend(home, st, ['--to', 'XISU', '--file', put(d, 'a.pdf', pdf(50)), '--body', '附上', '--no-reply'])
    assert.equal(r.code, 4); assert.match(r.err, /a\.pdf：上傳失敗（HTTP 500）/); assert.ok(!/SECRET-SIGNED|token/.test(r.err))
    assert.deepEqual(actions(st), ['attach_init'])
  } finally { await st.close(); fs.rmSync(d, { recursive: true, force: true }) }
})

test('第二個附件上傳失敗：整封信不寄', async () => {
  const st = await fakeServer({ putFailNth: 2 }), home = newHome(), d = tmpDir()
  try {
    const r = await runSend(home, st, ['--to', 'XISU', '--file', put(d, 'a.pdf', pdf(50)), '--file', put(d, 'b.txt', Buffer.from('x')), '--no-reply'])
    assert.equal(r.code, 4); assert.match(r.err, /b\.txt：上傳失敗/)
    assert.deepEqual(actions(st), ['attach_init', 'attach_commit', 'attach_init'])
    assert.ok(!actions(st).includes('send'))
  } finally { await st.close(); fs.rmSync(d, { recursive: true, force: true }) }
})

test('後端拒收：額度滿、型別不收、舊後端 404、commit 失敗 → 白話訊息、不寄信', async () => {
  const home = newHome(), d = tmpDir(), f = put(d, 'a.pdf', pdf(50))
  try {
    for (const [opts, re, expectActions] of [
      [{ initError: { status: 413, error: 'quota_exceeded' } }, /附件空間滿了/, ['attach_init']],
      [{ initError: { status: 400, error: 'unsupported_type' } }, /不收這種檔案/, ['attach_init']],
      [{ initError: { status: 413, error: 'file_too_large' } }, /檔案太大了/, ['attach_init']],
      [{ initError: { status: 404, error: 'not_found' } }, /還不支援傳附件/, ['attach_init']],
      [{ commitError: { status: 409, error: 'not_uploaded' } }, /還沒傳完/, ['attach_init', 'attach_commit']],
    ]) {
      const st = await fakeServer(opts)
      try {
        const r = await runSend(home, st, ['--to', 'XISU', '--file', f, '--body', 'x', '--no-reply'])
        assert.equal(r.code, 4, r.err); assert.match(r.err, re); assert.deepEqual(actions(st), expectActions)
      } finally { await st.close() }
    }
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('不寄給自己時仍擋在上傳之前（沒浪費上傳）', async () => {
  const st = await fakeServer(), home = newHome(), d = tmpDir()
  try {
    const r = await runSend(home, st, ['--to', 'T/T-視窗甲', '--file', put(d, 'a.txt', Buffer.from('x')), '--no-reply'])
    assert.equal(r.code, 1); assert.match(r.err, /不能寄給自己/); assert.deepEqual(st.reqs, [])
  } finally { await st.close(); fs.rmSync(d, { recursive: true, force: true }) }
})
