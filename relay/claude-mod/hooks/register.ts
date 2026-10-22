import type { Register } from 'claude-code'
import { buildSendArgv, guardBash, startNotice } from './lib'
import { createStatus, questionDetail } from './status'

const TOOL = 'mcp__asn__asn_send'

export const register: Register = (on, options) => {
  const str = (k: string): string => (typeof options[k] === 'string' ? (options[k] as string) : '')
  const st = createStatus() // 視窗狀態檔，見 status.ts
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
    // 提示這台有 ASN 與 asn 技能；附不上（例如沒有對話可附）就算了，不影響開窗
    try {
      const version = await $.fs
        .read(`${$.plugin.root}/.claude-plugin/plugin.json`)
        .then(t => String(JSON.parse(String(t)).version ?? ''))
        .catch(() => '')
      await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: startNotice(version) }] } })
    } catch (err) {
      $.ui.log(`asn：開窗提示沒附上（${String(err)}）`)
    }
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const c = cfg()
    if (!c.asnCliPath.trim()) {
      // asn_cli_path 沒設：找安裝器的預設位置 LOCALAPPDATA 下 ASN 資料夾的 asn-cli.exe，存在才用，否則維持空（退 send.mjs）
      const base = await $.env.get('LOCALAPPDATA')
      if (base) {
        const guess = `${base.replace(/[\\/]+$/, '')}\\ASN\\asn-cli.exe`
        const st = await $.fs.stat(guess).catch(() => undefined)
        if (st && st.kind === 'file') c.asnCliPath = guess
      }
    }
    const built = buildSendArgv(e as never, c)
    if ('error' in built) return { result: `asn_send 失敗：${built.error}`, isError: true } as never
    const r = await $.process.run(built.argv, { timeoutMs: 60000 })
    const ok = r.exitCode === 0
    const text = ok ? r.stdout.trim() : `asn_send 失敗（exit ${r.exitCode}）：${(r.stderr || r.stdout).trim()}`
    return { result: text, ...(ok ? {} : { isError: true }) } as never
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'asn_send 發生內部錯誤' }))

  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const why = guardBash(e.command)
    return why ? { deny: why } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'asn 寄信守門發生內部錯誤' }))

  // ───── 視窗狀態檔（只看主迴圈 e.agentId === undefined；全部純觀察、一律 next(e)）─────
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) st.turnStart({ home: async () => (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')), read: p => $.fs.read(p), write: (p, t) => $.fs.write(p, t), sid: () => $.session.id(), log: t => $.ui.log(t), root: $.plugin.root }, e.turnId)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', ($, e, next) => {
    st.stop({ home: async () => (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')), read: p => $.fs.read(p), write: (p, t) => $.fs.write(p, t), sid: () => $.session.id(), log: t => $.ui.log(t), root: $.plugin.root }, e)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) st.turnComplete({ home: async () => (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')), read: p => $.fs.read(p), write: (p, t) => $.fs.write(p, t), sid: () => $.session.id(), log: t => $.ui.log(t), root: $.plugin.root }, e.reason)
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
