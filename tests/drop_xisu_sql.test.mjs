// 拿掉角色節點 XISU（20261023150000_drop_xisu.sql）：
// 1. 靜態：不用 cascade／truncate、先備份再改寫再刪、整支一個交易、寄信函式除 XISU 寫死邏輯外與前一版逐字相同。
// 2. 實跑（pglite，帶真實外鍵）：刪除前後本人往來記錄筆數不變、歷史列都還在（改寫到接手設備）、備份表完整、
//    沒有外鍵錯誤、回信路徑正確（寄給 XISU／XISU/u:xxx／u:xxx／照收信欄位回信都扇出給本人）、可重跑。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const base = read('20261022020000_account_me.sql')
const display = read('20261022090000_owner_sender_display.sql')
const fixSend = read('20261023140000_reply_to_person.sql')
const mig = read('20261023150000_drop_xisu.sql')

const fnOf = (src, name) => {
  const m = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$function\\$;`, 'i').exec(src)
  assert.ok(m, `${name} 找不到`)
  return m[0]
}
const code = mig.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

test('靜態：整支在一個交易；不用 cascade／truncate；先備份、再改寫、最後才刪節點', () => {
  assert.match(mig, /^begin;$/m); assert.match(mig, /^commit;$/m)
  assert.doesNotMatch(code, /cascade|truncate|drop table|drop schema/i)
  const iBackup = code.indexOf('insert into relay._backup_xisu_20261023_messages')
  const iRewrite = code.indexOf("update relay.messages set from_node = v_h where from_node = 'XISU'")
  const iDelete = code.indexOf("delete from relay.nodes where id = 'XISU'")
  assert.ok(iBackup > 0 && iBackup < iRewrite && iRewrite < iDelete, '順序：備份 → 改寫 → 刪除')
  assert.equal((code.match(/delete from/g) ?? []).length, 1, '只准刪 XISU 那一列')
  for (const t of ['messages', 'launches', 'rooms', 'tenants', 'nodes']) assert.match(code, new RegExp(`create table if not exists relay\\._backup_xisu_20261023_${t} \\(like relay\\.${t}\\)`))
  assert.match(code, /revoke all on relay\._backup_xisu_20261023_messages/)
  assert.doesNotMatch(mig, /grant execute[^;]*to (anon|authenticated|public)/)
})

test('靜態：asn_relay_send 與 20261023140000 的差異只有 XISU 寫死邏輯換成相容寫法', () => {
  const now = fnOf(mig, 'asn_relay_send'), before = fnOf(fixSend, 'asn_relay_send')
  const oldBlock = "  if v_to = 'XISU' then\n    select character_node into v_char from relay.tenants where id = v_tenant;\n    if v_char is not null then v_to := v_char; end if;\n  end if;\n"
  assert.ok(before.includes(oldBlock))
  const s = now.indexOf('  -- 舊寫法相容：'), e = now.indexOf('    p_to_node := v_alias;\n  end if;\n', s) + '    p_to_node := v_alias;\n  end if;\n'.length
  assert.ok(s > 0 && e > s)
  assert.equal(now.slice(0, s) + now.slice(e), before.replace(oldBlock, '').replace('  v_char text;\n', ''))
  assert.doesNotMatch(now.slice(0, s) + now.slice(e), /'XISU'/, '除了相容區塊，函式不再寫死 XISU')
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001'

async function setup() {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.tenants(id uuid primary key, owner_user uuid, character_node text, owner_name text not null default '朋友');
    create table relay.nodes(id text primary key, tenant_id uuid not null, status text default 'active', role text default 'member',
      owner_user uuid, bell_topic text not null, created_at timestamptz default now(), name text not null default '', machine text, key_hash text,
      unique (tenant_id, id));
    create unique index nodes_one_owner_per_tenant on relay.nodes (tenant_id) where role = 'owner' and status = 'active';
    create table relay.messages(id uuid primary key default gen_random_uuid(), from_node text not null, from_agent text, to_node text not null, to_agent text,
      body text not null, reply_to uuid, created_at timestamptz default now(), delivered_at timestamptz, acked_at timestamptz, tenant_id uuid not null,
      expects_reply boolean, owner_signed boolean not null default false,
      constraint messages_from_node_fkey foreign key (from_node) references relay.nodes(id),
      constraint messages_from_same_tenant foreign key (tenant_id, from_node) references relay.nodes(tenant_id, id),
      constraint messages_to_node_fkey foreign key (to_node) references relay.nodes(id),
      constraint messages_to_same_tenant foreign key (tenant_id, to_node) references relay.nodes(tenant_id, id));
    create table relay.asn_presence(node text references relay.nodes(id), window_name text, updated_at timestamptz default now(), primary key (node, window_name));
    create table relay.roster(node text references relay.nodes(id), name text, engine text, primary key (node, name));
    create table relay.launches(id uuid primary key default gen_random_uuid(), tenant_id uuid, node text references relay.nodes(id),
      requested_by text not null references relay.nodes(id), name text);
    create table relay.rooms(id text primary key, tenant_id uuid, created_by text not null, name text);
    create table relay.partners(id uuid primary key default gen_random_uuid(), node text not null references relay.nodes(id), name text);
    create table relay.attachments(id uuid primary key default gen_random_uuid(), message_id uuid, room_id text, room_seq bigint, kind text, name text,
      mime text, bytes int, width int, height int, thumb text, status text default 'ready', expires_at timestamptz default now() + interval '30 days',
      removed_at timestamptz, created_at timestamptz default now(), owner_node text, tenant_id uuid, storage_path text);
    create table relay.room_members(room_id text, member text, left_at timestamptz);
    create function relay.node_tenant(p text) returns uuid language sql as $$ select tenant_id from relay.nodes where id = p $$;
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable as $$
      select p_user is not null and exists (select 1 from relay.nodes n join relay.tenants t on t.id = n.tenant_id
        where n.id = p_node and n.status = 'active' and n.owner_user = p_user and t.owner_user = p_user) $$;
    insert into relay.tenants values ('${T1}', '${U1}', null, '小良');
    insert into relay.nodes(id, tenant_id, role, owner_user, bell_topic, created_at, name, machine, key_hash) values
      ('XISU', '${T1}', 'owner', '${U1}', 'bell-XISU', now() - interval '5 day', '希緒', '家用機', 'hash-x'),
      ('P', '${T1}', 'member', '${U1}', 'bell-P', now() - interval '3 day', 'Oppo 手機', '手機', null),
      ('H', '${T1}', 'member', '${U1}', 'bell-H', now() - interval '4 day', '小良的家用機', '家用機', null),
      ('M', '${T1}', 'member', null, 'bell-M', now() - interval '1 day', 'M 機', null, null);
    update relay.tenants set character_node = 'XISU';
    insert into relay.roster values ('M', 'PCS', 'claude');`)
  await db.exec(base)
  await db.exec(display)
  await db.exec('alter function public.irori_relay_send(text, text, text, text, text, uuid, boolean, uuid, boolean) rename to asn_relay_send')
  await db.exec(fixSend)
  const q = async (text, args) => (await db.query(text, args)).rows
  const send = async (from, fromAgent, to, toAgent, body, extra = {}) => (await q(
    `select public.asn_relay_send($1,$2,$3,$4,$5,$6,$7,$8,$9) r`,
    [from, fromAgent, to, toAgent, body, extra.replyTo ?? null, extra.expects ?? true, extra.signed ?? null, extra.person ?? false]))[0].r
  const alias = (await q('select public.asn_person_alias($1) a', [U1]))[0].a
  return { db, q, send, alias }
}

// 造一批 Irori 時代的歷史：本人（手機 P）與 AI 的往來、XISU 當寄件／收件、未 ack 的舊信
async function seedHistory({ q, send, alias }) {
  const ins = (f, fa, t, ta, body, o = {}) => q(
    `insert into relay.messages(from_node, from_agent, to_node, to_agent, body, tenant_id, acked_at, created_at, person_user, owner_signed)
     values ($1,$2,$3,$4,$5,'${T1}',$6, now() - ($7 || ' hours')::interval, $8, $9)`,
    [f, fa, t, ta, body, o.acked === false ? null : new Date().toISOString(), String(o.hoursAgo ?? 50), o.person ?? null, o.signed ?? false])
  await send('P', 'P-ASN', 'M', 'PCS', '本人到AI-1', { signed: U1, person: true })
  await send('P', 'P-ASN', 'M', 'PCS', '本人到AI-2', { signed: U1, person: true })
  await q(`insert into relay.asn_presence(node, window_name) values ('P','P-ASN')`)
  await send('M', 'PCS', alias, null, 'AI回本人-1', { expects: false })
  await q(`delete from relay.asn_presence`)
  await send('M', 'PCS', alias, null, 'AI回本人-離線（留在XISU）', { expects: false })   // 沒有在線 ASN：留在角色節點
  await ins('XISU', 'Irori', 'M', 'PCS', 'XISU寄出-1', { hoursAgo: 300 })
  await ins('XISU', 'Irori', 'M', null, 'XISU寄出-2', { hoursAgo: 300 })
  await ins('M', 'PCS', 'XISU', null, '寄給XISU-舊已讀', { hoursAgo: 400 })
  await ins('M', 'PCS', 'XISU', '希緒', '寄給XISU-舊未讀指定視窗', { hoursAgo: 400, acked: false })
  await ins('M', 'PCS', 'XISU', null, '寄給XISU-近7天未讀', { hoursAgo: 2, acked: false })
}

const personCount = q => q(`select count(distinct coalesce(fanout_id, id)) n from relay.messages where person_user = '${U1}'`)

test('實跑（pglite）：刪除 XISU——歷史列全在、本人往來筆數不減、備份完整、無外鍵錯誤、接手設備升為擁有者', { skip }, async () => {
  const env = await setup()
  const { db, q } = env
  await seedHistory(env)
  await q(`insert into relay.launches(tenant_id, node, requested_by, name) values ('${T1}', 'H', 'XISU', '開窗'), ('${T1}', 'H', 'P', '開窗2')`)
  await q(`insert into relay.rooms values ('r1', '${T1}', 'XISU', '群'), ('r2', '${T1}', 'P', '群2')`)
  const idsBefore = (await q(`select id from relay.messages order by id`)).map(r => r.id)
  const personBefore = (await personCount(q))[0].n
  const xisuRows = (await q(`select count(*) n from relay.messages where from_node = 'XISU' or to_node = 'XISU'`))[0].n
  assert.ok(xisuRows >= 6, String(xisuRows))

  await db.exec(mig)

  // 歷史列一筆不少（原 id 都在），節點都改寫了，沒有任何列還指向 XISU
  const idsAfter = new Set((await q(`select id from relay.messages`)).map(r => r.id))
  assert.ok(idsBefore.every(id => idsAfter.has(id)), '原有信件不可少')
  assert.equal((await q(`select count(*) n from relay.messages where from_node = 'XISU' or to_node = 'XISU'`))[0].n, 0)
  assert.equal((await q(`select count(*) n from relay.nodes where id = 'XISU'`))[0].n, 0)
  // 本人往來（有 person_user 的）：筆數不減；多出來的只有「補扇出」的那一封（近 7 天、沒指定視窗、未 ack）和離線時留在 XISU 的回信不重複計
  const personAfter = (await personCount(q))[0].n
  assert.ok(personAfter >= personBefore, `本人往來不可減少：${personBefore} -> ${personAfter}`)
  // 備份：歷史列、launches、rooms、tenants、nodes 都有
  assert.equal((await q(`select count(*) n from relay._backup_xisu_20261023_messages`))[0].n, xisuRows)
  assert.equal((await q(`select count(*) n from relay._backup_xisu_20261023_launches`))[0].n, 1)
  assert.equal((await q(`select count(*) n from relay._backup_xisu_20261023_rooms`))[0].n, 1)
  assert.equal((await q(`select count(*) n from relay._backup_xisu_20261023_tenants`))[0].n, 1)
  assert.equal((await q(`select id, key_hash from relay._backup_xisu_20261023_nodes`))[0].id, 'XISU')
  // 其他引用
  assert.equal((await q(`select character_node from relay.tenants`))[0].character_node, null)
  assert.deepEqual((await q(`select requested_by from relay.launches order by name`)).map(r => r.requested_by), ['H', 'P'])
  assert.deepEqual((await q(`select created_by from relay.rooms order by id`)).map(r => r.created_by), ['H', 'P'])
  assert.deepEqual((await q(`select id, role from relay.nodes where role = 'owner'`)), [{ id: 'H', role: 'owner' }], '接手設備（本人名下最早的）升為擁有者')
  // 舊信不會被接手設備一次收到：不留任何寄給 H 的未 ack 舊信，除了補扇出的那一封（近 7 天）
  const pending = await q(`select body, to_node, to_agent from relay.messages where acked_at is null order by body`)
  const alias = env.alias
  assert.deepEqual(pending.filter(p => p.body.startsWith('寄給XISU')).map(p => [p.body, p.to_node, p.to_agent]), [['寄給XISU-近7天未讀', 'H', alias]])
  assert.equal((await q(`select acked_at is not null a from relay.messages where body = '寄給XISU-近7天未讀' and to_node = 'XISU'`)).length, 0)
  // 外鍵與唯一索引仍完整：能正常寄信
  assert.ok((await env.send('M', 'PCS', 'H', '某視窗', '刪除後一般信')).id)
})

test('實跑（pglite）：刪除後回信路徑——XISU、XISU/u:xxx、u:xxx、照收信欄位回信都扇出給本人；指定視窗的舊寫法是 unknown_to_node', { skip }, async () => {
  const env = await setup()
  const { db, q, send, alias } = env
  await db.exec(mig)
  await q(`insert into relay.asn_presence(node, window_name) values ('P','P-ASN'), ('H','H-ASN')`)
  for (const [i, [node, agent]] of [['XISU', null], ['XISU', ''], ['XISU', alias], [alias, null]].entries()) {
    const r = await send('M', 'PCS', node, agent, `回信路徑${i}`, { expects: false })
    assert.equal(r.fanout, 2, `${node}/${agent}`)
    const rows = await q(`select to_node, to_agent, person_user from relay.messages where body = $1 order by to_node`, [`回信路徑${i}`])
    assert.deepEqual(rows.map(x => [x.to_node, x.to_agent, x.person_user]), [['H', 'H-ASN', U1], ['P', 'P-ASN', U1]])
  }
  // 本人寄給 AI，AI 照收信欄位回信
  const sent = await send('P', 'P-ASN', 'M', 'PCS', '本人說', { signed: U1, person: true })
  const mail = (await q(`select public.irori_relay_inbox('M') r`))[0].r.find(m => m.id === sent.id)
  assert.equal(mail.from_node, 'P')
  assert.equal((await send('M', 'PCS', mail.from_node, mail.from_agent, '照欄位回', { replyTo: mail.id, expects: false })).fanout, 2)
  // 節點已不存在，指定了視窗名的舊寫法沒有地方可送
  assert.deepEqual(await send('M', 'PCS', 'XISU', '希緒', '指定視窗'), { error: 'unknown_to_node' })
  // 不是這個租戶擁有者的代號仍擋下
  assert.deepEqual(await send('M', 'PCS', 'u:000000000000', null, 'x'), { error: 'unknown_to_node' })
})

test('實跑（pglite）：可重跑；沒有可接手設備時整個交易失敗、什麼都不動', { skip }, async () => {
  const env = await setup()
  const { db, q } = env
  await seedHistory(env)
  await db.exec(mig)
  const snap = (await q(`select count(*) n from relay.messages`))[0].n
  await db.exec(mig)   // 第二次：XISU 已不在，什麼都不做
  assert.equal((await q(`select count(*) n from relay.messages`))[0].n, snap)

  const env2 = await setup()
  await env2.q(`update relay.nodes set status = 'left' where id in ('P','H')`)
  const before = (await env2.q(`select count(*) n from relay.nodes`))[0].n
  await assert.rejects(env2.db.exec(mig), /沒有可接手的設備節點/)
  await env2.q('rollback')   // 伺服器端連線結束時交易自然還原；pglite 同一條連線要明說
  assert.equal((await env2.q(`select count(*) n from relay.nodes where id = 'XISU'`))[0].n, 1, '失敗要整個還原')
  assert.equal((await env2.q(`select count(*) n from relay.nodes`))[0].n, before)
})
