// 測試用假 claude：`agents --json` 印 FAKE_AGENTS 檔；其餘當收發室 worker，每個橋接指令回 SENT <id>。
// 回覆區塊的標記帶橋啟動時的 nonce（從 --system-prompt 取）。
// FAKE_INBOUND（選用）：指向一個檔，每行 JSON {"from":"視窗名","text":"…","nonce":"可選，預設真 nonce"}；
// 假 worker 輪詢到新行就輸出一個 <<REPLY-nonce from=…>> 區塊，模擬「某本機視窗 SendMessage 給收發室」。
import fs from 'node:fs'
import readline from 'node:readline'
const args = process.argv.slice(2)
if (args[0] === 'agents') { process.stdout.write(fs.readFileSync(process.env.FAKE_AGENTS, 'utf8')); process.exit(0) }
const sp = args[args.indexOf('--system-prompt') + 1] ?? ''
const NONCE = (sp.match(/nonce=([0-9a-f]+)/) ?? [])[1] ?? 'none'
const emit = result => process.stdout.write(JSON.stringify({ type: 'result', result, duration_ms: 1, total_cost_usd: 0 }) + '\n')
const block = (from, text, nonce = NONCE) => `<<REPLY-${nonce} from=${from}>>\n${text}\n<<END-${nonce}>>`
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  let ev; try { ev = JSON.parse(line) } catch { return }
  const text = String(ev.message?.content ?? '')
  const m = text.match(/^\[BRIDGE-FORWARD nonce=\S+ id=(\S+) to=(.+?)\]/)
  if (!m) return
  fs.appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ id: m[1], to: m[2], text }) + '\n')
  emit(`SENT ${m[1]}` + (process.env.FAKE_REPLY ? '\n' + block(m[2], process.env.FAKE_REPLY) : ''))
})
rl.on('close', () => process.exit(0))
if (process.env.FAKE_INBOUND) {
  const pos = process.env.FAKE_INBOUND + '.pos'   // 重啟後不重播已處理的行
  let done = 0
  try { done = Number(fs.readFileSync(pos, 'utf8')) || 0 } catch {}
  setInterval(() => {
    let lines = []
    try { lines = fs.readFileSync(process.env.FAKE_INBOUND, 'utf8').split('\n').filter(Boolean) } catch {}
    while (done < lines.length) { const j = JSON.parse(lines[done++]); fs.writeFileSync(pos, String(done)); emit(block(j.from, j.text, j.nonce)) }
  }, 50)
}
