// 設備沒有名字時，所有通知的後備寫法統一成「電腦（X7K2）」「手機（Q9Z8）」：20261124100000_unnamed_device_label.sql
//   和介面 unnamedClue、Rust unnamed_clue 同一種寫法；有名字就寫名字。
// 靜態：新增 relay.device_label（stable、search_path 空、只給 service_role）；十五支通知函式簽章與權限不變；回復檔把各函式換回上一版。
// 實跑（pglite，沒裝就略過）：套用的是 migration 裡真正的函式本體（節點名字用後台實際會存的那種），
//   名字空白（空字串、全空白、null）寫「電腦（末 4 碼大寫）」，手機（platform 是 android／ios，或 kind＝phone）寫「手機（…）」，有名字寫名字；
//   主機名稱故意填 YOOLIANG-3080：不能再出現；用回復檔（舊本體）跑同一組斷言會變紅，證明守門有效。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const F = '20261124100000_unnamed_device_label.sql'
const rd = s => s.replace(/\r+\n/g, '\n')
const mig = rd(fs.readFileSync(new URL(`../supabase/migrations/${F}`, import.meta.url), 'utf8'))
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${F.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'))
const body = (sql, name) => {
  const s = sql.toLowerCase().indexOf(`create or replace function ${name}(`)
  assert.ok(s >= 0, name)
  return sql.slice(s, sql.indexOf('$function$;', sql.toLowerCase().indexOf('$function$', s) + 5) + 11)
}

const SIGS = {
  asn_relay_login_alert: 'text, text, timestamptz, text, integer',
  asn_relay_inbox_watch: 'boolean',
  asn_relay_send_bridge_notice: 'text, uuid, text',
  asn_relay_set_inbox_hold: 'text, timestamptz, integer, boolean',
  asn_relay_misroute_notice: 'text, uuid',
  asn_relay_waiting_notice: 'text, text, text, text, text',
  asn_relay_mux_down_notice: 'text, integer, boolean',
  asn_relay_mux_blind_notice: 'text',
  asn_relay_node_mismatch_notice: 'text, text',
  asn_relay_term_view_notice: 'text, uuid',
  asn_relay_device_key_alert: 'text, text, text, text',
  asn_relay_mux_resume_notice: 'text, integer, integer, text[]',
  asn_relay_compact_notice: 'text, text, integer, text, text, integer',
  asn_relay_acct_report: 'text, jsonb',
}
const NAMES = Object.keys(SIGS)

test('靜態：device_label 的屬性與授權；十四支通知函式簽章、權限不變、回復檔每支都有；只動後備', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.indexOf(F) > files.indexOf('20261123220000_login_alert_device_name.sql'), '編號在 login_alert 之後')
  assert.equal(files.filter(f => f.startsWith('20261124100000_')).length, 1, '版本號沒撞')
  assert.doesNotMatch(mig, /drop function|create table|drop table|alter table|create policy|truncate/i)
  assert.doesNotMatch(mig, /grant [^;]*to (anon|authenticated|public)/)
  for (const f of [mig, down]) { assert.match(f, /^begin;$/m); assert.match(f, /^commit;$/m) }
  const h = body(mig, 'relay.device_label')
  assert.match(h, /\bstable\b/); assert.match(h, /set search_path to ''/); assert.doesNotMatch(h, /security definer/i)
  assert.ok(mig.includes('revoke all on function relay.device_label(text) from public, anon, authenticated;'))
  assert.ok(mig.includes('grant execute on function relay.device_label(text) to service_role;'))
  assert.match(down, /drop function if exists relay\.device_label\(text\);/)
  for (const [n, sig] of Object.entries(SIGS)) {
    for (const f of [mig, down]) {
      assert.ok(f.includes(`revoke all on function public.${n}(${sig}) from public, anon, authenticated;`), n)
      assert.ok(f.includes(`grant execute on function public.${n}(${sig}) to service_role;`), n)
    }
    const b = body(mig, `public.${n}`)
    assert.match(b, /security definer/i, n); assert.equal(b.match(/set search_path to ''/i)?.length, 1, n)
    assert.doesNotMatch(b.replace(/^\s*--.*$/gm, ''), /未命名設備|代號末 4 碼 '/, `${n} 不再寫舊後備`)
    assert.match(b, /relay\.device_label\(/, `${n} 用共用的後備`)
    assert.match(body(down, `public.${n}`), /./, `${n} 回復檔有舊本體`)
  }
  assert.equal(NAMES.length, 14)
})

let PGlite = await fastPGlite()
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const U1 = '11111111-1111-1111-1111-111111111111'
const HOST = 'YOOLIANG-3080'
// 節點：有名字、全空白、null、手機（平台 android）、對方電腦（空白）
const NODES = [
  ['xisu7k2m', '30家用', null, null],
  ['blank9z8q', '  ', null, null],
  ['nul1abcd', null, null, null],
  ['phn7x2zk', '', null, 'android'],
  ['peerzzzz', '', null, null],
]
const EXPECT = { xisu7k2m: '30家用', blank9z8q: '電腦（9Z8Q）', nul1abcd: '電腦（ABCD）', phn7x2zk: '手機（X2ZK）' }
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

async function setup(source) {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.tenants(id uuid primary key, owner_user uuid);
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', owner_user uuid, name text, machine text, kind text, platform text,
      last_seen_at timestamptz default now(), inbox_hold_until timestamptz);
    create function relay.online_window() returns interval language sql immutable as $$ select interval '3 minutes' $$;
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable security definer set search_path = '' as $$
      select exists (select 1 from relay.nodes n join relay.tenants t on t.id = n.tenant_id where n.id = p_node and n.status = 'active' and n.owner_user = p_user and t.owner_user = p_user) $$;
    create function public.asn_relay_acct_email_ok(p text) returns boolean language sql as $$ select p like '%@%' $$;
    create function public.asn_relay_acct_quota(p jsonb) returns jsonb language sql as $$ select '{}'::jsonb $$;
    create table relay.sent(node text, topic text, body text);
    create function public.asn_relay_send_notice(p_node text, p_topic text, p_body text, p_limit integer default 3, p_window interval default interval '1 hour') returns jsonb language plpgsql as $$
      begin insert into relay.sent values (p_node, p_topic, p_body); return jsonb_build_object('ok', true, 'notify', 'sent', 'send', jsonb_build_object('id', gen_random_uuid()), 'bell_topics', '[]'::jsonb); end $$;
    create function public.asn_relay_send(p_from text, p_agent text, p_to text, p_to_agent text, p_body text, p_reply uuid, p_exp boolean, p_user uuid, p_person boolean) returns jsonb language plpgsql as $$
      begin insert into relay.sent values (p_from, 'bridge', p_body); return jsonb_build_object('id', gen_random_uuid()); end $$;
    create table relay.messages(id uuid primary key default gen_random_uuid(), to_node text, from_node text, from_agent text, to_agent text, kind text, reply_to uuid,
      fanout_id uuid, created_at timestamptz default now(), acked_at timestamptz, body text);
    create table relay.term_views(id uuid primary key, to_node text, from_node text, status text, notified_at timestamptz, window_name text, scope text);
    create table relay.device_key_alerts(node text, peer text, kind text, sent_at timestamptz default now(), primary key (node, peer, kind));
    create table relay.asn_accounts(node text primary key, accounts jsonb, updated_at timestamptz);
    create table relay.inbox_watch(node text primary key, state text default 'ok', stuck_since timestamptz, episode_oldest_at timestamptz, alert_since timestamptz,
      shadow_noticed_at timestamptz, level text, last_count int, last_oldest_at timestamptz, stuck_agents int default 0, orphan_count int default 0,
      updated_at timestamptz default now(), notified_at timestamptz, recovered_at timestamptz);
    create table relay.inbox_watch_log(at timestamptz default now(), node text, from_state text, to_state text, note text, cnt int, oldest_at timestamptz,
      stuck_since timestamptz, would_notify boolean, agents int);
    insert into relay.tenants values ('${T1}', '${U1}');`)
  for (const [id, name, kind, platform] of NODES) {
    await db.query('insert into relay.nodes(id, tenant_id, owner_user, name, machine, kind, platform) values ($1, $2, $3, $4, $5, $6, $7)', [id, T1, U1, name, HOST, kind, platform])
  }
  if (source === mig) await db.exec(body(mig, 'relay.device_label'))
  for (const n of NAMES) await db.exec(body(source, `public.${n}`))
  return db
}

// 每支通知：怎麼呼叫（n＝節點代號、i＝這個節點的序號）、寄出的主題
const CALLS = {
  asn_relay_login_alert: { topic: 'login', sql: `select public.asn_relay_login_alert($1, '${HOST}', now() - interval '2 minutes', 'a@x.test', 0)` },
  asn_relay_inbox_watch: { topic: 'inbox_watch' },   // 不在迴圈裡呼叫，一次掃全部節點（見 runAll）
  asn_relay_send_bridge_notice: { topic: 'bridge', sql: `select public.asn_relay_send_bridge_notice($1, $2::uuid, 'hello')` },
  asn_relay_set_inbox_hold: { topic: 'quota', sql: `select public.asn_relay_set_inbox_hold($1, now() + interval '1 hour', 3, false)` },
  asn_relay_misroute_notice: { topic: 'misroute', sql: `select public.asn_relay_misroute_notice($1, null)` },
  asn_relay_waiting_notice: { topic: 'waiting', sql: `select public.asn_relay_waiting_notice($1, 'win', 'permission', null, 'Bash')` },
  asn_relay_mux_down_notice: { topic: 'mux_down', sql: `select public.asn_relay_mux_down_notice($1, 2, false)` },
  asn_relay_mux_blind_notice: { topic: 'mux_blind', sql: `select public.asn_relay_mux_blind_notice($1)` },
  asn_relay_node_mismatch_notice: { topic: 'node_mismatch', sql: `select public.asn_relay_node_mismatch_notice($1, 'other123')` },
  asn_relay_term_view_notice: { topic: 'view', sql: `select public.asn_relay_term_view_notice($1, $2::uuid)` },
  asn_relay_device_key_alert: { topic: 'device_key', sql: `select public.asn_relay_device_key_alert($1, 'peerzzzz', 'first', 'aaaaaaaaaaaaaaaaaaaa')`, extra: ['電腦（ZZZZ）'] },
  asn_relay_mux_resume_notice: { topic: 'mux_down', sql: `select public.asn_relay_mux_resume_notice($1, 2, 0, array['a', 'b'])` },
  asn_relay_compact_notice: { topic: 'compact', sql: `select public.asn_relay_compact_notice($1, 'win', 3, 'remind_off', null, 50)` },
  asn_relay_acct_report: { topic: 'subscription', sql: `select public.asn_relay_acct_report($1, '[{"vendor":"claude","email":"a@x.test","sub_state":"lapsed"}]'::jsonb)` },
}

// 對每個節點、每支函式各跑一次，回 { 函式: { 節點: 寄出的內文（沒寄出是 undefined） } }
async function runAll(db) {
  const out = {}
  let k = 0
  const ids = {}
  for (const [n] of NODES) {
    k += 1
    const mail = uuid(100 + k), view = uuid(200 + k)
    ids[n] = { mail, view }
    const origin = n === 'xisu7k2m' ? 'peerzzzz' : 'xisu7k2m'
    await db.query(`insert into relay.messages(id, to_node, from_node, from_agent, to_agent, body) values ($1, $2, $3, 'bob', 'ag', 'x')`, [mail, n, origin])
    await db.query(`insert into relay.term_views values ($1, $2, 'nul1abcd', 'accepted', null, 'win', 'input')`, [view, n])
    // 收信卡住監控要的資料：這個代理 2 小時前確認過、最舊一封未確認的信 90 分鐘前寄的、監控狀態已經卡住 20 分鐘
    await db.query(`insert into relay.messages(to_node, to_agent, created_at, acked_at, body) values ($1, 'ag', now() - interval '3 hours', now() - interval '2 hours', 'old')`, [n])
    await db.query(`insert into relay.messages(to_node, to_agent, created_at, body) values ($1, 'ag', now() - interval '90 minutes', 'stuck')`, [n])
    await db.query(`insert into relay.inbox_watch(node, state, stuck_since, alert_since) values ($1, 'stuck', now() - interval '1 hour', now() - interval '20 minutes')`, [n])
  }
  // 收信卡住監控一次掃全部節點
  await db.query('select public.asn_relay_inbox_watch(true)')
  for (const [n] of NODES) {
    const row = (await db.query(`select body from relay.sent where node = $1 and topic = 'inbox_watch' order by ctid desc limit 1`, [n])).rows[0]
    ;(out.asn_relay_inbox_watch ??= {})[n] = row?.body
  }
  for (const [n] of NODES) {
    const { mail, view } = ids[n]
    for (const [fn, c] of Object.entries(CALLS)) {
      if (fn === 'asn_relay_inbox_watch') continue
      await db.query('delete from relay.sent where node = $1 and topic = $2', [n, c.topic])
      await db.query(c.sql, c.sql.includes('$2') ? [n, fn === 'asn_relay_term_view_notice' ? view : mail] : [n])
      const row = (await db.query('select body from relay.sent where node = $1 and topic = $2 order by ctid desc limit 1', [n, c.topic])).rows[0]
      ;(out[fn] ??= {})[n] = row?.body
    }
  }
  return out
}

test('設備名空白時，每支通知都寫「電腦（末 4 碼）」「手機（…）」；有名字寫名字；不出現主機名稱與舊後備', { skip }, async () => {
  const db = await setup(mig)
  const out = await runAll(db)
  for (const fn of NAMES) {
    for (const n of Object.keys(EXPECT)) {
      if (fn === 'asn_relay_inbox_watch' && n === 'phn7x2zk') { assert.equal(out[fn]?.[n], undefined, '手機不在收信卡住監控裡'); continue }
      const b = out[fn]?.[n]
      assert.ok(b, `${fn} ${n} 有寄出`)
      assert.ok(b.startsWith(`${EXPECT[n]}：`), `${fn} ${n}：${b}`)
      assert.ok(!b.includes(HOST) && !b.includes('未命名設備') && !b.includes('代號末 4 碼'), `${fn} ${n}：${b}`)
    }
  }
  assert.match(out.asn_relay_device_key_alert.xisu7k2m, /「電腦（ZZZZ）」第一次連到「30家用」/, '對方電腦沒名字也寫辨認線索')
  assert.match(out.asn_relay_term_view_notice.xisu7k2m, /「電腦（ABCD）」正在操作/, '另一台電腦沒名字也寫辨認線索')
  assert.match(out.asn_relay_compact_notice.blank9z8q, /設備 → 電腦（9Z8Q） → 工作管理員/)
})

test('device_label：名字清掉控制字元、最多 40 字；kind＝phone 也算手機；沒有代號英數字只寫「電腦」；查無此節點仍有後備', { skip }, async () => {
  const db = await setup(mig)
  const L = async p => (await db.query('select relay.device_label($1) l', [p])).rows[0].l
  await db.exec(`insert into relay.nodes(id, tenant_id, owner_user, name, kind) values ('ph2kind9', '${T1}', '${U1}', null, 'phone'),
    ('long0001', '${T1}', '${U1}', repeat('甲', 50), null), ('ctl00002', '${T1}', '${U1}', E'a\\tb', null)`)
  assert.equal(await L('ph2kind9'), '手機（IND9）')
  assert.equal(await L('long0001'), '甲'.repeat(40))
  assert.equal(await L('ctl00002'), 'ab')
  assert.equal(await L('--'), '電腦')
  assert.equal(await L('gone-abcd'), '電腦（ABCD）')
  assert.equal(await L(null), '電腦')
})

test('守門有效：回復檔（舊本體）寫的是舊後備，同一組斷言會紅（登入失效通知上一版就已是新寫法，不在此列）', { skip }, async () => {
  const db = await setup(down)
  const out = await runAll(db)
  for (const fn of NAMES.filter(n => n !== 'asn_relay_login_alert')) {
    const b = out[fn]?.blank9z8q
    assert.ok(b, `${fn} 有寄出`)
    assert.ok(!b.startsWith('電腦（9Z8Q）：'), `舊本體不該已是新寫法：${fn} ${b}`)
  }
  assert.ok(out.asn_relay_inbox_watch.blank9z8q.startsWith(`${HOST}：`), '舊的收信卡住退回主機名稱')
  assert.ok(out.asn_relay_send_bridge_notice.blank9z8q.startsWith(`${HOST}：`), '舊的橋通知退回主機名稱')
  assert.ok(out.asn_relay_set_inbox_hold.blank9z8q.startsWith('未命名設備：'))
  assert.ok(out.asn_relay_acct_report.blank9z8q.startsWith('電腦（代號末 4 碼 9z8q）：'))
})

closeAtEnd()
