// #14 R6 改名 migration（20261023040000_asn_relay_rename.sql）：public.irori_relay_* → public.asn_relay_*，舊名留薄包裝。
// 1. 靜態檢查：整支在交易內、可重跑的檢查、包裝只呼叫新名。
// 2. 實跑檢查：有安裝 @electric-sql/pglite 時（自己 `npm i --no-save @electric-sql/pglite`）在記憶體內的 Postgres 依序套用 migrations 目錄裡的全部檔案
//    （改名那支之前的先套，記下改名前的函式清單，再套改名），驗證：新名全部在、舊名包裝在且回傳相同、觸發器仍觸發、
//    內部呼叫與排程都改成新名、權限只給 service_role、重跑不出錯。沒裝就略過。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const DIR = new URL('../supabase/migrations/', import.meta.url)
const RENAME = '20261023040000_asn_relay_rename.sql'
const read = f => fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\r\n/g, '\n').replace(/create extension if not exists \w+[^;]*;/g, '')
const sql = read(RENAME)
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

test('靜態：整支在交易內；改名先檢查新名是否已存在；包裝 security definer＋search_path 空且只呼叫新名', () => {
  assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m)
  assert.match(sql, /if not exists \(\s*select 1 from pg_proc p[\s\S]*?asn_relay_'[\s\S]*?\) then\s+execute format\('alter function/)
  const wrappers = sql.split('create or replace function public.irori_relay_').slice(1)
  assert.ok(wrappers.length >= 60, '包裝數量：' + wrappers.length)
  for (const w of wrappers) {
    const head = w.slice(0, w.indexOf('$function$;') + 11)
    assert.match(head, /security definer\n set search_path to ''\nas \$function\$\n  select (\* from )?public\.asn_relay_\w+\(/, head.slice(0, 60))
    assert.doesNotMatch(head.slice(head.indexOf('as $function$')), /irori_relay_/, '包裝內容只准有新名')
  }
  assert.doesNotMatch(sql, /grant execute[^;]*to (anon|authenticated|public)/)
  assert.match(sql, /revoke all on function %s from public, anon, authenticated/)
  assert.match(sql, /grant execute on function %s to service_role/)
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const T1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const U1 = '11111111-1111-1111-1111-111111111111'

async function boot({ withRename }) {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key, email text, created_at timestamptz default now());
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid, bucket_id text, name text); alter table storage.objects enable row level security;
    alter default privileges in schema public grant execute on functions to anon, authenticated;
    create schema cron; create table cron.job(jobid serial, jobname text, schedule text, command text);
    create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job(jobname,schedule,command) values (n,s,c) returning jobid::bigint $$;
    create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname=n returning true $$;`)
  for (const f of files) {
    if (f === RENAME) break
    await db.exec(read(f))
  }
  // 改名前就有的外來排程（呼叫舊名），驗證排程指令會被改
  await db.exec(`select cron.schedule('t-old-name', '0 0 * * *', 'select public.irori_relay_acct_expire()')`)
  const before = (await db.query(`select proname, pg_get_function_identity_arguments(oid) ident from pg_proc where pronamespace = 'public'::regnamespace and proname like 'irori\\_relay\\_%' order by 1, 2`)).rows
  if (withRename) for (const f of files.slice(files.indexOf(RENAME))) await db.exec(read(f))
  return { db, before }
}
const rows = async (db, q, a = []) => (await db.query(q, a)).rows
const one = async (db, q, a = []) => (await rows(db, q, a))[0]
const newName = n => n.replace(/^irori_relay_/, 'asn_relay_')
const j = async (db, fn, args = []) => (await one(db, `select to_jsonb(public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(', ')})) as v`, args)).v

async function seed(db) {
  await db.exec(`
    insert into relay.tenants(id) values ('${T1}');
    insert into relay.nodes(id, name, key_hash, bell_topic, tenant_id, role, can_roster, machine, kind) values
      ('H', '家用機', 'kh-h', 'bell-h', '${T1}', 'owner', true, '家用機', 'claude'),
      ('W', '工作機', 'kh-w', 'bell-w', '${T1}', 'member', true, '工作機', 'claude');`)
}

test('實跑：改名前有 60 支以上的 irori_relay_ 函式；改名後新名全數存在、簽章一致、舊名各留一支包裝', { skip }, async () => {
  const { db, before } = await boot({ withRename: true })
  assert.ok(before.length >= 60, '改名前函式數：' + before.length)
  const now = await rows(db, `select proname, pg_get_function_identity_arguments(oid) ident, prosrc, prosecdef, proconfig from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'irori\\_relay\\_%' or proname like 'asn\\_relay\\_%')`)
  for (const b of before) {
    const nu = now.find(x => x.proname === newName(b.proname) && x.ident === b.ident)
    const old = now.find(x => x.proname === b.proname && x.ident === b.ident)
    assert.ok(nu, '缺新名 ' + newName(b.proname) + '(' + b.ident + ')')
    assert.ok(old, '缺舊名包裝 ' + b.proname + '(' + b.ident + ')')
    assert.ok(old.prosrc.includes('public.' + newName(b.proname) + '('), '包裝要呼叫新名：' + b.proname)
    assert.ok(old.prosecdef && String(old.proconfig).includes('search_path'), '包裝要 security definer＋search_path 空：' + b.proname)
    assert.doesNotMatch(nu.prosrc, /irori_relay_/, '新名內容不得還有舊名：' + nu.proname)
  }
  assert.equal(now.filter(x => x.proname.startsWith('asn_relay_')).length, before.length)
  assert.equal(now.filter(x => x.proname.startsWith('irori_relay_')).length, before.length)
  // 內部呼叫已改新名
  const sync = now.find(x => x.proname === 'asn_relay_partner_sync')
  assert.match(sync.prosrc, /public\.asn_relay_partner_sync_core\(/)
  // relay 結構描述的函式也沒有舊名
  assert.deepEqual(await rows(db, `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'relay' and p.prosrc like '%irori\\_relay\\_%'`), [])
  // 排程指令改新名
  const cron = await rows(db, `select jobname, command from cron.job`)
  assert.ok(cron.every(c => !c.command.includes('irori_relay_')))
  assert.match(cron.find(c => c.jobname === 't-old-name').command, /asn_relay_acct_expire/)
})

test('實跑：權限——新舊名都只有 service_role 能執行，public／anon／authenticated 都不行', { skip }, async () => {
  const { db } = await boot({ withRename: true })
  const bad = await rows(db, `select p.oid::regprocedure::text as sig, r.rolname from pg_proc p cross join (values ('anon'), ('authenticated')) r(rolname)
     where p.pronamespace = 'public'::regnamespace and (p.proname like 'irori\\_relay\\_%' or p.proname like 'asn\\_relay\\_%')
       and has_function_privilege(r.rolname, p.oid, 'execute')`)
  assert.deepEqual(bad, [])
  const pub = await rows(db, `select p.oid::regprocedure::text as sig from pg_proc p
     where p.pronamespace = 'public'::regnamespace and (p.proname like 'irori\\_relay\\_%' or p.proname like 'asn\\_relay\\_%')
       and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')`)
  assert.deepEqual(pub, [], 'public 不得有執行權')
  const missing = await rows(db, `select p.oid::regprocedure::text as sig from pg_proc p
     where p.pronamespace = 'public'::regnamespace and (p.proname like 'irori\\_relay\\_%' or p.proname like 'asn\\_relay\\_%')
       and not has_function_privilege('service_role', p.oid, 'execute')`)
  assert.deepEqual(missing, [])
})

test('實跑：舊名包裝與新名回傳相同（含預設參數、回傳表格、純量、空參數的多載）', { skip }, async () => {
  const { db } = await boot({ withRename: true })
  await seed(db)
  const same = async (fn, args) => assert.deepEqual(await j(db, 'irori_relay_' + fn, args), await j(db, 'asn_relay_' + fn, args), fn)
  await same('launch_name_ok', ['abc'])
  await same('launch_name_ok', ['不 合法'])
  await same('acct_email_ok', ['a@b.co'])
  await same('room_auto_rules', [])
  await same('room_auto_rules', ['H'])
  await same('roster_has', ['H', 'x'])
  await same('whoami', [T1])
  await same('list', [T1])
  await same('room_list', ['H'])        // 用到預設值 p_owner
  await same('room_list', ['H', true])
  await same('inbox', ['H'])            // 用到預設值 p_exclude_agents
  await same('inbox_peek', ['H', 'x'])
  assert.deepEqual(
    (await rows(db, `select * from public.irori_relay_auth('kh-h')`)),
    (await rows(db, `select * from public.asn_relay_auth('kh-h')`)))
  assert.equal((await rows(db, `select * from public.irori_relay_auth('kh-h')`)).length, 1, '回傳表格有那一列')
  assert.deepEqual(await rows(db, `select public.irori_relay_acct_expire() is null as v`), await rows(db, `select public.asn_relay_acct_expire() is null as v`))
  // 具名參數（PostgREST 的呼叫方式）：只給必要的、略過有預設值的
  const named = await one(db, `select to_jsonb(public.irori_relay_room_list(p_node => 'H')) as v`)
  assert.deepEqual(named.v, await j(db, 'asn_relay_room_list', ['H']))
})

test('實跑：舊名寄信、新名寄信都寫進同一張表；寫入觸發器（解析夥伴 ID）仍觸發', { skip }, async () => {
  const { db } = await boot({ withRename: true })
  await seed(db)
  await j(db, 'asn_relay_partner_sync', ['W', JSON.stringify([{ name: '小離', session_id: 's-1', engine: 'claude' }])])
  const pid = (await one(db, `select partner_id from relay.partners where node = 'W' and current_name = '小離'`))?.partner_id
  assert.ok(pid, '夥伴同步（新名，內部呼叫新名的 _core）要建出夥伴記錄')
  const viaOld = await j(db, 'irori_relay_send', ['H', null, 'W', '小離', '舊名寄的', null, null, null, false])
  const viaNew = await j(db, 'asn_relay_send', ['H', null, 'W', '小離', '新名寄的', null, null, null, false])
  assert.ok(viaOld.id && viaNew.id, JSON.stringify([viaOld, viaNew]))
  const ms = await rows(db, `select body, to_partner_id from relay.messages order by created_at, body`)
  assert.equal(ms.length, 2)
  assert.ok(ms.every(m => m.to_partner_id === pid), '觸發器要把收件夥伴 ID 寫上：' + JSON.stringify(ms))
  // 舊名的同步（包裝 → 新名 → _core）也能跑
  const viaOldSync = await j(db, 'irori_relay_partner_sync', ['W', JSON.stringify([{ name: '小離', session_id: 's-1', engine: 'claude' }])])
  assert.ok(viaOldSync.partners, JSON.stringify(viaOldSync))
  // 觸發器綁的函式是同一個物件，沒被重建成別的
  const trg = await rows(db, `select tgname, tgfoid::regproc::text f from pg_trigger where not tgisinternal order by 1`)
  assert.deepEqual(trg.map(t => t.tgname), ['messages_resolve_partner', 'messages_unarchive_sender'])
})

test('實跑：改名 migration 重跑不出錯、結果不變（新名已存在就不再改名，包裝不被當成本體）', { skip }, async () => {
  const { db } = await boot({ withRename: true })
  const snap = async () => JSON.stringify(await rows(db, `select proname, pg_get_function_identity_arguments(oid) i, md5(prosrc) m, proacl::text a from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'irori\\_relay\\_%' or proname like 'asn\\_relay\\_%') order by 1, 2`))
  const a = await snap()
  await db.exec(sql)
  await db.exec(sql)
  assert.equal(await snap(), a)
})
