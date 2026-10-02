// 測試用：假裝是一個 claude 視窗（在 ~/.claude/sessions 登記自己的 pid 與名字），再以子行程執行 send.mjs。
// 用法：node fake-window.mjs <視窗名|-無名> [send.mjs 參數...]；stdin 會轉給 send.mjs。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const [name, ...args] = process.argv.slice(2)
const dir = path.join(os.homedir(), '.claude', 'sessions'); fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, `${process.pid}.json`)
fs.writeFileSync(file, JSON.stringify({ pid: process.pid, ...(name === '-無名' ? {} : { name }), kind: 'interactive', entrypoint: 'cli' }))
const r = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'send.mjs'), ...args], { stdio: 'inherit' })
try { fs.unlinkSync(file) } catch {}
process.exit(r.status ?? 1)
