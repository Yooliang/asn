// 純函式：組 argv、解析設定、判斷 bash 命令與本人簽章。不 import pi，方便 node --test。
// 與 relay/claude-mod/hooks/lib.ts 邏輯一致（第一期複製，不抽共用核心；見 README）。

import path from 'node:path'

// 本人簽章（ASN#118）：擴充寄出的信一律是成員身分，argv／環境／命令都不得出現這些字樣。
const PERSON_RE = /as[_-]?person|x-asn-user|asn[_-]user|--person\b|person-sign|user[_-]?token/i

export function mentionsPersonSignature(text) {
  return PERSON_RE.test(String(text ?? ''))
}

/**
 * 解析設定。優先序：env > 設定檔物件 > 預設。
 * env: ASN_CLI_PATH、ASN_SEND_MJS、ASN_NODE_PATH；fileConfig: { asnCliPath, sendMjsPath, nodePath }。
 * Windows 預設 %LOCALAPPDATA%\ASN\asn-cli.exe；其他平台沒有預設 asn-cli，要設 send.mjs。
 */
export function resolveConfig(env = {}, fileConfig = {}, platform = process.platform) {
  const pick = (a, b) => (a && String(a).trim()) || (b && String(b).trim()) || ''
  let asnCliPath = pick(env.ASN_CLI_PATH, fileConfig.asnCliPath)
  const sendMjsPath = pick(env.ASN_SEND_MJS, fileConfig.sendMjsPath)
  const nodePath = pick(env.ASN_NODE_PATH, fileConfig.nodePath) || 'node'
  if (!asnCliPath && !sendMjsPath && platform === 'win32' && env.LOCALAPPDATA) {
    asnCliPath = path.win32.join(env.LOCALAPPDATA, 'ASN', 'asn-cli.exe')
  }
  return { asnCliPath, sendMjsPath, nodePath }
}

/** @returns {{argv: string[]} | {error: string}} argv[0] 是執行檔，其餘是參數。 */
export function buildSendArgv(i, c) {
  const to = (i.to ?? '').trim()
  const room = (i.room ?? '').trim()
  if (!i.body || !String(i.body).trim()) return { error: 'body 必填' }
  if (!!to === !!room) return { error: 'to 與 room 要二選一' }
  if (to && typeof i.expects_reply !== 'boolean') return { error: 'expects_reply 必填（true＝等回信、false＝只是告知）' }
  const cli = (c.asnCliPath ?? '').trim()
  const mjs = (c.sendMjsPath ?? '').trim()
  let head
  if (cli) head = [cli, 'send']
  else if (mjs) head = [(c.nodePath ?? '').trim() || 'node', mjs]
  else return { error: '尚未設定 asn-cli 路徑或 send.mjs 路徑（環境變數 ASN_CLI_PATH／ASN_SEND_MJS）' }

  const argv = [...head]
  if (to) argv.push('--to', to)
  else argv.push('--room', room)
  argv.push('--body', String(i.body))
  if (to) argv.push(i.expects_reply ? '--reply' : '--no-reply')
  if (i.reply_to && String(i.reply_to).trim()) argv.push('--reply-to', String(i.reply_to).trim())
  // 只檢查旗標與路徑；內文是使用者要寄的文字，不在此限。
  const nonBody = argv.filter((_, idx) => argv[idx - 1] !== '--body')
  if (mentionsPersonSignature(nonBody.join('\n'))) {
    return { error: '拒絕：寄信參數不得含本人簽章相關字樣（x-asn-user 之類），只能以成員身分寄信' }
  }
  return { argv }
}

const SEND_CMD_RE = /send\.mjs|asn-cli(\.exe)?["']?\s+send\b|(^|[\s;&|"'])asn\s+send\b/i

/** 回傳拒絕理由；放行回 undefined。提醒用的守門，不是安全邊界。 */
export function guardBash(command) {
  command = String(command ?? '')
  if (!SEND_CMD_RE.test(command)) return undefined
  if (mentionsPersonSignature(command)) return '寄信命令不得帶本人簽章相關參數或環境變數，請改用 asn_send 工具'
  const hasTo = /(^|\s)--to(\s|=)/.test(command)
  const hasFlag = /(?<![\w-])--(no-)?reply(?![\w-])/.test(command)
  if (hasTo && !hasFlag) return '請加 --reply 或 --no-reply，或改用 asn_send 工具'
  return undefined
}

/** asn_send 的 tool_call 守門：除內文外的欄位不得含本人簽章字樣。 */
export function guardAsnSendInput(input) {
  const { body: _body, ...rest } = input ?? {}
  if (mentionsPersonSignature(JSON.stringify(rest))) return '拒絕：asn_send 參數不得含本人簽章相關字樣，只能以成員身分寄信'
  return undefined
}

/**
 * 實際寄信。execFile 不經 shell，且不傳 env（子行程沿用 pi 原本環境，不額外加任何變數）。
 * exec 可注入（測試用），簽名同 child_process.execFile 的 callback 形式。
 */
export function runSend(argv, exec, { timeoutMs = 60000, signal } = {}) {
  return new Promise((resolve) => {
    const [file, ...args] = argv
    exec(file, args, { timeout: timeoutMs, windowsHide: true, signal, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout ?? '').trim()
      const errText = String(stderr ?? '').trim()
      if (err) {
        const code = err.code ?? 'error'
        resolve({ ok: false, text: `asn_send 失敗（${code}）：${errText || out || err.message}` })
      } else resolve({ ok: true, text: out || 'sent' })
    })
  })
}
