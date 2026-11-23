// 換新設備處理舊設備（20261124210000_device_replace.sql，#1860 H）。
// 1. 靜態：新函式 security definer、search_path 空、只授權 service_role；回復檔把 set_node_platform 換回上一版本體；沒有裸寫在線門檻。
// 2. 實跑（pglite；寄通知的 asn_relay_send_notice 用替身，只記「寄了什麼」）：候選規則、只通知一次、只在平台空變有值時觸發、
//    通知丟例外不影響回報平台、取代／不取代的效果與冪等、別人的節點被擋、回復後回到上一版。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = f => fs.readFileSync(new URL(`../supabase/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const MIG = rd('migrations/20261124210000_device_replace.sql')
const DOWN = rd('sql/rollback/20261124210000_device_replace_down.sql')
const PLAT = rd('migrations/20261102170000_node_platform_phone.sql')
const WINDOW = rd('migrations/20261123120000_online_window.sql')
const LABEL = rd('migrations/20261124100000_unnamed_device_label.sql')
const RENAME = rd('migrations/20261113500000_device_rename.sql')
const OWNS = rd('migrations/20261021060000_owner_signed.sql')
const grab = (src, start) => { const i = src.indexOf(start); assert.ok(i >= 0, start); return src.slice(i, src.indexOf('$function$;', i) + '$function$;'.length) }
const code = MIG.replace(/^--.*$/gm, '')

test('靜態：三個對外函式 security definer、search_path 空、只授權 service_role；沒有開給 anon／authenticated', () => {
  for (const sig of ['asn_device_replace_candidates\\(p_user uuid, p_actor text\\)', 'asn_device_replace\\(p_user uuid, p_actor text, p_new text, p_old text\\)', 'asn_device_replace_dismiss\\(p_user uuid, p_actor text, p_new text\\)']) {
    assert.match(MIG, new RegExp(`function public\\.${sig}[\\s\\S]*?security definer\\s+set search_path to ''`), sig)
  }
  for (const s of ['asn_device_replace_candidates(uuid, text)', 'asn_device_replace(uuid, text, text, text)', 'asn_device_replace_dismiss(uuid, text, text)']) {
    assert.ok(MIG.includes(`revoke all on function public.${s} from public, anon, authenticated;`), s)
    assert.ok(MIG.includes(`grant execute on function public.${s} to service_role;`), s)
  }
  assert.match(MIG, /revoke all on function relay\.new_device_check\(text\) from public, anon, authenticated;/)
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(code, /create policy/)
  assert.match(code, /new_device_check\(p_node\)[\s\S]*security definer\s+set search_path to ''/)
})

test('靜態：取代函式核對 actor、新、舊三台都是本人的；候選規則只有一份（取代也呼叫 device_replace_old_nodes）', () => {
  const body = grab(MIG, 'create or replace function public.asn_device_replace(')
  assert.match(body, /asn_user_owns_node\(p_user, p_actor\)[\s\S]*asn_user_owns_node\(p_user, p_new\)[\s\S]*asn_user_owns_node\(p_user, p_old\)/)
  assert.match(body, /relay\.device_replace_old_nodes\(p_new\)/)
  assert.match(grab(MIG, 'create or replace function relay.new_device_check('), /relay\.device_replace_old_nodes\(p_node\)/)
  assert.match(grab(MIG, 'create or replace function public.asn_device_replace_candidates('), /relay\.device_replace_old_nodes\(n\.id\)/)
})

test('靜態：候選的離線條件＝目前不在線（引用 online_window）且最後上線早於新設備建立；沒有天數門檻、沒有裸寫 3 分鐘', () => {
  const body = grab(MIG, 'create or replace function relay.device_replace_old_nodes(')
  assert.match(body, /< now\(\) - relay\.online_window\(\)/)
  assert.match(body, /< n\.created_at/)
  assert.doesNotMatch(code, /device_replace_offline_after/)
  assert.doesNotMatch(code, /interval '1 day'/)
  assert.doesNotMatch(code, /'\s*3\s+min/i)
  assert.doesNotMatch(DOWN, /device_replace_offline_after/)
})

test('靜態：回復檔把 set_node_platform 換回上一版本體，drop 新函式與欄位，換回在拿掉欄位之前', () => {
  assert.ok(DOWN.includes(grab(PLAT, 'create or replace function public.asn_relay_set_node_platform(')), 'set_node_platform 原文')
  for (const s of ['drop function if exists public.asn_device_replace(uuid, text, text, text);', 'drop function if exists relay.new_device_check(text);',
    'drop function if exists relay.device_replace_old_nodes(text);', 'alter table relay.nodes drop column if exists replace_asked_at;',
    'alter table relay.nodes drop column if exists new_device_noticed_at;']) assert.ok(DOWN.includes(s), s)
  assert.ok(DOWN.indexOf('create or replace function public.asn_relay_set_node_platform(') < DOWN.indexOf('drop function if exists relay.new_device_check'))
})

let PGlite = null
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const T1 = 'aaaaaaaa-1111-1111-1111-111111111111'
const T2 = 'bbbbbbbb-2222-2222-2222-222222222222'

async function boot({ down = false } = {}) {
  const db = new PGlite()
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.tenants(id uuid primary key, owner_user uuid, status text default 'active', features jsonb);
    create table relay.nodes(id text primary key, name text, owner_user uuid, tenant_id uuid, status text default 'active', kind text, platform text,
      last_seen_at timestamptz, created_at timestamptz not null default now(), name_by_owner boolean not null default false);
    create table relay.asn_presence(node text, window_name text, updated_at timestamptz not null default now());
    create table relay.room_members(room_id text, member text, display_name text, primary key (room_id, member));
    create table relay.account_events(id bigint generated always as identity primary key, at timestamptz default now(), user_id uuid, event text not null, node text, detail jsonb);
    create table relay.stub(mode text);
    create table relay.notices_log(id bigint generated always as identity primary key, node text, topic text, body text, win interval, lim int);
    create function public.asn_relay_send_notice(p_node text, p_topic text, p_body text, p_limit integer default 3, p_window interval default interval '1 hour') returns jsonb language plpgsql as $$
      begin
        if exists (select 1 from relay.stub where mode = 'failed') then return jsonb_build_object('ok', true, 'notify', 'failed'); end if;
        insert into relay.notices_log (node, topic, body, win, lim) values (p_node, p_topic, p_body, p_window, p_limit);
        return jsonb_build_object('ok', true, 'notify', 'sent');
      end $$;
    insert into relay.tenants values ('${T1}', '${U1}', 'active', null), ('${T2}', '${U2}', 'active', null);`)
  await db.exec(OWNS.slice(OWNS.indexOf('create or replace function public.asn_user_owns_node'), OWNS.indexOf('grant execute on function public.asn_user_owns_node')))
  await db.exec(grab(WINDOW, 'create or replace function relay.online_window()'))
  await db.exec(grab(RENAME, 'create or replace function relay.device_name_ok('))
  await db.exec(grab(LABEL, 'create or replace function relay.device_label('))
  await db.exec(grab(PLAT, 'create or replace function public.asn_relay_set_node_platform('))
  const prevDef = (await db.query("select pg_get_functiondef('public.asn_relay_set_node_platform(text,text)'::regprocedure) d")).rows[0].d
  await db.exec(MIG)
  if (down) await db.exec(DOWN)
  const q = async (t, a) => (await db.query(t, a)).rows
  const one = async (t, a) => (await q(t, a))[0].r
  const api = {
    db, q, prevDef,
    // 節點：seen＝最後上線距今幾小時、age＝建立距今幾小時（可帶小數）；新舊先後靠這兩個數字控制
    node: (id, o = {}) => db.query(`insert into relay.nodes (id, name, owner_user, tenant_id, status, kind, platform, last_seen_at, created_at, name_by_owner)
      values ($1, $2, $3, $4, $5, $6, $7, now() - ($8 || ' hours')::interval, now() - ($9 || ' hours')::interval, $10)`,
      [id, o.name ?? null, o.user ?? U1, o.tenant ?? (o.user === U2 ? T2 : T1), o.status ?? 'active', o.kind ?? null, o.platform === undefined ? 'windows' : o.platform,
        String(o.seen ?? 48), String(o.age ?? 1), o.byOwner ?? false]),
    cands: (u, actor) => one('select public.asn_device_replace_candidates($1, $2) r', [u, actor]),
    replace: (u, actor, nw, old) => one('select public.asn_device_replace($1, $2, $3, $4) r', [u, actor, nw, old]),
    dismiss: (u, actor, nw) => one('select public.asn_device_replace_dismiss($1, $2, $3) r', [u, actor, nw]),
    check: id => one('select relay.new_device_check($1) r', [id]),
    setPlat: (id, p) => one('select public.asn_relay_set_node_platform($1, $2) r', [id, p]),
    notices: () => q('select node, topic, body from relay.notices_log order by id'),
    row: async id => (await q('select name, name_by_owner, platform, replace_asked_at, new_device_noticed_at from relay.nodes where id = $1', [id]))[0],
    removed: async () => (await q("select features -> 'device_prefs' r from relay.tenants where id = $1", [T1]))[0].r,
  }
  return api
}

/** 基本場景：本人 U1 一台新的 nw（剛建立、平台已回報）、一台離線兩天的舊的 o1（同平台） */
async function basic(b) {
  await b.node('nw', { name: '新電腦', seen: 0, age: 1 })
  await b.node('o1', { name: '舊的辦公室電腦', seen: 48, age: 500 })
}

test('實跑：只有「同平台、目前離線、最後上線早於新設備建立」的才列候選；不同平台、在線、新設備建立後又上線過、已移除、別人的、已撤銷、presence 還在線的都不列', { skip }, async () => {
  const b = await boot()
  await basic(b)
  await b.node('o2', { name: '別平台', platform: 'linux', seen: 48, age: 500 })
  await b.node('o3', { name: '在線的', seen: 0, age: 500 })
  await b.node('o4', { name: '新設備建立後醒來過', seen: 0.5, age: 500 })
  await b.node('o5', { name: '已移除的', seen: 48, age: 500 })
  await b.node('o6', { name: '心跳舊但 presence 在線', seen: 48, age: 500 })
  await b.node('o7', { name: '已撤銷', status: 'left', seen: 48, age: 500 })
  await b.node('x1', { name: '別人的', user: U2, seen: 48, age: 500 })
  await b.node('o8', { name: '網頁', kind: 'web', seen: 48, age: 500 })
  await b.db.exec(`insert into relay.asn_presence (node, window_name) values ('o6', 'w'); update relay.tenants set features = '{"device_prefs":{"order":[],"shown":[],"removed":["o5"],"rev":5,"at":1}}' where id = '${T1}'`)
  const r = await b.cands(U1, 'nw')
  assert.equal(r.cards.length, 1)
  assert.deepEqual(r.cards[0].candidates.map(c => [c.node, c.name]), [['o1', '舊的辦公室電腦']])
  assert.equal(r.cards[0].node, 'nw')
  assert.equal(r.cards[0].name, '新電腦')
  // 別人的帳號看不到我的
  assert.deepEqual((await b.cands(U2, 'x1')).cards, [])
  assert.equal((await b.cands(U2, 'nw')).error, 'not_found')
})

test('實跑：新設備建立超過 7 天、或已經回答過，就不出卡；新的改過名（name_by_owner）仍出卡', { skip }, async () => {
  const b = await boot()
  await b.node('o1', { name: '舊', seen: 48, age: 500 })
  await b.node('nOld', { name: '八天前建的', seen: 0, age: 24 * 8 })
  assert.deepEqual((await b.cands(U1, 'o1')).cards, [], '超過 7 天')
  await b.node('nNamed', { name: '改過名的新電腦', seen: 0, age: 1, byOwner: true })
  assert.deepEqual((await b.cands(U1, 'o1')).cards.map(c => c.node), ['nNamed'])
})

test('實跑：沒候選不發通知；有候選才發，內文用設備名、不出代號與 email', { skip }, async () => {
  const b = await boot()
  await b.node('nw', { name: '新電腦', seen: 0 })
  await b.node('o3', { name: '在線的', seen: 0, age: 500 })
  await b.node('o2', { platform: 'linux', name: '別平台', seen: 48, age: 500 })
  assert.equal((await b.setPlat('nw', 'windows')).ok, true)
  assert.deepEqual(await b.notices(), [], '沒有候選就不通知')
  await b.node('o1', { name: '舊的辦公室電腦', seen: 48, age: 500 })
  assert.equal((await b.check('nw')).notify, 'sent')
  const n = await b.notices()
  assert.equal(n.length, 1)
  assert.equal(n[0].topic, 'new_device')
  assert.equal(n[0].node, 'nw')
  assert.equal(n[0].body, '有一台新的電腦連上了：新電腦。它是用來取代舊設備的話，到設定 → 設備處理。')
  assert.doesNotMatch(n[0].body, /o1|nw|@/)
})

test('實跑：沒有名字的新設備通知內文用「電腦（末 4 碼）」，手機寫「手機」', { skip }, async () => {
  const b = await boot()
  await b.node('n1abcX7K2', { name: null, platform: 'windows', seen: 0 })
  await b.node('o1', { name: '舊', seen: 48, age: 500 })
  await b.check('n1abcX7K2')
  assert.match((await b.notices())[0].body, /^有一台新的電腦連上了：電腦（X7K2）。/)
  const c = await boot()
  await c.node('p1Q9Z8', { name: null, platform: 'android', seen: 0 })
  await c.node('ph0', { name: '舊手機', platform: 'android', seen: 48, age: 500 })
  await c.check('p1Q9Z8')
  assert.match((await c.notices())[0].body, /^有一台新的手機連上了：手機（Q9Z8）。/)
})

test('實跑：同一個節點呼叫兩次 new_device_check 只通知一次（旗標在函式內判斷與寫入）', { skip }, async () => {
  const b = await boot()
  await basic(b)
  assert.equal((await b.check('nw')).notify, 'sent')
  assert.equal((await b.check('nw')).notify, 'skipped')
  assert.equal((await b.notices()).length, 1)
  assert.ok((await b.row('nw')).new_device_noticed_at)
  assert.equal((await b.row('nw')).replace_asked_at, null, '通知不等於使用者回答')
})

test('實跑：寄通知回 failed 時不寫已通知旗標（之後還能再試）', { skip }, async () => {
  const b = await boot()
  await basic(b)
  await b.db.exec("insert into relay.stub values ('failed')")
  assert.equal((await b.check('nw')).notify, 'failed')
  assert.equal((await b.row('nw')).new_device_noticed_at, null)
  await b.db.exec('delete from relay.stub')
  assert.equal((await b.check('nw')).notify, 'sent')
})

test('實跑：set_node_platform 只在平台由空變有值那次觸發；已有平台的節點換值或重報都不觸發', { skip }, async () => {
  const b = await boot()
  await b.node('o1', { name: '舊', seen: 48, age: 500 })
  await b.node('already', { name: '早就回報過的', platform: 'windows', seen: 0 })
  await b.setPlat('already', 'windows')
  await b.setPlat('already', 'linux')
  await b.setPlat('already', 'windows')
  assert.deepEqual(await b.notices(), [], '平台不是空的：不觸發')
  await b.node('fresh', { name: '新', platform: null, seen: 0 })
  assert.equal((await b.setPlat('fresh', 'windows')).ok, true)
  assert.equal((await b.notices()).length, 1, '空變有值：觸發')
  await b.setPlat('fresh', 'windows')
  assert.equal((await b.notices()).length, 1, '重報不再觸發')
  assert.equal((await b.setPlat('fresh', 'beos')).error, 'bad_request')
  assert.equal((await b.setPlat('nope', 'windows')).ok, true, '不存在的節點：照舊回 ok、不丟例外')
})

test('實跑：new_device_check 內部丟例外時 set_node_platform 仍成功、平台照寫', { skip }, async () => {
  const b = await boot()
  await b.node('o1', { name: '舊', seen: 48, age: 500 })
  await b.node('fresh', { name: '新', platform: null, seen: 0 })
  await b.db.exec(`create or replace function relay.new_device_check(p_node text) returns jsonb language plpgsql as $$ begin raise exception 'boom'; end $$`)
  assert.deepEqual(await b.setPlat('fresh', 'windows'), { ok: true })
  assert.equal((await b.row('fresh')).platform, 'windows')
  assert.deepEqual(await b.q("select user_id, event, node, detail from relay.account_events"),
    [{ user_id: U1, event: 'new_device_check_failed', node: 'fresh', detail: { error: 'boom' } }], '留一筆稽核')
})

test('實跑：new_device_check 丟例外、節點沒有擁有者時不寫稽核、設平台照樣成功', { skip }, async () => {
  const b = await boot()
  await b.db.exec(`insert into relay.nodes (id, name, owner_user, tenant_id, platform) values ('orphan', 'x', null, null, null)`)
  await b.db.exec(`create or replace function relay.new_device_check(p_node text) returns jsonb language plpgsql as $$ begin raise exception 'boom'; end $$`)
  assert.deepEqual(await b.setPlat('orphan', 'windows'), { ok: true })
  assert.equal((await b.row('orphan')).platform, 'windows')
  assert.equal((await b.q('select count(*)::int n from relay.account_events'))[0].n, 0)
})

test('實跑：重灌情境：舊設備 10 分鐘前離線、之後沒再上線，新設備第一次回報平台就通知、候選有它', { skip }, async () => {
  const b = await boot()
  await b.node('o1', { name: '舊的辦公室電腦', seen: 1 / 6, age: 500 })
  await b.node('fresh', { name: '新電腦', platform: null, seen: 0, age: 0.05 })
  assert.equal((await b.setPlat('fresh', 'windows')).ok, true)
  assert.equal((await b.notices()).length, 1)
  assert.deepEqual((await b.cands(U1, 'fresh')).cards[0].candidates.map(c => c.node), ['o1'])
})

test('實跑：舊設備在新設備建立之後又上線過（醒來過）、現在才離線：不列、不通知', { skip }, async () => {
  const b = await boot()
  await b.node('o1', { name: '剛睡著的電腦', seen: 1, age: 500 })
  await b.node('fresh', { name: '新電腦', platform: null, seen: 0, age: 2 })
  assert.equal((await b.setPlat('fresh', 'windows')).ok, true)
  assert.deepEqual(await b.notices(), [])
  assert.deepEqual((await b.cands(U1, 'fresh')).cards, [])
  assert.equal((await b.replace(U1, 'fresh', 'fresh', 'o1')).error, 'not_candidate')
})

test('實跑：舊設備目前在線（最後上線在 online_window 內）：不列、不通知', { skip }, async () => {
  const b = await boot()
  await b.node('o1', { name: '在線的電腦', seen: 0.01, age: 500 })
  await b.node('fresh', { name: '新電腦', platform: null, seen: 0, age: 1 })
  assert.equal((await b.setPlat('fresh', 'windows')).ok, true)
  assert.deepEqual(await b.notices(), [])
  assert.deepEqual((await b.cands(U1, 'fresh')).cards, [])
})

test('實跑：取代後舊的在 removed、新的 name＝舊名且 name_by_owner、replace_asked_at 有值、舊的保留原名、account_events 一筆', { skip }, async () => {
  const b = await boot()
  await basic(b)
  await b.db.exec(`insert into relay.room_members values ('r1', 'nw', '新電腦'), ('r2', 'nw', '自訂')`)
  await b.db.exec(`update relay.tenants set features = '{"other":1,"device_prefs":{"order":["o1","nw"],"shown":["nw"],"removed":["zz"],"rev":9999999999999,"at":1}}' where id = '${T1}'`)
  assert.deepEqual(await b.replace(U1, 'nw', 'nw', 'o1'), { ok: true, already: false, renamed: true })
  const p = await b.removed()
  assert.deepEqual(p.removed, ['zz', 'o1'])
  assert.deepEqual([p.order, p.shown], [['o1', 'nw'], ['nw']], '順序與顯示清單不動')
  assert.ok(Number(p.rev) > 9999999999999, 'rev 一定比現有的大')
  assert.equal((await b.q(`select features -> 'other' r from relay.tenants where id = '${T1}'`))[0].r, 1, '其他設定不動')
  const nw = await b.row('nw')
  assert.equal(nw.name, '舊的辦公室電腦')
  assert.equal(nw.name_by_owner, true)
  assert.ok(nw.replace_asked_at)
  assert.equal((await b.row('o1')).name, '舊的辦公室電腦', '舊的保留原名')
  assert.deepEqual((await b.q("select room_id, display_name from relay.room_members order by room_id")), [{ room_id: 'r1', display_name: '舊的辦公室電腦' }, { room_id: 'r2', display_name: '自訂' }])
  const ev = await b.q('select user_id, event, node, detail from relay.account_events')
  assert.deepEqual(ev, [{ user_id: U1, event: 'device_replaced', node: 'nw', detail: { old: 'o1', new: 'nw', by: 'nw', renamed: true } }])
  assert.deepEqual((await b.cands(U1, 'nw')).cards, [], '回答過不再出卡')
  assert.equal((await b.check('nw')).notify, 'skipped', '回答過不再通知')
})

test('實跑：沒有 device_prefs 時取代會建立；舊的沒有名字就不搬名字（新的照舊）', { skip }, async () => {
  const b = await boot()
  await b.node('nw', { name: '新電腦', seen: 0 })
  await b.node('o1', { name: null, seen: 48, age: 500 })
  assert.deepEqual(await b.replace(U1, 'nw', 'nw', 'o1'), { ok: true, already: false, renamed: false })
  const p = await b.removed()
  assert.deepEqual([p.order, p.shown, p.removed], [[], [], ['o1']])
  assert.deepEqual(await b.row('nw').then(r => [r.name, r.name_by_owner]), ['新電腦', false])
  assert.ok((await b.row('nw')).replace_asked_at)
})

test('實跑：舊的名字不合格式（像指紋）也不搬，但仍完成取代', { skip }, async () => {
  const b = await boot()
  await b.node('nw', { name: '新電腦', seen: 0 })
  await b.node('o1', { name: 'x DEAD1EEF', seen: 48, age: 500 })
  assert.equal((await b.replace(U1, 'nw', 'nw', 'o1')).renamed, false)
  assert.equal((await b.row('nw')).name, '新電腦')
})

test('實跑：重複取代冪等（不重複寫 removed、不重複寫紀錄）；回答過「不取代」再取代回 answered', { skip }, async () => {
  const b = await boot()
  await basic(b)
  await b.replace(U1, 'nw', 'nw', 'o1')
  const first = await b.row('nw')
  assert.deepEqual(await b.replace(U1, 'nw', 'nw', 'o1'), { ok: true, already: true })
  assert.deepEqual((await b.removed()).removed, ['o1'])
  assert.equal((await b.q('select count(*)::int n from relay.account_events'))[0].n, 1)
  assert.deepEqual(await b.row('nw'), first)
  const c = await boot()
  await basic(c)
  await c.dismiss(U1, 'nw', 'nw')
  assert.equal((await c.replace(U1, 'nw', 'nw', 'o1')).error, 'answered')
  assert.equal((await c.q('select count(*)::int n from relay.account_events'))[0].n, 0)
})

test('實跑：拿別人帳號的新或舊節點、別人的 actor 來取代，一律被擋下且什麼都沒改', { skip }, async () => {
  const b = await boot()
  await basic(b)
  await b.node('x1', { name: '別人的舊', user: U2, seen: 48, age: 500 })
  await b.node('x2', { name: '別人的新', user: U2, seen: 0, age: 1 })
  const before = await b.q('select id, name, name_by_owner, replace_asked_at from relay.nodes order by id')
  assert.equal((await b.replace(U1, 'nw', 'nw', 'x1')).error, 'not_found', '拿別人的舊節點')
  assert.equal((await b.replace(U1, 'nw', 'x2', 'o1')).error, 'not_found', '拿別人的新節點')
  assert.equal((await b.replace(U1, 'x2', 'nw', 'o1')).error, 'not_found', 'actor 不是本人的')
  assert.equal((await b.replace(U2, 'x2', 'nw', 'o1')).error, 'not_found', '別人從他的設備取代我的')
  assert.equal((await b.replace(U2, 'x2', 'x2', 'nw')).error, 'not_found', '別人把我的設備當舊的')
  assert.equal((await b.replace(null, 'nw', 'nw', 'o1')).error, 'bad_request')
  assert.equal((await b.replace(U1, 'nw', 'nw', 'nw')).error, 'bad_request', '新舊同一台')
  assert.equal((await b.replace(U1, 'nw', 'nw', "o1'; drop")).error, 'bad_request')
  assert.deepEqual(await b.q('select id, name, name_by_owner, replace_asked_at from relay.nodes order by id'), before)
  assert.equal((await b.q('select count(*)::int n from relay.account_events'))[0].n, 0)
  assert.equal((await b.removed()), null)
})

test('實跑：舊的不符合候選規則（又上線了、不同平台、已移除）取代被擋成 not_candidate', { skip }, async () => {
  const b = await boot()
  await basic(b)
  await b.node('on', { name: '在線', seen: 0, age: 500 })
  await b.node('lx', { name: '別平台', platform: 'linux', seen: 48, age: 500 })
  assert.equal((await b.replace(U1, 'nw', 'nw', 'on')).error, 'not_candidate')
  assert.equal((await b.replace(U1, 'nw', 'nw', 'lx')).error, 'not_candidate')
  assert.equal((await b.row('nw')).replace_asked_at, null)
})

test('實跑：移除清單已滿 200 個時取代回 removed_full，清單與新設備都不動（不偷丟舊的）', { skip }, async () => {
  const b = await boot()
  await basic(b)
  const list = Array.from({ length: 200 }, (_, i) => `k${i}`)
  await b.db.exec(`update relay.tenants set features = '{"device_prefs":{"order":[],"shown":[],"removed":${JSON.stringify(list)},"rev":1,"at":1}}' where id = '${T1}'`)
  assert.equal((await b.replace(U1, 'nw', 'nw', 'o1')).error, 'removed_full')
  assert.deepEqual((await b.removed()).removed, list)
  assert.equal((await b.row('nw')).replace_asked_at, null)
})

test('實跑：不取代只寫 replace_asked_at；之後不再列候選、不再通知；別人的節點被擋；重複呼叫不改時間', { skip }, async () => {
  const b = await boot()
  await basic(b)
  await b.node('x2', { name: '別人的新', user: U2, seen: 0, age: 1 })
  assert.equal((await b.dismiss(U1, 'nw', 'x2')).error, 'not_found')
  assert.equal((await b.dismiss(U1, 'x2', 'nw')).error, 'not_found')
  assert.equal((await b.row('x2')).replace_asked_at, null)
  assert.deepEqual(await b.dismiss(U1, 'nw', 'nw'), { ok: true })
  const t = (await b.row('nw')).replace_asked_at
  assert.ok(t)
  await b.dismiss(U1, 'nw', 'nw')
  assert.deepEqual((await b.row('nw')).replace_asked_at, t)
  assert.deepEqual((await b.cands(U1, 'nw')).cards, [])
  assert.equal((await b.check('nw')).notify, 'skipped')
  assert.equal((await b.setPlat('nw', 'windows')).ok, true)
  assert.deepEqual(await b.notices(), [])
  assert.equal((await b.row('o1')).name, '舊的辦公室電腦', '兩台都留')
  assert.equal(await b.removed(), null)
})

test('實跑：回復檔可套用，set_node_platform 回到上一版本體，新函式與欄位都不在了', { skip }, async () => {
  const b = await boot({ down: true })
  const def = (await b.q("select pg_get_functiondef('public.asn_relay_set_node_platform(text,text)'::regprocedure) d"))[0].d
  assert.equal(def, b.prevDef)
  assert.doesNotMatch(def, /new_device_check/)
  await b.node('o1', { name: '舊', seen: 48, age: 500 })
  await b.node('fresh', { name: '新', platform: null, seen: 0 })
  assert.deepEqual(await b.setPlat('fresh', 'windows'), { ok: true })
  assert.equal((await b.q("select count(*)::int n from pg_proc where proname in ('asn_device_replace', 'asn_device_replace_candidates', 'asn_device_replace_dismiss', 'new_device_check', 'device_replace_old_nodes')"))[0].n, 0)
  assert.equal((await b.q("select count(*)::int n from information_schema.columns where table_name = 'nodes' and column_name in ('replace_asked_at', 'new_device_noticed_at')"))[0].n, 0)
})

test('靜態：set_node_platform 熱路徑不加鎖：第一次讀舊值沒有 for update，只有舊值為空時才加鎖重讀；原有的 update 行逐字不變', () => {
  const body = grab(MIG, 'create or replace function public.asn_relay_set_node_platform(')
  const first = body.indexOf('select platform into v_prev')
  const guard = body.indexOf('if v_found and v_prev is null then')
  assert.ok(first >= 0 && guard > first)
  assert.doesNotMatch(body.slice(first, guard), /for update/, '第一次讀取不得加鎖')
  const second = body.indexOf('select platform into v_prev', first + 10)
  assert.ok(second > guard)
  assert.match(body.slice(second, body.indexOf(';', second)), /for update/, '舊值為空時才加鎖重讀')
  const origUpdate = grab(PLAT, 'create or replace function public.asn_relay_set_node_platform(').split('\n').find(l => l.includes('update relay.nodes set platform'))
  assert.ok(origUpdate && body.includes(origUpdate), '原本那行 update 逐字不變')
})

test('實跑：平台已有值（同值、不同值）時完全不呼叫 new_device_check；空變有值才呼叫一次（替身計數）', { skip }, async () => {
  const b = await boot()
  await b.db.exec(`create table relay.calls(node text);
    create or replace function relay.new_device_check(p_node text) returns jsonb language plpgsql as $$ begin insert into relay.calls values (p_node); return '{}'::jsonb; end $$`)
  await b.node('has', { name: '已有平台', platform: 'windows', seen: 0 })
  await b.setPlat('has', 'windows')
  await b.setPlat('has', 'linux')
  await b.setPlat('has', 'linux')
  assert.equal((await b.q('select count(*)::int n from relay.calls'))[0].n, 0, '已有值：同值、不同值都不呼叫')
  assert.equal((await b.row('has')).platform, 'linux', '不同值照寫')
  await b.node('fresh', { name: '新', platform: null, seen: 0 })
  await b.setPlat('fresh', 'windows')
  await b.setPlat('fresh', 'windows')
  assert.deepEqual(await b.q('select node from relay.calls'), [{ node: 'fresh' }])
})

test('實跑：web_denied_notice 擋新設備通知，原本六種照擋，其他種類不擋；回復後新設備不再被擋', { skip }, async () => {
  const denied = async (bb, k) => (await bb.q('select relay.web_denied_notice($1) r', [k]))[0].r
  const b = await boot()
  for (const k of ['notice:new_device', 'notice:login', 'notice:waiting', 'notice:device_key', 'notice:view', 'notice:waiting_login', 'notice:forward_stuck']) assert.equal(await denied(b, k), true, k)
  for (const k of ['notice:quota', 'new_device', 'notice:x']) assert.equal(await denied(b, k), false, k)
  const down = await boot({ down: true })
  assert.equal(await denied(down, 'notice:new_device'), false, '回復後回到上一版')
  assert.equal(await denied(down, 'notice:forward_stuck'), true)
  assert.ok(DOWN.includes(grab(rd('migrations/20261123130000_waiting_notice_forward_stuck.sql'), 'create or replace function relay.web_denied_notice(')), '回復檔逐字等於上一版')
})

test('實跑：新設備本人已改過名（name_by_owner）時取代不覆蓋它的名字，但仍移除舊的、標已回答、寫事件（renamed=false）', { skip }, async () => {
  const b = await boot()
  await b.node('nw', { name: '我自己取的名字', seen: 0, byOwner: true })
  await b.node('o1', { name: '舊的辦公室電腦', seen: 48, age: 500 })
  assert.deepEqual(await b.replace(U1, 'nw', 'nw', 'o1'), { ok: true, already: false, renamed: false })
  const nw = await b.row('nw')
  assert.deepEqual([nw.name, nw.name_by_owner], ['我自己取的名字', true])
  assert.ok(nw.replace_asked_at)
  assert.deepEqual((await b.removed()).removed, ['o1'])
  assert.deepEqual(await b.q('select event, detail from relay.account_events'), [{ event: 'device_replaced', detail: { old: 'o1', new: 'nw', by: 'nw', renamed: false } }])
})

test('實跑：回答過後只有真的有「新取代舊」的紀錄才回 already；先不取代、手動移除舊的、再按取代回 answered 而不是假成功', { skip }, async () => {
  const b = await boot()
  await basic(b)
  await b.dismiss(U1, 'nw', 'nw')
  await b.db.exec(`update relay.tenants set features = '{"device_prefs":{"order":[],"shown":[],"removed":["o1"],"rev":1,"at":1}}' where id = '${T1}'`)
  assert.equal((await b.replace(U1, 'nw', 'nw', 'o1')).error, 'answered')
  // 紀錄是別的舊設備、或別的新設備的：也不算
  await b.db.exec(`insert into relay.account_events (user_id, event, node, detail) values ('${U1}', 'device_replaced', 'nw', '{"old":"zz"}'), ('${U1}', 'device_replaced', 'other', '{"old":"o1"}')`)
  assert.equal((await b.replace(U1, 'nw', 'nw', 'o1')).error, 'answered')
  await b.db.exec(`insert into relay.account_events (user_id, event, node, detail) values ('${U1}', 'device_replaced', 'nw', '{"old":"o1"}')`)
  assert.deepEqual(await b.replace(U1, 'nw', 'nw', 'o1'), { ok: true, already: true })
})

test('實跑：從未上線的舊節點（last_seen_at 與 presence 都沒有）不列候選、不通知、取代回 not_candidate', { skip }, async () => {
  const b = await boot()
  await b.node('nw', { name: '新電腦', seen: 0, age: 1 })
  await b.db.exec(`insert into relay.nodes (id, name, owner_user, tenant_id, platform, last_seen_at, created_at) values ('ghost', '註冊後沒裝成功', '${U1}', '${T1}', 'windows', null, now() - interval '500 hours')`)
  assert.deepEqual((await b.cands(U1, 'nw')).cards, [])
  assert.equal((await b.check('nw')).notify, 'skipped')
  assert.deepEqual(await b.notices(), [])
  assert.equal((await b.replace(U1, 'nw', 'nw', 'ghost')).error, 'not_candidate')
  await b.node('o1', { name: '真的舊的', seen: 48, age: 500 })
  assert.deepEqual((await b.cands(U1, 'nw')).cards[0].candidates.map(c => c.node), ['o1'], '有上線紀錄的照列')
})

test('整合（真實 asn_relay_send_notice）：新設備第一次回報平台真的寫進 notice:new_device 通知，限流窗不超過真實函式上限；網頁節點那列被刪', { skip }, async () => {
  const b = await boot()
  await b.db.exec(`alter table relay.nodes add column bell_topic text;
    create table relay.messages(id uuid primary key default gen_random_uuid(), fanout_id uuid, from_node text, to_node text, kind text, body text, created_at timestamptz not null default now());
    create function public.asn_person_alias(p uuid) returns text language sql as $$ select 'owner' $$;
    create function public.asn_relay_send(p_node text, p_agent text, p_alias text, p_a text, p_body text, p_b text, p_c boolean, p_d text, p_e boolean) returns jsonb language plpgsql as $$
      declare v uuid := gen_random_uuid(); t record; first boolean := true;
      begin
        for t in select id from relay.nodes where owner_user = (select owner_user from relay.nodes where id = p_node) and status = 'active' order by id loop
          insert into relay.messages (id, fanout_id, from_node, to_node, body) values (case when first then v else gen_random_uuid() end, case when first then null else v end, p_node, t.id, p_body);
          first := false;
        end loop;
        return jsonb_build_object('id', v);
      end $$;`)
  await b.db.exec(grab(rd('migrations/20261119200000_web_sessions.sql'), 'create or replace function public.asn_relay_send_notice('))
  await b.node('o1', { name: '舊的辦公室電腦', seen: 48, age: 500 })
  await b.node('webx', { name: '瀏覽器', kind: 'web', platform: null, seen: 0, age: 500 })
  await b.node('fresh', { name: '新電腦', platform: null, seen: 0, age: 0.05 })
  assert.equal((await b.setPlat('fresh', 'windows')).ok, true)
  const m = await b.q('select from_node, to_node, kind, body from relay.messages order by to_node')
  assert.ok(m.length >= 1 && m.every(r => r.kind === 'notice:new_device' && r.from_node === 'fresh'), JSON.stringify(m))
  assert.ok(m.some(r => r.to_node === 'fresh' && r.body.startsWith('有一台新的電腦連上了：新電腦。')), '寫給本人設備的內文')
  assert.ok(!m.some(r => r.to_node === 'webx'), '網頁節點那列被刪')
  assert.ok((await b.row('fresh')).new_device_noticed_at, '真的寄成功才寫旗標')
  assert.equal((await b.q("select (relay.device_replace_new_within() <= interval '7 days' and relay.device_replace_new_within() > interval '0') ok"))[0].ok, true, '視窗在真實函式上限（7 天）內')
})
