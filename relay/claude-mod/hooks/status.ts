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
}

export type CronLike = { schedule?: string; recurring?: boolean }
export type StopInfo = { background_tasks?: readonly unknown[]; session_crons?: readonly CronLike[] }

export function statusPath(home: string, sessionId: string): string {
  return `${home.replace(/[\\/]+$/, '')}/.asn/status/${sessionId}.json`
}

export function buildStatus(
  p: { sessionId: string; state: WinState; detail?: string; turnId?: string; version?: string },
  now: number,
): StatusDoc {
  return {
    sessionId: p.sessionId,
    state: p.state,
    detail: p.detail ?? '',
    at: now,
    turnId: p.turnId ?? '',
    plugin: `asn@${p.version || 'unknown'}`,
  }
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
}

// 狀態機＋寫檔。回傳的 promise 永不 reject；寫檔的任何錯誤只 log 一行。
export function createStatus() {
  let version: string | undefined
  let chain: Promise<unknown> = Promise.resolve()
  let turnId = ''
  let stop: StopInfo | undefined
  let ended: string | undefined // 本輪 turn.complete 的 reason；undefined＝還沒結束

  // 寫檔排進同一條鏈，順序不亂
  const write = (io: Io, state: WinState, detail: string): Promise<unknown> => {
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
        const doc = buildStatus({ sessionId: sid, state, detail, turnId, version }, Date.now())
        await io.write(statusPath(home, sid), JSON.stringify(doc))
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
