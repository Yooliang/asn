#!/usr/bin/env node
// 寄信／回信 CLI（欄位同 relay/machine/send.mjs 的後端呼叫）。
//   node send.mjs --to <節點>[/<視窗>] --body "內文" (--reply | --no-reply) [--reply-to <信件id>] [--from Grok]
//   echo 內文 | node send.mjs --to W/W-政策 --body - --no-reply --reply-to <信件id>
// --reply＝我在等對方回信；--no-reply＝只是告知。兩個必選一個（欄位 expects_reply，不往內文加標記）。
// 回信務必帶 --reply-to <來信 id>：收發室靠它知道你回了哪一封、不再寄「沒收到回覆」的提醒。
// exit code：1 用法、2 沒金鑰、4 後端錯誤。輸出 `sent id=…`；金鑰絕不印出。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCore } from '../machine/relay-core.mjs'
import { Fail, ID_RE, NO_KEY_MSG, UUID_RE, readKey, resolveCloudAgents, resolveConfig, rosterScanEnvFrom } from './config.mjs'
import { applyEnvCompat } from './env-compat.mjs'

const MAX_BODY = 20000
const USAGE = `用法：
  node send.mjs --to <節點>[/<視窗>] --body "<內文>" (--reply | --no-reply) [--reply-to <信件id>] [--from <名稱>]
  --body -  內文從 stdin 讀；--body-file <檔> 從檔案讀
  --reply   我在等對方回信；--no-reply  只是告知。二選一、不能同時給。
  --from    寄件視窗名（預設 Grok，環境變數 IRORI_CLOUD_ROSTER_NAME 可改）；必須是名單（agents.json／IRORI_CLOUD_AGENTS）上的一位
回信一定要帶 --reply-to <來信 id>。內文至多 ${MAX_BODY} 字。`

export function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const need = () => { if (i + 1 >= argv.length) throw new Fail(1, `${k} 缺少參數\n${USAGE}`); return argv[++i] }
    if (k === '--to') a.to = need()
    else if (k === '--body') a.body = need()
    else if (k === '--body-file') a.bodyFile = need()
    else if (k === '--reply-to') a.replyTo = need()
    else if (k === '--from') a.from = need()
    else if (k === '--reply') a.reply = true
    else if (k === '--no-reply') a.noReply = true
    else if (k === '--help' || k === '-h') a.help = true
    else throw new Fail(1, `不認得的參數 ${k}\n${USAGE}`)
  }
  return a
}

export async function main(argv, rawEnv = process.env) {
  const { env } = applyEnvCompat(rawEnv)
  const a = parseArgs(argv)
  if (a.help) { console.log(USAGE); return 0 }
  if (!a.to) throw new Fail(1, `缺少 --to\n${USAGE}`)
  if (a.reply && a.noReply) throw new Fail(1, `--reply 與 --no-reply 不能同時給\n${USAGE}`)
  if (!a.reply && !a.noReply) throw new Fail(1, `請說明要不要回信：等對方回就加 --reply，只是告知就加 --no-reply\n${USAGE}`)
  let body = a.body
  if (a.bodyFile) body = fs.readFileSync(a.bodyFile, 'utf8')
  else if (body === '-') body = fs.readFileSync(0, 'utf8')
  body = (body ?? '').replace(/\s+$/, '')
  if (!body) throw new Fail(1, `內文是空的\n${USAGE}`)
  if (body.length > MAX_BODY) throw new Fail(1, `內文 ${body.length} 字，超過 ${MAX_BODY} 字`)
  if (a.replyTo && !UUID_RE.test(a.replyTo)) throw new Fail(1, '--reply-to 要是信件 id（uuid）')
  const i = a.to.indexOf('/')
  const toNode = i < 0 ? a.to : a.to.slice(0, i), toAgent = i < 0 ? '' : a.to.slice(i + 1)
  if (!ID_RE.test(toNode)) throw new Fail(1, `--to ${a.to} 的節點代號格式不對`)
  const cfg = resolveConfig(env)
  if (toNode === cfg.node) throw new Fail(1, '收件人是自己這個節點')
  const key = readKey(cfg, env)
  if (!key) throw new Fail(2, NO_KEY_MSG)
  const from = (a.from || cfg.name).trim().slice(0, 100)
  const names = (await resolveCloudAgents(cfg, rosterScanEnvFrom(cfg))).map(x => x.name)
  if (!names.includes(from)) throw new Fail(1, `「${from}」不在這台的代理名單上（${names.join('、')}）：用名單上的名字回信，或先把他加進 agents.json`)
  const core = createCore({ baseUrl: cfg.baseUrl, key, anonKey: '', log: () => {}, workDir: cfg.mailDir })
  let r
  try {
    r = await core.api('send', { method: 'POST', body: { to_node: toNode, to_agent: toAgent || undefined, body, reply_to: a.replyTo || undefined, from_agent: from, expects_reply: !!a.reply } })
  } catch (e) { throw new Fail(4, `send 失敗：${e.message}`) }
  console.log(`sent id=${r?.id} to=${a.to} from=${cfg.node}/${from}`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(c => { process.exitCode = c }, e => {
    console.error(e instanceof Fail ? e.message : `錯誤：${e.message}`)
    process.exitCode = e instanceof Fail ? e.code : 4
  })
}
