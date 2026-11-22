// #2104 C：日誌守門。#2104 列的每一項都要有對應的 log 行；所有產生出來的行都不能有 token／密碼樣式字串或未遮的 email。
// 判準全寫在本檔（前綴字串與掃描規則都是手寫的），不 import 被測程式的常數或正則來驗它自己。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createStateLog } from '../ui/lib/state-log.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

// 故意把憑證、帳號、token 塞進輸入欄位：log 行不能把它們帶出來
const SECRET_EMAIL = 'someone.private@example.com'
const SECRET_TOKEN = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const row = (o = {}) => ({ id: 'claude', installed: true, version: '1.2.3', version_state: 'latest', latest: '1.2.3', login: 'in', login_count: 2, email: SECRET_EMAIL, token: SECRET_TOKEN, ...o })

function produceAllLines() {
  const lines = []
  const log = createStateLog(t => lines.push(t))
  log.aiCliStatus([row(), row({ id: 'codex', version: '0.5', login: 'out' })])
  log.aiCliStatus([row({ version: '1.2.4', version_state: 'behind', latest: '1.3.0' }), row({ id: 'codex', version: '0.5', login: 'in' })])
  log.aiCliDetect([{ id: 'claude', binary_found: true, version: '1.0' }, { id: 'codex', binary_found: false }])
  log.aiCliDetect([{ id: 'claude', binary_found: true, version: '1.0' }, { id: 'codex', binary_found: true, version: '0.9' }])
  log.claudeMod({ state: 'checking' })
  log.claudeMod({ state: 'installed', version: '0.2.63', reason: '找不到 claude 指令' })
  log.cwdAdded('D:\work\專案')
  log.cwdRemoved('D:\work\專案')
  log.cwdRejected('加入', '這個資料夾是系統資料夾，不能加入')
  return lines
}

// 每一項要有的行：[項目名, 行的開頭]
const EXPECTED = [
  ['ai-cli 初始', 'ai-cli 初始：'],
  ['ai-cli 變動', 'ai-cli 變動：'],
  ['ai-cli-detect 初始', 'ai-cli-detect 初始：'],
  ['ai-cli-detect 變動', 'ai-cli-detect 變動：'],
  ['外掛 初始', '外掛 初始：'],
  ['外掛 變動', '外掛 變動：'],
  ['資料夾 加入', '資料夾 加入：'],
  ['資料夾 移除', '資料夾 移除：'],
  ['資料夾 拒絕', '資料夾 拒絕：'],
]

test('#2104 每一項狀態都產得出對應的 log 行', () => {
  const lines = produceAllLines()
  for (const [name, head] of EXPECTED) {
    assert.ok(lines.some(l => l.startsWith(head)), `缺少「${name}」那一行（開頭 ${head}）：\n${lines.join('\n')}`)
  }
})

test('#2104 所有 log 行沒有 token／密碼樣式字串、也沒有未遮的 email', () => {
  const lines = produceAllLines()
  assert.ok(lines.length >= EXPECTED.length)
  const bad = [
    [/sk-ant-/i, 'sk-ant- 金鑰'],
    [/\bsk-[A-Za-z0-9_-]{8,}/, 'sk- 金鑰'],
    [/Bearer\s/i, 'Bearer 權杖'],
    [/[A-Za-z0-9+/_=-]{32,}/, '長度 32 以上的連續 base64／hex 樣式'],
    [/pass(word|wd)?\s*[=:：]/i, 'password='],
    [/(token|secret|api[_-]?key)\s*[=:：]/i, 'token=／secret=／api_key='],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/, '未遮的 email'],
    [/someone\.private|AAAAAAAA/, '輸入裡塞的帳號與權杖原文'],
  ]
  for (const l of lines) for (const [re, what] of bad) assert.ok(!re.test(l), `log 行含${what}：${l}`)
})

test('#2104 Rust 端：[elog] 前綴、輪替檔、寫檔出口遮 email 都在原始碼裡', () => {
  const src = read('../src-tauri/src/ui_log.rs')
  assert.ok(src.includes('info [elog] '), 'elog 那一行少了 [elog] 前綴')
  assert.ok(src.includes('"ui.log.1"'), '少了輪替檔 ui.log.1')
  // append 一定要遮 email（前端整批寫入與 elog 都經這裡）
  const body = src.split('pub fn append(')[1].split('// ---------- elog')[0]
  assert.ok(body.includes('mask_emails('), 'append 沒有遮 email')
  // elog! 真的寫進 ui.log
  assert.ok(read('../src-tauri/src/elog.rs').includes('ui_log::elog_to_file('), 'elog! 沒有寫進 ui.log')
})

test('#2104 對照文件列出每一種 log 行的開頭', () => {
  const doc = read('../../../docs/日誌對照.md')
  for (const [name, head] of EXPECTED) assert.ok(doc.includes(head), `docs/日誌對照.md 少了「${name}」（${head}）`)
  assert.ok(doc.includes('[elog]') && doc.includes('ui.log.1') && doc.includes('<email>'))
})
