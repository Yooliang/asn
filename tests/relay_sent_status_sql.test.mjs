// sent_status RPC：只回寄件人自己的信；replied_at 子查詢綁在該列 id 上。不連資料庫，只讀 SQL。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const sql = read('20261020000600_relay_sent_status_reply.sql')

test('migration：交易包裝、security definer、只授權 service_role', () => {
  assert.match(sql, /^begin;/m)
  assert.match(sql, /^commit;/m)
  assert.match(sql, /security definer[\s\S]*set search_path = ''/)
  assert.match(sql, /revoke all on function public\.irori_relay_sent_status\(text, uuid\[\]\) from public, anon, authenticated/)
  assert.match(sql, /grant execute on function public\.irori_relay_sent_status\(text, uuid\[\]\) to service_role/)
  assert.doesNotMatch(sql, /grant execute[^;]*to (anon|authenticated|public)/)
})

test('irori_relay_sent_status：where 限 from_node，子查詢只用 m.id', () => {
  assert.match(sql, /where m\.from_node = p_node/)
  assert.match(sql, /and m\.id = any\(coalesce\(p_ids, array\[\]::uuid\[\]\)\)/)
  assert.match(sql, /where r\.reply_to = m\.id/)
  assert.match(sql, /'replied_at'/)
  assert.doesNotMatch(sql, /from relay\.messages r[\s\S]*where r\.from_node <> p_node/)
})
