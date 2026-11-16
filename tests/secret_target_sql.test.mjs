// 登入網址只送給發出請求的手機（20261117100000_secret_target.sql；#1593）：
// 1. 靜態：六個函式除了本次加的行與上一版逐字相同；新簽章只授權 service_role；回復腳本放回上一版原文。
// 2. 實跑（pglite）：舊手機不帶＝全部設備看得到；帶了就只有那支看得到、別支看不到也回覆不了、門鈴只敲那支（沒有門鈴就一個都不敲）；
//    一般「程式要密碼」照舊給全部；請求結束、逾時、被新請求覆蓋、超過 15 分鐘後不再綁；舊的七參數簽章不存在。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = f => fs.readFileSync(new URL(`../supabase/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const REMOTE = rd('migrations/20261023060000_secret_remote.sql')
const LINKM = rd('migrations/20261101230000_secret_link.sql')
const SETUP = rd('migrations/20261102140000_setup_requests.sql')
const WATCH = rd('migrations/20261102130000_inbox_watch.sql')
const PLAT = rd('migrations/20261102170000_node_platform_phone.sql')
const DEV = rd('migrations/20261112400000_setup_device_login.sql')
const MODE = rd('migrations/20261116200000_setup_mode.sql')
const MIG = rd('migrations/20261117100000_secret_target.sql')
const DOWN = rd('sql/rollback/20261117100000_secret_target_down.sql')
const grab = (src, start) => { const i = src.indexOf(start); return src.slice(i, src.indexOf('$function$;', i) + '$function$;'.length) }
const fn = name => `create or replace function public.${name}(`
// 把新版函式本體裡本次加的行去掉，應該等於上一版原文
const stripReq = s => s
  .replace(", p_requester_phone text default null)", ')')
  .replace('  v_phone text;\n', '')
  .replace(/  -- 發出請求的手機[\s\S]*?end;\n(?=  insert into relay\.setup_requests)/, '')
  .replace('expires_at, mode, requester_phone)', 'expires_at, mode)')
  .replace(' end, p_mode, v_phone)\n', ' end, p_mode)\n')
  .replace(',\n        mode = excluded.mode, requester_phone = excluded.requester_phone;', ',\n        mode = excluded.mode;')
const stripPoll = s => s.replace(/, requester_phone = null/g, '')
const stripResult = stripPoll
const stripLink = s => s
  .replace('  v_target text;\n', '')
  .replace(/  -- 這個網址是為哪支手機產生的[\s\S]*?(?=  update relay\.secret_requests)/, '')
  .replace(', target_node = v_target where', ' where')
  .replace(/  if v_target is not null then[\s\S]*?  end if;\n(?=  return v_res;)/, '')
const stripPending = s => s.replace('\n      and (r.target_node is null or r.target_node = p_actor);', ';')
const stripReply = s => s.replace('\n      and (target_node is null or target_node = p_actor)', '')

const PAIRS = [
  ['asn_setup_request', MODE, stripReq],
  ['asn_relay_setup_poll', MODE, stripPoll],
  ['asn_relay_setup_result', SETUP, stripResult],
  ['asn_relay_secret_request_link', DEV, stripLink],
  ['asn_relay_secret_pending', LINKM, stripPending],
  ['asn_relay_secret_reply', REMOTE, stripReply],
]

test('靜態：六個函式除了本次加的行，與上一版逐字相同；而且確實有加行', () => {
  for (const [name, prev, strip] of PAIRS) {
    const now = grab(MIG, fn(name))
    assert.notEqual(now, grab(prev, fn(name)), `${name} 應該有改動`)
    assert.equal(strip(now), grab(prev, fn(name)), name)
  }
  const code = MIG.replace(/^--.*$/gm, '')
  assert.equal(code.split('create or replace function').length - 1, 6)
  assert.doesNotMatch(code, /create policy|grant execute[^;]*to (anon|authenticated|public)/)
})

test('靜態：欄位、八參數簽章只授權 service_role、舊的七參數先 drop；不帶網址的請求函式不動', () => {
  assert.match(MIG, /alter table relay\.setup_requests add column if not exists requester_phone text references relay\.nodes\(id\) on delete set null;/)
  assert.match(MIG, /alter table relay\.secret_requests add column if not exists target_node text;/)
  assert.match(MIG, /drop function if exists public\.asn_setup_request\(uuid, text, text, text, text, text, text\);/)
  assert.match(MIG, /revoke all on function public\.asn_setup_request\(uuid, text, text, text, text, text, text, text\) from public, anon, authenticated;/)
  assert.match(MIG, /grant execute on function public\.asn_setup_request\(uuid, text, text, text, text, text, text, text\) to service_role;/)
  assert.doesNotMatch(MIG.replace(/^--.*$/gm, ''), /function public\.asn_relay_secret_request\(/)
  for (const name of PAIRS.map(p => p[0])) {
    const i = MIG.indexOf(fn(name))
    assert.match(MIG.slice(i, MIG.indexOf('as $function$', i)), /security definer\s+set search_path to ''/, name)
  }
  // 只有 claude 才記手機；舊的 link 約束名稱沒有被這支 migration 碰（登入網址規則一致性測試找的是定義它的那一支）
  assert.match(MIG, /v_phone := case when p_kind = 'claude' and /)
  assert.ok(!MIG.includes('secret_requests_link_ck'))
})

test('靜態：回復腳本放回六個函式上一版原文，並 drop 新簽章與欄位', () => {
  for (const [name, prev] of PAIRS) assert.ok(DOWN.includes(grab(prev, fn(name))), name)
  for (const s of ['drop function if exists public.asn_setup_request(uuid, text, text, text, text, text, text, text);',
    'drop column if exists requester_phone;', 'drop column if exists target_node;',
    'revoke all on function public.asn_setup_request(uuid, text, text, text, text, text, text) from public, anon, authenticated;',
    'grant execute on function public.asn_setup_request(uuid, text, text, text, text, text, text) to service_role;']) assert.ok(DOWN.includes(s), s)
})

let PGlite = null
PGlite = await fastPGlite()
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const LINK = 'https://claude.ai/oauth/authorize?client_id=C&state=S&code_challenge=H&redirect_uri=R'
const pub = n => String(n).padStart(43, 'P')
const CIPHER = 'C'.repeat(120)

// mode：'new'＝套用本次 migration；'old'＝只到上一版（驗證新測試在舊程式上會紅）；'down'＝套用後再回復
async function boot(mode = 'new') {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, name text, machine text, kind text, status text default 'active', owner_user uuid, last_seen_at timestamptz,
      platform text, launch_closed_reason text, inbox_hold_until timestamptz, tenant_id uuid, bell_topic text);
    alter table relay.nodes add constraint nodes_platform_check check (platform is null or platform in ('linux', 'windows', 'macos'));
    create table relay.asn_presence(node text, window_name text default 'w', version text, updated_at timestamptz default now());
    create table relay.account_events(id bigint generated always as identity primary key, at timestamptz default now(), user_id uuid, event text not null, node text, detail jsonb);
    create table relay.messages(id uuid primary key default gen_random_uuid(), from_node text, from_agent text, to_node text, body text, created_at timestamptz default now(), acked_at timestamptz, fanout_id uuid);
    create table relay.device_keys(node text primary key, sign_pub text not null);
    create function public.asn_person_alias(p_user uuid) returns text language sql as $$ select 'u:' || substr(md5(p_user::text), 1, 12) $$;
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable as
      $$ select p_user is not null and exists (select 1 from relay.nodes n where n.id = p_node and n.status = 'active' and n.owner_user = p_user) $$;
    create function public.asn_relay_send(p_from_node text, p_from_agent text, p_to_node text, p_to_agent text, p_body text, p_reply_to uuid, p_expects_reply boolean, p_signed_user uuid, p_as_person boolean)
      returns jsonb language plpgsql as $$ begin insert into relay.messages(from_node, from_agent, to_node, body) values (p_from_node, p_from_agent, p_to_node, p_body); return jsonb_build_object('ok', true); end $$;`)
  const list = [REMOTE, LINKM, SETUP.slice(0, SETUP.indexOf('-- 清理：')) + '\ncommit;', WATCH.slice(0, WATCH.indexOf('-- ===cron===')) + '\ncommit;', PLAT, DEV, MODE]
  if (mode !== 'old') list.push(MIG)
  if (mode === 'down') list.push(DOWN)
  for (const sql of list) await db.exec(sql)
  const q = async (t, a) => (await db.query(t, a)).rows
  const one = async (t, a) => (await q(t, a))[0].r
  const node = async (id, o = {}) => {
    await db.query('insert into relay.nodes(id, owner_user, tenant_id, platform, bell_topic, last_seen_at) values ($1,$2,$3,$4,$5, now())',
      [id, 'user' in o ? o.user : U1, T1, o.platform ?? null, 'bell' in o ? o.bell : `bell-${id}`])
    if (o.version !== null) await db.query('insert into relay.asn_presence(node, version) values ($1, $2)', [id, o.version ?? '0.2.27'])
  }
  await node('PC', { platform: 'windows' })
  await node('PC2', { platform: 'windows' })
  await node('PHA', { platform: 'android', version: null })
  await node('PHB', { platform: 'ios', version: null })
  await node('PHN', { platform: 'android', version: null, bell: null })
  const h = {
    db, q, node,
    req: async (extra = '', n = 'PC') => one(`select public.asn_setup_request(p_user => $1, p_node => $2${extra}) r`, [U1, n]),
    reqPhone: async (phone, n = 'PC') => one('select public.asn_setup_request(p_user => $1, p_node => $2, p_requester_phone => $3) r', [U1, n, phone]),
    poll: async (n = 'PC') => one("select public.asn_relay_setup_poll($1, '0.2.27') r", [n]),
    result: async (ok = true, n = 'PC') => one('select public.asn_relay_setup_result($1, $2, null) r', [n, ok]),
    link: async (i = 1, n = 'PC') => one('select public.asn_relay_secret_request_link($1,$2,$3,$4,$5,$6,$7) r', [n, pub(i), 'Claude Code 登入', '重新登入', 180, LINK, U1]),
    plain: async (i = 50, n = 'PC') => one("select public.asn_relay_secret_request($1,$2,'git.exe','git push',180) r", [n, pub(i)]),
    pending: async actor => (await one('select public.asn_relay_secret_pending($1,$2) r', [actor, U1])).requests,
    reply: async (actor, id) => one('select public.asn_relay_secret_reply($1,$2,$3,$4,false) r', [actor, U1, id, CIPHER]),
    phoneOf: async () => (await q("select requester_phone p from relay.setup_requests where node = 'PC'"))[0]?.p ?? null,
    targetOf: async id => (await q('select target_node t from relay.secret_requests where id = $1', [id]))[0].t,
  }
  return h
}

test('實跑：舊手機不帶 requester_phone，登入網址不指定對象，同帳號兩支手機都看得到、都敲門鈴', { skip }, async () => {
  const h = await boot()
  assert.deepEqual(await h.req(), { ok: true, already: false, state: 'pending' })
  await h.poll()
  const r = await h.link()
  assert.equal(await h.targetOf(r.id), null)
  assert.deepEqual([...r.bell_topics].sort(), ['bell-PC2', 'bell-PHA', 'bell-PHB'])
  assert.equal((await h.pending('PHA')).length, 1)
  assert.equal((await h.pending('PHB')).length, 1)
})

test('實跑：帶 requester_phone，只有那支手機看得到、別支看不到也回覆不了，門鈴只敲那支', { skip }, async () => {
  const h = await boot()
  assert.deepEqual(await h.reqPhone('PHA'), { ok: true, already: false, state: 'pending' })
  assert.equal(await h.phoneOf(), 'PHA')
  await h.poll()
  assert.equal(await h.phoneOf(), 'PHA', '被電腦取走後還在')
  const r = await h.link()
  assert.deepEqual(r.bell_topics, ['bell-PHA'])
  assert.equal(await h.targetOf(r.id), 'PHA')
  assert.equal((await h.pending('PHA')).length, 1)
  assert.equal((await h.pending('PHA'))[0].link, LINK)
  assert.deepEqual(await h.pending('PHB'), [])
  assert.deepEqual(await h.pending('PC2'), [])
  assert.deepEqual(await h.reply('PHB', r.id), { error: 'not_found' })
  assert.deepEqual(await h.reply('PC2', r.id), { error: 'not_found' })
  assert.equal((await h.reply('PHA', r.id)).ok, true)
})

test('實跑：目標手機沒有門鈴，bell_topics 是空陣列，不退回全部；手機被刪掉網址也不退回全部', { skip }, async () => {
  const h = await boot()
  await h.reqPhone('PHN')
  await h.poll()
  const r = await h.link()
  assert.deepEqual(r.bell_topics, [])
  assert.equal(await h.targetOf(r.id), 'PHN')
  assert.deepEqual(await h.pending('PHA'), [])
  assert.deepEqual(await h.pending('PHB'), [])
  const h2 = await boot()
  await h2.reqPhone('PHA')
  await h2.poll()
  const r2 = await h2.link()
  await h2.db.query("delete from relay.nodes where id = 'PHA'")
  assert.equal(await h2.targetOf(r2.id), 'PHA', '目標手機不在了，指定對象照舊留著')
  assert.deepEqual(await h2.pending('PHB'), [])
  assert.equal((await h2.q("select count(*)::int n from relay.setup_requests where requester_phone = 'PHA'"))[0].n, 0, '請求上的手機欄位隨節點刪除設回空')
})

test('實跑：一般「程式要密碼」（不帶網址）照舊給全部設備', { skip }, async () => {
  const h = await boot()
  await h.reqPhone('PHA')
  await h.poll()
  const r = await h.plain()
  assert.equal(await h.targetOf(r.id), null)
  assert.deepEqual([...r.bell_topics].sort(), ['bell-PC2', 'bell-PHA', 'bell-PHB'])
  assert.equal((await h.pending('PHA')).length, 1)
  assert.equal((await h.pending('PHB')).length, 1)
})

test('實跑：回報結果後、逾時標失敗後、被新請求覆蓋後，手機都不殘留；超過 15 分鐘的 taken 不綁', { skip }, async () => {
  // 結果回報後，電腦自己再建的網址不綁手機
  let h = await boot()
  await h.reqPhone('PHA')
  await h.poll()
  await h.result(true)
  assert.equal(await h.phoneOf(), null)
  let r = await h.link()
  assert.equal(await h.targetOf(r.id), null)
  assert.equal((await h.pending('PHB')).length, 1)
  // 回報失敗同樣清掉
  h = await boot()
  await h.reqPhone('PHA'); await h.poll(); await h.result(false)
  assert.equal(await h.phoneOf(), null)
  // taken 太久沒回報，poll 標失敗
  h = await boot()
  await h.reqPhone('PHA'); await h.poll()
  await h.db.query("update relay.setup_requests set updated_at = now() - interval '41 minutes' where node = 'PC'")
  await h.poll()
  assert.equal((await h.q("select status from relay.setup_requests where node = 'PC'"))[0].status, 'failed')
  assert.equal(await h.phoneOf(), null)
  r = await h.link()
  assert.equal(await h.targetOf(r.id), null)
  // 同一台新請求覆蓋舊的（舊的 pending 已過期十分鐘），上一次的手機不殘留
  h = await boot()
  await h.reqPhone('PHA')
  await h.db.query("update relay.setup_requests set requested_at = now() - interval '11 minutes' where node = 'PC'")
  assert.deepEqual(await h.req(), { ok: true, already: false, state: 'pending' })
  assert.equal(await h.phoneOf(), null)
  await h.poll()
  r = await h.link()
  assert.equal(await h.targetOf(r.id), null)
  // 覆蓋成另一支手機：換成這次的
  h = await boot()
  await h.reqPhone('PHA')
  await h.db.query("update relay.setup_requests set requested_at = now() - interval '11 minutes' where node = 'PC'")
  await h.reqPhone('PHB')
  assert.equal(await h.phoneOf(), 'PHB')
  // 超過 15 分鐘的 taken 不綁
  h = await boot()
  await h.reqPhone('PHA'); await h.poll()
  await h.db.query("update relay.setup_requests set updated_at = now() - interval '16 minutes' where node = 'PC'")
  r = await h.link()
  assert.equal(await h.targetOf(r.id), null)
})

test('實跑：requester_phone 只收本人名下有效的手機節點（電腦、別人的、不存在的、已停用的一律不記）', { skip }, async () => {
  const h = await boot()
  await h.node('OTHERPH', { platform: 'android', user: U2, version: null })
  await h.node('OFFPH', { platform: 'android', version: null })
  await h.db.query("update relay.nodes set status = 'revoked' where id = 'OFFPH'")
  for (const p of ['PC2', 'OTHERPH', 'OFFPH', 'NOPE', '', null]) {
    await h.db.query("delete from relay.setup_requests")
    await h.db.query("delete from relay.account_events")
    assert.deepEqual(await h.reqPhone(p), { ok: true, already: false, state: 'pending' }, String(p))
    assert.equal(await h.phoneOf(), null, String(p))
  }
})

test('實跑：權限——新的八參數簽章只有 service_role 能執行，舊的七參數簽章不存在', { skip }, async () => {
  const { q } = await boot()
  const sig = 'public.asn_setup_request(uuid, text, text, text, text, text, text, text)'
  for (const [role, want] of [['service_role', true], ['anon', false], ['authenticated', false], ['public', false]]) {
    assert.equal((await q('select has_function_privilege($1, $2, $3) ok', [role, sig, 'execute']))[0].ok, want, role)
  }
  assert.equal((await q("select to_regprocedure('public.asn_setup_request(uuid, text, text, text, text, text, text)') r"))[0].r, null)
  assert.equal((await q("select count(*)::int n from pg_proc where proname = 'asn_setup_request'"))[0].n, 1)
})

test('實跑：回復後七參數簽章回來、八參數與兩個欄位不見，舊行為照舊（登入網址廣播）', { skip }, async () => {
  const h = await boot('down')
  assert.equal((await h.q("select count(*)::int n from information_schema.columns where column_name in ('requester_phone', 'target_node')"))[0].n, 0)
  assert.equal((await h.q("select to_regprocedure('public.asn_setup_request(uuid, text, text, text, text, text, text, text)') r"))[0].r, null)
  assert.deepEqual(await h.req(), { ok: true, already: false, state: 'pending' })
  await h.poll()
  const r = await h.link()
  assert.equal((await h.pending('PHA')).length, 1)
  assert.equal((await h.pending('PHB')).length, 1)
  assert.ok(r.id)
})

closeAtEnd()
