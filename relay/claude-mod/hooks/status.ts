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
  // 背景工作列表（#539 之三）：只在 state 為 background 時寫；每筆只有代號、說明、類型，不存指令全文
  tasks?: TaskItem[]
  // 選擇框的問題和選項：只在 state 為 waiting_user 時寫（夥伴卡住太久時，收發室拿來通知本人）
  prompt?: QuestionPrompt
  // 最近一次跳權限框的工具名（只有名字，不寫指令內容）：夥伴卡住太久時，收發室拿來通知本人
  waitingTool?: string
}

export type QuestionPrompt = { question: string; options: string[] }

// st：這件背景工作現在在不在跑（#1368）。只有兩種值；'idle'＝$.agent.list 說閒置的子代理／teammate，其餘都是 'run'
export type TaskRun = 'run' | 'idle'
export type TaskItem = { id: string; desc: string; kind?: string; st: TaskRun }

// 外掛控制檔（control.ts）的執行結果：id 原樣回傳，detail 為中文且 ≤200 字（op:'command' 成功時放指令輸出，≤1500 字）
export type ControlResult = { id: string; ok: boolean; detail: string }
export type ContextUsage = { used: number; limit: number; percent: number }

export type CronLike = { schedule?: string; recurring?: boolean }
// agents：Stop 當下 $.agent.list() 的結果（#1368）；undefined＝拿不到（不存在、丟錯、逾時），退回只看 background_tasks
export type StopInfo = { background_tasks?: readonly unknown[]; session_crons?: readonly CronLike[]; agents?: readonly unknown[] }

// ---------- 背景工作列表（#539 之三） ----------
// Claude Code Stop hook 的 background_tasks 每筆是 BackgroundTaskSummary：
//   id、type（shell／subagent／monitor／workflow…）、status、description（≤1000 字），
//   選填 command（shell 的指令全文）、agent_type、server、tool、name、last_assistant_message。
// 這裡只取 id、description、type 三個字串欄位；command 與 last_assistant_message 一律不存（可能含金鑰或長內容）。
// 欄位不是字串、整筆不是物件就略過；說明壓成一行、遮掉像金鑰的字串、截到 MAX_DESC 字。
export const MAX_TASKS = 20
export const MAX_DESC = 60
const TASK_ID_RE = /^[\w.:-]{1,64}$/
const TASK_KIND_RE = /^[\w -]{1,24}$/
// 「token=…」「password: …」「Bearer …」只遮值、留下欄位名；看起來像金鑰的整段換成 ***
const SECRET_KV = /\b(token|api[_-]?key|key|secret|password|passwd|pwd|auth)(\s*[=:]\s*)\S+/gi
const SECRET_BEARER = /\b(bearer)(\s+)\S+/gi
const SECRET_RES: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[\w-]{8,}/g,
  /\bgh[pousr]_\w{10,}/g,
  /\bxox[abpr]-[\w-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\beyJ[\w-]{10,}(?:\.[\w-]+){0,2}/g,
  /[A-Za-z0-9_-]{32,}/g,
]
export function maskSecrets(text: string): string {
  const kv = text.replace(SECRET_KV, '$1$2***').replace(SECRET_BEARER, '$1$2***')
  return SECRET_RES.reduce((t, re) => t.replace(re, '***'), kv)
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
function clip(s: string, n: number): string {
  const cs = [...s]
  return cs.length > n ? `${cs.slice(0, n).join('')}…` : s
}
// ---------- 在跑／閒置（#1368） ----------
// background_tasks 只放 status 為 running／pending 的工作；teammate 一輪結束只把 isIdle 設成 true、status 仍是 running，
// 所以光看 background_tasks 分不出閒置。子代理與 teammate 的狀態改用 $.agent.list()：Claude Code 自己換算好的
// running／waiting／idle／completed（其他狀態原樣傳出，例如 pending／failed／killed）。
// 對應方式：background_tasks 的 type 是換過的名稱，子代理＝subagent、teammate＝teammate；這兩種整批由 agent.list 涵蓋
//（teammate 的任務代號和 agent.list 的 id 對不上，所以只看 type 不看 id）。其餘（shell、monitor、workflow…）照舊用 background_tasks，一律算在跑。
// agent.list 拿不到時退回舊做法：background_tasks 全部算在跑（子代理／teammate 也不扣），件數不少算。
export const AGENT_KINDS: ReadonlySet<string> = new Set(['subagent', 'teammate'])
const AGENT_RUN: ReadonlySet<string> = new Set(['running', 'waiting', 'pending'])
const AGENT_GONE: ReadonlySet<string> = new Set(['completed', 'failed', 'killed'])
export const AGENT_LIST_MS = 300

/** agent.list 每筆的 status → 在跑／閒置／已結束（不列不計）。沒看過的值算在跑，並記一筆 */
export function agentRun(status: unknown, note: (s: string) => void = noteInfo): TaskRun | 'gone' {
  if (status === 'idle') return 'idle'
  if (typeof status === 'string' && AGENT_GONE.has(status)) return 'gone'
  if (!(typeof status === 'string' && AGENT_RUN.has(status))) note(`[asn] 子代理狀態沒看過，當作在跑：${[...String(status)].slice(0, 40).join('')}`)
  return 'run'
}
function noteInfo(text: string): void {
  try {
    console.info(text)
  } catch {
    /* 吞掉 */
  }
}

/** Stop 時取 agent.list，最多等 AGENT_LIST_MS；不存在、丟錯、逾時、不是陣列都回 undefined（退回舊做法）並記一筆原因。
 * 上限一定有效：agent.list、$.clock.sleep、setTimeout 三者一起比，任一個上限先到就算逾時；結束後清掉 setTimeout。
 * sleep 失敗只是少一個計時，不算逾時；setTimeout 不能用時就靠 sleep。 */
export async function agentsWithin(list: () => unknown, sleep: (ms: number) => Promise<unknown>, note: (s: string) => void = noteInfo): Promise<readonly unknown[] | undefined> {
  const TIMEOUT = Symbol('timeout')
  const never = new Promise<never>(() => undefined)
  const bySleep = Promise.resolve()
    .then(() => sleep(AGENT_LIST_MS))
    .then(() => TIMEOUT, () => never)
  let handle: ReturnType<typeof setTimeout> | undefined
  const byTimer = new Promise<symbol>(r => {
    try {
      handle = setTimeout(() => r(TIMEOUT), AGENT_LIST_MS)
    } catch {
      /* 沒有 setTimeout：只靠 sleep */
    }
  })
  try {
    const r = await Promise.race([Promise.resolve().then(list), bySleep, byTimer])
    if (r === TIMEOUT) return void note('[asn] 子代理清單逾時，背景工作全部當作在跑')
    if (!Array.isArray(r)) return void note('[asn] 子代理清單格式不對，背景工作全部當作在跑')
    return r
  } catch (err) {
    note(`[asn] 子代理清單拿不到，背景工作全部當作在跑：${err instanceof Error ? err.message : String(err)}`.slice(0, 200))
    return undefined
  } finally {
    try {
      if (handle !== undefined) clearTimeout(handle)
    } catch {
      /* 吞掉 */
    }
  }
}

type Entry = { o: Record<string, unknown>; desc: string; kind: string; st: TaskRun }
const objOf = (t: unknown): Record<string, unknown> | undefined => (t && typeof t === 'object' && !Array.isArray(t) ? (t as Record<string, unknown>) : undefined)

/** background_tasks＋agent.list → 每件工作（在跑的排前面）。agents 為 undefined＝退回舊做法。
 * 差額補算：background_tasks 裡 subagent／teammate 有 B 筆，agent.list 裡列得出來的（在跑＋閒置，不含已結束）有 A 筆；
 * B > A 時（id 對不上、漏列、或 agent.list 說已結束但 background_tasks 還在跑），從 background_tasks 補 B − A 筆算在跑，
 * 優先補 id 不在 agent.list 裡的，不夠再補其餘的。件數因此不會比 background_tasks 少。 */
export function taskEntries(bg: readonly unknown[] | undefined, agents?: readonly unknown[]): Entry[] {
  const tasks = (Array.isArray(bg) ? bg : []).flatMap(t => {
    const o = objOf(t)
    return o ? [{ o, desc: str(o.description), kind: str(o.type).trim(), st: 'run' as const }] : []
  })
  if (!Array.isArray(agents)) return tasks
  const fromAgents: Entry[] = agents.flatMap(a => {
    const o = objOf(a)
    if (!o) return []
    const st = agentRun(o.status)
    return st === 'gone' ? [] : [{ o, desc: str(o.description), kind: str(o.type).trim() || 'subagent', st }]
  })
  const bgAgents = tasks.filter(e => AGENT_KINDS.has(e.kind))
  const others = tasks.filter(e => !AGENT_KINDS.has(e.kind))
  const listed = new Set(fromAgents.map(e => str(e.o.id)).filter(Boolean))
  const shortfall = Math.max(0, bgAgents.length - fromAgents.length)
  const extra = [...bgAgents.filter(e => !listed.has(str(e.o.id))), ...bgAgents.filter(e => listed.has(str(e.o.id)))].slice(0, shortfall)
  const all = [...fromAgents, ...extra, ...others]
  return [...all.filter(e => e.st === 'run'), ...all.filter(e => e.st === 'idle')]
}

export function taskList(bg: readonly unknown[] | undefined, agents?: readonly unknown[]): TaskItem[] {
  return toItems(taskEntries(bg, agents))
}

function toItems(entries: readonly Entry[]): TaskItem[] {
  const out: TaskItem[] = []
  for (const e of entries) {
    if (out.length >= MAX_TASKS) break
    const id = TASK_ID_RE.test(str(e.o.id)) ? str(e.o.id) : ''
    const desc = clip(maskSecrets(e.desc.replace(/\s+/g, ' ').trim()), MAX_DESC)
    const kind = TASK_KIND_RE.test(e.kind) ? e.kind : ''
    if (!id && !desc && !kind) continue
    out.push(kind ? { id, desc, kind, st: e.st } : { id, desc, st: e.st })
  }
  return out
}

export function statusPath(home: string, sessionId: string): string {
  return `${home.replace(/[\\/]+$/, '')}/.asn/status/${sessionId}.json`
}

export function buildStatus(
  p: { sessionId: string; state: WinState; detail?: string; turnId?: string; version?: string },
  now: number,
  extra: { model?: string; context?: ContextUsage; control?: ControlResult; tasks?: TaskItem[]; prompt?: QuestionPrompt; waitingTool?: string } = {},
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
    ...(extra.prompt ? { prompt: extra.prompt } : {}),
    ...(extra.waitingTool ? { waitingTool: extra.waitingTool } : {}),
    ...(extra.tasks && extra.tasks.length ? { tasks: extra.tasks } : {}),
  }
}

// $.session.usage().context → {used, limit, percent}；三個都是數字才給，拿不到回 undefined
export function contextOf(u: unknown): ContextUsage | undefined {
  const c = (u as { context?: { tokens?: unknown; window?: unknown; percent?: unknown } } | undefined)?.context
  if (!c || typeof c.tokens !== 'number' || typeof c.window !== 'number' || !Number.isFinite(c.tokens) || !Number.isFinite(c.window) || c.window <= 0) return undefined
  const percent = typeof c.percent === 'number' && Number.isFinite(c.percent) ? c.percent : Math.round((c.tokens / c.window) * 100)
  return { used: c.tokens, limit: c.window, percent }
}

// 工具名只收一般字元，其他一律不寫
export function safeToolName(t: unknown): string | undefined {
  return typeof t === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(t) ? t : undefined
}

// 選擇框的第一題：問題最多 200 字，選項最多 6 個、各 40 字（狀態檔有大小上限）
export function questionPrompt(e: { questions?: unknown }): QuestionPrompt | undefined {
  const qs = Array.isArray(e.questions) ? e.questions : []
  const q0 = qs[0] as { question?: unknown; options?: unknown } | undefined
  const flat = (s: string, n: number) => [...s.replace(/\s+/g, ' ').trim()].slice(0, n).join('')
  const question = typeof q0?.question === 'string' ? flat(q0.question, 200) : ''
  if (!question) return undefined
  const opts = Array.isArray(q0?.options) ? q0.options : []
  const options = opts.map(o => (typeof (o as { label?: unknown })?.label === 'string' ? flat((o as { label: string }).label, 40) : '')).filter(Boolean).slice(0, 6)
  return { question, options }
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

// 「背景工作 N 件」N 只算在跑的；有閒置的接「・閒置 M 件」（全部閒置時是「背景工作 0 件・閒置 M 件」）。
// 件數算全部，不受列表只存 MAX_TASKS 筆影響
export function taskDetail(entries: readonly { st: TaskRun }[]): string {
  const idle = entries.filter(e => e.st === 'idle').length
  const run = entries.length - idle
  return idle > 0 ? `背景工作 ${run} 件・閒置 ${idle} 件` : `背景工作 ${run} 件`
}

// 一輪結束後的狀態。reason 不是 answer 一律 idle（中斷／出錯），不看 Stop 的資料。
export function finalState(reason: string, stop: StopInfo | undefined): { state: WinState; detail: string; tasks?: TaskItem[] } {
  if (reason === 'aborted') return { state: 'idle', detail: '中斷' }
  if (reason === 'error') return { state: 'idle', detail: '出錯' }
  const bg = stop?.background_tasks ?? []
  if (bg.length > 0) {
    // state 只看 background_tasks（跟以前一樣）；件數與列表加上 agent.list。合起來一件都沒有時（兩邊對不上）退回舊做法，不顯示 0 件
    const merged = taskEntries(bg, stop?.agents)
    const entries = merged.length > 0 ? merged : taskEntries(bg)
    return { state: 'background', detail: taskDetail(entries), tasks: toItems(entries) }
  }
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
  let last: { state: WinState; detail: string; tasks?: TaskItem[]; prompt?: QuestionPrompt; waitingTool?: string } = { state: 'idle', detail: '' }
  let kept: { path: string; doc: StatusDoc } | undefined // 最近一次實際寫出去的內容（心跳只換 at）

  // 寫檔排進同一條鏈，順序不亂
  const write = (io: Io, state: WinState, detail: string, tasks?: TaskItem[], prompt?: QuestionPrompt, waitingTool?: string): Promise<unknown> => {
    last = { state, detail, tasks, prompt, waitingTool }
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
        const doc = buildStatus({ sessionId: sid, state, detail, turnId, version }, clock(), { model, context, control, tasks, prompt, waitingTool })
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
    void write(io, f.state, f.detail, f.tasks)
  }

  return {
    write,
    // 控制檔執行完：記下結果並用目前的狀態重寫一次（其餘欄位照舊）
    setControl(io: Io, r: ControlResult): Promise<unknown> {
      control = r
      return write(io, last.state, last.detail, last.tasks, last.prompt, last.waitingTool)
    },
    // 權限框回答了：工具名清掉，不然下一個框會帶到舊的
    clearWaitingTool(io: Io): Promise<unknown> {
      return last.waitingTool ? write(io, last.state, last.detail, last.tasks, last.prompt) : chain
    },
    // 跳權限框：記下工具名，其餘欄位照舊（狀態有變動時這個欄位就清掉）
    setWaitingTool(io: Io, tool: unknown): Promise<unknown> {
      const name = safeToolName(tool)
      return name ? write(io, last.state, last.detail, last.tasks, last.prompt, name) : chain
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
      stop = { background_tasks: e.background_tasks, session_crons: e.session_crons, agents: e.agents }
      if (ended === 'answer') settle(io)
    },
    turnComplete(io: Io, reason: string): void {
      ended = reason
      settle(io)
    },
  }
}
