// AI 端的群組規則：技能文件、asn-cli 子命令、後台的危險操作類別三處要一致（兩份真相＝一定會分家）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n')
const skill = read('relay', 'claude-mod', 'skills', 'asn', 'SKILL.md')
const kindsOf = src => [...src.matchAll(/"([a-z_]+)"/g)].map(m => m[1])

test('危險操作類別：後台、asn-cli、技能文件列的是同一組六類', () => {
  const backend = kindsOf(/CONFIRM_KINDS = \[([^\]]*)\]/.exec(read('supabase', 'functions', '_shared', 'rooms.ts'))[1])
  const cli = kindsOf(/pub const KINDS: \[&str; 6\] = \[([^\]]*)\]/.exec(read('relay', 'asn', 'src-tauri', 'src', 'cli', 'confirm.rs'))[1])
  assert.deepEqual(backend, ['data_change', 'deploy', 'spend', 'external_send', 'account_config', 'other'])
  assert.deepEqual(cli, backend, 'asn-cli 的類別要和後台一致')
  for (const k of backend) assert.ok(skill.includes(`\`${k}\``), `技能文件少了類別 ${k}`)
})

test('技能文件：被別人點名時創建性的事直接做；危險操作先請主持人確認、放行才做、只能用一次；有對應的 asn-cli 指令', () => {
  const sec = /## 群組裡被別人點名([\s\S]*?)\n## /.exec(skill)?.[1] ?? ''
  assert.ok(sec.length > 300, '要有「群組裡被別人點名」一節')
  for (const s of ['直接做', '調查', '寫文件', '新增檔案', '先請主持人確認', '修改或刪除既有的資料', 'asn-cli room confirm-request', 'asn-cli room confirm-status', 'approved', '只能用一次', '24 小時', '不要做']) assert.ok(sec.includes(s), `缺「${s}」`)
  assert.match(skill, /\| 群組裡做危險操作前，請主持人確認 \| `asn-cli room confirm-request --room/)
  assert.match(skill, /\| 查主持人有沒有放行 \| `asn-cli room confirm-status/)
})

test('asn-cli：room 子命令認得 confirm-request／confirm-status，頂層說明有列；確認請求只在後台的人簽章動作之外走節點金鑰', () => {
  const room = read('relay', 'asn', 'src-tauri', 'src', 'cli', 'room.rs'), mod = read('relay', 'asn', 'src-tauri', 'src', 'cli', 'mod.rs'), conf = read('relay', 'asn', 'src-tauri', 'src', 'cli', 'confirm.rs')
  assert.match(room, /"confirm-request" \| "confirm-status"/); assert.match(mod, /asn room\s+confirm-request/); assert.match(mod, /asn room\s+confirm-status/)
  assert.match(conf, /room_confirm_request/); assert.match(conf, /room_confirm_status/)
  assert.doesNotMatch(conf, /group_confirm_decide/, 'AI 絕不能自己按同意：同意只能由主持人本人簽章走 group_confirm_decide')
  assert.doesNotMatch(conf, /x-asn-user|api_signed/, 'asn-cli 沒有本人簽章')
  const rooms = read('supabase', 'functions', '_shared', 'groups.ts')
  assert.match(rooms, /"group_confirm_decide"/)
})