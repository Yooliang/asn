// ASN pi 擴充（#135 第一期）：asn_send 寄信工具＋bash 守門。純邏輯在 lib.mjs。
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { buildSendArgv, guardAsnSendInput, guardBash, resolveConfig, runSend } from './lib.mjs'

function loadFileConfig(): Record<string, string> {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), 'asn.config.json')
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return {}
  }
}

export default function (pi: ExtensionAPI) {
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
