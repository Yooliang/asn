// 契約：代貼端解析 send --whoami 輸出所依賴的固定字串，必須還在 caller.rs 的 whoami 裡。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  WHOAMI_CHAIN_PREFIX, WHOAMI_ENV_PREFIX, WHOAMI_NODE_PREFIX, WHOAMI_PID_KEY, WHOAMI_NAME_KEY, WHOAMI_NO_NAME,
} from '../../../tools/release/post_pending_rules.mjs'

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const caller = read('../src-tauri/src/cli/caller.rs')
const send = read('../src-tauri/src/cli/send.rs')

test('契約：caller.rs 的 --whoami 輸出文字一改這條就會紅，要同步改代貼端的解析（tools/release/post_pending_rules.mjs），另見 #2372', () => {
  assert.ok(caller.includes(`"${WHOAMI_CHAIN_PREFIX}{}"`), '行程鏈判定行')
  assert.ok(caller.includes(`"${WHOAMI_ENV_PREFIX}{}"`), '環境變數備援判定行')
  assert.ok(caller.includes(`"${WHOAMI_NODE_PREFIX}{}"`), '機器節點判定行')
  assert.ok(caller.includes(`"${WHOAMI_PID_KEY}{} ${WHOAMI_NAME_KEY}{}"`), '判定值的 pid= name= 格式')
  assert.ok(caller.includes(`"${WHOAMI_NO_NAME}"`), '視窗沒名字時的佔位字')
})

test('契約：send.rs 仍有 --whoami 進入點並呼叫 caller.rs 的 whoami（另見 #2372）', () => {
  assert.ok(send.includes('"--whoami"'))
  assert.match(send, /if a\.whoami \{\s*whoami\(env, io\)/)
})
