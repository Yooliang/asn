import { expect, test } from 'claude-code/testing'
import { buildSendArgv, guardBash, mentionsPersonSignature } from './lib'

const CLI = { asnCliPath: 'C:/ASN/asn-cli.exe' }
const MJS = { sendMjsPath: '/r/relay/machine/send.mjs', nodePath: 'node' }

test('argv：--reply／--no-reply／--reply-to／--room', () => {
  expect(buildSendArgv({ to: 'W/W-政策', body: 'hi', expects_reply: true }, CLI)).toEqual({
    argv: ['C:/ASN/asn-cli.exe', 'send', '--to', 'W/W-政策', '--body', 'hi', '--reply'],
  })
  expect(buildSendArgv({ to: 'XISU', body: 'hi', expects_reply: false, reply_to: '  abc ' }, CLI)).toEqual({
    argv: ['C:/ASN/asn-cli.exe', 'send', '--to', 'XISU', '--body', 'hi', '--no-reply', '--reply-to', 'abc'],
  })
  expect(buildSendArgv({ room: 'r1', body: 'hi' }, CLI)).toEqual({
    argv: ['C:/ASN/asn-cli.exe', 'send', '--room', 'r1', '--body', 'hi'],
  })
  // 沒設 asn-cli 就退回 node send.mjs
  expect(buildSendArgv({ to: 'XISU', body: 'hi', expects_reply: true }, MJS)).toEqual({
    argv: ['node', '/r/relay/machine/send.mjs', '--to', 'XISU', '--body', 'hi', '--reply'],
  })
})

test('argv：缺欄位一律回錯誤，不組命令', () => {
  expect('error' in buildSendArgv({ to: 'X', body: 'hi' }, CLI)).toBe(true)
  expect('error' in buildSendArgv({ to: 'X', room: 'r', body: 'hi', expects_reply: true }, CLI)).toBe(true)
  expect('error' in buildSendArgv({ body: 'hi' }, CLI)).toBe(true)
  expect('error' in buildSendArgv({ to: 'X', expects_reply: true }, CLI)).toBe(true)
  expect('error' in buildSendArgv({ to: 'X', body: 'hi', expects_reply: true }, {})).toBe(true)
})

test('argv：本人簽章字樣被擋（路徑、to、reply_to），內文不受限', () => {
  for (const bad of ['--as_person', 'x-asn-user', 'as-person']) {
    expect('error' in buildSendArgv({ to: 'X', body: 'hi', expects_reply: true, reply_to: bad }, CLI)).toBe(true)
    expect('error' in buildSendArgv({ to: bad, body: 'hi', expects_reply: true }, CLI)).toBe(true)
  }
  expect('error' in buildSendArgv({ to: 'X', body: 'hi', expects_reply: true }, { asnCliPath: 'C:/x/as_person/asn-cli.exe' })).toBe(true)
  expect('argv' in buildSendArgv({ to: 'X', body: '討論 x-asn-user 標頭', expects_reply: false }, CLI)).toBe(true)
})

test('Bash 守門：--to 沒旗標擋、有旗標與 --room 放行', () => {
  const need = '請加 --reply 或 --no-reply，或改用 asn_send 工具'
  expect(guardBash('node relay/machine/send.mjs --to XISU --body hi')).toBe(need)
  expect(guardBash('asn send --to XISU --body hi')).toBe(need)
  expect(guardBash('"C:/ASN/asn-cli.exe" send --to XISU --reply-to abc --body hi')).toBe(need)
  expect(guardBash('node send.mjs --to XISU --body hi --reply')).toBeUndefined()
  expect(guardBash('asn send --to XISU --body hi --no-reply')).toBeUndefined()
  expect(guardBash('node send.mjs --room r1 --body hi')).toBeUndefined()
  expect(guardBash('ls -la')).toBeUndefined()
  expect(guardBash('asn recv --once')).toBeUndefined()
})

test('Bash 守門：本人簽章相關一律擋（即使有旗標）', () => {
  expect(guardBash('node send.mjs --to X --body hi --reply --person')).toContain('本人簽章')
  expect(guardBash('ASN_USER_TOKEN=1 asn send --to X --body hi --no-reply')).toContain('本人簽章')
  expect(guardBash('asn send --room r --body hi -H "x-asn-user: Bearer a"')).toContain('本人簽章')
  expect(mentionsPersonSignature('as_person')).toBe(true)
  expect(mentionsPersonSignature('hello')).toBe(false)
})

test('外掛本體：asn_send 走 $.process.run、缺欄位不執行', { options: { asn_cli_path: 'C:/ASN/asn-cli.exe' } }, async ($, on) => {
  const ran: string[][] = []
  on('tool.register', () => ({ value: { tool: 'mcp__asn__asn_send' } }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    ran.push([...(e as { argv: string[] }).argv])
    return { value: { exitCode: 0, stdout: 'sent id=1\n', stderr: '' } } as never
  })
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const denied = await $.tool.call({ tool: 'Bash', command: 'node send.mjs --to X --body hi' })
  expect(denied.deny).toContain('--reply')
  const ok = await $.tool.call({ tool: 'Bash', command: 'node send.mjs --to X --body hi --no-reply' })
  expect(ok.deny).toBeUndefined()

  const sent = await $.tool.call({ tool: 'mcp__asn__asn_send', to: 'XISU', body: 'hi', expects_reply: false } as never)
  expect(ran).toEqual([['C:/ASN/asn-cli.exe', 'send', '--to', 'XISU', '--body', 'hi', '--no-reply']])
  expect(JSON.stringify(sent)).toContain('sent id=1')
  // 註冊工具沒有輸出 schema：引擎只收字串或內容區塊陣列（10-22 實際載入時物件被拒）
  expect(typeof (sent as { result: unknown }).result).toBe('string')

  await $.tool.call({ tool: 'mcp__asn__asn_send', to: 'XISU', body: 'hi' } as never)
  expect(ran.length).toBe(1)
})
