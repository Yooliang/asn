// 測試用「被開出來的視窗」：launcher.json 的 profile 指向它。把自己加進假 `claude agents` 的清單（FAKE_AGENTS）
// 與假 ~/.claude/sessions/<pid>.json（entrypoint=cli），就像真的 Claude 視窗開好了；收到的 argv、cwd、可疑環境變數寫進 FAKE_LAUNCHED。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const name = process.argv[2]
const leaked = Object.keys(process.env).filter(k => /^CLAUDE|^NO_COLOR$|^IRORI_RELAY_KEY$|^IRORI_LAUNCH_(FILE|ARGS|DIR|STYLE)$/i.test(k))
fs.appendFileSync(process.env.FAKE_LAUNCHED, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), leaked }) + '\n')
if (process.env.FAKE_LAUNCH_NO_APPEAR !== '1') {
  const pid = 95000 + Math.floor(Math.random() * 4000)
  const dir = path.join(os.homedir(), '.claude', 'sessions'); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, entrypoint: 'cli', kind: 'interactive', updatedAt: Date.now() }))
  const list = JSON.parse(fs.readFileSync(process.env.FAKE_AGENTS, 'utf8'))
  list.push({ pid, cwd: process.cwd(), kind: 'interactive', startedAt: Date.now(), name, status: 'idle' })
  fs.writeFileSync(process.env.FAKE_AGENTS, JSON.stringify(list))
}
