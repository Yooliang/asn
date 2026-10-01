// 測試用：以測試寄件節點寄信給 <to_node>/<to_agent>，輪詢自己的 inbox 等回信，印出延遲
// 用法：node tools-roundtrip.mjs <寄件節點> <to_node> <to_agent|-> "<body>" [等待秒數]
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
const URL_ = 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/irori-relay'
const [me, toNode, toAgent, body, waitS = '120'] = process.argv.slice(2)
const key = fs.readFileSync(path.join(os.homedir(), '.irori-relay', `${me}.key`), 'utf8').trim()
const call = async (a, method = 'GET', b) => (await fetch(`${URL_}?action=${a}`, { method, headers: { 'x-relay-key': key, ...(b ? { 'content-type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined })).json()
const t0 = Date.now()
const s = await call('send', 'POST', { to_node: toNode, to_agent: toAgent === '-' ? undefined : toAgent, body, from_agent: 'tester' })
console.log('sent', JSON.stringify(s)); const id = s.id
while (Date.now() - t0 < Number(waitS) * 1000) {
  const { messages = [] } = await call('inbox')
  const mine = messages.filter(m => m.reply_to === id)
  if (messages.length) await call('ack', 'POST', { ids: messages.map(m => m.id) })
  if (mine.length) { for (const m of mine) console.log(`REPLY after ${Date.now() - t0}ms from=${m.from_node}/${m.from_agent} :: ${m.body}`); process.exit(0) }
  await new Promise(r => setTimeout(r, 1500))
}
console.log('no reply within', waitS, 's')
