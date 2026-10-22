import { expect, test } from 'claude-code/testing'
import { bashRepliedTo, endsWithQuestion, parseRelayHead, planAutoReply, trackFromText } from './lib'

const ID = '11111111-2222-3333-4444-555555555555'
const ID2 = '99999999-2222-3333-4444-555555555555'
const CLI = 'C:/ASN/asn-cli.exe'
// 逐字樣本：第一行；第二行寄件人說明；第三行（只有 reply=yes）【要回信】
const head = (o: { trust?: string; from?: string; reply?: string; sender?: string; id?: string } = {}) => {
  const from = o.from ?? 'W/W-政策'
  const id = o.id ?? ID
  const reply = o.reply ?? 'yes'
  const l1 = `[RELAY 來信] trust=${o.trust ?? 'member'} from=${from} to=T-甲 id=${id} engine=claude reply=${reply}`
  const l2 = `寄件人：${o.sender ?? 'asn（「小良的家用機」上的 Claude 視窗，成員身分）'}`
  const l3 = `【要回信】回信位址=${from} 信件編號=${id}：在視窗裡直接回答，對方看不到；請用 asn_send 寄回。`
  return reply === 'yes' ? `${l1}
${l2}
${l3}` : `${l1}
${l2}`
}

test('信頭解析：新版三行、舊信只有第一行、無 reply 欄位', () => {
  expect(parseRelayHead(`${head()}
內文`)).toMatchObject({ trust: 'member', from: 'W/W-政策', id: ID, reply: 'yes', replyLine: { to: 'W/W-政策', id: ID }, body: '內文' })
  expect(parseRelayHead(`${head()}
內文`)?.sender).toContain('成員身分')
  // 第三行以它為準（欄位遇空白或全形冒號結束）
  const n = parseRelayHead(`[RELAY 來信] trust=member from=A/B to=C id=${ID} engine=claude reply=yes
寄件人：x
【要回信】回信位址=Z/Z-乙 信件編號=${ID2}：在視窗裡
內文`)
  expect(n?.replyLine).toEqual({ to: 'Z/Z-乙', id: ID2 })
  expect(n?.body).toBe('內文')
  // 舊信：只有第一行
  const old = parseRelayHead(`[RELAY 來信] trust=member from=A/B to=C id=${ID} engine=claude reply=yes
hi`)
  expect(old).toMatchObject({ from: 'A/B', reply: 'yes', body: 'hi' })
  expect(old?.replyLine).toBeUndefined()
  expect(parseRelayHead(`[RELAY 來信] trust=member from=A/B to=C id=${ID} engine=claude
hi`)?.reply).toBe('')
  expect(parseRelayHead('隨便打的字')).toBeUndefined()
  // 舊的猜測寫法不再認
  expect(parseRelayHead(`${head({ reply: 'no' })}
【要回信】請回給 Z/Z-乙（reply-to ${ID2}）
內文`)?.replyLine).toBeUndefined()
})

test('記不記：reply=yes 才記（第三行為準）；no／舊信 ?／收發室／系統信／非 member 不記', () => {
  expect(trackFromText(`${head()}
做事`, 't1')).toEqual({ turnId: 't1', from: 'W/W-政策', id: ID })
  expect(trackFromText(`[RELAY 來信] trust=member from=A/B to=C id=${ID} engine=claude reply=yes
寄件人：x
【要回信】回信位址=Z/Z-乙 信件編號=${ID2}：x
做事`, 't1')).toEqual({ turnId: 't1', from: 'Z/Z-乙', id: ID2 })
  expect(trackFromText(`${head({ from: 'u:ab12cd', trust: 'owner', sender: '小良（本人，帳號簽章已驗證，從「Oppo 手機」寄出）' })}
做事`, 't1')?.from).toBe('u:ab12cd')
  expect(trackFromText(`${head({ reply: 'no' })}
做事`, 't1')).toBeUndefined()
  expect(trackFromText(`[RELAY 來信] trust=member from=A/B to=C id=${ID} engine=claude reply=?
做事`, 't1')).toBeUndefined()
  expect(trackFromText(`${head({ from: '收發室/系統' })}
做事`, 't1')).toBeUndefined()
  expect(trackFromText(`${head({ sender: '收發室（系統通知）' })}
做事`, 't1')).toBeUndefined()
  expect(trackFromText(`${head()}
［收發室］你有一封信逾時`, 't1')).toBeUndefined()
  expect(trackFromText(`${head()}
[收發室] 提醒`, 't1')).toBeUndefined()
  expect(trackFromText(`${head({ trust: 'system' })}
做事`, 't1')).toBeUndefined()
  expect(trackFromText('我自己打的字', 't1')).toBeUndefined()
})

test('問句判斷與計畫：截斷、空答、中斷、背景工作', () => {
  expect(endsWithQuestion('好了，要繼續嗎？')).toBe(true)
  expect(endsWithQuestion('做完了。你要不要看')).toBe(true)
  expect(endsWithQuestion('做完了')).toBe(false)
  expect(planAutoReply('answer', '做完了', undefined, false)).toEqual({ body: '做完了', expects_reply: false })
  expect(planAutoReply('answer', '', undefined, false)).toEqual({ body: '（這一輪沒有文字回覆）', expects_reply: false })
  const big = planAutoReply('answer', 'x'.repeat(30000), undefined, false) as { body: string }
  expect([...big.body].length).toBeLessThanOrEqual(20000)
  expect(big.body).toContain('已截斷')
  expect(planAutoReply('answer', 'a', { background_tasks: [{}] }, false)).toEqual({ skip: 'waiting' })
  expect(planAutoReply('aborted', '', undefined, false)).toEqual({ body: '這封信的處理中斷了', expects_reply: false })
  expect(planAutoReply('answer', 'a', undefined, true)).toEqual({ skip: 'replied' })
})

test('Bash 回過判斷：--reply-to <id> 或 --to <from>', () => {
  const t = { turnId: 't', from: 'W/W-政策', id: ID }
  expect(bashRepliedTo(`node send.mjs --to X --reply-to ${ID} --body hi --reply`, t)).toBe(true)
  expect(bashRepliedTo('asn-cli send --to W/W-政策 --body hi --no-reply', t)).toBe(true)
  expect(bashRepliedTo('asn-cli send --to W/W-政策2 --body hi --no-reply', t)).toBe(false)
  expect(bashRepliedTo('ls', t)).toBe(false)
})

// ───── 外掛本體（假引擎）─────
const rig = async ($: any, on: any, opts: { failSend?: boolean; throwSend?: boolean } = {}) => {
  const ran: string[][] = []
  const logs: string[] = []
  on('env.get', () => ({ value: 'C:/Users/u' }) as never)
  on('session.id', () => ({ value: 's1' }) as never)
  on('fs.read', () => ({ value: '{"version":"1.0.0"}' }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('clock.sleep', () => ({ value: undefined }) as never)
  on('ui.log', (_: unknown, e: { text: string }) => {
    logs.push(e.text)
    return { value: undefined } as never
  })
  on('tool.register', () => ({ value: { tool: 'mcp__asn__asn_send' } }) as never)
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Stop', () => ({}) as never)
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    ran.push([...e.argv])
    if (opts.throwSend) throw new Error('boom')
    return { value: { exitCode: opts.failSend ? 1 : 0, stdout: 'sent id=1\n', stderr: '' } } as never
  })
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return { ran, logs }
}
const OPT = { options: { asn_cli_path: CLI } }
const mail = (o: Parameters<typeof head>[0] = {}) => `${head(o)}\n請處理這件事`
const done = ($: any, answer: string, reason = 'answer', turnId = 't1', extra: object = {}) =>
  $.turn.complete({ answer, durationMs: 1, isAborted: reason === 'aborted', turnId, reason, ...extra })

test('來信 reply=yes：做完自動寄回（--reply-to id、--no-reply）', OPT, async ($, on) => {
  const r = await rig($, on)
  await $.turn.start({ text: mail(), turnId: 't1' })
  await done($, '處理好了')
  expect(r.ran).toEqual([[CLI, 'send', '--to', 'W/W-政策', '--body', '處理好了', '--no-reply', '--reply-to', ID]])
})

test('答案是問句：--reply 並加「（對方在問）」', OPT, async ($, on) => {
  const r = await rig($, on)
  await $.turn.start({ text: mail(), turnId: 't1' })
  await done($, '要用 A 還是 B？')
  expect(r.ran).toEqual([[CLI, 'send', '--to', 'W/W-政策', '--body', '（對方在問）要用 A 還是 B？', '--reply', '--reply-to', ID]])
})

test('新版第三行：寄到行內位址、帶行內 id', OPT, async ($, on) => {
  const r = await rig($, on)
  await $.turn.start({ text: `[RELAY 來信] trust=member from=A/B to=C id=${ID} engine=claude reply=yes
寄件人：x
【要回信】回信位址=Z/Z-乙 信件編號=${ID2}：x
內文`, turnId: 't1' })
  await done($, 'ok')
  expect(r.ran).toEqual([[CLI, 'send', '--to', 'Z/Z-乙', '--body', 'ok', '--no-reply', '--reply-to', ID2]])
})

test('本人寄的信：回信位址 u:xxxx 原樣帶進 --to', OPT, async ($, on) => {
  const r = await rig($, on)
  await $.turn.start({ text: `${head({ from: 'u:ab12cd', trust: 'owner', sender: '小良（本人，帳號簽章已驗證，從「Oppo 手機」寄出）' })}
幫我查`, turnId: 't1' })
  await done($, '查好了')
  expect(r.ran).toEqual([[CLI, 'send', '--to', 'u:ab12cd', '--body', '查好了', '--no-reply', '--reply-to', ID]])
})

test('寄件人說明含「收發室」：當系統信，不寄', OPT, async ($, on) => {
  const r = await rig($, on)
  await $.turn.start({ text: `${head({ sender: '收發室（系統通知）' })}
逾時提醒`, turnId: 't1' })
  await done($, 'ok')
  expect(r.ran.length).toBe(0)
})

test('本輪已用 asn_send 回過：不重複寄', OPT, async ($, on) => {
  const r = await rig($, on)
  await $.turn.start({ text: mail(), turnId: 't1' })
  await $.tool.call({ tool: 'mcp__asn__asn_send', to: 'W/W-政策', body: 'hi', expects_reply: false, reply_to: ID } as never)
  expect(r.ran.length).toBe(1)
  await done($, '處理好了')
  expect(r.ran.length).toBe(1)
})

test('本輪已用 Bash send.mjs --reply-to 回過：不重複寄', OPT, async ($, on) => {
  const r = await rig($, on)
  await $.turn.start({ text: mail(), turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: `node send.mjs --to W/W-政策 --reply-to ${ID} --body hi --no-reply` } as never)
  await done($, '處理好了')
  expect(r.ran.length).toBe(0)
})

test('不該寄的輪次：reply=no、收發室系統信、使用者自己打字、子代理', OPT, async ($, on) => {
  const r = await rig($, on)
  await $.turn.start({ text: mail({ reply: 'no' }), turnId: 't1' })
  await done($, 'a', 'answer', 't1')
  await $.turn.start({ text: `${head({ from: '收發室/系統' })}\n通知`, turnId: 't2' })
  await done($, 'a', 'answer', 't2')
  await $.turn.start({ text: '幫我看一下', turnId: 't3' })
  await done($, 'a', 'answer', 't3')
  await $.turn.start({ text: mail(), turnId: 't4' })
  await $.turn.start({ text: mail(), turnId: 'ts', agentId: 'ag' })
  await done($, 'sub', 'answer', 'ts', { agentId: 'ag' })
  expect(r.ran.length).toBe(0)
})

test('aborted：寄中斷一行；Stop 有背景工作：不寄', OPT, async ($, on) => {
  const r = await rig($, on)
  await $.turn.start({ text: mail(), turnId: 't1' })
  await done($, '', 'aborted', 't1')
  expect(r.ran).toEqual([[CLI, 'send', '--to', 'W/W-政策', '--body', '這封信的處理中斷了', '--no-reply', '--reply-to', ID]])
  await $.turn.start({ text: mail(), turnId: 't2' })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b' }], session_crons: [] } as never)
  await done($, '先等背景', 'answer', 't2')
  expect(r.ran.length).toBe(1)
})

test('寄信失敗（非 0 結束、丟例外）不拋錯，事件照常通過', OPT, async ($, on) => {
  const r = await rig($, on, { failSend: true })
  await $.turn.start({ text: mail(), turnId: 't1' })
  const out = await done($, 'ok')
  expect(out).toBeDefined()
  expect(r.ran.length).toBe(1)
  expect(r.logs.join('\n')).toContain('自動回信失敗')
})

test('寄信丟例外也不拋錯', OPT, async ($, on) => {
  const r = await rig($, on, { throwSend: true })
  await $.turn.start({ text: mail(), turnId: 't1' })
  await done($, 'ok')
  expect(r.ran.length).toBe(1)
})
