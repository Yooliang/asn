// ASN pi 擴充：第一期 asn_send 寄信工具＋bash 守門（lib.mjs）；第二期視窗登記＋收信（inbox.mjs）。
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { ackEntry, formatInjection, nextEntries, pruneDone, removeWindow, resolveWindowName, validSessionId, windowRecord, writeWindow } from './inbox.mjs'
import { nextRequests, pickModel, pruneControl, writeResult } from './control.mjs'
import { buildSendArgv, guardAsnSendInput, guardBash, resolveConfig, runSend } from './lib.mjs'

// 第二期的時間常數（見 README「資料流」）：登記心跳 60 秒、掃收件匣 2 秒、done/ 保留 7 天
const HEARTBEAT_MS = 60_000
const POLL_MS = 2_000
const DONE_KEEP_MS = 7 * 24 * 3600 * 1000

function loadFileConfig(): Record<string, string> {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), 'asn.config.json')
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return {}
  }
}

export default function (pi: ExtensionAPI) {
  registerInbox(pi)
  pi.registerTool({
    name: 'asn_send',
    label: 'ASN 寄信',
    description:
      '寄信給 ASN 收發室的成員或群組。寄給成員（to）一定要明說 expects_reply：true＝我在等對方回信（會計時提醒），false＝只是告知。群組用 room（與 to 二選一，不計時）。回信時帶 reply_to（信件 id）。',
    promptSnippet: '寄 ASN 收發室信件（成員或群組）',
    promptGuidelines: [
      '用 asn_send 寄 ASN 信，不要在 bash 裡自己組寄信命令；寄給 to 時 expects_reply 必填。',
    ],
    parameters: Type.Object({
      to: Type.Optional(Type.String({ description: '成員代號或 節點/視窗名；與 room 二選一' })),
      room: Type.Optional(Type.String({ description: '群組 id；與 to 二選一' })),
      body: Type.String({ description: '內文' }),
      expects_reply: Type.Optional(Type.Boolean({ description: '寄給 to 時必填：true＝等回信、false＝只是告知' })),
      reply_to: Type.Optional(Type.String({ description: '回信時帶被回的信件 id（uuid），選填' })),
    }),
    async execute(_id, params, signal) {
      const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {}, isError: true })
      const why = guardAsnSendInput(params)
      if (why) return fail(why)
      const built = buildSendArgv(params, resolveConfig(process.env, loadFileConfig()))
      if ('error' in built) return fail(`asn_send 失敗：${built.error}`)
      const r = await runSend(built.argv, execFile, { signal })
      if (!r.ok) return fail(r.text)
      return { content: [{ type: 'text' as const, text: r.text }], details: {} }
    },
  })

  pi.on('tool_call', async (event) => {
    if (event.toolName === 'bash') {
      const why = guardBash((event.input as { command?: string }).command ?? '')
      if (why) return { block: true, reason: why }
    } else if (event.toolName === 'asn_send') {
      const why = guardAsnSendInput(event.input)
      if (why) return { block: true, reason: why }
    }
  })
}

// ---- 第二期：讓互動中的 pi 變成 ASN 名單上可收信的視窗 ----
// 背景資源（計時器）只在 session_start 起、session_shutdown 清；只在互動（tui）與 rpc 模式登記，
// -p／json 是單次執行，不登記（見 README）。
function registerInbox(pi: ExtensionAPI) {
  const asnDir = join(homedir(), '.asn')
  const windowsDir = join(asnDir, 'pi-windows')
  const inboxDir = join(asnDir, 'pi-inbox')
  const controlDir = join(asnDir, 'pi-control')
  let timers: ReturnType<typeof setInterval>[] = []
  let sid = ''
  let state: 'idle' | 'busy' = 'idle'
  let beat: () => void = () => {}
  const seen = new Set<string>()
  const seenControl = new Set<string>()
  let controlBusy = false

  const stop = () => {
    for (const t of timers) clearInterval(t)
    timers = []
    beat = () => {}
    if (sid) removeWindow(windowsDir, sid)
    sid = ''
  }

  pi.on('session_start', async (_event, ctx) => {
    stop()
    if (ctx.mode !== 'tui' && ctx.mode !== 'rpc') return
    const id = String(ctx.sessionManager.getSessionId())
    if (!validSessionId(id)) return
    sid = id
    beat = () => {
      try {
        const name = resolveWindowName({ env: process.env, sessionName: pi.getSessionName(), cwd: ctx.cwd })
        writeWindow(windowsDir, windowRecord({ sessionId: id, name, pid: process.pid, cwd: ctx.cwd, state, model: ctx.model?.id, provider: ctx.model?.provider, at: Date.now() }))
      } catch {}
    }
    const poll = () => {
      try {
        for (const e of nextEntries(inboxDir, id, seen, 5)) {
          // 忙碌時排在整輪做完之後（followUp），不打斷進行中的工作；閒置時立刻開一輪
          pi.sendMessage(
            { customType: 'asn-mail', content: formatInjection(e), display: true, details: { id: e.id } },
            { triggerTurn: true, deliverAs: ctx.isIdle() ? undefined : 'followUp' },
          )
          ackEntry(inboxDir, id, e.id) // 已交給 pi 才標記處理過
          if (ctx.hasUI) ctx.ui.notify(`ASN 來信 ${e.id.slice(0, 8)}`, 'info')
        }
      } catch {}
    }
    // 第三期：遠端控制（目前只有 set_model）。橋把請求寫成檔案，這裡呼叫 pi.setModel 再把結果寫回檔案（見 control.mjs）。
    // 工作進行中不動（換模型換到一半的那一輪行為不明），等閒置再處理；橋端有逾時
    const pollControl = async () => {
      if (controlBusy || !ctx.isIdle()) return
      controlBusy = true
      try {
        for (const r of nextRequests(controlDir, id, seenControl, 3)) {
          let result: { ok: boolean; model?: string; provider?: string; error?: string; providers?: string[] }
          try {
            const picked = pickModel({ available: ctx.modelRegistry.getAvailable(), all: ctx.modelRegistry.getAll() }, r.provider, r.model)
            if ('error' in picked) result = { ok: false, error: picked.error, providers: picked.providers }
            else if (await pi.setModel(picked.model)) result = { ok: true, model: picked.model.id, provider: picked.model.provider }
            else result = { ok: false, error: 'no_api_key' }
          } catch {
            result = { ok: false, error: 'failed' }
          }
          writeResult(controlDir, id, r.id, result)
          beat() // 登記檔的 model 立刻更新
          if (ctx.hasUI && result.ok) ctx.ui.notify(`ASN 已切換模型：${result.model}`, 'info')
        }
      } catch {} finally {
        controlBusy = false
      }
    }
    beat()
    pruneDone(inboxDir, id, Date.now(), DONE_KEEP_MS)
    pruneControl(controlDir, id, Date.now(), DONE_KEEP_MS)
    timers.push(setInterval(() => beat(), HEARTBEAT_MS), setInterval(poll, POLL_MS), setInterval(() => void pollControl(), POLL_MS))
    for (const t of timers) t.unref?.()
    if (ctx.hasUI) ctx.ui.setStatus('asn', 'ASN 可收信')
  })

  pi.on('agent_start', async () => {
    state = 'busy'
    beat()
  })
  pi.on('agent_settled', async () => {
    state = 'idle'
    beat()
  })
  pi.on('session_shutdown', async () => stop())
}
