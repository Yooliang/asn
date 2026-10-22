// 外掛控制檔（PARTNER-OPS 第八節）：橋寫 ~/.asn/control/<sessionId>.json，外掛執行後把結果寫進狀態檔的 control 欄位。
// 只有純邏輯與 poll；I/O 由 register.ts 在現場用 $.noun.event(...) 包成 ControlIo 交進來。
// 不刪控制檔（橋會刪）；讀不到、JSON 壞掉一律安靜忽略，poll 永不 reject。
import type { ControlResult, Io } from './status'

export const CONTROL_MAX_AGE_MS = 2 * 60 * 1000
export const POLL_MS = 1500
const SID_RE = /^[A-Za-z0-9_-]{1,128}$/
const MODEL_RE = /^[A-Za-z0-9._:/\[\]-]{1,100}$/
const MAX_NAME = 100
const COMMAND_RE = /^[A-Za-z0-9:_-]{1,64}$/
const MAX_ARGS = 2000
const MAX_OUTPUT = 1500
const SEEN_MAX = 200

export type ControlRequest =
  | { kind: 'ignore' }
  | { kind: 'reject'; id: string; detail: string }
  | { kind: 'run'; id: string; op: 'rename' | 'model' | 'command'; command: string; args: string }

export function validSessionId(sid: unknown): sid is string {
  return typeof sid === 'string' && SID_RE.test(sid)
}

export function controlPath(home: string, sessionId: string): string {
  return `${home.replace(/[\\/]+$/, '')}/.asn/control/${sessionId}.json`
}

export function clip(text: string, max = 200): string {
  return [...text].slice(0, max).join('')
}

// 解析一份控制檔。壞掉、過期、沒有可回傳的 id 一律 ignore；有 id 但內容不合法才 reject（回 ok:false）。
export function parseControl(text: string, now: number): ControlRequest {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return { kind: 'ignore' }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { kind: 'ignore' }
  const { id, op, arg, at, command, args } = o as Record<string, unknown>
  if (typeof id !== 'string' || id === '' || [...id].length > 200) return { kind: 'ignore' }
  if (typeof at !== 'number' || !Number.isFinite(at) || now - at > CONTROL_MAX_AGE_MS) return { kind: 'ignore' }
  if (op === 'command') {
    // 從手機傳 / 指令：command 不含開頭斜線，args 可空（電腦端只轉本人簽章、以 / 開頭的信）
    if (typeof command !== 'string' || !COMMAND_RE.test(command)) return { kind: 'reject', id, detail: '指令名稱不合法（只收英數與 : _ -，上限 64 字，不含開頭斜線）' }
    if (args !== undefined && typeof args !== 'string') return { kind: 'reject', id, detail: '指令參數必須是文字' }
    const g = (args ?? '').trim()
    if ([...g].length > MAX_ARGS) return { kind: 'reject', id, detail: `指令參數太長（上限 ${MAX_ARGS} 字）` }
    if (/[\u0000-\u001f\u007f]/.test(g)) return { kind: 'reject', id, detail: '參數含有控制字元，不執行' }
    return { kind: 'run', id, op, command, args: g }
  }
  if (op !== 'rename' && op !== 'model') return { kind: 'reject', id, detail: clip(`不認得的操作：${typeof op === 'string' ? clip(op, 30) : '（空）'}`) }
  if (typeof arg !== 'string' || arg.trim() === '') return { kind: 'reject', id, detail: op === 'rename' ? '新名字不能是空的' : '模型名稱不能是空的' }
  const a = arg.trim()
  if (/[\u0000-\u001f\u007f]/.test(a)) return { kind: 'reject', id, detail: '參數含有控制字元，不執行' }
  if (op === 'rename' && [...a].length > MAX_NAME) return { kind: 'reject', id, detail: `新名字太長（上限 ${MAX_NAME} 字）` }
  if (op === 'model' && !MODEL_RE.test(a)) return { kind: 'reject', id, detail: '模型名稱格式不合法（只收英數與 . _ : / [ ] -，上限 100 字）' }
  return { kind: 'run', id, op, command: op, args: a }
}

export type ControlIo = Io & {
  run: (command: string, args: string) => Promise<unknown>
  now: () => number
}

type Writer = { setControl: (io: Io, r: ControlResult) => Promise<unknown> }

// command.run hook 看到的那一筆（只用到這三欄）
export type CommandRunLike = { command: string; args: string; origin?: { kind?: string } }

export const ABANDONED_NOTE = '橋已放棄等待'

export function createControl(st: Writer) {
  const seen: string[] = []
  let busy = false
  // 已交給 $.command.run、還沒跑完的那一筆（busy 保證同時只有一筆）；abandoned＝執行前發現橋已放棄、沒有執行
  let pending: { id: string; command: string; args: string; abandoned: boolean } | undefined
  const remember = (id: string): void => {
    seen.push(id)
    if (seen.length > SEEN_MAX) seen.shift()
  }

  // 控制檔還在、而且 id 相同（＝橋還在等這一筆）。讀不到、壞掉一律當不在。永不 reject
  const stillWanted = async (io: Io, id: string): Promise<boolean> => {
    try {
      const home = await io.home()
      if (!home) return false
      const sid = await io.sid()
      if (!validSessionId(sid)) return false
      const o = JSON.parse(await io.read(controlPath(home, sid))) as unknown
      return !!o && typeof o === 'object' && (o as { id?: unknown }).id === id
    } catch {
      return false
    }
  }

  // command.run hook 用：$.command.run 排到閒置才跑，橋可能已逾時刪掉控制檔。
  // 只管自己排進去的那一筆（來源是外掛、指令與參數相同）；回 true＝放行，false＝放棄不執行。永不 reject
  const gate = async (io: Io, e: CommandRunLike): Promise<boolean> => {
    const p = pending
    if (!p || p.abandoned || e.origin?.kind !== 'plugin' || e.command !== p.command || e.args !== p.args) return true
    if (await stillWanted(io, p.id)) return true
    p.abandoned = true
    return false
  }

  // 輪詢一次。回傳的 promise 永不 reject。
  const poll = async (io: ControlIo): Promise<void> => {
    if (busy) return
    busy = true
    try {
      const home = await io.home()
      if (!home) return
      const sid = await io.sid()
      if (!validSessionId(sid)) return
      const text = await io.read(controlPath(home, sid)).catch(() => undefined)
      if (typeof text !== 'string') return
      const req = parseControl(text, io.now())
      if (req.kind === 'ignore' || seen.includes(req.id)) return
      remember(req.id)
      if (req.kind === 'reject') {
        await st.setControl(io, { id: req.id, ok: false, detail: req.detail })
        return
      }
      let result: ControlResult
      const p = { id: req.id, command: req.command, args: req.args, abandoned: false }
      pending = p
      try {
        const r = (await io.run(req.command, req.args)) as { text?: unknown } | undefined
        // 執行前 gate 發現橋已放棄：指令沒跑，不寫結果
        if (p.abandoned) {
          io.log(`asn 控制檔 ${req.id}：${ABANDONED_NOTE}，未執行`)
          return
        }
        const raw = typeof r?.text === 'string' ? r.text.trim() : ''
        if (req.op === 'command') {
          // 指令輸出原樣（保留換行）截 MAX_OUTPUT 字；沒有輸出文字就說已執行
          result = { id: req.id, ok: true, detail: raw ? clip(raw, MAX_OUTPUT) : `已執行 /${req.command}` }
        } else {
          const said = raw.replace(/\s+/g, ' ')
          const base = req.op === 'rename' ? `已改名為「${clip(req.args, 60)}」` : `已切換模型為 ${req.args}`
          result = { id: req.id, ok: true, detail: clip(said ? `${base}：${said}` : base) }
        }
      } catch (err) {
        if (p.abandoned) return
        result = { id: req.id, ok: false, detail: clip(`執行失敗：${err instanceof Error ? err.message : String(err)}`) }
      } finally {
        pending = undefined
      }
      // 已經送出無法取消：跑完才發現橋放棄了，照樣寫結果，detail 開頭加註讓橋之後看得出來
      if (!(await stillWanted(io, req.id))) {
        result = { ...result, detail: clip(`（${ABANDONED_NOTE}）${result.detail}`, req.op === 'command' && result.ok ? MAX_OUTPUT : 200) }
      }
      await st.setControl(io, result)
    } catch (err) {
      try {
        io.log(`asn 控制檔處理失敗：${err instanceof Error ? err.message : String(err)}`)
      } catch {
        /* 吞掉 */
      }
    } finally {
      busy = false
    }
  }

  return { poll, gate }
}
