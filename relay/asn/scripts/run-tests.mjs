// 跑 test/*.test.mjs；Linux 且沒有 DISPLAY 時用 xvfb-run（雲端 VM／CI 跑 --shot e2e 需要）。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tests = fs.readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.test.mjs')).sort().map(f => path.join('test', f))
const nodeArgs = ['--test', ...tests]
const useXvfb = process.platform === 'linux' && !process.env.DISPLAY

const r = useXvfb
  ? spawnSync('xvfb-run', ['-a', process.execPath, ...nodeArgs], { cwd: root, stdio: 'inherit' })
  : spawnSync(process.execPath, nodeArgs, { cwd: root, stdio: 'inherit' })

process.exit(typeof r.status === 'number' ? r.status : 1)
