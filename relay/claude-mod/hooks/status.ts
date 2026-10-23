// 視窗狀態檔（#134 寫檔那半）：~/.asn/status/<sessionId>.json。
// 只看主迴圈；hook 在 register.ts 登記（引擎只認 register.ts 裡直接寫的 on(...)），全部純觀察、一律 next(e)；
// 這支只放狀態與寫檔，寫檔失敗吞掉。
// 引擎沒有 $.fs 刪除／改名：直接覆蓋（讀的一方讀到半份當沒有），session.end 寫 state:idle＋「已結束」。
//
// classic.Stop 與 turn.complete 的先後型別檔沒保證，所以不依賴順序：
// - turn.start 清空本輪暫存；classic.Stop 記下 background_tasks／session_crons；
// - turn.complete 立刻依「目前已收到的 Stop 資料」寫一次；之後若 Stop 才到（且該輪正常結束），重算再寫一次覆蓋。

export type WinState = 'busy' | 'idle' | 'waiting_user' | 'background' | 'scheduled'

export type StatusDoc = {
  sessionId: string
  state: WinState
  detail: string
  at: number
  turnId: string
  plugin: string
  // 以下三個是選填：拿得到才寫（見 PARTNER-OPS 第八節）
  model?: string
  context?: { used: number; limit: number; percent: number }
  control?: ControlResult
}

// 外掛控制檔（control.ts）的執行結果：id 原樣回傳，detail 為中文且 ≤200 字（op:'command' 成功時放指令輸出，≤1500 字）
export type ControlResult = { id: string; ok: boolean; detail: string }
export type ContextUsage = { used: number; limit: number; percent: number }

export type CronLike = { schedule?: string; recurring?: boolean }
export type StopInfo = { background_tasks?: readonly unknown[]; session_crons?: readonly CronLike[] }

export function statusPath(home: string, sessionId: string): string {
  return `${home.replace(/[\\/]+$/, '')}/.asn/status/${sessionId}.json`
}

export function buildStatus(
  p: { sessionId: string; state: WinState; detail?: string; turnId?: string; version?: string },
  now: number,
  extra: { model?: string; context?: ContextUsage; control?: ControlResult } = {},
): StatusDoc {
  return {
    sessionId: p.sessionId,
    state: p.state,
    detail: p.detail ?? '',
    at: now,
    turnId: p.turnId ?? '',
    plugin: `asn@${p.version || 'unknown'}`,
    ...(extra.model ? { model: extra.model } : {}),
    ...(extra.context ? { context: extra.context } : {}),
    ...(extra.control ? { control: extra.control } : {}),
  }
}

// $.session.usage().context → {used, limit, percent}；三個都是數字才給，拿不到回 undefined
export function contextOf(u: unknown): ContextUsage | undefined {
  const c = (u as { context?: { tokens?: unknown; window?: unknown; percent?: unknown } } | undefined)?.context
  if (!c || typeof c.tokens !== 'number' || typeof c.window !== 'number' || !Number.isFinite(c.tokens) || !Number.isFinite(c.window) || c.window <= 0) return undefined
  const percent = typeof c.percent === 'number' && Number.isFinite(c.percent) ? c.percent : Math.round((c.tokens / c.window) * 100)
  return { used: c.tokens, limit: c.window, percent }
}

export function questionDetail(e: { questions?: unknown }): string {
  const qs = Array.isArray(e.questions) ? e.questions : []
  const q = qs[0] && typeof (qs[0] as { question?: unknown }).question === 'string' ? (qs[0] as { question: string }).question : ''
  const flat = q.replace(/\s+/g, ' ').trim()
  return flat ? `AskUserQuestion：${[...flat].slice(0, 80).join('')}` : 'AskUserQuestion'
}

// 一次性喚醒的 cron 欄位就是單一觸發時間「分 時 日 月 *」；取得到時間就寫「ScheduleWakeup HH:MM」，否則寫件數
export function cronDetail(crons: readonly CronLike[]): string {
  for (const c of crons) {
    const m = !c.recurring && typeof c.schedule === 'string' ? /^(\d{1,2})\s+(\d{1,2})\s/.exec(c.schedule.trim()) : null
    if (m) return `ScheduleWakeup ${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`
  }
  return `排程 ${crons.length} 件`
}

// 一輪結束後的狀態。reason 不是 answer 一律 idle（中斷／出錯），不看 Stop 的資料。
export function finalState(reason: string, stop: StopInfo | undefined): { state: WinState; detail: string } {
  if (reason === 'aborted') return { state: 'idle', detail: '中斷' }
  if (reason === 'error') return { state: 'idle', detail: '出錯' }
  const bg = stop?.background_tasks ?? []
  if (bg.length > 0) return { state: 'background', detail: `背景工作 ${bg.length} 件` }
  const cr = stop?.session_crons ?? []
  if (cr.length > 0) return { state: 'scheduled', detail: cronDetail(cr) }
  return { state: 'idle', detail: '' }
}

// 引擎掃描器不許 $ 被當參數傳，所以 I/O 由 register.ts 每個 hook 在現場用 $.noun.event(...) 包成 Io 交進來
export type Io = {
  home: () => Promise<string | undefined>
  read: (path: string) => Promise<unknown>
  write: (path: string, text: string) => Promise<unknown>
  sid: () => Promise<string>
  log: (text: string) => void
  root: string
  // 選填：目前模型與上下文用量（拿不到就不寫這兩欄；任何錯誤都吞掉）
  model?: () => Promise<string>
  usage?: () => Promise<unknown>
}

// 狀態機＋寫檔。回傳的 promise 永不 reject；寫檔的任何錯誤只 log 一行。
// 心跳：狀態沒變時也至少每 5 分鐘重寫一次（只更新 at，內容照舊），橋看到的 at 才不會過期
export const HEARTBEAT_MS = 5 * 60 * 1000

export function createStatus(clock: () => number = Date.now) {
  let version: string | undefined
  let chain: Promise<unknown> = Promise.resolve()
  let turnId = ''
  let stop: StopInfo | undefined
  let ended: string | undefined // 本輪 turn.complete 的 reason；undefined＝還沒結束
  let control: ControlResult | undefined // 最近一次控制檔結果；之後每次寫檔都保留，橋只認 id
  let last: { state: WinState; detail: string } = { state: 'idle', detail: '' }
  let kept: { path: string; doc: StatusDoc } | undefined // 最近一次實際寫出去的內容（心跳只換 at）

  // 寫檔排進同一條鏈，順序不亂
  const write = (io: Io, state: WinState, detail: string): Promise<unknown> => {
    last = { state, detail }
    chain = chain
      .then(async () => {
        const home = await io.home()
        if (!home) return
        if (version === undefined) {
          version = await io
            .read(`${io.root}/.claude-plugin/plugin.json`)
            .then(t => String(JSON.parse(String(t)).version ?? ''))
            .catch(() => '')
        }
        const sid = await io.sid()
        const model = await Promise.resolve().then(() => io.model?.()).then(m => (typeof m === 'string' ? m : ''), () => '')
        const context = await Promise.resolve().then(() => io.usage?.()).then(contextOf, () => undefined)
        const doc = buildStatus({ sessionId: sid, state, detail, turnId, version }, clock(), { model, context, control })
        const path = statusPath(home, sid)
        await io.write(path, JSON.stringify(doc))
        kept = { path, doc }
      })
      .catch((err: unknown) => {
        try {
          io.log(`asn 狀態檔寫入失敗：${err instanceof Error ? err.message : String(err)}`)
        } catch {
          /* 吞掉 */
        }
      })
    return chain
  }
  const settle = (io: Io): void => {
    if (ended === undefined) return
    const f = finalState(ended, stop)
    void write(io, f.state, f.detail)
  }

  return {
    write,
    // 控制檔執行完：記下結果並用目前的狀態重寫一次（其餘欄位照舊）
    setControl(io: Io, r: ControlResult): Promise<unknown> {
      control = r
      return write(io, last.state, last.detail)
    },
    // 狀態沒變也定時重寫：只把 at 換成現在，其餘欄位照上次寫出去的內容。還沒寫過或還沒到 5 分鐘就不動
    heartbeat(io: Io): Promise<unknown> {
      if (!kept || clock() - kept.doc.at < HEARTBEAT_MS) return chain
      chain = chain
        .then(async () => {
          if (!kept || clock() - kept.doc.at < HEARTBEAT_MS) return
          const doc = { ...kept.doc, at: clock() }
          await io.write(kept.path, JSON.stringify(doc))
          kept = { path: kept.path, doc }
        })
        .catch((err: unknown) => {
          try {
            io.log(`asn 狀態檔心跳失敗：${err instanceof Error ? err.message : String(err)}`)
          } catch {
            /* 吞掉 */
          }
        })
      return chain
    },
    sessionStart(io: Io): void {
      turnId = ''
      stop = undefined
      ended = undefined
      void write(io, 'idle', '')
    },
    turnStart(io: Io, id: string): void {
      turnId = id
      stop = undefined
      ended = undefined
      void write(io, 'busy', '')
    },
    stop(io: Io, e: StopInfo): void {
      stop = { background_tasks: e.background_tasks, session_crons: e.session_crons }
      if (ended === 'answer') settle(io)
    },
    turnComplete(io: Io, reason: string): void {
      ended = reason
      settle(io)
    },
  }
}
