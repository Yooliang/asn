// 手機切換帳號「本人簽章」標記 migration：不連資料庫，只讀 SQL 守住規則（#300 第 1、2 項）。
// 簽章只能在發出指令的那一刻由 asn_user_owns_node 判定；沒簽章、簽章不成立一律 false；欄位預設 false；權限維持只給 service_role。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = fs.readFileSync(new URL('../supabase/migrations/20261026100000_acct_switch_signed_flag.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const fn = name => {
  const i = sql.indexOf(`function public.${name}(`)
  assert.ok(i >= 0, `找不到函式 ${name}`)
  return sql.slice(i, sql.indexOf('$function$;', sql.indexOf('as $function$', i)))
}

test('欄位 signed：不可為空、預設 false（舊指令與沒簽章的都是 false）', () => {
  assert.match(sql, /alter table relay\.account_switches add column if not exists signed boolean not null default false;/)
})

test('signed 只由 asn_user_owns_node(簽章使用者, 發起端) 判定，並且只在新增指令時寫入', () => {
  const sw = fn('asn_relay_acct_switch')
  assert.match(sw, /v_signed boolean := public\.asn_user_owns_node\(p_signed_user, p_actor\);/)
  assert.match(sw, /insert into relay\.account_switches \(tenant_id, requested_by, node, vendor, email, signed\)/)
  assert.match(sw, /values \(v_t, p_actor, p_node, p_vendor, p_email, v_signed\)/)
  assert.doesNotMatch(sw, /signed\s*=\s*true/i, '不直接寫死 true')
  // 其他地方（取走、回報結果）不能改 signed
  assert.doesNotMatch(sql, /update relay\.account_switches set (?:(?!\bwhere\b)[\s\S])*\bsigned\b/i)
})

test('發起端資格判斷不變：role = owner，或簽章成立；其餘 forbidden', () => {
  const sw = fn('asn_relay_acct_switch')
  assert.match(sw, /and \(role = 'owner' or v_signed\)/)
  assert.match(sw, /'error', 'forbidden'/)
  for (const e of ['not_found', 'bad_vendor', 'bad_email', 'asn_offline', 'unknown_account', 'busy', 'rate_limited']) assert.match(sw, new RegExp(`'error', '${e}'`), e)
})

test('取走待辦：把 signed 一起交給目標電腦，仍只動自己節點、pending 的列', () => {
  const p = fn('asn_relay_acct_switch_pending')
  assert.match(p, /where node = p_node and status = 'pending'/)
  assert.match(p, /returning id, requested_by, vendor, email, created_at, signed/)
  assert.match(p, /'signed', t\.signed/)
})

test('權限：兩支函式只給 service_role', () => {
  assert.match(sql, /revoke all on function public\.asn_relay_acct_switch\(text, text, text, text, uuid\) from public, anon, authenticated;/)
  assert.match(sql, /revoke all on function public\.asn_relay_acct_switch_pending\(text\) from public, anon, authenticated;/)
  assert.match(sql, /grant execute on function public\.asn_relay_acct_switch\(text, text, text, text, uuid\) to service_role;/)
  assert.match(sql, /grant execute on function public\.asn_relay_acct_switch_pending\(text\) to service_role;/)
  assert.doesNotMatch(sql, /to (anon|authenticated|public)\b/)
})

test('函式 search_path 為空、security definer（跟其他 acct 函式一致）', () => {
  for (const n of ['asn_relay_acct_switch', 'asn_relay_acct_switch_pending']) {
    const i = sql.indexOf(`function public.${n}(`)
    const head = sql.slice(i, sql.indexOf('as $function$', i))
    assert.match(head, /security definer/)
    assert.match(head, /set search_path to ''/)
  }
})
