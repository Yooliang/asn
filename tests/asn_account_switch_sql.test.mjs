// ASN 遠端切換帳號 migration：不連資料庫，只讀 SQL 守住權限與規則（RLS、只給 service_role、擁有者限定、同租戶、只存 email、逾時、頻率、清理）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = fs.readFileSync(new URL('../supabase/migrations/20261021040000_asn_account_switch.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const fn = name => {
  const i = sql.indexOf(`function public.${name}(`)
  assert.ok(i >= 0, `找不到函式 ${name}`)
  return sql.slice(i, sql.indexOf('$function$;', sql.indexOf('as $function$', i)))
}

test('表：RLS 開、不給 anon／authenticated、沒有 policy；只存 email／方案，沒有任何權杖欄位', () => {
  for (const t of ['asn_accounts', 'account_switches']) {
    assert.match(sql, new RegExp(`alter table relay\\.${t} enable row level security;`))
    assert.match(sql, new RegExp(`revoke all on relay\\.${t} from public, anon, authenticated;`))
  }
  assert.doesNotMatch(sql, /create policy/)
  assert.doesNotMatch(sql, /token|credential|secret|password/i, '整份 migration 沒有權杖類欄位')
  assert.match(sql, /constraint account_switches_vendor_check check \(vendor = 'claude'\)/)
  assert.match(sql, /status = any \(array\['pending','taken','ok','failed','denied'\]\)/)
  assert.match(sql, /email = lower\(email\)/)
})

test('同租戶：指令的發起端與目標節點都要跟指令同租戶（複合外鍵）', () => {
  assert.match(sql, /account_switches_node_same_tenant foreign key \(tenant_id, node\) references relay\.nodes\(tenant_id, id\)/)
  assert.match(sql, /account_switches_requester_same_tenant foreign key \(tenant_id, requested_by\) references relay\.nodes\(tenant_id, id\)/)
})

test('擁有者限定：看別台清單、送指令都要 role = owner 且 active（跟 irori_relay_launch 同一種判法），並且限定同租戶', () => {
  for (const name of ['irori_relay_acct_list', 'irori_relay_acct_switch']) {
    const body = fn(name)
    assert.match(body, /where id = p_actor and role = 'owner' and status = 'active'/, name)
    assert.match(body, /return jsonb_build_object\('error', 'forbidden'\)/, name)
    assert.match(body, /tenant_id is not distinct from v_t/, `${name} 要限定同租戶`)
  }
})

test('送出前的檢查：對方 ASN 在線、email 在對方回報的清單裡、同時只能有一個在處理、每台每小時 10 次', () => {
  const body = fn('irori_relay_acct_switch')
  assert.match(body, /relay\.asn_presence where node = p_node and updated_at > now\(\) - interval '3 minutes'/)
  assert.match(body, /'asn_offline'/)
  assert.match(body, /e->>'email' = p_email/)
  assert.match(body, /'unknown_account'/)
  assert.match(body, /status in \('pending', 'taken'\)[\s\S]*'busy'/)
  assert.match(body, /interval '1 hour'\) >= 10[\s\S]*'rate_limited'/)
  assert.match(body, /p_vendor is distinct from 'claude'/)
})

test('回報、取待辦、回報結果：只動金鑰所屬的自己節點（p_node），結果只能從 taken 改', () => {
  assert.match(fn('irori_relay_acct_report'), /insert into relay\.asn_accounts \(node, accounts, updated_at\) values \(p_node,/)
  assert.match(fn('irori_relay_acct_report'), /jsonb_array_length\(p_accounts\) > 20/)
  assert.match(fn('irori_relay_acct_switch_pending'), /where node = p_node and status = 'pending'/)
  const res = fn('irori_relay_acct_switch_result')
  assert.match(res, /where id = p_id and node = p_node and status = 'taken'/)
  assert.match(res, /p_status not in \('ok', 'failed', 'denied'\)/)
})

test('查結果：只看得到自己送出的指令', () => {
  assert.match(fn('irori_relay_acct_switch_status'), /s\.requested_by = p_actor and s\.id = any \(p_ids\)/)
})

test('逾時：3 分鐘沒被取走、10 分鐘沒回報都標失敗，取待辦與查結果時順便處理', () => {
  const e = fn('irori_relay_acct_expire')
  assert.match(e, /status = 'pending' and created_at <= now\(\) - interval '3 minutes'/)
  assert.match(e, /status = 'taken' and taken_at <= now\(\) - interval '10 minutes'/)
  assert.match(fn('irori_relay_acct_switch_pending'), /irori_relay_acct_expire\(\)/)
  assert.match(fn('irori_relay_acct_switch_status'), /irori_relay_acct_expire\(\)/)
})

test('每個函式：security definer、search_path 清空、只授權 service_role（不給 anon／authenticated／public）', () => {
  const names = [...sql.matchAll(/create or replace function public\.(irori_relay_acct_\w+)\(/g)].map(m => m[1])
  assert.equal(names.length, 8)
  for (const n of names) {
    const head = sql.slice(sql.indexOf(`function public.${n}(`), sql.indexOf('as $function$', sql.indexOf(`function public.${n}(`)))
    assert.match(head, /set search_path to ''/, n)
    if (n !== 'irori_relay_acct_email_ok') assert.match(head, /security definer/, n)
    assert.match(sql, new RegExp(`revoke all on function public\\.${n}\\([^)]*\\) from public, anon, authenticated`), n)
    assert.match(sql, new RegExp(`grant execute on function public\\.${n}\\([^)]*\\) to service_role`), n)
  }
  assert.doesNotMatch(sql, /grant execute[^;]*to (anon|authenticated|public)/)
})

test('90 天清理排程：每天 03:37（UTC），冪等（先 unschedule）', () => {
  assert.match(sql, /cron\.unschedule\('asn-account-switch-purge-90d'\)/)
  assert.match(sql, /cron\.schedule\('asn-account-switch-purge-90d', '37 3 \* \* \*'/)
  assert.match(sql, /delete from relay\.account_switches where created_at < now\(\) - interval '90 days'/)
  assert.match(sql, /delete from relay\.asn_accounts where updated_at < now\(\) - interval '90 days'/)
})
