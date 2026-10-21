// ASN 在線狀態 migration：不連資料庫，只讀 SQL 守住權限與規則（RLS、只給 service_role、只寫自己的節點、3 分鐘、90 天清理）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const sql = read('20261021020000_asn_presence.sql')

test('表：主鍵 (node, window_name)、RLS 開、不給 anon／authenticated、status 白名單、psm ≤ 80', () => {
  assert.match(sql, /create table relay\.asn_presence \(/)
  assert.match(sql, /constraint asn_presence_pkey primary key \(node, window_name\)/)
  assert.match(sql, /alter table relay\.asn_presence enable row level security;/)
  assert.match(sql, /revoke all on relay\.asn_presence from public, anon, authenticated;/)
  assert.match(sql, /check \(status in \('online', 'away', 'busy'\)\)/)
  assert.match(sql, /char_length\(psm\) <= 80/)
  assert.doesNotMatch(sql, /create policy/)
})

test('set 函式：security definer、只授權 service_role、只動 p_node 那一列、offline＝刪列、每節點最多 20 列', () => {
  assert.match(sql, /function public\.irori_relay_asn_presence_set\(p_node text, p_window text, p_version text, p_status text, p_psm text\)[\s\S]*security definer[\s\S]*set search_path to ''/)
  assert.match(sql, /revoke all on function public\.irori_relay_asn_presence_set\(text, text, text, text, text\) from public, anon, authenticated/)
  assert.match(sql, /grant execute on function public\.irori_relay_asn_presence_set\(text, text, text, text, text\) to service_role/)
  assert.doesNotMatch(sql, /grant execute[^;]*to (anon|authenticated|public)/)
  assert.match(sql, /delete from relay\.asn_presence where node = p_node and window_name = v_window/)
  assert.match(sql, /where node = p_node\) >= 20/)
})

test('list：asn 只帶 3 分鐘內回報的列；原有欄位都還在', () => {
  assert.match(sql, /relay\.asn_presence p where p\.node = n\.id and p\.updated_at > now\(\) - interval '3 minutes'/)
  for (const k of ["'id'", "'name'", "'kind'", "'machine'", "'online'", "'presence'", "'last_seen_at'", "'avatar_updated_at'", "'agents'", "'asn'"]) assert.ok(sql.includes(k), k)
  assert.match(sql, /grant execute on function public\.irori_relay_list\(uuid\) to service_role/)
})

test('90 天清理排程：每天 03:23（UTC），冪等（先 unschedule）', () => {
  assert.match(sql, /cron\.unschedule\('asn-presence-purge-90d'\)/)
  assert.match(sql, /cron\.schedule\('asn-presence-purge-90d', '23 3 \* \* \*'/)
  assert.match(sql, /delete from relay\.asn_presence where updated_at < now\(\) - interval '90 days'/)
})
