#!/usr/bin/env node
// 雲端代理下載收到的附件（照片）：向收發室換一次短效下載網址，把檔案存到本機並印出路徑。
//   node attach.mjs --id <附件編號> [--out <路徑>]
// 預設存到 <信件目錄>/attachments/<編號前 8 碼>-<檔名>（信件目錄預設 /workspace/relay，重置後保留）；不覆蓋既有檔案。
// 只有寄件人與收件人（群組＝成員）換得到網址；沒權限一律 404。金鑰（ASN_RELAY_KEY，舊名 IRORI_RELAY_KEY）絕不印出。
// exit code：1 用法／目的地已有檔案、2 沒金鑰、4 後端或下載錯誤。輸出 `saved <路徑>`。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCore } from '../machine/relay-core.mjs'
import { AttachFail, downloadAttachment } from '../machine/attach-download.mjs'
import { NO_KEY_MSG, readKey, resolveConfig } from './config.mjs'

const USAGE = '用法：node attach.mjs --id <附件編號> [--out <路徑>]'

// 收到信時提示行裡的下載指令（inbox.mjs 用）
export const ATTACH_CLI = fileURLToPath(import.meta.url)
export const cloudCmd = () => `node "${ATTACH_CLI}"`

export function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const need = () => { if (i + 1 >= argv.length) throw new AttachFail(1, `${k} 缺少參數\n${USAGE}`); return argv[++i] }
    if (k === '--id') a.id = need()
    else if (k === '--out') a.out = need()
    else if (k === '--help' || k === '-h') a.help = true
    else throw new AttachFail(1, `不認得的參數 ${k}\n${USAGE}`)
  }
  return a
}

export async function main(argv, env = process.env, out = s => process.stdout.write(s + '\n')) {
  const a = parseArgs(argv)
  if (a.help) { out(USAGE); return 0 }
  if (!a.id) throw new AttachFail(1, `缺少 --id\n${USAGE}`)
  const cfg = resolveConfig(env)
  const key = readKey(cfg, env)
  if (!key) throw new AttachFail(2, NO_KEY_MSG)
  const core = createCore({ baseUrl: cfg.baseUrl, key, anonKey: '', log: () => {}, workDir: cfg.mailDir })
  const r = await downloadAttachment({ api: core.api, baseUrl: cfg.baseUrl, id: a.id, outDir: path.join(cfg.mailDir, 'attachments'), out: a.out })
  out(`saved ${r.path}`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(c => { process.exitCode = c }, e => {
    console.error(e instanceof AttachFail ? e.message : `錯誤：${e.message}`)
    process.exitCode = e instanceof AttachFail ? e.code : 4
  })
}
