// Claude 訂閱失效通知（#1646 拆項 G／H）：20261122210000_acct_sub_lapsed_notice.sql，比照 acct_sub_state_sql.test.mjs。
// 靜態：只換 asn_relay_acct_report 一支、簽章與權限不變、去掉新增片段等於 #2095 版本體、回復檔＝#2095 版本體。
// 實跑（pglite，沒裝就略過；寄信函式用替身，替身照真函式的規則計「每台每主題每小時」的上限）：
//   active 變 lapsed 寄 1 封；再報 lapsed 不寄；unknown／沒帶不寄；回到 active 再變 lapsed 又寄；從沒存過就是 lapsed 寄 1 封；
//   別台互不影響；限流；非 claude 不寄；內文只有電腦名與 email；整份被退回不寄；同一份重複 email 只寄一封。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const F = '20261122210000_acct_sub_lapsed_notice.sql'
const rd = s => s.replace(/\r+\n/g, '\n')
const read = f => rd(fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8'))
const mig = read(F)
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${F.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'))
const prev = read('20261122200000_acct_sub_state.sql')
const usable = read('20261115100000_acct_usable_at.sql')
const latest = read('20261120120000_acct_quota_latest_per_window.sql')
const share = read('20261110100000_acct_quota_share.sql')
const dropExp = read('20261113100000_acct_quota_drop_missing_expired.sql')
const simplify = read('20261113000000_acct_quota_rules_simplify.sql')
const wk = read('20261111200000_acct_quota_week_confirm.sql')
const gem = read('20261029130000_acct_roster_gemini.sql')
const flags = read('20261031100000_acct_login_flags.sql')
const reset = read('20261030100000_acct_reset_times.sql')
const roster = read('20261029100000_acct_roster.sql')
const lock = read('20261029110000_acct_roster_lock_lower.sql')
const base = read('20261021040000_asn_account_switch.sql').replace(/irori_relay_/g, 'asn_relay_').split('-- 90 天清理')[0] + 'commit;'
const priorMigs = ['20261023160000_acct_report_vendors.sql', '20261024130000_acct_switch_signed.sql', '20261024200000_acct_report_quota.sql', '20261026200000_acct_vendor_grok.sql'].map(read)

const SIG = 'asn_relay_acct_report(text, jsonb)'
const body = (sql, name) => { const s = sql.toLowerCase().indexOf(`create or replace function public.${name}(`); assert.ok(s >= 0, name); return sql.slice(s, sql.indexOf('$function$;', sql.toLowerCase().indexOf('$function$', s) + 5) + 11) }

const DECL = "\n  v_prev text;\n  v_alerts text[] := '{}';\n  v_email text;\n  v_computer text;\n  v_body text;\n  v_res jsonb;\n  v_ids jsonb := '[]'::jsonb;\n  v_topics jsonb := '[]'::jsonb;"
const stripNew = t => {
  // 把新增的幾塊逐段拿掉，剩下的要跟 #2095 版逐字相同
  let s = t.replace(DECL, '')
  s = s.replace(/\n    v_prev := null;/, '')
  s = s.replace(/\n      -- 這台上次存的同帳號值[\s\S]*?limit 1;(?=\n      v_sub := case)/, '')
  s = s.replace(/\n      -- 轉換：[\s\S]*?\n      end if;(?=\n    end if;\n    v_out)/, '')
  s = s.replace(/\n  -- 寄通知：[\s\S]*?\n  end if;(?=\n  return jsonb_build_object)/, '')
  return s.replace("'count', jsonb_array_length(v_out), 'mail_ids', v_ids, 'bell_topics', v_topics)", "'count', jsonb_array_length(v_out))")
}

test('靜態：只換 asn_relay_acct_report、權限不變；去掉新增片段等於 #2095 版；回復檔＝#2095 版；轉換判斷與寄信參數在', () => {
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  assert.ok(files.indexOf(F) > files.indexOf('20261122200000_acct_sub_state.sql'), '編號比 #2095 的大')
  assert.equal((mig.match(/^create or replace function/gim) ?? []).length, 1)
  assert.doesNotMatch(mig, /drop function|create table|drop table|alter table|create policy|truncate/i)
  assert.doesNotMatch(mig, /grant [^;]*to (anon|authenticated|public)/)
  for (const f of [mig, down]) {
    assert.ok(f.includes(`revoke all on function public.${SIG} from public, anon, authenticated;`))
    assert.ok(f.includes(`grant execute on function public.${SIG} to service_role;`))
    assert.match(f, /^begin;$/m); assert.match(f, /^commit;$/m)
  }
  const a = body(mig, 'asn_relay_acct_report'), b = body(prev, 'asn_relay_acct_report')
  assert.match(a, /security definer/i); assert.equal(a.match(/set search_path to ''/i)?.length, 1)
  assert.notEqual(a, b)
  assert.equal(stripNew(a), b, '去掉新增片段後等於 #2095 版')
  assert.equal(body(down, 'asn_relay_acct_report'), b, '回復檔＝#2095 版逐字')
  assert.match(a, /if v_sub = 'lapsed' and v_prev is distinct from 'lapsed'/, '轉換判斷')
  assert.match(a, /asn_relay_send_notice\(p_node, 'subscription', v_body, 3, interval '1 hour'\)/, '既有寄信函式、每台每小時 3 則')
})

let PGlite = await fastPGlite()
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const U1 = '11111111-1111-1111-1111-111111111111'

async function setup() {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.tenants(id uuid primary key, owner_user uuid);
    create table relay.nodes(id text primary key, tenant_id uuid, status text default 'active', role text default 'member', owner_user uuid, bell_topic text, name text, unique (tenant_id, id));
    create table relay.asn_presence(node text, updated_at timestamptz default now());
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable security definer set search_path = '' as $$
      select p_user is not null and exists (select 1 from relay.nodes n join relay.tenants t on t.id = n.tenant_id
        where n.id = p_node and n.status = 'active' and n.owner_user = p_user and t.owner_user = p_user) $$;
    insert into relay.tenants values ('${T1}', '${U1}');
    insert into relay.nodes(id, tenant_id, role, owner_user, bell_topic, name) values ('W', '${T1}', 'member', '${U1}', 'bell-W', '工作機'), ('Q', '${T1}', 'member', '${U1}', 'bell-Q', null), ('H', '${T1}', 'owner', '${U1}', 'bell-H', '家用');
    create table relay.sent(id uuid default gen_random_uuid(), node text, topic text, body text, at timestamptz default now());
    create function public.asn_relay_send_notice(p_node text, p_topic text, p_body text, p_limit integer default 3, p_window interval default interval '1 hour') returns jsonb language plpgsql as $$
      declare v_id uuid; begin
        if (select count(*) from relay.sent where node = p_node and topic = p_topic and at > now() - p_window) >= p_limit then
          return jsonb_build_object('ok', true, 'notify', 'rate_limited', 'bell_topics', '[]'::jsonb); end if;
        insert into relay.sent(node, topic, body) values (p_node, p_topic, p_body) returning id into v_id;
        return jsonb_build_object('ok', true, 'notify', 'sent', 'bell_topics', jsonb_build_array('bell-' || p_node), 'send', jsonb_build_object('id', v_id)); end $$;`)
  await db.exec(base)
  for (const p of priorMigs) await db.exec(p)
  for (const f of [roster, lock, gem, reset, flags, share, wk, simplify, dropExp, usable, latest, prev]) await db.exec(f)
  await db.exec(mig)
  return db
}
const rep = async (db, node, rows) => (await db.query('select public.asn_relay_acct_report($1, $2::jsonb) r', [node, JSON.stringify(rows)])).rows[0].r
const sent = async (db, node) => (await db.query(`select topic, body from relay.sent ${node ? 'where node = $1' : ''} order by at, ctid`, node ? [node] : [])).rows
const A = { vendor: 'claude', email: 'a@x.test', plan: 'max', current: true }

test('實跑：active 變 lapsed 寄 1 封；再報 lapsed 不寄；unknown／沒帶不寄；回 active 再變 lapsed 又寄', { skip }, async () => {
  const db = await setup()
  let r = await rep(db, 'W', [{ ...A, sub_state: 'active' }])
  assert.equal(r.ok, true); assert.deepEqual(r.mail_ids, []); assert.deepEqual(r.bell_topics, [])
  r = await rep(db, 'W', [{ ...A, sub_state: 'lapsed' }])
  assert.equal(r.count, 1); assert.equal(r.mail_ids.length, 1); assert.deepEqual(r.bell_topics, ['bell-W'])
  assert.equal((await sent(db)).length, 1)
  assert.equal(r.mail_ids[0], (await db.query('select id from relay.sent')).rows[0].id, '回的是寄出那封的 id')
  for (const row of [{ ...A, sub_state: 'lapsed' }, { ...A, sub_state: 'unknown' }, A]) {
    r = await rep(db, 'W', [row]); assert.deepEqual(r.mail_ids, [], JSON.stringify(row))
  }
  assert.equal((await sent(db)).length, 1, '已經是 lapsed 不重複')
  await rep(db, 'W', [{ ...A, sub_state: 'active' }])
  assert.equal((await rep(db, 'W', [{ ...A, sub_state: 'unknown' }])).mail_ids.length, 0, '讀不到不算失效')
  r = await rep(db, 'W', [{ ...A, sub_state: 'lapsed' }])
  assert.equal(r.mail_ids.length, 1); assert.equal((await sent(db)).length, 2, '恢復後又失效再寄一次')
})

test('實跑：從沒存過值，第一次就是 lapsed 也寄 1 封；沒帶／unknown 的帳號不寄', { skip }, async () => {
  const db = await setup()
  assert.deepEqual((await rep(db, 'W', [A])).mail_ids, [])
  assert.deepEqual((await rep(db, 'W', [{ ...A, sub_state: 'unknown' }])).mail_ids, [])
  assert.equal((await sent(db)).length, 0)
  assert.equal((await rep(db, 'Q', [{ ...A, email: 'n@x.test', sub_state: 'lapsed' }])).mail_ids.length, 1)
  assert.equal((await sent(db, 'Q')).length, 1)
})

test('實跑：別台互不影響；非 claude 不寄；同一份重複 email 只寄一封；多個帳號各一封', { skip }, async () => {
  const db = await setup()
  await rep(db, 'W', [{ ...A, sub_state: 'lapsed' }])
  assert.equal((await rep(db, 'Q', [{ ...A, sub_state: 'lapsed' }])).mail_ids.length, 1, 'W 已失效不影響 Q 這台')
  assert.deepEqual((await rep(db, 'W', [{ ...A, sub_state: 'lapsed' }])).mail_ids, [])
  const db2 = await setup()
  assert.deepEqual((await rep(db2, 'W', [{ vendor: 'codex', email: 'c@x.test', sub_state: 'lapsed' }, { vendor: 'grok', email: 'g@x.test', sub_state: 'lapsed' }])).mail_ids, [])
  assert.equal((await sent(db2)).length, 0, '非 claude 不寄')
  const r = await rep(db2, 'W', [{ ...A, sub_state: 'lapsed' }, { ...A, email: 'a@x.test', sub_state: 'lapsed' }, { ...A, email: 'b@x.test', sub_state: 'lapsed' }])
  assert.equal(r.mail_ids.length, 2); assert.deepEqual(r.bell_topics, ['bell-W', 'bell-W'])
})

test('實跑：限流（每台每小時 3 封），被限流的不回 id 但回報照樣寫入；整份退回時不寄', { skip }, async () => {
  const db = await setup()
  const rows = ['a', 'b', 'c', 'd'].map(n => ({ ...A, email: `${n}@x.test`, sub_state: 'lapsed' }))
  const r = await rep(db, 'W', rows)
  assert.equal(r.ok, true); assert.equal(r.count, 4); assert.equal(r.mail_ids.length, 3)
  assert.equal((await db.query(`select jsonb_array_length(accounts) n from relay.asn_accounts where node = 'W'`)).rows[0].n, 4)
  assert.equal((await rep(db, 'Q', [{ ...A, sub_state: 'lapsed' }])).mail_ids.length, 1, '別台不受影響')
  const db2 = await setup()
  assert.deepEqual(await rep(db2, 'W', [{ ...A, sub_state: 'lapsed' }, { vendor: 'claude', email: 'bad', sub_state: 'lapsed' }]), { error: 'bad_request' })
  assert.equal((await sent(db2)).length, 0, '整份退回不寄')
  assert.deepEqual(await rep(db2, 'W', [{ ...A, sub_state: 'bogus' }]), { error: 'bad_request' })
  assert.deepEqual(await rep(db2, '沒有這台', [{ ...A, sub_state: 'lapsed' }]), { error: 'not_found' })
})

test('實跑：通知內容寫電腦名與帳號、白話；沒名字用代號末 4 碼；不含方案等其他資料', { skip }, async () => {
  const db = await setup()
  await rep(db, 'W', [{ ...A, plan: 'SECRETPLAN', sub_state: 'lapsed' }])
  const [m] = await sent(db, 'W')
  assert.equal(m.topic, 'subscription')
  assert.equal(m.body, '工作機：Claude 訂閱已失效\n帳號 a@x.test 的訂閱已失效，這台的 Claude 夥伴會停擺。請到「設備與帳號」切換帳號或續訂。')
  assert.doesNotMatch(m.body, /SECRETPLAN|max|bell|token/i)
  await rep(db, 'Q', [{ ...A, email: 'q@x.test', sub_state: 'lapsed' }])
  assert.match((await sent(db, 'Q'))[0].body, /^電腦（代號末 4 碼 Q）：Claude 訂閱已失效\n帳號 q@x\.test /)
})

test('實跑：回復檔跑回去後不再寄、回傳沒有 mail_ids', { skip }, async () => {
  const db = await setup()
  await db.exec(down)
  assert.deepEqual(await rep(db, 'W', [{ ...A, sub_state: 'lapsed' }]), { ok: true, count: 1 })
  assert.equal((await sent(db)).length, 0)
})

closeAtEnd()
