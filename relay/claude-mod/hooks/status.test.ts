import { expect, test } from 'claude-code/testing'
import { buildStatus, createStatus, cronDetail, finalState, HEARTBEAT_MS, questionDetail, statusPath } from './status'

// 假引擎：env.get 給家目錄、fs.read 給 plugin.json、fs.write 收進 writes（可設成失敗）
const SID = 'sess-1'
const PATH = 'C:/Users/u/.asn/status/sess-1.json'
type Doc = { sessionId: string; state: string; detail: string; at: number; turnId: string; plugin: string }

const rig = async ($: any, on: any, opts: { failWrite?: boolean } = {}) => {
  const writes: { path: string; doc: Doc }[] = []
  on('env.get', () => ({ value: 'C:/Users/u' }) as never)
  on('session.id', () => ({ value: SID }) as never)
  on('fs.read', () => ({ value: JSON.stringify({ name: 'asn', version: '9.8.7' }) }) as never)
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    if (opts.failWrite) throw new Error('EACCES')
    writes.push({ path: e.path, doc: JSON.parse(e.text) })
    return { value: undefined } as never
  })
  on('tool.register', () => ({ value: { tool: 'mcp__asn__asn_send' } }) as never)
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', () => ({ sessionId: SID }) as never)
  on('classic.Stop', () => ({}) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('tool.call', () => ({ result: 'ok' }))
  // 寫檔在 hook 背後的鏈上跑：讓出幾輪等它落地
  const flush = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve()
    await new Promise(r => setTimeout(r, 20))
  }
  const last = () => writes[writes.length - 1]?.doc
  return { writes, flush, last }
}
const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

test('純函式：路徑、內容、詳情字串、最終狀態', () => {
  expect(statusPath('C:\\Users\\u\\', 'a')).toBe('C:\\Users\\u/.asn/status/a.json')
  expect(buildStatus({ sessionId: 'a', state: 'busy', turnId: 't', version: '1.2.3' }, 5)).toEqual({
    sessionId: 'a', state: 'busy', detail: '', at: 5, turnId: 't', plugin: 'asn@1.2.3',
  })
  expect(questionDetail({ questions: [{ question: 'x'.repeat(100) }] })).toBe(`AskUserQuestion：${'x'.repeat(80)}`)
  expect(cronDetail([{ schedule: '20 13 22 10 *', recurring: false }])).toBe('ScheduleWakeup 13:20')
  expect(cronDetail([{ schedule: '*/5 * * * *', recurring: true }, { recurring: true }])).toBe('排程 2 件')
  expect(finalState('answer', undefined)).toEqual({ state: 'idle', detail: '' })
  expect(finalState('aborted', { background_tasks: [{}] }).detail).toBe('中斷')
  expect(finalState('error', undefined).detail).toBe('出錯')
})

test('turn.start→busy（記 turnId、帶版本）、session.start→idle', async ($, on) => {
  const r = await rig($, on)
  await start($)
  await r.flush()
  expect(r.writes[0].path.replace(/\\/g, '/')).toBe(PATH) // Windows 上引擎會把斜線正規化成反斜線
  expect(r.last()?.state).toBe('idle')
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await r.flush()
  expect(r.last()).toMatchObject({ sessionId: SID, state: 'busy', turnId: 't1', plugin: 'asn@9.8.7' })
  expect(typeof r.last()?.at).toBe('number')
})

test('AskUserQuestion：waiting_user（問題前 80 字）→ 回來後 busy，且不改動工具呼叫', async ($, on) => {
  const r = await rig($, on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const q = 'Q'.repeat(120)
  const out = await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: q, header: 'h', options: [], multiSelect: false }] } as never)
  await r.flush()
  expect(out.deny).toBeUndefined()
  expect(typeof (out as { result: unknown }).result).toBe('string')
  const seq = r.writes.map(w => w.doc.state)
  expect(seq.slice(-2)).toEqual(['waiting_user', 'busy'])
  expect(r.writes.find(w => w.doc.state === 'waiting_user')?.doc.detail).toBe(`AskUserQuestion：${'Q'.repeat(80)}`)
})

test('turn.complete 沒有背景／排程→idle', async ($, on) => {
  const r = await rig($, on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [] } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await r.flush()
  expect(r.last()).toMatchObject({ state: 'idle', detail: '', turnId: 't1' })
})

test('有 background_tasks→background（Stop 先到）', async ($, on) => {
  const r = await rig($, on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: '1' }, { id: '2' }], session_crons: [] } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await r.flush()
  expect(r.last()).toMatchObject({ state: 'background', detail: '背景工作 2 件' })
})

test('有 session_crons→scheduled（Stop 晚到也會覆蓋 turn.complete 先寫的 idle）', async ($, on) => {
  const r = await rig($, on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await r.flush()
  expect(r.last()?.state).toBe('idle')
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [],
    session_crons: [{ id: 'c', schedule: '20 13 22 10 *', recurring: false, prompt: 'p' }],
  } as never)
  await r.flush()
  expect(r.last()).toMatchObject({ state: 'scheduled', detail: 'ScheduleWakeup 13:20' })
})

test('aborted／error→idle 並註明，不看 Stop 的背景資料', async ($, on) => {
  const r = await rig($, on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: '1' }] } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' })
  await r.flush()
  expect(r.last()).toMatchObject({ state: 'idle', detail: '中斷' })
  await $.turn.start({ text: 'again', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'error' })
  await r.flush()
  expect(r.last()).toMatchObject({ state: 'idle', detail: '出錯', turnId: 't2' })
})

test('子代理輪次不寫檔', async ($, on) => {
  const r = await rig($, on)
  await start($)
  await r.flush()
  const before = r.writes.length
  await $.turn.start({ text: 'sub', turnId: 'ts', agentId: 'agent-1' })
  await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 'ts', agentId: 'agent-1', reason: 'answer' })
  await $.tool.call({ tool: 'AskUserQuestion', agentId: 'agent-1', questions: [{ question: 'q', header: 'h', options: [], multiSelect: false }] } as never)
  await r.flush()
  expect(r.writes.length).toBe(before)
})

test('session.end→寫 idle／已結束（引擎沒有刪檔）', async ($, on) => {
  const r = await rig($, on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.session.end({ reason: 'other', sessionId: SID, resume: {} } as never)
  expect(r.last()).toMatchObject({ state: 'idle', detail: '已結束' })
})

test('寫檔失敗不拋錯、事件照常通過', async ($, on) => {
  const r = await rig($, on, { failWrite: true })
  await start($)
  const t = await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(t.turnId).toBe('t1')
  const out = await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'q', header: 'h', options: [], multiSelect: false }] } as never)
  expect(out.deny).toBeUndefined()
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.session.end({ reason: 'other', sessionId: SID, resume: {} } as never)
  await r.flush()
  expect(r.writes.length).toBe(0)
})

// 心跳：不經引擎，直接用假時鐘驅動 createStatus
test('心跳：狀態沒變、超過 5 分鐘才重寫 at，其餘欄位照舊', async () => {
  let now = 1_000_000
  const writes: { path: string; doc: Record<string, unknown> }[] = []
  const io = {
    home: async () => 'C:/Users/u',
    sid: async () => SID,
    read: async () => JSON.stringify({ version: '9.8.7' }),
    write: async (p: string, t: string) => void writes.push({ path: p, doc: JSON.parse(t) }),
    log: () => undefined,
    root: '/root',
    model: async () => 'opus',
  }
  const st = createStatus(() => now)
  await st.write(io, 'waiting_user', '等你回答')
  await st.heartbeat(io)
  expect(writes.length).toBe(1)
  now += HEARTBEAT_MS - 1
  await st.heartbeat(io)
  expect(writes.length).toBe(1)
  now += 1
  await st.heartbeat(io)
  expect(writes.length).toBe(2)
  expect(writes[1].path).toBe(writes[0].path)
  expect(writes[1].doc).toMatchObject({ state: 'waiting_user', detail: '等你回答', model: 'opus', at: now })
  await st.heartbeat(io)
  expect(writes.length).toBe(2)
})

test('心跳：還沒寫過狀態就不寫；寫入失敗不拋錯', async () => {
  let now = 0
  const writes: unknown[] = []
  const io = {
    home: async () => 'C:/Users/u',
    sid: async () => SID,
    read: async () => JSON.stringify({ version: '9.8.7' }),
    write: async (_p: string, t: string) => {
      writes.push(JSON.parse(t))
      throw new Error('EACCES')
    },
    log: () => undefined,
    root: '/root',
  }
  const st = createStatus(() => now)
  await st.heartbeat(io)
  expect(writes.length).toBe(0)
  now = 0
  await st.write(io, 'idle', '')
  now = 10 * 60 * 1000
  await st.heartbeat(io)
  // 寫入失敗沒有留下可重寫的內容，心跳不會再試
  expect(writes.length).toBe(1)
})
