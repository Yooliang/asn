import { expect, test } from 'claude-code/testing'
import { CONTROL_MAX_AGE_MS, controlPath, createControl, parseControl, validSessionId, type ControlIo } from './control'
import { contextOf, createStatus } from './status'

// 不經引擎：直接用假的 Io 驅動 createControl＋createStatus，檢查寫出的狀態檔與有沒有執行指令
const SID = 'sess-1'
const NOW = 1_800_000_000_000
type Doc = Record<string, unknown>

const rig = (o: { control?: string | (() => string); sid?: string; runFails?: boolean; runText?: string; model?: string; usage?: unknown; now?: number } = {}) => {
  const writes: Doc[] = []
  const reads: string[] = []
  const runs: { command: string; args: string }[] = []
  const st = createStatus()
  const ctl = createControl(st)
  const io: ControlIo = {
    home: async () => 'C:/Users/u',
    sid: async () => o.sid ?? SID,
    read: async (p: string) => {
      reads.push(p)
      if (p.endsWith('plugin.json')) return JSON.stringify({ version: '9.8.7' })
      if (o.control === undefined) throw new Error('ENOENT')
      return typeof o.control === 'function' ? o.control() : o.control
    },
    write: async (_p: string, t: string) => void writes.push(JSON.parse(t)),
    log: () => undefined,
    root: '/root',
    model: o.model === undefined ? undefined : async () => o.model as string,
    usage: o.usage === undefined ? undefined : async () => o.usage,
    run: async (command: string, args: string) => {
      runs.push({ command, args })
      if (o.runFails) throw new Error('boom')
      return { text: o.runText ?? '' }
    },
    now: () => o.now ?? NOW,
  }
  return { st, ctl, io, writes, reads, runs, last: () => writes[writes.length - 1] }
}
const req = (extra: Doc = {}) => JSON.stringify({ id: 'r1', op: 'rename', arg: '新名字', at: NOW - 1000, ...extra })

test('純函式：sessionId 格式、路徑、解析', () => {
  expect(validSessionId('abc-DEF_123')).toBe(true)
  for (const bad of ['', '../x', 'a/b', 'a.b', 'a b', 'x'.repeat(129), 5, undefined]) expect(validSessionId(bad)).toBe(false)
  expect(validSessionId('x'.repeat(128))).toBe(true)
  expect(controlPath('C:\\Users\\u\\', 'a')).toBe('C:\\Users\\u/.asn/control/a.json')
  expect(parseControl(req(), NOW)).toEqual({ kind: 'run', id: 'r1', op: 'rename', command: 'rename', args: '新名字' })
  expect(parseControl('{壞掉', NOW)).toEqual({ kind: 'ignore' })
  expect(parseControl('[]', NOW)).toEqual({ kind: 'ignore' })
  expect(contextOf({ context: { tokens: 50, window: 200, percent: 25 } })).toEqual({ used: 50, limit: 200, percent: 25 })
  expect(contextOf({ context: { tokens: 50, window: 200 } })).toEqual({ used: 50, limit: 200, percent: 25 })
  expect(contextOf({ context: { window: 200 } })).toBeUndefined()
  expect(contextOf(undefined)).toBeUndefined()
})

test('合法 rename：執行 /rename、狀態檔加 control，id 原樣回傳', async () => {
  const r = rig({ control: req() })
  await r.ctl.poll(r.io)
  expect(r.runs).toEqual([{ command: 'rename', args: '新名字' }])
  expect(r.reads[0].replace(/\\/g, '/')).toBe('C:/Users/u/.asn/control/sess-1.json')
  expect(r.last()).toMatchObject({ sessionId: SID, control: { id: 'r1', ok: true } })
  expect(String((r.last().control as { detail: string }).detail).length).toBeLessThanOrEqual(200)
})

test('合法 model：執行 /model', async () => {
  const r = rig({ control: req({ id: 'm1', op: 'model', arg: 'opus[1m]' }) })
  await r.ctl.poll(r.io)
  expect(r.runs).toEqual([{ command: 'model', args: 'opus[1m]' }])
  expect(r.last()).toMatchObject({ control: { id: 'm1', ok: true } })
})

test('過期的 at（超過 2 分鐘）：忽略，不執行、不寫檔', async () => {
  const r = rig({ control: req({ at: NOW - CONTROL_MAX_AGE_MS - 1 }) })
  await r.ctl.poll(r.io)
  expect(r.runs).toEqual([])
  expect(r.writes).toEqual([])
  // 剛好 2 分鐘內仍有效
  const ok = rig({ control: req({ at: NOW - CONTROL_MAX_AGE_MS }) })
  await ok.ctl.poll(ok.io)
  expect(ok.runs.length).toBe(1)
})

test('同一個 id 不重複執行（連續輪詢讀到同一份）', async () => {
  const r = rig({ control: req() })
  await r.ctl.poll(r.io)
  await r.ctl.poll(r.io)
  await r.ctl.poll(r.io)
  expect(r.runs.length).toBe(1)
  expect(r.writes.filter(w => w.control).length).toBe(1)
})

test('新的 id 會再執行', async () => {
  let cur = req()
  const r = rig({ control: () => cur })
  await r.ctl.poll(r.io)
  cur = req({ id: 'r2', arg: '另一個' })
  await r.ctl.poll(r.io)
  expect(r.runs.map(x => x.args)).toEqual(['新名字', '另一個'])
  expect(r.last()).toMatchObject({ control: { id: 'r2', ok: true } })
})

test('壞 JSON、檔案不存在：安靜忽略，不拋錯', async () => {
  for (const control of ['{"id":', '', 'null', undefined] as const) {
    const r = rig({ control })
    await r.ctl.poll(r.io)
    expect(r.runs).toEqual([])
    expect(r.writes).toEqual([])
  }
})

test('非法 sessionId：連控制檔都不讀、不執行', async () => {
  for (const sid of ['../evil', 'a/b', 'x'.repeat(129), '']) {
    const r = rig({ sid, control: req() })
    await r.ctl.poll(r.io)
    expect(r.reads).toEqual([])
    expect(r.runs).toEqual([])
    expect(r.writes).toEqual([])
  }
})

test('未知 op／參數不合法：回 ok:false 與中文 detail，不執行', async () => {
  const cases: Doc[] = [{ op: 'delete' }, { op: undefined }, { arg: '' }, { arg: '   ' }, { arg: 5 }, { arg: 'a\nb' }, { arg: 'x'.repeat(101) }, { op: 'model', arg: 'bad model; rm -rf' }]
  for (const [i, c] of cases.entries()) {
    const r = rig({ control: req({ id: `bad${i}`, ...c }) })
    await r.ctl.poll(r.io)
    expect(r.runs).toEqual([])
    const ctrl = r.last().control as { id: string; ok: boolean; detail: string }
    expect(ctrl.id).toBe(`bad${i}`)
    expect(ctrl.ok).toBe(false)
    expect(ctrl.detail).toMatch(/[\u4e00-\u9fff]/)
    expect(ctrl.detail.length).toBeLessThanOrEqual(200)
  }
})

test('指令執行失敗：ok:false，detail 不超過 200 字', async () => {
  const r = rig({ control: req(), runFails: true })
  await r.ctl.poll(r.io)
  const ctrl = r.last().control as { ok: boolean; detail: string }
  expect(ctrl.ok).toBe(false)
  expect(ctrl.detail).toContain('執行失敗')
})

test('狀態檔保留舊欄位、加上 control；之後的狀態更新仍保留 control', async () => {
  const r = rig({ control: req(), model: 'claude-opus-5', usage: { context: { tokens: 1000, window: 200000, percent: 1 } } })
  await r.st.write(r.io, 'busy', '做事中')
  await r.ctl.poll(r.io)
  expect(r.last()).toMatchObject({
    sessionId: SID, state: 'busy', detail: '做事中', plugin: 'asn@9.8.7', model: 'claude-opus-5',
    context: { used: 1000, limit: 200000, percent: 1 }, control: { id: 'r1', ok: true },
  })
  expect(typeof r.last().at).toBe('number')
  await r.st.write(r.io, 'idle', '')
  expect(r.last()).toMatchObject({ state: 'idle', control: { id: 'r1', ok: true } })
})

test('model／context 拿不到就不寫這兩欄', async () => {
  const r = rig({ usage: { context: { window: 200000 } } })
  await r.st.write(r.io, 'idle', '')
  expect('model' in r.last()).toBe(false)
  expect('context' in r.last()).toBe(false)
  expect('control' in r.last()).toBe(false)
})

const cmd = (extra: Doc = {}) => JSON.stringify({ id: 'c1', op: 'command', command: 'status', at: NOW - 1000, ...extra })

test('command：執行任意 / 指令，detail 放輸出文字（保留換行、截 1500 字）', async () => {
  const r = rig({ control: cmd({ command: 'model', args: ' opus ' }), runText: '第一行\n第二行' })
  await r.ctl.poll(r.io)
  expect(r.runs).toEqual([{ command: 'model', args: 'opus' }])
  expect(r.last()).toMatchObject({ control: { id: 'c1', ok: true, detail: '第一行\n第二行' } })
  const long = rig({ control: cmd(), runText: '字'.repeat(3000) })
  await long.ctl.poll(long.io)
  expect(long.runs).toEqual([{ command: 'status', args: '' }])
  expect([...(long.last().control as { detail: string }).detail].length).toBe(1500)
  const quiet = rig({ control: cmd({ command: 'compact' }) })
  await quiet.ctl.poll(quiet.io)
  expect(quiet.last()).toMatchObject({ control: { ok: true, detail: '已執行 /compact' } })
})

test('command：指令被拒（未知指令）→ ok:false 帶原因', async () => {
  const r = rig({ control: cmd({ command: 'nope' }), runFails: true })
  await r.ctl.poll(r.io)
  expect(r.last()).toMatchObject({ control: { id: 'c1', ok: false } })
  expect((r.last().control as { detail: string }).detail).toContain('boom')
})

test('command：名稱或參數不合法 → ok:false，不執行', async () => {
  const cases: Doc[] = [{ command: '/model' }, { command: '' }, { command: undefined }, { command: 'a b' }, { command: 'x'.repeat(65) }, { command: 'rm;ls' }, { args: 5 }, { args: 'a\u0007b' }, { args: 'x'.repeat(2001) }]
  for (const [i, c] of cases.entries()) {
    const r = rig({ control: cmd({ id: `cb${i}`, ...c }) })
    await r.ctl.poll(r.io)
    expect(r.runs).toEqual([])
    expect(r.last()).toMatchObject({ control: { id: `cb${i}`, ok: false } })
  }
  const ok = rig({ control: cmd({ command: 'plugin:do-thing_2', args: 'x'.repeat(2000) }) })
  await ok.ctl.poll(ok.io)
  expect(ok.runs.length).toBe(1)
})

test('command：過期與重複 id 規則沿用', async () => {
  const old = rig({ control: cmd({ at: NOW - CONTROL_MAX_AGE_MS - 1 }) })
  await old.ctl.poll(old.io)
  expect(old.runs).toEqual([])
  const r = rig({ control: cmd() })
  await r.ctl.poll(r.io)
  await r.ctl.poll(r.io)
  expect(r.runs.length).toBe(1)
})

// 模擬引擎：$.command.run 排到閒置才跑，真正執行前會經過外掛的 command.run hook（gate）
const queued = (r: ReturnType<typeof rig>, before: () => void, after: () => void = () => undefined) => {
  const ran: string[] = []
  r.io.run = async (command: string, args: string) => {
    before()
    if (!(await r.ctl.gate(r.io, { command, args, origin: { kind: 'plugin' } }))) return { text: '沒有執行' }
    ran.push(command)
    after()
    return { text: '輸出' }
  }
  return ran
}

test('執行前控制檔已被橋刪掉：不執行、不寫結果', async () => {
  let file: string | undefined = cmd()
  const r = rig({ control: () => { if (file === undefined) throw new Error('ENOENT'); return file } })
  const ran = queued(r, () => { file = undefined })
  await r.ctl.poll(r.io)
  expect(ran).toEqual([])
  expect(r.writes).toEqual([])
})

test('執行前控制檔換成別的 id：不執行、不寫結果', async () => {
  let file = cmd()
  const r = rig({ control: () => file })
  const ran = queued(r, () => { file = cmd({ id: 'c2' }) })
  await r.ctl.poll(r.io)
  expect(ran).toEqual([])
  expect(r.writes.filter(w => (w.control as { id?: string } | undefined)?.id === 'c1')).toEqual([])
})

test('執行中橋放棄（跑完控制檔已不在）：照樣寫結果，detail 開頭加註', async () => {
  let file: string | undefined = req()
  const r = rig({ control: () => { if (file === undefined) throw new Error('ENOENT'); return file } })
  const ran = queued(r, () => undefined, () => { file = undefined })
  await r.ctl.poll(r.io)
  expect(ran).toEqual(['rename'])
  const c = r.last().control as { id: string; ok: boolean; detail: string }
  expect(c).toMatchObject({ id: 'r1', ok: true })
  expect(c.detail.startsWith('（橋已放棄等待）')).toBe(true)
})

test('控制檔還在：正常執行，detail 不加註', async () => {
  const r = rig({ control: cmd() })
  const ran = queued(r, () => undefined)
  await r.ctl.poll(r.io)
  expect(ran).toEqual(['status'])
  expect(r.last()).toMatchObject({ control: { id: 'c1', ok: true, detail: '輸出' } })
})

test('gate 只管自己排的那一筆：使用者自己打的、別的指令、沒有排隊中的一律放行', async () => {
  const r = rig({ control: () => { throw new Error('ENOENT') } })
  // 沒有排隊中的：控制檔不在也放行
  expect(await r.ctl.gate(r.io, { command: 'status', args: '', origin: { kind: 'plugin' } })).toBe(true)
  const c = rig({ control: cmd() })
  let inner: boolean[] = []
  c.io.run = async (command: string, args: string) => {
    // 排隊中但控制檔已不在：只有「外掛來源＋同指令同參數」會被擋
    c.io.read = async () => { throw new Error('ENOENT') }
    inner = [
      await c.ctl.gate(c.io, { command, args, origin: { kind: 'composer' } }),
      await c.ctl.gate(c.io, { command: 'other', args, origin: { kind: 'plugin' } }),
      await c.ctl.gate(c.io, { command, args: 'x', origin: { kind: 'plugin' } }),
      await c.ctl.gate(c.io, { command, args, origin: { kind: 'plugin' } }),
    ]
    return { text: '' }
  }
  await c.ctl.poll(c.io)
  expect(inner).toEqual([true, true, true, false])
})
