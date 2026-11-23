// #1881（#1860 E）登入失效通知的設備名：20261123120000_login_alert_device_name.sql
//   通知裡的設備名要等於後台記的名字（relay.nodes.name，設備頁同一份），不是 ASN 帶來的電腦主機名稱。
// 靜態：只換 asn_relay_login_alert 一支、簽章與權限不變；本體不再用 p_computer 組內文；回復檔＝notice_center 版本體。
// 實跑（pglite，沒裝就略過）：套用的是 migration 裡真正的函式本體，節點名字用後台實際會存的那種（例如「30家用」），
//   主機名稱故意帶 YOOLIANG-3080（擁有者實際撞到的那個）：內文必須寫後台的名字；名字空白寫「電腦（代號末 4 碼）」；
//   用回復檔（舊本體）跑同一組斷言會變紅，證明守門有效。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const F = '20261123120000_login_alert_device_name.sql'
const rd = s => s.replace(/\r+\n/g, '\n')
const read = f => rd(fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8'))
const mig = read(F)
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${F.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'))
const prev = read('20261111100000_notice_center.sql')
const SIG = 'asn_relay_login_alert(text, text, timestamptz, text, integer)'
const body = (sql, name) => { const s = sql.toLowerCase().indexOf(`create or replace function public.${name}(`); assert.ok(s >= 0, name); return sql.slice(s, sql.indexOf('$function$;', sql.toLowerCase().indexOf('$function$', s) + 5) + 11) }

test('#1881 靜態：只換 asn_relay_login_alert、權限不變；內文不再用 p_computer；回復檔＝notice_center 版本體', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.indexOf(F) > files.indexOf('20261122210000_acct_sub_lapsed_notice.sql'), '編號在 sub_lapsed 之後')
  assert.equal((mig.match(/^create or replace function/gim) ?? []).length, 1)
  assert.doesNotMatch(mig, /drop function|create table|drop table|alter table|create policy|truncate/i)
  assert.doesNotMatch(mig, /grant [^;]*to (anon|authenticated|public)/)
  for (const f of [mig, down]) {
    assert.ok(f.includes(`revoke all on function public.${SIG} from public, anon, authenticated;`))
    assert.ok(f.includes(`grant execute on function public.${SIG} to service_role;`))
    assert.match(f, /^begin;$/m); assert.match(f, /^commit;$/m)
  }
  const a = body(mig, 'asn_relay_login_alert'), b = body(prev, 'asn_relay_login_alert')
  assert.match(a, /security definer/i); assert.equal(a.match(/set search_path to ''/i)?.length, 1)
  assert.equal(body(down, 'asn_relay_login_alert'), b, '回復檔＝notice_center 版逐字')
  assert.doesNotMatch(a.replace(/^\s*--.*$/gm, ''), /btrim\(coalesce\(p_computer/, '不再用 p_computer 當設備名')
  assert.match(a, /from relay\.nodes where id = p_node and status = 'active'/)
  assert.match(a, /asn_relay_send_notice\(p_node, 'login', v_body, 3, interval '1 hour'\)/, '寄信、限流照舊')
})

let PGlite = await fastPGlite()
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const U1 = '11111111-1111-1111-1111-111111111111'
const HOST = 'YOOLIANG-3080'   // 擁有者 11-20 撞到的電腦主機名稱

async function setup(fnSql) {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.tenants(id uuid primary key, owner_user uuid);
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', owner_user uuid, name text);
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable security definer set search_path = '' as $$
      select exists (select 1 from relay.nodes n join relay.tenants t on t.id = n.tenant_id where n.id = p_node and n.status = 'active' and n.owner_user = p_user and t.owner_user = p_user) $$;
    create function public.asn_relay_acct_email_ok(p text) returns boolean language sql as $$ select p like '%@%' $$;
    insert into relay.tenants values ('${T1}', '${U1}');
    insert into relay.nodes(id, tenant_id, owner_user, name) values ('xisu7k2m', '${T1}', '${U1}', '30家用'), ('blank9z8q', '${T1}', '${U1}', '  '), ('nul1abcd', '${T1}', '${U1}', null);
    create table relay.sent(node text, topic text, body text);
    create function public.asn_relay_send_notice(p_node text, p_topic text, p_body text, p_limit integer default 3, p_window interval default interval '1 hour') returns jsonb language plpgsql as $$
      begin insert into relay.sent values (p_node, p_topic, p_body); return jsonb_build_object('ok', true, 'notify', 'sent', 'send', jsonb_build_object('id', gen_random_uuid())); end $$;`)
  await db.exec(fnSql)
  return db
}
const alert = async (db, node, computer = HOST) => {
  const r = (await db.query(`select public.asn_relay_login_alert($1, $2, now() - interval '2 minutes', 'a@x.test', 0) r`, [node, computer])).rows[0].r
  const sent = (await db.query('select body from relay.sent where node = $1 order by ctid desc limit 1', [node])).rows[0]?.body
  return { r, sent }
}
const fnOf = sql => body(sql, 'asn_relay_login_alert')

test('#1881 設備名只有一個來源：登入失效通知的名字等於後台記的名字，不是電腦主機名稱', { skip }, async () => {
  const db = await setup(fnOf(mig))
  const { r, sent } = await alert(db, 'xisu7k2m')
  assert.equal(r.error, undefined)
  assert.ok(sent.startsWith('30家用：Claude 登入失效'), sent)
  assert.ok(!sent.includes(HOST), '不能出現電腦主機名稱')
  const named = (await db.query(`select name from relay.nodes where id = 'xisu7k2m'`)).rows[0].name
  assert.equal(sent.split('：')[0], named, '通知的設備名＝後台 nodes.name（設備頁同一份）')
})

test('#1881 後台改名後，下一則通知跟著換；主機名稱帶什麼都不影響（新版不帶也行）', { skip }, async () => {
  const db = await setup(fnOf(mig))
  await db.exec(`update relay.nodes set name = '改過的名字' where id = 'xisu7k2m'`)
  assert.ok((await alert(db, 'xisu7k2m', 'OTHER-PC')).sent.startsWith('改過的名字：'))
  assert.ok((await alert(db, 'xisu7k2m', '')).sent.startsWith('改過的名字：'), '新版 ASN 不帶主機名稱也行')
})

test('#1881 後台名字空白（或沒有）：寫「電腦（代號末 4 碼）」，不退回主機名稱', { skip }, async () => {
  const db = await setup(fnOf(mig))
  for (const [node, tail] of [['blank9z8q', '9Z8Q'], ['nul1abcd', 'ABCD']]) {
    const { sent } = await alert(db, node)
    assert.ok(sent.startsWith(`電腦（${tail}）：Claude 登入失效`), sent)
    assert.ok(!sent.includes(HOST))
  }
})

test('#1881 其餘規則照舊：別人的節點、時間超出、email 不合都不寄', { skip }, async () => {
  const db = await setup(fnOf(mig))
  assert.equal((await alert(db, 'nobody')).r.error, 'not_claimed')
  const bad = (await db.query(`select public.asn_relay_login_alert('xisu7k2m', 'x', now() - interval '3 days') r`)).rows[0].r
  assert.equal(bad.error, 'bad_request')
  const badMail = (await db.query(`select public.asn_relay_login_alert('xisu7k2m', 'x', now(), 'nomail') r`)).rows[0].r
  assert.equal(badMail.error, 'bad_request')
  assert.equal((await db.query('select count(*)::int c from relay.sent')).rows[0].c, 0)
})

test('#1881 守門有效：舊本體（回復檔）會寫主機名稱，同一組斷言會紅', { skip }, async () => {
  const db = await setup(fnOf(down))
  const { sent } = await alert(db, 'xisu7k2m')
  assert.ok(sent.startsWith(`${HOST}：`), '舊本體寫的是主機名稱：' + sent)
  assert.notEqual(sent.split('：')[0], '30家用')
})

closeAtEnd()
