// 登入過期推播（20261119400000_waiting_notice_login.sql，#1792）：asn_relay_waiting_notice 多收 login。
// 靜態：回復檔逐字等於上一版定義（20261111100000_notice_center.sql）；實跑（pglite）：內文、名額與等待確認分開、其他種類不變。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const NAME = '20261119400000_waiting_notice_login'
const SIG = 'asn_relay_waiting_notice(text, text, text, text, text)'
const rd = s => s.replace(/\r+\n/g, '\n')
const DIR = new URL('../supabase/migrations/', import.meta.url)
const mig = rd(fs.readFileSync(new URL(`${NAME}.sql`, DIR), 'utf8'))
const down = rd(fs.readFileSync(new URL(`../supabase/sql/rollback/${NAME}_down.sql`, import.meta.url), 'utf8'))

function fnOf(file, name, schema = 'public') {
  const s = rd(fs.readFileSync(new URL(file, DIR), 'utf8'))
  const st = s.indexOf(`create or replace function ${schema}.${name}(`)
  assert.ok(st >= 0, `${file} 找不到 ${name}`)
  const tag = /\$\w*\$/.exec(s.slice(st))[0]
  const i = s.indexOf(tag, st) + tag.length
  const j = s.indexOf(tag, i) + tag.length
  return s.slice(st, s.indexOf(';', j) + 1)
}

test('靜態：回復檔逐字等於上一版定義；新版只授權 service_role、security definer', () => {
  const old = fnOf('20261111100000_notice_center.sql', 'asn_relay_waiting_notice')
  assert.ok(down.includes(old), '回復檔缺上一版原文')
  assert.ok(down.includes(`revoke all on function public.${SIG} from public, anon, authenticated;`))
  assert.equal((mig.match(/^create or replace function/gim) ?? []).length, 2, 'waiting_notice 與 web_denied_notice')
  assert.match(mig, /security definer\s+set search_path to ''/)
  assert.ok(mig.includes(`revoke all on function public.${SIG} from public, anon, authenticated;`))
  assert.ok(mig.includes(`grant execute on function public.${SIG} to service_role;`))
  assert.match(mig, /'waiting_login'/)
  assert.doesNotMatch(mig.replace(/^--.*$/gm, ''), /grant [^;]*to (anon|authenticated|public)|drop |create table|alter table|truncate/i)
})

test('靜態：web_denied_notice 回復檔逐字等於 #1766 的定義；新版多擋 notice:waiting_login，其餘不變', () => {
  const old = fnOf('20261119200000_web_sessions.sql', 'web_denied_notice', 'relay')
  assert.ok(down.includes(old), '回復檔缺 #1766 的原文')
  const neu = fnOf(`${NAME}.sql`, 'web_denied_notice', 'relay')
  assert.ok(neu.includes("'notice:waiting_login'"))
  assert.equal(neu.replace(", 'notice:waiting_login'", ''), old)
  assert.ok(mig.includes('revoke all on function relay.web_denied_notice(text) from public, anon, authenticated;'))
})

test('靜態：relay 放行 login，且寄出後照樣推播 waiting', () => {
  const src = rd(fs.readFileSync(new URL('../supabase/functions/_shared/waiting_notice.ts', import.meta.url), 'utf8'))
  assert.match(src, /"login"/)
  const idx = rd(fs.readFileSync(new URL('../supabase/functions/relay/index.ts', import.meta.url), 'utf8'))
  assert.match(idx, /data\?\.notify === "sent"\) signal\.background\(notifyPush\([^\n]*"waiting", me\.id, null\)/)
})

const PGlite = await fastPGlite()
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'
const OWNER = 'bbbbbbbb-0000-0000-0000-00000000000a'

async function setup() {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, status text default 'active', owner_user uuid, name text);
    create table relay.messages(id uuid default gen_random_uuid() primary key, fanout_id uuid, from_node text, from_agent text, to_node text, body text, expects_reply boolean, kind text, created_at timestamptz default now());
    insert into relay.nodes(id, owner_user, name) values ('W', '${OWNER}', '工作機'), ('X', null, '沒有主人');
    create function public.asn_user_owns_node(u uuid, n text) returns boolean language sql as $$ select true $$;
    create function public.asn_person_alias(u uuid) returns text language sql as $$ select 'u:' || right(u::text, 4) $$;
    create function public.asn_relay_send(a text, b text, c text, d text, e text, f uuid, g boolean, h uuid, i boolean) returns jsonb language plpgsql as $$
      declare v uuid; begin insert into relay.messages(from_node, from_agent, to_node, body, expects_reply) values (a, b, c, e, g) returning id into v; return jsonb_build_object('ok', true, 'id', v, 'bell_topics', jsonb_build_array('bell-1')); end $$;`)
  await db.exec(fnOf('20261111100000_notice_center.sql', 'asn_relay_send_notice'))
  await db.exec(fnOf('20261111100000_notice_center.sql', 'asn_relay_waiting_notice')) // 上一版
  await db.exec(mig)
  return db
}
const notice = async (db, node, kind, win = 'asn雯') => (await db.query('select public.asn_relay_waiting_notice($1, $2, $3, null, null) r', [node, win, kind])).rows[0].r
const msgs = async (db, node) => (await db.query('select body, kind, expects_reply from relay.messages where from_node = $1 order by created_at', [node])).rows

test('實跑（pglite）：login 內文寫出設備、視窗、要重新登入，kind 是 notice:waiting_login', { skip }, async () => {
  const db = await setup()
  const r = await notice(db, 'W', 'login')
  assert.deepEqual([r.ok, r.notify, r.bell_topics], [true, 'sent', ['bell-1']])
  const m = await msgs(db, 'W')
  assert.equal(m[0].body, '工作機：「asn雯」Claude 登入過期，要重新登入。')
  assert.equal(m[0].kind, 'notice:waiting_login')
  assert.equal(m[0].expects_reply, false)
})

test('實跑（pglite）：login 每節點每小時 6 封，和等待確認的名額分開；原有種類內文不變', { skip }, async () => {
  const db = await setup()
  for (let i = 0; i < 6; i++) assert.equal((await notice(db, 'W', 'login')).notify, 'sent')
  assert.equal((await notice(db, 'W', 'login')).notify, 'rate_limited')
  assert.equal((await notice(db, 'W', 'other')).notify, 'sent', 'login 用完不影響等待確認')
  for (let i = 0; i < 5; i++) assert.equal((await notice(db, 'W', 'other')).notify, 'sent')
  assert.equal((await notice(db, 'W', 'other')).notify, 'rate_limited')
  await db.exec(`delete from relay.messages where kind = 'notice:waiting_login'`)
  assert.equal((await notice(db, 'W', 'login')).notify, 'sent', '等待確認用完不影響 login')
  const o = (await msgs(db, 'W')).find(x => x.kind === 'notice:waiting')
  assert.equal(o.body, '工作機：夥伴「asn雯」在等你處理\n已經等超過 2 分鐘。')
})

test('實跑（pglite）：web_denied_notice 擋 waiting_login 與原本四種，不擋別的', { skip }, async () => {
  const db = await setup()
  await db.exec('create schema if not exists relay')
  await db.exec(fnOf('20261119200000_web_sessions.sql', 'web_denied_notice', 'relay'))
  await db.exec(mig)
  const q = async k => (await db.query('select relay.web_denied_notice($1) r', [k])).rows[0].r
  for (const k of ['notice:login', 'notice:waiting', 'notice:device_key', 'notice:view', 'notice:waiting_login']) assert.equal(await q(k), true, k)
  for (const k of ['notice:quota', 'notice:mux_down', null]) assert.notEqual(await q(k), true, String(k))
})

test('實跑（pglite）：login 沒有擁有者不寄；不認得的種類 bad_request', { skip }, async () => {
  const db = await setup()
  assert.equal((await notice(db, 'X', 'login')).notify, 'skipped')
  assert.deepEqual(await notice(db, 'W', 'nope'), { error: 'bad_request' })
  assert.deepEqual(await notice(db, 'W', 'login', ' '), { error: 'bad_request' })
})

closeAtEnd()
