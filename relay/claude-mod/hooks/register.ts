import type { Register } from 'claude-code'
import { buildSendArgv, guardBash } from './lib'

const TOOL = 'mcp__asn__asn_send'

export const register: Register = (on, options) => {
  const str = (k: string): string => (typeof options[k] === 'string' ? (options[k] as string) : '')
  const cfg = () => ({ asnCliPath: str('asn_cli_path'), sendMjsPath: str('send_mjs_path'), nodePath: str('node_path') })

  on('session.start', async ($, e, next) => {
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

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const built = buildSendArgv(e as never, cfg())
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
}
