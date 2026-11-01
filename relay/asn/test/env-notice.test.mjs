// 夥伴清單上「使用者環境變數裡有金鑰類變數」的提醒（共用終端服務，規格 11.2-6）：句子由後端組好，前端只負責取、不顯示就當沒有。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnvNotice } from '../ui/lib/env-notice.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = p => fs.readFileSync(path.join(here, '..', p), 'utf8')

test('後端回一句話就原樣顯示（去掉頭尾空白）', async () => {
  const s = '使用者環境變數裡有看起來像金鑰的變數（ASN_RELAY_KEY），會被帶進每個夥伴的終端；建議移到別處'
  assert.equal(await loadEnvNotice({ termEnvNotice: async () => `  ${s}\n` }), s)
})

test('沒有、空字串、不是字串、命令不存在、丟錯，一律當沒有', async () => {
  assert.equal(await loadEnvNotice({ termEnvNotice: async () => null }), '')
  assert.equal(await loadEnvNotice({ termEnvNotice: async () => '' }), '')
  assert.equal(await loadEnvNotice({ termEnvNotice: async () => ({ a: 1 }) }), '')
  assert.equal(await loadEnvNotice({}), '', '舊版後端／手機版沒有這個命令')
  assert.equal(await loadEnvNotice(null), '')
  assert.equal(await loadEnvNotice({ termEnvNotice: async () => { throw new Error('unknown command') } }), '')
})

test('接線：transport 有 termEnvNotice、電腦版註冊 term_env_notice、名單上有這一行', () => {
  assert.match(read('ui/lib/tauri.mjs'), /termEnvNotice: \(\) => invoke\('term_env_notice'\)/)
  const lib = read('src-tauri/src/lib.rs')
  const desktop = lib.slice(lib.indexOf('.invoke_handler('), lib.indexOf('.invoke_handler(', lib.indexOf('.invoke_handler(') + 1))
  assert.match(desktop, /[\s,]term_env_notice[\s,]/, 'term_env_notice 沒註冊在電腦版的指令清單')
  assert.match(read('ui/list.html'), /v-if="envNotice"/)
  assert.match(read('ui/list.js'), /envNotice/)
})

test('前台切換失敗時：後端標了要通知才把原因顯示出來（其他原因照舊靜默）', () => {
  const js = read('ui/list.js')
  assert.match(js, /r\?\.notify && r\.reason/)
})
