// 測試用：用 H 金鑰單次回報名單（不碰 inbox），驗證 roster 欄位與過濾規則
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execFileSync } from 'node:child_process'
const key = fs.readFileSync(path.join(os.homedir(), '.irori-relay', 'H.key'), 'utf8').trim()
const list = JSON.parse(execFileSync('claude', ['agents', '--json'], { encoding: 'utf8' }))
const ep = pid => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8')).entrypoint } catch { return '' } }
const agents = list.filter(a => a.kind === 'interactive' && ep(a.pid) === 'cli').map(a => ({ name: a.name, status: a.status, cwd_label: String(a.cwd).split(/[\\/]+/).filter(Boolean).pop() }))
const r = await fetch('https://hwtahctsgjcemtwzlvnq.supabase.co/functions/v1/irori-relay?action=roster', { method: 'POST', headers: { 'x-relay-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ agents }) })
console.log(r.status, await r.text(), JSON.stringify(agents))
