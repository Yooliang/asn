// 信件「要不要回信」欄位的 SQL 守門（node --test tests/relay_expects_reply_sql.test.mjs）：
// relay.messages 多一個可為 null 的 expects_reply（null＝舊信不知道）；irori_relay_send 多收一個選填參數、寫進去；
// irori_relay_inbox／irori_relay_inbox_agent 多回傳這個欄位；其他行為「一字不改」（函式本體和 01／08／16 的版本逐字比對，只差預期的幾行）；
// rollback 還原成舊版函式並拿掉欄位。這支不連資料庫，只讀 SQL 檔。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../supabase/sql/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')   // 工作目錄在 Windows 可能是 CRLF
const up = read('23_relay_expects_reply.sql')
const down = read('rollback/23_relay_expects_reply_down.sql')

// 取出名為 name（含參數列的開頭）的函式本體：$$ … $$ 之間的文字
function bodyOf(sql, header) {
  const i = sql.indexOf(header)
  assert.ok(i >= 0, `找不到 ${header}`)
  const a = sql.indexOf('$$', i), b = sql.indexOf('$$', a + 2)
  assert.ok(a > 0 && b > a, `${header} 沒有 $$ 本體`)
  return sql.slice(a, b + 2)
}
const must = (s, from, to) => { assert.ok(s.includes(from), `預期舊版本體有：${from}`); return s.replace(from, to) }

const SEND_OLD = bodyOf(read('16_tenants.sql'), 'create or replace function public.irori_relay_send(')
const INBOX_OLD = bodyOf(read('01_relay.sql'), 'create or replace function public.irori_relay_inbox(p_node text)')
const AGENT_OLD = bodyOf(read('08_agent_inbox.sql'), 'create or replace function public.irori_relay_inbox_agent(')

test('包在一個交易裡、可重複執行：add column if not exists、create or replace、drop function if exists', () => {
  assert.match(up, /^begin;$/m); assert.match(up, /^commit;$/m)
  assert.match(down, /^begin;$/m); assert.match(down, /^commit;$/m)
  assert.match(up, /alter table relay\.messages add column if not exists expects_reply boolean;/)
  assert.equal(up.match(/add column if not exists expects_reply boolean[^;]*;/)[0], 'add column if not exists expects_reply boolean;')   // null＝舊信不知道，不能有預設值或 not null
  assert.doesNotMatch(up, /^\s*(delete|truncate)\b|drop table|drop column/im)
  assert.doesNotMatch(up, /update relay\.messages\s+set\s+expects_reply/i)   // 不回填舊信：舊信維持 null
})

test('irori_relay_send：舊的 6 參數版本拿掉（免得多載造成呼叫歧義），新版多收選填的 p_expects_reply（預設 null＝舊程式照舊能呼叫）', () => {
  assert.match(up, /drop function if exists public\.irori_relay_send\(text, ?text, ?text, ?text, ?text, ?uuid\);/)
  assert.match(up, /create or replace function public\.irori_relay_send\(\s*p_from_node text, p_from_agent text, p_to_node text, p_to_agent text,\s*p_body text, p_reply_to uuid, p_expects_reply boolean default null\s*\) returns jsonb/)
  assert.match(up, /security definer set search_path = ''/)
})

test('irori_relay_send：本體和 16_tenants.sql 的版本逐字相同，只差 insert 多寫 expects_reply', () => {
  const now = bodyOf(up, 'create or replace function public.irori_relay_send(')
  const expected = must(SEND_OLD,
    'insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id)\n    values (p_from_node, p_from_agent, v_to, p_to_agent, p_body, p_reply_to, v_tenant)',
    'insert into relay.messages (from_node, from_agent, to_node, to_agent, body, reply_to, tenant_id, expects_reply)\n    values (p_from_node, p_from_agent, v_to, p_to_agent, p_body, p_reply_to, v_tenant, p_expects_reply)')
  assert.equal(now, expected)
})

test('irori_relay_inbox／irori_relay_inbox_agent：本體和 01／08 的版本逐字相同，只差回傳多一個 expects_reply（null 就是 null）', () => {
  const add = s => must(s, "'reply_to', m.reply_to, 'created_at', m.created_at,", "'reply_to', m.reply_to, 'created_at', m.created_at, 'expects_reply', m.expects_reply,")
  assert.equal(bodyOf(up, 'create or replace function public.irori_relay_inbox(p_node text)'), add(INBOX_OLD))
  assert.equal(bodyOf(up, 'create or replace function public.irori_relay_inbox_agent('), add(AGENT_OLD))
})

test('權限：新函式只開給 service_role，不開給 public／anon／authenticated', () => {
  for (const sig of ['public.irori_relay_send(text,text,text,text,text,uuid,boolean)', 'public.irori_relay_inbox(text)', 'public.irori_relay_inbox_agent(text,text)']) {
    assert.ok(up.includes(`'${sig}'`), `${sig} 要在授權清單裡`)
  }
  assert.match(up, /revoke execute on function %s from public, anon, authenticated/)
  assert.match(up, /grant execute on function %s to service_role/)
  assert.doesNotMatch(up, /grant execute[^;]*to (anon|authenticated|public)/)
})

test('rollback：send 還原成 16 的 6 參數版、inbox／inbox_agent 還原成 01／08 的版本、再拿掉欄位；順序是先還原函式再刪欄位', () => {
  assert.match(down, /drop function if exists public\.irori_relay_send\(text, ?text, ?text, ?text, ?text, ?uuid, ?boolean\);/)
  assert.equal(bodyOf(down, 'create or replace function public.irori_relay_send('), SEND_OLD)
  assert.match(down, /create or replace function public\.irori_relay_send\(\s*p_from_node text, p_from_agent text, p_to_node text, p_to_agent text,\s*p_body text, p_reply_to uuid\s*\) returns jsonb/)
  assert.equal(bodyOf(down, 'create or replace function public.irori_relay_inbox(p_node text)'), INBOX_OLD)
  assert.equal(bodyOf(down, 'create or replace function public.irori_relay_inbox_agent('), AGENT_OLD)
  assert.match(down, /alter table relay\.messages drop column if exists expects_reply;/)
  assert.ok(down.indexOf('drop column if exists expects_reply') > down.lastIndexOf('create or replace function'), '要先還原函式，最後才刪欄位')
  assert.match(down, /public\.irori_relay_send\(text,text,text,text,text,uuid\)/)   // 舊簽章要重新授權
  assert.doesNotMatch(down, /grant execute[^;]*to (anon|authenticated|public)/)
})
