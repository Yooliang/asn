import { expect, test } from 'claude-code/testing'
import { buildSendArgv, guardBash, mentionsPersonSignature, startNotice } from './lib'

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

// asn_cli_path 留空：自動找 LOCALAPPDATA 下 ASN 資料夾的 asn-cli.exe（存在才用），否則退 send.mjs
const DEFAULT_CLI = 'C:\\Users\\u\\AppData\\Local\\ASN\\asn-cli.exe'
const autoFind = async ($: any, on: any, present: boolean) => {
  const ran: string[][] = []
  on('tool.register', () => ({ value: { tool: 'mcp__asn__asn_send' } }) as never)
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: 'C:\\Users\\u\\AppData\\Local' }) as never)
  on('fs.stat', (_: unknown, e: { path: string }) => {
    if (present && e.path === DEFAULT_CLI) return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } } as never
    throw new Error('ENOENT')
  })
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'sent id=2\n', stderr: '' } } as never
  })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const sent = await $.tool.call({ tool: 'mcp__asn__asn_send', to: 'XISU', body: 'hi', expects_reply: false } as never)
  return { ran, sent }
}

test('自動找預設 asn-cli：LOCALAPPDATA 下存在就用它', { options: { asn_cli_path: '', send_mjs_path: '/r/send.mjs' } }, async ($, on) => {
  const { ran, sent } = await autoFind($, on, true)
  expect(ran).toEqual([[DEFAULT_CLI, 'send', '--to', 'XISU', '--body', 'hi', '--no-reply']])
  expect(typeof (sent as { result: unknown }).result).toBe('string')
})

test('自動找預設 asn-cli：不存在就退回 node send.mjs', { options: { asn_cli_path: '', send_mjs_path: '/r/send.mjs' } }, async ($, on) => {
  const { ran, sent } = await autoFind($, on, false)
  expect(ran).toEqual([['node', '/r/send.mjs', '--to', 'XISU', '--body', 'hi', '--no-reply']])
  expect(typeof (sent as { result: unknown }).result).toBe('string')
})

test('自動找預設 asn-cli：都沒有就回清楚的錯誤字串、不執行', { options: { asn_cli_path: '', send_mjs_path: '' } }, async ($, on) => {
  const { ran, sent } = await autoFind($, on, false)
  expect(ran.length).toBe(0)
  const r = (sent as { result: unknown }).result
  expect(typeof r).toBe('string')
  expect(r as string).toContain('尚未設定')
})

test('開窗提示：帶版本、指向 asn 技能；版本空白時不留空', () => {
  expect(startNotice('0.1.33')).toContain('ASN 0.1.33')
  expect(startNotice('0.1.33')).toContain('asn 技能')
  expect(startNotice('  ')).toContain('（版本不明）')
})

test('系統提示最後多一段 asn:installed（session、帶版本），原有段落不動', async ($, on) => {
  const base = [
    { id: 'intro', text: 'A', scope: 'shared' },
    { id: 'tone', text: 'B', scope: 'session' },
  ]
  on('fs.read', () => ({ value: JSON.stringify({ name: 'asn', version: '9.8.7' }) }) as never)
  on('prompt.compose', () => ({ sections: base }) as never)
  const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  expect(r.sections.slice(0, 2)).toEqual(base)
  const last = r.sections[r.sections.length - 1]
  expect(r.sections.length).toBe(3)
  expect(last.id).toBe('asn:installed')
  expect(last.scope).toBe('session')
  expect(last.text).toContain('ASN 9.8.7')
  expect(last.text).toContain('asn 技能')
})

test('開窗不再用 session.append 附提示', async ($, on) => {
  let appended = 0
  on('env.get', () => ({ value: 'C:/Users/u' }) as never)
  on('session.id', () => ({ value: 's1' }) as never)
  on('fs.read', () => ({ value: '{"version":"1.0.0"}' }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: { tool: 'mcp__asn__asn_send' } }) as never)
  on('session.append', (_: unknown, e: unknown, next: (x: unknown) => unknown) => {
    appended++
    return next(e) as never
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  const out = await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  expect(out).toMatchObject({ cwd: '/x' })
  expect(appended).toBe(0)
})
