#!/usr/bin/env node
// asn-send：本機 Claude 視窗主動寄信給仲介成員／群組，不經收發室、不經任何模型。
//   node send.mjs --to PC1 --body "內文" --reply|--no-reply [--reply-to <信件id>]
//   node send.mjs --to W/W-政策 --body-file msg.txt --no-reply
//   node send.mjs --room <群組id> --body "內文"
//   echo 內文 | node send.mjs --to PC1 --body - --reply
//   node send.mjs --to W/W-政策 --file 報告.pdf --file 截圖.webp --body "說明" --no-reply   # 寄檔案／照片（內文可省略）
// 寄給成員／視窗（--to，含回信 --reply-to）一定要明說要不要回信：--reply＝我在等回信（收發室 10 分鐘沒收到回覆會提醒）、
// --no-reply＝只是告知；結果以 expects_reply 欄位送給後端，【不往內文加任何標記】（內文有沒有標記沒辦法用程式可靠判斷）。
// 兩個都沒給就不寄（exit 1）；--room 群組本來就不計時，給了會忽略。
// 用這台機器的節點金鑰（~/.asn/<節點>.key，橋用的同一把）直接呼叫 relay。
// 寄件視窗名不能自填：沿父行程鏈往上找 claude 程序，對照 ~/.claude/sessions/<pid>.json 的 name 當 from_agent；找不到就拒絕。
// 輸出 `sent id=…`（或 `posted room=… seq=…`）；錯誤印到 stderr，exit code：1 用法／內容、2 認不出呼叫者、3 超量、4 後端錯誤。
import { envGet } from './env-compat.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sentMarkName } from './sent-mark.mjs'
import { AttachFail } from './attach-download.mjs'
import { MAX_FILES, attachmentText, prepareFiles, uploadItems } from './attach-upload.mjs'
import { BASE_URL, Fail, HOME_DIR, findCaller, inspectCaller, machineNode, readMachineKey, readSession, sessionsDir } from './identity.mjs'

export { findCaller, inspectCaller }

const LIMIT = Number(envGet(process.env, 'SEND_PER_HOUR') || 30)
const MAX_BODY = 20000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/
const PERSON_RE = /^u:[0-9a-f]{12}$/   // 本人位址（與節點無關），後台認得
const USAGE = `用法：
  node send.mjs --to <成員代號 | 節點/視窗名> --body "<內文>" (--reply | --no-reply) [--reply-to <信件id>]
  node send.mjs --room <群組id> --body "<內文>"
  --reply | --no-reply  寄給成員／視窗（含回信 --reply-to）時二選一、一定要給，兩個不能同時給：
                     --reply＝我在等對方回信（收發室 10 分鐘沒收到回覆會提醒）；--no-reply＝只是告知，不用回、不會提醒。
                     結果以欄位送給後端，不會在內文加任何標記。--room 群組本來就不計時，給了會忽略（印一行說明）。
  --body-file <檔>   內文從檔案讀；--body -  內文從 stdin 讀
  --file <路徑>      附件，可重複，一封至多 ${MAX_FILES} 個（--to、--room 都能用；內文可省略，只有附件時內文就是附件清單）。
                     照片只收已是 webp 的（5 MB；本程式不轉檔，png／jpg 請先轉 webp，或用 ASN 電腦版寄）；
                     一般檔案收 pdf、txt、md、json、csv、zip、docx、xlsx、pptx（25 MB），可執行檔、腳本一律擋。
                     檢查全在本機先做，任何一個不合格或上傳失敗都不寄信。收的人用 attach.mjs --id <編號> 下載。
  --whoami           不寄信，印出父行程鏈、session 對照、節點判定（除錯用）
同一台機器上的其他視窗（含 ASN）也可以寄（--to <本機節點>/<視窗名>）；不能寄給自己這個視窗。
內文至多 ${MAX_BODY} 字。寄件人（視窗名）由本程式自動判定，不能自填；信任一律是 member。`


export function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const need = () => { if (i + 1 >= argv.length) throw new Fail(1, `${k} 缺少參數\n${USAGE}`); return argv[++i] }
    if (k === '--to') a.to = need()
    else if (k === '--room') a.room = need()
    else if (k === '--body') a.body = need()
    else if (k === '--body-file') a.bodyFile = need()
    else if (k === '--reply-to') a.replyTo = need()
    else if (k === '--file') (a.files ??= []).push(need())
    else if (k === '--reply') a.reply = true
    else if (k === '--no-reply') a.noReply = true
    else if (k === '--whoami') a.whoami = true
    else if (k === '--help' || k === '-h') a.help = true
    else throw new Fail(1, `不認得的參數 ${k}\n${USAGE}`)
  }
  return a
}

// 要不要回信：--to 一定要二選一；回傳要送給後端的 expects_reply（true＝等回信、false＝只是告知）。
// 群組（--room）不計時：旗標忽略（expectsReply=null、不送欄位），note 是要印給呼叫者的一行說明。兩個旗標互相矛盾一律報錯。
export function resolveReplyFlag({ reply, noReply, room }) {
  if (reply && noReply) throw new Fail(1, `--reply 與 --no-reply 不能同時給（一個說要等回信、一個說只是告知）\n${USAGE}`)
  if (room) return { expectsReply: null, note: reply || noReply ? '群組訊息本來就不計時，--reply／--no-reply 不適用，已忽略' : '' }
  if (!reply && !noReply) throw new Fail(1, `請說明要不要回信：等對方回就加 --reply，只是告知就加 --no-reply\n${USAGE}`)
  return { expectsReply: !!reply, note: '' }
}

function whoami() {
  const ev = inspectCaller()
  console.log(`node pid=${process.pid} ppid=${process.ppid} platform=${process.platform} home=${os.homedir()}`)
  console.log(`CLAUDE_CODE_MESSAGING_SOCKET=${ev.envSocket || '(未設)'}`)
  if (ev.tableError) console.log(`行程表讀取失敗：${ev.tableError}`)
  console.log('父行程鏈（由近到遠）：'); for (const c of ev.chain) console.log(`  pid=${c.pid} ${c.name}${c.session ? `  <== session「${c.session}」` : ''}`)
  console.log(`判定（行程鏈）：${ev.viaChain ? `pid=${ev.viaChain.pid} name=${ev.viaChain.name || '(無名)'}` : '無'}`)
  console.log(`判定（環境變數備援）：${ev.viaEnv ? `pid=${ev.viaEnv.pid} name=${ev.viaEnv.name || '(無名)'}` : '無'}`)
  let sess = []; try { sess = fs.readdirSync(sessionsDir()).filter(f => /^\d+\.json$/.test(f)).map(f => readSession(Number(f.slice(0, -5)))).filter(Boolean) } catch {}
  console.log('~/.claude/sessions：'); for (const s of sess) console.log(`  pid=${s.pid} name=${s.name ?? '(無名)'} kind=${s.kind} entrypoint=${s.entrypoint}`)
  try { console.log(`機器節點判定：${machineNode()}`) } catch (e) { console.log(`機器節點判定失敗：${e.message}`) }
}

// 每視窗每小時上限，記在 ~/.asn/send-rate.json（暫存檔＋rename，避免寫壞）
function takeRate(window) {
  const file = path.join(HOME_DIR, 'send-rate.json')
  let all = {}
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')) || {} } catch {}
  const now = Date.now()
  for (const k of Object.keys(all)) { all[k] = (all[k] || []).filter(t => now - t < 3_600_000); if (!all[k].length) delete all[k] }
  const recent = all[window] ?? []
  if (recent.length >= LIMIT) throw new Fail(3, `被擋：視窗「${window}」每小時最多寄 ${LIMIT} 封，${Math.ceil((recent[0] + 3_600_000 - now) / 60000)} 分鐘後再試`)
  all[window] = [...recent, now]
  fs.mkdirSync(HOME_DIR, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(all)); fs.renameSync(tmp, file)
}

// 視窗直接回信（--reply-to）後在本機留記號：機器橋看到就不再寄「10 分鐘內沒有收到回覆」——
// 不然對方會同時收到真的回信和一封「沒回」，收件的人把兩封一起轉述時就說成沒回
export const repliedDir = node => path.join(HOME_DIR, `machine-${node}`, 'replied')
function markReplied(node, mailId) {
  try { fs.mkdirSync(repliedDir(node), { recursive: true }); fs.writeFileSync(path.join(repliedDir(node), mailId), String(Date.now())) } catch {}
}

// 每次寄給某節點／視窗也留記號（誰、什麼時候、寄給誰）：橋計時到時，若收件視窗在轉交後曾寄信給原寄件人，就不再寄「沒有回覆」
export const sentDir = node => path.join(HOME_DIR, `machine-${node}`, 'sent')
function markSent(node, from, toNode, toAgent) {
  try { fs.mkdirSync(sentDir(node), { recursive: true }); fs.writeFileSync(path.join(sentDir(node), sentMarkName(from, toNode, toAgent)), String(Date.now())) } catch {}
}

async function call(key, action, body) {
  const res = await fetch(`${BASE_URL}?action=${action}`, {
    method: 'POST', headers: { 'x-relay-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text(); let data = null
  try { data = JSON.parse(text) } catch {}
  if (!res.ok) throw new Fail(4, `${action} HTTP ${res.status} ${data?.error ?? ''}`.trim())
  return data
}

export async function main(argv) {
  const a = parseArgs(argv)
  if (a.help) { console.log(USAGE); return 0 }
  if (a.whoami) { whoami(); return 0 }
  if (!a.to === !a.room) throw new Fail(1, `--to 與 --room 要二選一\n${USAGE}`)
  const { expectsReply, note } = resolveReplyFlag({ reply: a.reply, noReply: a.noReply, room: a.room })   // 先檢查旗標，沒說就不讀內文、不寄
  let body = a.body
  if (a.bodyFile) body = fs.readFileSync(a.bodyFile, 'utf8')
  else if (body === '-') body = fs.readFileSync(0, 'utf8')
  body = (body ?? '').replace(/\s+$/, '')
  if (!body && !a.files?.length) throw new Fail(1, `內文是空的\n${USAGE}`)
  const items = a.files?.length ? prepareFiles(a.files) : []   // 附件先在本機全部檢查完（不碰網路），不合格就不往下
  if (items.length) body = attachmentText(items, body)
  if (body.length > MAX_BODY) throw new Fail(1, `內文 ${body.length} 字，超過 ${MAX_BODY} 字`)
  if (a.replyTo && !UUID_RE.test(a.replyTo)) throw new Fail(1, '--reply-to 要是信件 id（uuid）')
  let toNode = '', toAgent = ''
  if (a.to) {
    const i = a.to.indexOf('/')
    toNode = i < 0 ? a.to : a.to.slice(0, i); toAgent = i < 0 ? '' : a.to.slice(i + 1)
    if (!ID_RE.test(toNode) && !PERSON_RE.test(toNode)) throw new Fail(1, `--to ${a.to} 的成員代號格式不對`)
  }
  const node = machineNode()
  const key = readMachineKey(node)
  const caller = findCaller('寄信')   // 先認人，再計次、再寄
  // 同節點可以寄（例如寄給本機的 ASN）：信經後端回到本機橋，照一般信轉交。只擋「寄給自己這個視窗」（沒有意義，還會把信轉回自己）
  if (toNode === node && toAgent === caller.name) throw new Fail(1, `收件人就是你自己（${node}/${caller.name}）；不能寄給自己`)
  takeRate(caller.name)
  // 附件先傳完並確認；任何一個失敗就丟錯，下面不會寄信
  const attachment_ids = items.length ? await uploadItems({ api: (action, b) => call(key, action, b), baseUrl: BASE_URL, items }) : undefined
  if (a.room) {
    const r = await call(key, 'room_post', { room: a.room, body, from_agent: caller.name, attachment_ids })
    console.log(`posted room=${a.room}${r?.seq != null ? ` seq=${r.seq}` : ''} from=${node}/${caller.name}`)
  } else {
    const r = await call(key, 'send', { to_node: toNode, to_agent: toAgent || undefined, body, reply_to: a.replyTo || undefined, from_agent: caller.name, expects_reply: expectsReply, attachment_ids })
    if (a.replyTo) markReplied(node, a.replyTo)
    markSent(node, caller.name, toNode, toAgent)
    console.log(`sent id=${r?.id} to=${a.to} from=${node}/${caller.name}`)
  }
  if (note) console.error(note)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 不呼叫 process.exit()：Windows 上 fetch 剛結束就強制結束，node 偶爾會在關閉 handle 時 assertion 當掉；改設 exitCode 讓事件圈自然結束
  main(process.argv.slice(2)).then(c => { process.exitCode = c }, e => {
    const known = e instanceof Fail || e instanceof AttachFail
    console.error(known ? e.message : `錯誤：${e.message}`)
    process.exitCode = known ? e.code : 4
  })
}
