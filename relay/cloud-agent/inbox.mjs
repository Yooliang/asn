#!/usr/bin/env node
// 給 Grok 自己看信、標記處理完：讀 inbox.jsonl（recv 寫的），已處理記在 done.jsonl。
//   node inbox.mjs [--unread]        列出還沒處理的信（預設）
//   node inbox.mjs --all             列出全部（已處理的標 [已處理]）
//   node inbox.mjs --json            改成每封一行 JSON（可搭配 --unread／--all）
//   node inbox.mjs --agent <名>      只看寄給這位代理的信（沒指定收件代理的信算給預設那位，IRORI_CLOUD_ROSTER_NAME）
//   node inbox.mjs --done <id> [<id>…]   把信標成已處理（可給前 8 碼以上、唯一的前綴）
// 回信：node send.mjs --to <from_node>/<from_agent> --reply-to <id> --body "…" (--reply|--no-reply)
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Fail, resolveCloudAgents, resolveConfig, rosterScanEnvFrom } from './config.mjs'
import { appendLineDurable, ensureDir, readJsonl } from './lib.mjs'

const USAGE = `用法：
  node inbox.mjs [--unread] [--all] [--json] [--agent <名>]
  node inbox.mjs --done <信件id> [<信件id>…]`

export function parseArgs(argv) {
  const a = { done: [] }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--unread') a.unread = true
    else if (k === '--all') a.all = true
    else if (k === '--json') a.json = true
    else if (k === '--agent') { a.agent = argv[++i]; if (!a.agent) throw new Fail(1, `--agent 後面要給名字
${USAGE}`) }
    else if (k === '--done') { a.doneMode = true; while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) a.done.push(argv[++i]) }
    else if (k === '--help' || k === '-h') a.help = true
    else throw new Fail(1, `不認得的參數 ${k}\n${USAGE}`)
  }
  if (a.unread && a.all) throw new Fail(1, `--unread 與 --all 不能同時給\n${USAGE}`)
  return a
}

const fmt = m => {
  const reply = m.expects_reply === true ? '要回信' : m.expects_reply === false ? '只是告知' : '未說明'
  return `[${m.id}] ${m.created_at ?? ''} to=${m.to_agent || '（未指定）'} from=${m.from_node}${m.from_agent ? '/' + m.from_agent : ''} (${reply})${m.reply_to ? ` reply_to=${m.reply_to}` : ''}\n${m.body}\n`
}

export async function main(argv, env = process.env, out = s => process.stdout.write(s + '\n')) {
  const a = parseArgs(argv)
  if (a.help) { out(USAGE); return 0 }
  const cfg = resolveConfig(env)
  const mails = readJsonl(cfg.inboxFile)
  const doneIds = new Set(readJsonl(cfg.doneFile).map(d => d?.id))
  if (a.doneMode) {
    if (!a.done.length) throw new Fail(1, `--done 後面要給信件 id\n${USAGE}`)
    ensureDir(cfg.mailDir, 0o700)
    let bad = 0
    for (const want of a.done) {
      const hits = mails.filter(m => m.id === want || (want.length >= 8 && m.id.startsWith(want)))
      const ids = [...new Set(hits.map(m => m.id))]
      if (ids.length !== 1) { out(`${ids.length ? '前綴不唯一' : '找不到這封信'}：${want}`); bad++; continue }
      if (doneIds.has(ids[0])) { out(`早就標過了：${ids[0]}`); continue }
      appendLineDurable(cfg.doneFile, JSON.stringify({ id: ids[0], done_at: new Date().toISOString() }))
      doneIds.add(ids[0])
      out(`done ${ids[0]}`)
    }
    return bad ? 1 : 0
  }
  const seen = new Set()
  // 沒指定收件代理、或收件代理不在名單上的信，算給預設那位（不會被漏掉）
  const names = new Set((await resolveCloudAgents(cfg, rosterScanEnvFrom(cfg))).map(x => x.name))
  const owner = m => (m.to_agent && names.has(m.to_agent) ? m.to_agent : cfg.name)
  const list = mails.filter(m => m?.id && !seen.has(m.id) && seen.add(m.id)).filter(m => a.all || !doneIds.has(m.id))
    .filter(m => !a.agent || owner(m) === a.agent)
  if (a.json) { for (const m of list) out(JSON.stringify({ ...m, done: doneIds.has(m.id) })); return 0 }
  if (!list.length) { out(a.all ? '（信箱是空的）' : '（沒有未處理的信）'); return 0 }
  for (const m of list) out((doneIds.has(m.id) ? '[已處理] ' : '') + fmt(m))
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    c => { process.exitCode = c },
    e => { console.error(e instanceof Fail ? e.message : `錯誤：${e.message}`); process.exitCode = e instanceof Fail ? e.code : 4 },
  )
}
