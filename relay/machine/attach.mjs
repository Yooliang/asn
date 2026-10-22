#!/usr/bin/env node
// 下載收到的附件（照片）到本機：向收發室換一次短效下載網址，再把檔案存到本機路徑並印出路徑。
//   node attach.mjs --id <附件編號> [--out <路徑>]
// 預設存到 ~/.asn/machine-<節點>/attachments/<編號前 8 碼>-<檔名>；不覆蓋既有檔案（--out 指到已存在的檔案會拒絕）。
// 只有寄件人與收件人（群組＝成員）換得到網址；沒權限一律 404。金鑰絕不印出。
// exit code：1 用法／目的地已有檔案、4 後端或下載錯誤（含沒權限、已過期、檔案內容不對）。輸出 `saved <路徑>`。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE_URL, Fail, HOME_DIR, machineNode, readMachineKey } from './identity.mjs'
import { createCore } from './relay-core.mjs'
import { AttachFail, downloadAttachment } from './attach-download.mjs'

export { MAX_DOWNLOAD_BYTES, contentOk, downloadAttachment, localName } from './attach-download.mjs'

export const USAGE = `用法：
  node attach.mjs --id <附件編號> [--out <路徑>]
  下載收到的照片／附件，存到本機並印出路徑（預設在工作資料夾的 attachments/ 底下）。`

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

export async function main(argv, out = s => process.stdout.write(s + '\n')) {
  const a = parseArgs(argv)
  if (a.help) { out(USAGE); return 0 }
  if (!a.id) throw new AttachFail(1, `缺少 --id\n${USAGE}`)
  const node = machineNode()
  const key = readMachineKey(node)
  const work = path.join(HOME_DIR, `machine-${node}`)
  const core = createCore({ baseUrl: BASE_URL, key, anonKey: '', log: () => {}, workDir: work })
  const r = await downloadAttachment({ api: core.api, baseUrl: BASE_URL, id: a.id, outDir: path.join(work, 'attachments'), out: a.out })
  out(`saved ${r.path}`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(c => { process.exitCode = c }, e => {
    console.error(e instanceof Fail || e instanceof AttachFail ? e.message : `錯誤：${e.message}`)
    process.exitCode = e instanceof Fail || e instanceof AttachFail ? e.code : 4
  })
}
