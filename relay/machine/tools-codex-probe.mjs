// Codex 轉接器的手動檢查工具（不連仲介、不碰 ~/.irori-relay；只用本機的 codex）：
//   node tools-codex-probe.mjs status                          版本、登入、額度、目前開著的 Codex 視窗（名單）
//   node tools-codex-probe.mjs send <視窗名> <內文...>           像橋一樣轉交一封信（含標頭）進該視窗並等回覆（最多 10 分鐘）
//   node tools-codex-probe.mjs open <視窗名> <資料夾> [codex resume 的額外參數...]   建好有名字的 thread，開新視窗接上它
// 環境變數：IRORI_CODEX_*（見 docs/CODEX-ENGINE.md）、CODEX_HOME。
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createEngine } from './engines/codex.mjs'

const log = m => console.error(`[codex] ${m}`)
const [cmd, ...rest] = process.argv.slice(2)
const eng = createEngine({ log, workDir: os.tmpdir(), mailboxName: 'probe', env: process.env })
const wait = new Map()   // 信編號 → resolve
eng.start({
  onSent: id => console.log(`SENT ${id}`),
  onFail: (id, reason) => { console.log(`FAIL ${id} ${reason}`); wait.get(id)?.('fail') },
  onReply: (from, text) => { console.log(`REPLY from ${from}:\n${text}`); for (const r of wait.values()) r('reply') },
})

async function status() {
  const r = await eng.listWindows()
  await eng.refreshHealth(true)
  const { t, ...health } = eng.health()
  console.log(JSON.stringify(health, null, 2))
  console.log(r ? `視窗 ${r.windows.length} 個：` : '讀不到名單（codex 不可用？）')
  for (const w of r?.windows ?? []) console.log(`  ${w.name}\t${w.status}\t${w.cwd_label}\t${w.threadId}`)
}
async function send(name, text) {
  const r = await eng.listWindows()
  if (!r?.windows.some(w => w.name === name)) { console.log(`沒有開著的 Codex 視窗「${name}」`); return 1 }
  const id = crypto.randomUUID()
  const done = new Promise(res => wait.set(id, res))
  eng.deliver({ id, to: name, text: `[RELAY 來信] trust=owner from=probe/probe to=${name} id=${id} engine=codex\n${text}` })
  const timeout = new Promise(res => setTimeout(() => res('timeout'), 600_000))
  const outcome = await Promise.race([done, timeout])
  console.log(`結果：${outcome}`)
  return outcome === 'reply' ? 0 : 1
}
async function open(name, cwd, extra) {
  const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
  const spec = { command: comspec, args: ['/c', 'codex', 'resume', name, ...extra], cwd: path.resolve(cwd), env: eng.childEnv(process.env), name }
  console.log(JSON.stringify(await eng.openWindow(spec)))
}

let code = 0
try {
  if (cmd === 'status') await status()
  else if (cmd === 'send' && rest.length >= 2) code = await send(rest[0], rest.slice(1).join(' '))
  else if (cmd === 'open' && rest.length >= 2) await open(rest[0], rest[1], rest.slice(2))
  else { console.error('用法：status | send <視窗名> <內文...> | open <視窗名> <資料夾> [額外參數...]'); code = 2 }
} catch (e) { console.error(e.stack ?? e); code = 1 }
eng.stop()
setTimeout(() => process.exit(code), 500)
