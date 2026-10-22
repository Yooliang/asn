// 產生 public/skill/version.json：{ version, sha256 }。sha256 是 asn-cloud-agent.md 換行統一成 LF 之後的雜湊。
// 改了技能說明就要升版（檔頭 version）並重跑：node site/make-skill-version.mjs（守門測試會檢查兩者一致）。
import crypto from 'node:crypto'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = new URL('./public/skill/', import.meta.url)

export function skillVersionInfo(text) {
  const lf = text.replace(/\r\n/g, '\n')
  const version = Number(/^version:\s*(\d+)\s*$/m.exec(lf)?.[1])
  if (!Number.isInteger(version) || version < 1) throw new Error('技能說明檔頭找不到 version')
  return { version, sha256: crypto.createHash('sha256').update(lf, 'utf8').digest('hex') }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const info = skillVersionInfo(fs.readFileSync(new URL('asn-cloud-agent.md', dir), 'utf8'))
  fs.writeFileSync(new URL('version.json', dir), JSON.stringify(info) + '\n')
  console.log(JSON.stringify(info))
}
