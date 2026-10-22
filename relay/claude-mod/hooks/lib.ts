// 純函式：組 argv、判斷 Bash 命令。不碰 $，方便測試。

export type SendInput = {
  to?: string
  room?: string
  body?: string
  expects_reply?: boolean
  reply_to?: string
}

export type SendConfig = {
  asnCliPath?: string
  sendMjsPath?: string
  nodePath?: string
}

// 本人簽章（ASN#118）：mod 寄出的信一律 trust=member，argv／環境／Bash 命令都不得出現這些。
const PERSON_RE = /as[_-]?person|x-asn-user|asn[_-]user|--person\b|person-sign|user[_-]?token/i

export function mentionsPersonSignature(text: string): boolean {
  return PERSON_RE.test(text)
}

export type BuildResult = { argv: string[] } | { error: string }

export function buildSendArgv(i: SendInput, c: SendConfig): BuildResult {
  const to = (i.to ?? '').trim()
  const room = (i.room ?? '').trim()
  if (!i.body || !i.body.trim()) return { error: 'body 必填' }
  if (!!to === !!room) return { error: 'to 與 room 要二選一' }
  if (to && typeof i.expects_reply !== 'boolean') return { error: 'expects_reply 必填（true＝等回信、false＝只是告知）' }
  const cli = (c.asnCliPath ?? '').trim()
  const mjs = (c.sendMjsPath ?? '').trim()
  let head: string[]
  if (cli) head = [cli, 'send']
  else if (mjs) head = [(c.nodePath ?? '').trim() || 'node', mjs]
  else return { error: '尚未設定 asn_cli_path 或 send_mjs_path（/plugin 設定頁）' }

  const argv = [...head]
  if (to) argv.push('--to', to)
  else argv.push('--room', room)
  argv.push('--body', i.body)
  if (to) argv.push(i.expects_reply ? '--reply' : '--no-reply')
  if (i.reply_to && i.reply_to.trim()) argv.push('--reply-to', i.reply_to.trim())
  // 只檢查旗標與路徑；內文是使用者要寄的文字，不在此限。
  const nonBody = argv.filter((_, idx) => argv[idx - 1] !== '--body')
  if (mentionsPersonSignature(nonBody.join('\n'))) {
    return { error: '拒絕：寄信參數不得含本人簽章相關字樣（as_person／x-asn-user），mod 只能以成員身分寄信' }
  }
  return { argv }
}

const SEND_CMD_RE = /send\.mjs|asn-cli(\.exe)?["']?\s+send\b|(^|[\s;&|"'])asn\s+send\b/i

export function guardBash(command: string): string | undefined {
  if (!SEND_CMD_RE.test(command)) return undefined
  if (mentionsPersonSignature(command)) return '寄信命令不得帶本人簽章相關參數或環境變數（as_person／x-asn-user），請改用 asn_send 工具'
  const hasTo = /(^|\s)--to(\s|=)/.test(command)
  const hasFlag = /(?<![\w-])--(no-)?reply(?![\w-])/.test(command)
  if (hasTo && !hasFlag) return '請加 --reply 或 --no-reply，或改用 asn_send 工具'
  return undefined
}
