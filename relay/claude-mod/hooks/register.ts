import type { Register } from 'claude-code'
import { bashRepliedTo, buildSendArgv, guardBash, planAutoReply, resolveCli, sendRepliedTo, startNotice, trackFromText, type ReplyTrack, type StopLike } from './lib'
import { createStatus, questionDetail } from './status'

const TOOL = 'mcp__asn__asn_send'

export const register: Register = (on, options) => {
  const str = (k: string): string => (typeof options[k] === 'string' ? (options[k] as string) : '')
  const st = createStatus() // 視窗狀態檔，見 status.ts
  // 來信輪次自動回信（見 README「第三期」）：turn.start 記下來信、本輪寄過就標已回、turn.complete 才寄
  let track: ReplyTrack | undefined
  let replied = false
  let stopSeen: StopLike | undefined
  const cfg = () => ({ asnCliPath: str('asn_cli_path'), sendMjsPath: str('send_mjs_path'), nodePath: str('node_path') })

  on('session.start', async ($, e, next) => {
    st.sessionStart({ home: async () => (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')), read: p => $.fs.read(p), write: (p, t) => $.fs.write(p, t), sid: () => $.session.id(), log: t => $.ui.log(t), root: $.plugin.root })
    await $.tool.register({
      name: 'asn_send',
      isDeferred: false,
      description:
        '寄信給 ASN 收發室的成員或群組。寄給成員（to）一定要明說 expects_reply：true＝我在等對方回信（會計時提醒），false＝只是告知。群組用 room（與 to 二選一，不計時）。回信時帶 reply_to（信件 id）。',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '成員代號或 節點/視窗名；與 room 二選一' },
          room: { type: 'string', description: '群組 id；與 to 二選一' },
          body: { type: 'string', description: '內文' },
          expects_reply: { type: 'boolean', description: '寄給 to 時必填：true＝等回信、false＝只是告知' },
          reply_to: { type: 'string', description: '回信時帶被回的信件 id（uuid），選填' },
        },
        required: ['body'],
      },
    })
    return next(e)
  })

  // 這台有 ASN 與 asn 技能的提示：放系統提示（每次請求都帶；/clear 後 session.start 不再觸發、append 的列也會被清掉或壓縮摘掉）
  let versionP: Promise<string> | undefined
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    versionP ??= $.fs
      .read(`${$.plugin.root}/.claude-plugin/plugin.json`)
      .then(t => String(JSON.parse(String(t)).version ?? ''))
      .catch(() => '')
    const version = await versionP
    return { ...r, sections: [...r.sections, { id: 'asn:installed', scope: 'session' as const, text: startNotice(version) }] }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const c = await resolveCli(cfg(), () => $.env.get('LOCALAPPDATA'), p => $.fs.stat(p) as never)
    const built = buildSendArgv(e as never, c)
    if ('error' in built) return { result: `asn_send 失敗：${built.error}`, isError: true } as never
    const r = await $.process.run(built.argv, { timeoutMs: 60000 })
    const ok = r.exitCode === 0
    if (ok && track && sendRepliedTo(e as never, track)) replied = true
    const text = ok ? r.stdout.trim() : `asn_send 失敗（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`
    return { result: text, ...(ok ? {} : { isError: true }) } as never
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'asn_send 發生內部錯誤' }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const why = guardBash(e.command)
    if (why) return { deny: why }
    const r = await next(e)
    if (track && bashRepliedTo(e.command, track) && !(r as { isError?: boolean } | undefined)?.isError) replied = true
    return r
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'asn 寄信守門發生內部錯誤' }))

  // ───── 視窗狀態檔（只看主迴圈 e.agentId === undefined；全部純觀察、一律 next(e)）─────
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      replied = false
      stopSeen = undefined
      track = trackFromText(e.text, e.turnId)
    }
    if (e.agentId === undefined) st.turnStart({ home: async () => (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')), read: p => $.fs.read(p), write: (p, t) => $.fs.write(p, t), sid: () => $.session.id(), log: t => $.ui.log(t), root: $.plugin.root }, e.turnId)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', ($, e, next) => {
    stopSeen = { background_tasks: e.background_tasks, session_crons: e.session_crons }
    st.stop({ home: async () => (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')), read: p => $.fs.read(p), write: (p, t) => $.fs.write(p, t), sid: () => $.session.id(), log: t => $.ui.log(t), root: $.plugin.root }, e)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) st.turnComplete({ home: async () => (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')), read: p => $.fs.read(p), write: (p, t) => $.fs.write(p, t), sid: () => $.session.id(), log: t => $.ui.log(t), root: $.plugin.root }, e.reason)
    const t = e.agentId === undefined && track && track.turnId === e.turnId ? track : undefined
    if (t) {
      track = undefined
      try {
        // classic.Stop 與 turn.complete 的先後沒保證：Stop 還沒到就稍等一下再判斷有沒有背景工作
        if (e.reason === 'answer' && stopSeen === undefined) await $.clock.sleep(600).catch(() => undefined)
        const plan = planAutoReply(e.reason, e.answer, stopSeen, replied)
        if ('body' in plan) {
          const c = await resolveCli(cfg(), () => $.env.get('LOCALAPPDATA'), p => $.fs.stat(p) as never)
          const built = buildSendArgv({ to: t.from, body: plan.body, expects_reply: plan.expects_reply, reply_to: t.id }, c)
          if ('error' in built) $.ui.log(`asn 自動回信略過：${built.error}`)
          else {
            const r = await $.process.run(built.argv, { timeoutMs: 60000 })
            if (r.exitCode !== 0) $.ui.log(`asn 自動回信失敗（exit ${r.exitCode}）`)
          }
        }
      } catch (err) {
        try {
          $.ui.log(`asn 自動回信失敗：${err instanceof Error ? err.message : String(err)}`)
        } catch {
          /* 吞掉 */
        }
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const isMain = e.agentId === undefined
    const io = { home: async () => (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')), read: (p: string) => $.fs.read(p), write: (p: string, t: string) => $.fs.write(p, t), sid: () => $.session.id(), log: (t: string) => $.ui.log(t), root: $.plugin.root }
    if (isMain) void st.write(io, 'waiting_user', questionDetail(e as never))
    try {
      return await next(e)
    } finally {
      if (isMain) void st.write(io, 'busy', '')
    }
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    // 引擎給 session.end 約 1.5 秒：等寫完再放行
    await st.write({ home: async () => (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')), read: p => $.fs.read(p), write: (p, t) => $.fs.write(p, t), sid: () => $.session.id(), log: t => $.ui.log(t), root: $.plugin.root }, 'idle', '已結束')
    return next(e)
  }).catch(($, e, next) => next(e))
}
