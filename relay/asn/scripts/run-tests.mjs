// 跑 test/*.test.mjs；Linux 且沒有 DISPLAY 時用 xvfb-run（雲端 VM／CI 跑 --shot e2e 需要）。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tests = fs.readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.test.mjs')).sort().map(f => path.join('test', f))
// 單支逾時＋整套時限：測試失敗沒關假後台時不會一直掛著（曾掛十二小時）。不用 --test-force-exit：Windows 上會在結束時觸發 libuv 斷言崩潰（假紅）
const nodeArgs = ['--test', '--test-timeout=120000', ...tests]
const RUN_LIMIT_MS = 20 * 60 * 1000   // 整套最多 20 分鐘，超過就收掉並當失敗
const useXvfb = process.platform === 'linux' && !process.env.DISPLAY
const env = { ...process.env }
if (process.platform === 'linux') {
  env.WEBKIT_DISABLE_COMPOSITING_MODE = '1'
  env.WEBKIT_DISABLE_DMABUF_RENDERER = '1'
}

const r = useXvfb
  ? spawnSync('xvfb-run', ['-a', process.execPath, ...nodeArgs], { cwd: root, stdio: 'inherit', env, timeout: RUN_LIMIT_MS })
  : spawnSync(process.execPath, nodeArgs, { cwd: root, stdio: 'inherit', env, timeout: RUN_LIMIT_MS })

if (r.error?.code === 'ETIMEDOUT') console.error(`測試超過 ${RUN_LIMIT_MS / 60000} 分鐘沒結束，已收掉（多半是某支測試失敗後沒關假後台）`)
process.exit(typeof r.status === 'number' ? r.status : 1)
