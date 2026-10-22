// 外掛控制檔（PARTNER-OPS 第八節）：橋寫 ~/.asn/control/<sessionId>.json，外掛執行後把結果寫進狀態檔的 control 欄位。
// 只有純邏輯與 poll；I/O 由 register.ts 在現場用 $.noun.event(...) 包成 ControlIo 交進來。
// 不刪控制檔（橋會刪）；讀不到、JSON 壞掉一律安靜忽略，poll 永不 reject。
import type { ControlResult, Io } from './status'

export const CONTROL_MAX_AGE_MS = 2 * 60 * 1000
export const POLL_MS = 1500
const SID_RE = /^[A-Za-z0-9_-]{1,128}$/
const MODEL_RE = /^[A-Za-z0-9._:/\[\]-]{1,100}$/
const MAX_NAME = 100
const SEEN_MAX = 200

export type ControlRequest =
  | { kind: 'ignore' }
  | { kind: 'reject'; id: string; detail: string }
  | { kind: 'run'; id: string; op: 'rename' | 'model'; arg: string }

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
  const { id, op, arg, at } = o as Record<string, unknown>
  if (typeof id !== 'string' || id === '' || [...id].length > 200) return { kind: 'ignore' }
  if (typeof at !== 'number' || !Number.isFinite(at) || now - at > CONTROL_MAX_AGE_MS) return { kind: 'ignore' }
  if (op !== 'rename' && op !== 'model') return { kind: 'reject', id, detail: clip(`不認得的操作：${typeof op === 'string' ? clip(op, 30) : '（空）'}`) }
  if (typeof arg !== 'string' || arg.trim() === '') return { kind: 'reject', id, detail: op === 'rename' ? '新名字不能是空的' : '模型名稱不能是空的' }
  const a = arg.trim()
  if (/[\u0000-\u001f\u007f]/.test(a)) return { kind: 'reject', id, detail: '參數含有控制字元，不執行' }
  if (op === 'rename' && [...a].length > MAX_NAME) return { kind: 'reject', id, detail: `新名字太長（上限 ${MAX_NAME} 字）` }
  if (op === 'model' && !MODEL_RE.test(a)) return { kind: 'reject', id, detail: '模型名稱格式不合法（只收英數與 . _ : / [ ] -，上限 100 字）' }
  return { kind: 'run', id, op, arg: a }
}

export type ControlIo = Io & {
  run: (command: string, args: string) => Promise<unknown>
  now: () => number
}

type Writer = { setControl: (io: Io, r: ControlResult) => Promise<unknown> }

export function createControl(st: Writer) {
  const seen: string[] = []
  let busy = false
  const remember = (id: string): void => {
    seen.push(id)
    if (seen.length > SEEN_MAX) seen.shift()
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
      try {
        const r = (await io.run(req.op, req.arg)) as { text?: unknown } | undefined
        const said = typeof r?.text === 'string' ? r.text.replace(/\s+/g, ' ').trim() : ''
        const base = req.op === 'rename' ? `已改名為「${clip(req.arg, 60)}」` : `已切換模型為 ${req.arg}`
        result = { id: req.id, ok: true, detail: clip(said ? `${base}：${said}` : base) }
      } catch (err) {
        result = { id: req.id, ok: false, detail: clip(`執行失敗：${err instanceof Error ? err.message : String(err)}`) }
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

  return { poll }
}
