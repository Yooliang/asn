// 一次跑一串監看工具指令：node gui.mjs "指令1" "指令2" ...（"sleep N" 等 N 毫秒）。結果逐行印出
import { spawn } from 'node:child_process'; import path from 'node:path'; import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const mon = spawn(path.join(here, 'focustest.exe'), [path.join(here, 'focus-gui.log')], { stdio: ['pipe', 'pipe', 'inherit'] })
let buf = '', w = []; mon.stdout.setEncoding('utf8'); mon.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); w.shift()?.(l) } })
const cmd = c => new Promise(r => { w.push(r); mon.stdin.write(c + '\n') })
for (const c of process.argv.slice(2)) {
  if (c.startsWith('sleep ')) { await new Promise(r => setTimeout(r, Number(c.slice(6)))); continue }
  console.log(c, '=>', await cmd(c))
}
mon.stdin.write('quit\n'); setTimeout(() => process.exit(0), 300)