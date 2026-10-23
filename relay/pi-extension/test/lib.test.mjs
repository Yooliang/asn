import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { buildSendArgv, guardAsnSendInput, guardBash, mentionsPersonSignature, resolveConfig, runSend } from '../lib.mjs'

const CLI = { asnCliPath: 'C:/ASN/asn-cli.exe' }
const MJS = { sendMjsPath: '/r/relay/machine/send.mjs', nodePath: 'node' }

test('argv：--reply／--no-reply／--reply-to／--room', () => {
  assert.deepEqual(buildSendArgv({ to: 'W/W-政策', body: 'hi', expects_reply: true }, CLI), {
    argv: ['C:/ASN/asn-cli.exe', 'send', '--to', 'W/W-政策', '--body', 'hi', '--reply'],
  })
  assert.deepEqual(buildSendArgv({ to: 'PC1', body: 'hi', expects_reply: false, reply_to: '  abc ' }, CLI), {
    argv: ['C:/ASN/asn-cli.exe', 'send', '--to', 'PC1', '--body', 'hi', '--no-reply', '--reply-to', 'abc'],
  })
  assert.deepEqual(buildSendArgv({ room: 'r1', body: 'hi' }, CLI), {
    argv: ['C:/ASN/asn-cli.exe', 'send', '--room', 'r1', '--body', 'hi'],
  })
  assert.deepEqual(buildSendArgv({ to: 'PC1', body: 'hi', expects_reply: true }, MJS), {
    argv: ['node', '/r/relay/machine/send.mjs', '--to', 'PC1', '--body', 'hi', '--reply'],
  })
})

test('argv：缺欄位一律回錯誤', () => {
  for (const [i, c] of [
    [{ to: 'X', body: 'hi' }, CLI],
    [{ to: 'X', room: 'r', body: 'hi', expects_reply: true }, CLI],
    [{ body: 'hi' }, CLI],
    [{ to: 'X', expects_reply: true }, CLI],
    [{ to: 'X', body: 'hi', expects_reply: true }, {}],
  ]) assert.ok('error' in buildSendArgv(i, c))
})

test('argv：本人簽章字樣被擋（路徑、to、reply_to），內文不受限', () => {
  for (const bad of ['--as_person', 'x-asn-user', 'as-person', 'user_token']) {
    assert.ok('error' in buildSendArgv({ to: 'X', body: 'hi', expects_reply: true, reply_to: bad }, CLI))
    assert.ok('error' in buildSendArgv({ to: bad, body: 'hi', expects_reply: true }, CLI))
  }
  assert.ok('error' in buildSendArgv({ to: 'X', body: 'hi', expects_reply: true }, { asnCliPath: 'C:/x/as_person/asn-cli.exe' }))
  assert.ok('argv' in buildSendArgv({ to: 'X', body: '討論 x-asn-user 標頭', expects_reply: false }, CLI))
})

test('設定：env 優先、Windows 預設 LOCALAPPDATA、Linux 無預設', () => {
  assert.equal(resolveConfig({ LOCALAPPDATA: 'C:\\U\\AppData\\Local' }, {}, 'win32').asnCliPath, 'C:\\U\\AppData\\Local\\ASN\\asn-cli.exe')
  assert.equal(resolveConfig({ ASN_CLI_PATH: 'D:/a.exe', LOCALAPPDATA: 'C:\\x' }, { asnCliPath: 'E:/b.exe' }, 'win32').asnCliPath, 'D:/a.exe')
  assert.equal(resolveConfig({}, { asnCliPath: 'E:/b.exe' }, 'linux').asnCliPath, 'E:/b.exe')
  // 設了 send.mjs 就不套 Windows 預設 asn-cli
  assert.equal(resolveConfig({ ASN_SEND_MJS: '/r/send.mjs', LOCALAPPDATA: 'C:\\x' }, {}, 'win32').asnCliPath, '')
  const lx = resolveConfig({}, {}, 'linux')
  assert.equal(lx.asnCliPath, '')
  assert.equal(lx.nodePath, 'node')
  assert.ok('error' in buildSendArgv({ to: 'X', body: 'hi', expects_reply: true }, lx))
  assert.deepEqual(buildSendArgv({ room: 'r', body: 'hi' }, resolveConfig({ ASN_SEND_MJS: '/r/relay/machine/send.mjs' }, {}, 'linux')), {
    argv: ['node', '/r/relay/machine/send.mjs', '--room', 'r', '--body', 'hi'],
  })
})

test('bash 守門：--to 沒旗標擋、有旗標與 --room 放行', () => {
  const need = '請加 --reply 或 --no-reply，或改用 asn_send 工具'
  assert.equal(guardBash('node relay/machine/send.mjs --to PC1 --body hi'), need)
  assert.equal(guardBash('asn send --to PC1 --body hi'), need)
  assert.equal(guardBash('"C:/ASN/asn-cli.exe" send --to PC1 --reply-to abc --body hi'), need)
  assert.equal(guardBash('node send.mjs --to PC1 --body hi --reply'), undefined)
  assert.equal(guardBash('asn send --to PC1 --body hi --no-reply'), undefined)
  assert.equal(guardBash('node send.mjs --room r1 --body hi'), undefined)
  assert.equal(guardBash('ls -la'), undefined)
  assert.equal(guardBash('asn recv --once'), undefined)
})

test('bash 守門：本人簽章一律擋（即使有旗標）；asn_send 參數同', () => {
  assert.match(guardBash('node send.mjs --to X --body hi --reply --person'), /本人簽章/)
  assert.match(guardBash('ASN_USER_TOKEN=1 asn send --to X --body hi --no-reply'), /本人簽章/)
  assert.match(guardBash('asn send --room r --body hi -H "x-asn-user: Bearer a"'), /本人簽章/)
  assert.equal(mentionsPersonSignature('as_person'), true)
  assert.equal(mentionsPersonSignature('hello'), false)
  assert.ok(guardAsnSendInput({ to: 'X', body: 'hi', reply_to: 'as_person' }))
  assert.equal(guardAsnSendInput({ to: 'X', body: '講 x-asn-user 標頭', expects_reply: false }), undefined)
})

test('runSend：execFile 不經 shell、不帶 env；成功與失敗文字', async () => {
  const calls = []
  const ok = (file, args, opts, cb) => { calls.push({ file, args, opts }); cb(null, 'sent id=1\n', '') }
  const r = await runSend(['C:/ASN/asn-cli.exe', 'send', '--room', 'r', '--body', 'a; rm -rf / & echo $HOME'], ok)
  assert.deepEqual(r, { ok: true, text: 'sent id=1' })
  assert.equal(calls[0].file, 'C:/ASN/asn-cli.exe')
  assert.deepEqual(calls[0].args, ['send', '--room', 'r', '--body', 'a; rm -rf / & echo $HOME'])
  assert.equal('env' in calls[0].opts, false)
  assert.equal('shell' in calls[0].opts, false)

  const bad = (file, args, opts, cb) => cb(Object.assign(new Error('x'), { code: 2 }), '', 'no node key')
  assert.deepEqual(await runSend(['x'], bad), { ok: false, text: 'asn_send 失敗（2）：no node key' })
})

test('runSend：真 execFile 打 127.0.0.1 假伺服器（node -e 當假 asn-cli）', async () => {
  let got = ''
  const srv = http.createServer((req, res) => {
    req.on('data', (d) => (got += d))
    req.on('end', () => res.end('sent id=fake'))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address()
  const script = `fetch('http://127.0.0.1:${port}/',{method:'POST',body:process.argv.slice(1).join('|')}).then(r=>r.text()).then(t=>console.log(t))`
  const r = await runSend([process.execPath, '-e', script, '--', '--to', 'X', '--reply'], execFile)
  srv.close()
  assert.deepEqual(r, { ok: true, text: 'sent id=fake' })
  assert.equal(got, '--to|X|--reply')
})
