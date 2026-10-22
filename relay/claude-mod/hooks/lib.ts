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
  else return { error: '尚未設定 asn_cli_path 或 send_mjs_path，也找不到預設的 %LOCALAPPDATA%\\ASN\\asn-cli.exe（/plugin 設定頁）' }

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

export type CmdSegment = { tokens: string[]; raw: string }

// 把 Bash 命令依 &&、||、;、|、換行切成幾段，每段拆成詞（引號內算同一個詞、去掉引號）。
// heredoc 內文（<<WORD … WORD）整段略過；引號裡的文字不會被當成運算子。
export function splitCommand(command: string): CmdSegment[] {
  const out: CmdSegment[] = []
  let tokens: string[] = []
  let cur = ''
  let has = false
  let segStart = 0
  const heredocs: { word: string; dash: boolean }[] = []
  const endTok = () => {
    if (has) tokens.push(cur)
    cur = ''
    has = false
  }
  const endSeg = (i: number) => {
    endTok()
    if (tokens.length) out.push({ tokens, raw: command.slice(segStart, i) })
    tokens = []
    segStart = i + 1
  }
  const n = command.length
  let i = 0
  while (i < n) {
    const c = command[i]
    if (c === "'") {
      has = true
      const j = command.indexOf("'", i + 1)
      const end = j < 0 ? n : j
      cur += command.slice(i + 1, end)
      i = end + 1
    } else if (c === '"') {
      has = true
      i++
      while (i < n && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < n && (command[i + 1] === '"' || command[i + 1] === '\\')) i++
        cur += command[i]
        i++
      }
      i++
    } else if (c === '\n') {
      endSeg(i)
      i++
      // 換行之後先把待處理的 heredoc 內文跳過
      while (heredocs.length) {
        const h = heredocs.shift()!
        while (i < n) {
          let e = command.indexOf('\n', i)
          if (e < 0) e = n
          const line = command.slice(i, e).replace(/\r$/, '')
          i = Math.min(e + 1, n)
          if ((h.dash ? line.trim() : line) === h.word) break
        }
      }
      segStart = i
    } else if (c === ';' || c === '|' || (c === '&' && command[i + 1] === '&')) {
      endSeg(i)
      if ((c === '|' || c === '&') && command[i + 1] === c) i++
      segStart = i + 1
      i++
    } else if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      endTok()
      i += 2
      const dash = command[i] === '-'
      if (dash) i++
      while (command[i] === ' ' || command[i] === '\t') i++
      const q = command[i] === "'" || command[i] === '"' ? command[i] : ''
      if (q) i++
      let w = ''
      while (i < n && !/[\s;&|<>'"]/.test(command[i])) w += command[i++]
      if (q && command[i] === q) i++
      if (w) heredocs.push({ word: w, dash })
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endTok()
      i++
    } else {
      has = true
      cur += c
      i++
    }
  }
  endSeg(n)
  return out
}

const baseName = (t: string): string => t.replace(/\\/g, '/').split('/').pop() ?? ''

// 真正的寄信指令呼叫：段首詞（去掉前導環境變數賦值）是 asn-cli／asn-cli.exe／asn（後接 send）或 node（後接 *send.mjs）
export function sendInvocations(command: string): CmdSegment[] {
  return splitCommand(command).filter(seg => {
    const t = seg.tokens
    let k = 0
    while (k < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[k])) k++
    const head = baseName(t[k] ?? '').toLowerCase()
    if (head === 'asn-cli' || head === 'asn-cli.exe' || head === 'asn') return t[k + 1] === 'send'
    if (head === 'node' || head === 'node.exe') {
      const script = t.slice(k + 1).find(x => !x.startsWith('-'))
      return script !== undefined && /send\.mjs$/i.test(baseName(script))
    }
    return false
  })
}

export function guardBash(command: string): string | undefined {
  for (const seg of sendInvocations(command)) {
    if (mentionsPersonSignature(seg.raw)) return '寄信命令不得帶本人簽章相關參數或環境變數（as_person／x-asn-user），請改用 asn_send 工具'
    const hasTo = seg.tokens.some(x => x === '--to' || x.startsWith('--to='))
    const hasFlag = seg.tokens.some(x => /^--(no-)?reply(=|$)/.test(x))
    if (hasTo && !hasFlag) return '請加 --reply 或 --no-reply，或改用 asn_send 工具'
  }
  return undefined
}

// 開新視窗時附在對話裡的一句提示：讓沒有 ASN 原始碼的電腦上的 Claude 也知道有 asn 技能可看。
export function startNotice(version: string): string {
  const v = version.trim() || '（版本不明）'
  return `這台電腦裝了 ASN ${v}（AI 夥伴與人互寄信件的收發室）。收到「[RELAY 來信]」、要寄信或回信、被問到 ASN 版本或新功能時，先看 asn 技能：裡面有 asn-cli 用法、信任等級規則與各版更新說明。`
}
