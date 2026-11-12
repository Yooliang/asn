// 手機替電腦安裝並登入別家 CLI（20261112400000_setup_device_login.sql；#933 PR-6＋PR-5b 後台）：
// 1. 靜態：登入網址規則（約束與函式兩處）等於由 _shared/login_domains.json 產生的規則；新函式只授權 service_role；
//    非 claude 種類的最低版本先是 9999.0.0（還不交）；回復腳本放回原文。
// 2. 實跑（pglite）：網址規則對 login_link_cases.json 的正反例；兩參數的舊呼叫照舊是 claude；裝置碼型的請求本文每個欄位都檢查；
//    版本不夠新不交；電腦取請求時多帶請求本文、簽章與手機設備公鑰；密文放一次就鎖、只能放自己節點的；手機取一次就清、只能取自己的；過期清掉。
import { track, closeAtEnd, fastPGlite } from './_pglite_close.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const rd = f => fs.readFileSync(new URL(`../supabase/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const SETUP = rd('migrations/20261102140000_setup_requests.sql')
const WATCH = rd('migrations/20261102130000_inbox_watch.sql')
const PLAT = rd('migrations/20261102170000_node_platform_phone.sql')
const LINK = rd('migrations/20261101230000_secret_link.sql')
const MIG = rd('migrations/20261112400000_setup_device_login.sql')
const DOWN = rd('sql/rollback/20261112400000_setup_device_login_down.sql')
const DOMAINS = JSON.parse(rd('functions/_shared/login_domains.json'))
const CASES = JSON.parse(rd('functions/_shared/login_link_cases.json'))
const grab = (src, start) => { const i = src.indexOf(start); return src.slice(i, src.indexOf('$function$;', i) + '$function$;'.length) }
const esc = d => d.replace(/\./g, '\\.')
// 由清單產生的規則（和 Edge 的 LINK_RE 同一個形狀）
const RULE = `^https://(([a-z0-9-]+\\.)*(${DOMAINS.suffix.map(esc).join('|')})|${DOMAINS.exact.map(esc).join('|')})(:443)?([/?#][\\x21-\\x5b\\x5d-\\x7e]*)?$`

test('靜態：網址規則（約束與函式）等於 login_domains.json 產生的規則', () => {
  assert.equal(MIG.split(RULE).length - 1, 2, '約束與函式各一次，同一條規則')
  assert.deepEqual(DOMAINS.exact, ['auth.openai.com', 'accounts.x.ai'])
})

test('靜態：新函式 security definer、search_path 空、只授權 service_role；沒有開放給 anon／authenticated', () => {
  for (const sig of ['asn_setup_request\\(uuid, text, text, text, text, text\\)', 'asn_relay_setup_code_put\\(text, text, text, text, text\\)', 'asn_setup_code_fetch\\(uuid, text\\)']) {
    assert.match(MIG, new RegExp(`revoke all on function public\\.${sig} from public, anon, authenticated;`), sig)
    assert.match(MIG, new RegExp(`grant execute on function public\\.${sig} to service_role;`), sig)
  }
  const code = MIG.replace(/^--.*$/gm, '')
  assert.doesNotMatch(code, /grant execute[^;]*to (anon|authenticated|public)/)
  assert.doesNotMatch(code, /create policy/)
  for (const name of ['asn_setup_request', 'asn_relay_setup_poll', 'asn_relay_setup_code_put', 'asn_setup_code_fetch']) {
    const i = MIG.indexOf(`create or replace function public.${name}(`)
    assert.ok(i >= 0, name)
    assert.match(MIG.slice(i, MIG.indexOf('as $function$', i)), /security definer\s+set search_path to ''/, name)
  }
  assert.match(MIG, /drop function if exists public\.asn_setup_request\(uuid, text\);/, '舊的兩參數版本要先 drop，免得具名呼叫有歧義')
})

test('靜態：非 claude 的種類先不交（最低版本 9999.0.0）；後台只存、只轉交（不呼叫簽章相關函式）', () => {
  const fn = MIG.slice(MIG.indexOf('function relay.setup_kind_version_ok'), MIG.indexOf('$function$;', MIG.indexOf('function relay.setup_kind_version_ok')))
  assert.match(fn, /when 'claude' then array\[0, 2, 2\] else array\[9999, 0, 0\]/)
  assert.doesNotMatch(MIG.replace(/^--.*$/gm, ''), /ed25519|verify|pgcrypto|digest\(/i, '後台只存、只轉交')
})

test('靜態：回復腳本把三個函式與 link 約束換回原文，drop 新函式與欄位', () => {
  assert.ok(DOWN.includes(grab(PLAT, 'create or replace function public.asn_setup_request(')), 'asn_setup_request 原文')
  assert.ok(DOWN.includes(grab(PLAT, 'create or replace function public.asn_relay_setup_poll(')), 'asn_relay_setup_poll 原文')
  assert.ok(DOWN.includes(grab(LINK, 'create or replace function public.asn_relay_secret_request_link(')), 'secret_request_link 原文')
  for (const s of ['drop function if exists public.asn_setup_code_fetch(uuid, text);', 'drop function if exists public.asn_relay_setup_code_put(text, text, text, text, text);',
    'drop function if exists public.asn_setup_request(uuid, text, text, text, text, text);', "delete from relay.setup_requests where kind <> 'claude';", "check (kind in ('claude'))"]) {
    assert.ok(DOWN.includes(s), s)
  }
  // 換回 link 約束前，先把不合舊規則的登入網址清成空（規則和下面加回的約束同一條）
  const old = DOWN.match(/link !~ '([^']+)';/)
  assert.ok(old, '回復檔要先清掉不合舊規則的 link')
  assert.ok(DOWN.indexOf(old[0]) < DOWN.indexOf('add constraint secret_requests_link_ck'), '清在加回約束之前')
  assert.ok(DOWN.includes(`and link ~ '${old[1]}'`), '清的規則等於加回的約束')
})

let PGlite = null
try { PGlite = await fastPGlite() } catch { /* 沒裝就略過實跑 */ }
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite'

test('實跑：網址規則對共用正反例（加上兩個新主機的正反例）', { skip }, async () => {
  const db = track(new PGlite())
  // 和約束、函式一樣：長度 12～2048 且符合規則
  const ok = async u => (await db.query(`select char_length($1) between 12 and 2048 and $1 ~ '${RULE}' as m`, [u])).rows[0].m
  const expand = s => s.replace(/<A\*(\d+)>/g, (_, n) => 'a'.repeat(Number(n)))
  for (const g of CASES.good) assert.equal(await ok(expand(g)), true, g)
  // 空字元連資料庫的參數都送不進去（編碼錯誤），不在這裡比（和 secret_link_sql 同一個做法）
  for (const b of CASES.bad.filter(x => !x.includes('\u0000'))) assert.equal(await ok(expand(b)), false, b)
})

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const RID = 'AAAAAAAAAAAAAAAAAAAAAA'
const PUB = 'B'.repeat(43)
const SIG = 'C'.repeat(86)
const T_SIG = 'D'.repeat(86)
const CIPHER = 'E'.repeat(200)
const now = () => Math.floor(Date.now() / 1000)
const payload = (o = {}) => JSON.stringify({ v: 'asn-device-login-req-v1', rid: RID, t_node: 'PC', p_node: 'PH', vendor: 'codex', p_eph_pub: PUB, exp: now() + 600, ...o })

async function boot() {
  const db = track(new PGlite())
  await db.exec(`create role service_role; create role anon; create role authenticated; create schema relay;
    create table relay.nodes(id text primary key, name text, machine text, kind text, status text default 'active', owner_user uuid, last_seen_at timestamptz,
      platform text, launch_closed_reason text, inbox_hold_until timestamptz, tenant_id uuid);
    alter table relay.nodes add constraint nodes_platform_check check (platform is null or platform in ('linux', 'windows', 'macos'));
    create table relay.asn_presence(node text, window_name text default 'w', version text, updated_at timestamptz default now());
    create table relay.account_events(id bigint generated always as identity primary key, at timestamptz default now(), user_id uuid, event text not null, node text, detail jsonb);
    create table relay.messages(id uuid primary key default gen_random_uuid(), from_node text, from_agent text, to_node text, body text, created_at timestamptz default now(), acked_at timestamptz, fanout_id uuid);
    create table relay.device_keys(node text primary key, sign_pub text not null);
    create table relay.secret_requests(id uuid primary key default gen_random_uuid(), requester_node text, link text);
    create function public.asn_relay_secret_request(p_node text, p_pub text, p_program text, p_purpose text, p_ttl_seconds integer) returns jsonb language sql as $$ select jsonb_build_object('id', gen_random_uuid()) $$;
    create function public.asn_person_alias(p_user uuid) returns text language sql as $$ select 'u:' || substr(md5(p_user::text), 1, 12) $$;
    create function public.asn_user_owns_node(p_user uuid, p_node text) returns boolean language sql stable as
      $$ select p_user is not null and exists (select 1 from relay.nodes n where n.id = p_node and n.status = 'active' and n.owner_user = p_user) $$;
    create function public.asn_relay_send(p_from_node text, p_from_agent text, p_to_node text, p_to_agent text, p_body text, p_reply_to uuid, p_expects_reply boolean, p_signed_user uuid, p_as_person boolean)
      returns jsonb language plpgsql as $$ begin insert into relay.messages(from_node, from_agent, to_node, body) values (p_from_node, p_from_agent, p_to_node, p_body); return jsonb_build_object('ok', true); end $$;`)
  for (const sql of [SETUP.slice(0, SETUP.indexOf('-- 清理：')) + '\ncommit;', WATCH.slice(0, WATCH.indexOf('-- ===cron===')) + '\ncommit;', PLAT, MIG]) await db.exec(sql)
  const q = async (t, a) => (await db.query(t, a)).rows
  const node = async (id, o = {}) => {
    await db.query('insert into relay.nodes(id, owner_user, platform, last_seen_at) values ($1,$2,$3, now())', [id, o.owner ?? U1, o.platform ?? null])
    if (o.version) await db.query('insert into relay.asn_presence(node, version) values ($1, $2)', [id, o.version])
    if (o.key) await db.query('insert into relay.device_keys(node, sign_pub) values ($1, $2)', [id, o.key])
  }
  const req = async (o = {}) => (await q('select public.asn_setup_request(p_user => $1, p_node => $2, p_kind => $3, p_payload => $4, p_sig => $5, p_p_node => $6) r',
    [o.user ?? U1, o.node ?? 'PC', o.kind ?? 'codex', o.payload === undefined ? payload() : o.payload, o.sig === undefined ? SIG : o.sig, o.p_node === undefined ? 'PH' : o.p_node]))[0].r
  const poll = async (n = 'PC', v = '9999.0.0') => (await q('select public.asn_relay_setup_poll($1, $2) r', [n, v]))[0].r
  const put = async (o = {}) => (await q('select public.asn_relay_setup_code_put($1,$2,$3,$4,$5) r', [o.node ?? 'PC', o.rid ?? RID, o.pub ?? PUB, o.cipher ?? CIPHER, o.sig ?? T_SIG]))[0].r
  const fetch = async (u = U1, rid = RID) => (await q('select public.asn_setup_code_fetch($1,$2) r', [u, rid]))[0].r
  // PC＝要登入的電腦（夠新的版本、有設備公鑰）；PH＝發起的手機（本人的、有設備公鑰）
  await node('PC', { version: '9999.0.0', key: 'T'.repeat(43) })
  await node('PH', { platform: 'linux', key: 'P'.repeat(43) })
  return { db, q, node, req, poll, put, fetch }
}

test('實跑：兩參數的舊呼叫照舊是 claude（具名參數）', { skip }, async () => {
  const { q, node } = await boot()
  await node('OLD', { version: '0.2.2' })
  const r = (await q('select public.asn_setup_request(p_user => $1, p_node => $2) r', [U1, 'OLD']))[0].r
  assert.deepEqual(r, { ok: true, already: false, state: 'pending' })
  assert.equal((await q("select kind, rid, req_payload from relay.setup_requests where node = 'OLD'"))[0].kind, 'claude')
  const p = (await q("select public.asn_relay_setup_poll('OLD', '0.2.2') r"))[0].r
  assert.deepEqual(p, { requested: true, requested_by: U1, kind: 'claude' }, '舊版 ASN 看到的回應和原本一樣')
})

test('實跑：裝置碼型的請求本文每個欄位都檢查；claude／agy 不能帶本文', { skip }, async () => {
  const { req } = await boot()
  const bad = [
    { payload: null }, { sig: null }, { p_node: null }, { sig: 'x' }, { payload: '不是 JSON' }, { payload: '[1]' },
    { payload: payload({ v: 'other' }) }, { payload: payload({ t_node: 'X' }) }, { payload: payload({ p_node: 'X' }) },
    { payload: payload({ vendor: 'grok' }) }, { payload: payload({ rid: 'short' }) }, { payload: payload({ p_eph_pub: 'x' }) },
    { payload: payload({ exp: now() - 5 }) }, { payload: payload({ exp: now() + 2000 }) }, { payload: payload({ exp: '1' }) }, { payload: payload({ exp: undefined }) },
    { payload: 'x'.repeat(1025) }, { kind: 'claude' }, { kind: 'agy' }, { kind: 'gemini' },
  ]
  for (const b of bad) assert.equal((await req(b)).error, 'bad_request', JSON.stringify(b).slice(0, 80))
  assert.deepEqual(await req(), { ok: true, already: false, state: 'pending' })
  // 同一台已經有進行中的請求：照舊回 already，多帶那筆的種類
  assert.deepEqual(await req({ kind: 'grok', payload: payload({ vendor: 'grok', rid: 'Z'.repeat(22) }) }), { ok: true, already: true, state: 'pending', kind: 'codex' })
})

test('實跑：發起的手機要是本人的、要有設備公鑰；別人的電腦一律 not_found', { skip }, async () => {
  const { req, node } = await boot()
  await node('PH2', { platform: 'android' })
  assert.equal((await req({ p_node: 'PH2', payload: payload({ p_node: 'PH2' }) })).error, 'bad_request', '沒有設備公鑰')
  await node('OTHER', { owner: U2, key: 'O'.repeat(43) })
  assert.equal((await req({ p_node: 'OTHER', payload: payload({ p_node: 'OTHER' }) })).error, 'bad_request', '別人的手機')
  assert.equal((await req({ user: U2 })).error, 'not_found', '別人的電腦')
})

test('實跑：電腦版本不夠新就回 asn_outdated、也不交請求', { skip }, async () => {
  const { req, poll, db } = await boot()
  await db.query("update relay.asn_presence set version = '0.2.12' where node = 'PC'")
  assert.equal((await req()).error, 'asn_outdated')
  await db.query("update relay.asn_presence set version = '9999.0.0' where node = 'PC'")
  assert.equal((await req()).state, 'pending')
  assert.deepEqual(await poll('PC', '0.2.12'), { requested: false }, '舊版電腦不交')
})

test('實跑：電腦取請求多帶本文、簽章、手機設備公鑰與到期時間；同一個 rid 不能再用', { skip }, async () => {
  const { req, poll, db } = await boot()
  await req()
  const p = await poll()
  assert.equal(p.requested, true)
  assert.equal(p.kind, 'codex'); assert.equal(p.rid, RID); assert.equal(p.payload, payload().replace(/"exp":\d+/, `"exp":${JSON.parse(p.payload).exp}`))
  assert.equal(p.sig, SIG); assert.equal(p.p_node, 'PH'); assert.equal(p.p_sign_pub, 'P'.repeat(43))
  assert.ok(Math.abs(p.expires_at - JSON.parse(p.payload).exp) <= 1)
  // 這筆結束後，同一個 rid 再送一次 → 不收（rid 在列存活期間不可重複）
  await db.query("update relay.setup_requests set status = 'failed', updated_at = now() - interval '2 minutes' where node = 'PC'")
  assert.equal((await req()).error, 'bad_request')
})

test('實跑：密文只能放自己節點、已取走、還沒放過、沒過期的那一筆；放一次就鎖住', { skip }, async () => {
  const { req, poll, put, db, node } = await boot()
  await req()
  assert.equal((await put()).error, 'not_found', '還沒被取走')
  await poll()
  await node('PC2', { version: '9999.0.0' })
  assert.equal((await put({ node: 'PC2' })).error, 'not_found', '別台不能放')
  for (const b of [{ rid: 'x' }, { pub: 'x' }, { cipher: 'short' }, { cipher: 'E'.repeat(4097) }, { cipher: 'E'.repeat(30) + '!' }, { sig: 'x' }]) {
    assert.equal((await put(b)).error, 'bad_request', JSON.stringify(b).slice(0, 40))
  }
  assert.deepEqual(await put(), { ok: true })
  assert.equal((await put({ cipher: 'F'.repeat(200) })).error, 'not_found', '放過就鎖住，不能覆蓋')
  await db.query("update relay.setup_requests set cipher = null, cipher_put_at = null, expires_at = now() - interval '1 second'")
  assert.equal((await put()).error, 'not_found', '過期不能放')
})

test('實跑：手機取密文只能取自己的、取一次就清；過期清掉', { skip }, async () => {
  const { req, poll, put, fetch, q, db } = await boot()
  await req(); await poll()
  assert.equal((await fetch()).state, 'waiting')
  await put()
  assert.equal((await fetch(U2)).error, 'not_found', '別人取不到')
  const r = await fetch()
  assert.deepEqual(r, { state: 'ready', t_node: 'PC', t_sign_pub: 'T'.repeat(43), t_eph_pub: PUB, cipher: CIPHER, t_sig: T_SIG })
  assert.equal((await q("select cipher from relay.setup_requests where node = 'PC'"))[0].cipher, null, '取走就清')
  assert.equal((await fetch()).state, 'delivered', '第二次取不到')
  // 過期：密文清掉
  await db.query("update relay.setup_requests set delivered_at = null, cipher = $1, expires_at = now() - interval '1 second'", [CIPHER])
  assert.equal((await fetch()).state, 'expired')
  assert.equal((await q("select cipher from relay.setup_requests where node = 'PC'"))[0].cipher, null)
  assert.equal((await fetch(U1, 'x')).error, 'bad_request')
})

test('實跑：資料表約束擋得住直接寫入不完整的裝置碼型列', { skip }, async () => {
  const { db } = await boot()
  await assert.rejects(db.query("insert into relay.setup_requests(node, requested_by, kind) values ('PC', $1, 'codex')", [U1]), /setup_requests_device_ck/)
  await assert.rejects(db.query("insert into relay.setup_requests(node, requested_by, kind, rid) values ('PC', $1, 'claude', $2)", [U1, RID]), /setup_requests_device_ck/)
  await assert.rejects(db.query("insert into relay.setup_requests(node, requested_by, kind) values ('PC', $1, 'gemini')", [U1]), /setup_requests_kind_check/)
})

// 全部測試都登記完才掛收尾（檔案前面若有 top-level await，太早掛會在測試開跑前就執行）
closeAtEnd()
