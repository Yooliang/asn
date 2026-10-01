// 測試用假 claude：`agents --json` 印 FAKE_AGENTS 檔；其餘當收發室 worker，每個橋接指令回 SENT <id>。
import fs from 'node:fs'
import readline from 'node:readline'
const args = process.argv.slice(2)
if (args[0] === 'agents') { process.stdout.write(fs.readFileSync(process.env.FAKE_AGENTS, 'utf8')); process.exit(0) }
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  let ev; try { ev = JSON.parse(line) } catch { return }
  const text = String(ev.message?.content ?? '')
  const m = text.match(/^\[BRIDGE-FORWARD nonce=\S+ id=(\S+) to=(.+?)\]/)
  if (!m) return
  fs.appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ id: m[1], to: m[2], text }) + '\n')
  process.stdout.write(JSON.stringify({ type: 'result', result: `SENT ${m[1]}`, duration_ms: 1, total_cost_usd: 0 }) + '\n')
})
rl.on('close', () => process.exit(0))
