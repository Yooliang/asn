// 多使用者第一期 A 段的資料庫守門測試（node --test tests/tenants_sql.test.mjs）。
// 用 PGlite（WebAssembly 版 PostgreSQL，純記憶體的臨時資料庫）真的跑 supabase/sql/01～17 與回退腳本，
// 驗證：租戶 1 回填、租戶隔離（節點、信、群組、遠端開視窗、邀請）、邀請與帳號流程、停用、額度只送一次、回退與重新上線。
// PGlite 不在 repo 依賴裡：找不到就整檔跳過。安裝方式 `npm i --no-save @electric-sql/pglite`，或設環境變數 PGLITE_PATH 指到它的 dist/index.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SQL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'sql');

async function loadPglite() {
  const tries = [process.env.PGLITE_PATH ? pathToFileURL(process.env.PGLITE_PATH).href : null, '@electric-sql/pglite'].filter(Boolean);
  for (const spec of tries) {
    try {
      return (await import(spec)).PGlite;
    } catch { /* 試下一個 */ }
  }
  return null;
}
const PGlite = await loadPglite();
const skip = PGlite ? false : '沒有安裝 @electric-sql/pglite（npm i --no-save @electric-sql/pglite），跳過資料庫測試';

const T1 = '00000000-0000-0000-0000-000000000001';
const OWNER = '2f0eb1f5-8a6b-4032-9aa2-dbd79af27d0e'; // 舊資料的擁有者（小良哥）
const U_B = 'b0000000-0000-4000-8000-00000000000b';
const U_C = 'c0000000-0000-4000-8000-00000000000c';
const U_D = 'd0000000-0000-4000-8000-00000000000d';
const U_E = 'e0000000-0000-4000-8000-00000000000e';
const ISO = '1970-01-01T00:00:00Z';

const sqlFile = (name) => fs.readFileSync(path.join(SQL_DIR, name), 'utf8');
const numbered = () => fs.readdirSync(SQL_DIR).filter((f) => /^\d\d_.*\.sql$/.test(f)).sort();

// 小工具：呼叫 public.<fn>(args…)，結果轉成 JS 值
async function newDb(upTo) {
  const db = new PGlite();
  await db.exec('create role service_role; create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key, email text);');
  for (const f of numbered()) {
    if (upTo && f > upTo) break;
    await db.exec(sqlFile(f));
  }
  return db;
}
const call = async (db, fn, ...args) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  const r = await db.query(`select to_jsonb(public.${fn}(${ph})) as v`, args);
  return r.rows[0].v;
};
const rows = async (db, sql, args = []) => (await db.query(sql, args)).rows;
const authRows = (db, keyHash) => rows(db, 'select * from public.irori_relay_auth($1)', [keyHash]);
const one = async (db, sql, args = []) => (await rows(db, sql, args))[0];
const fails = async (fn, re) => {
  try {
    await fn();
  } catch (e) {
    if (re) assert.match(String(e.message), re);
    return;
  }
  assert.fail('應該要出錯但沒有');
};

// 舊環境（16 之前）的資料：仿真實專案——小良哥的 XISU（owner）、H（機器，可邀請）、w02／aegis（可回報名單）、已離開的 W，
// 群組、信件、一筆遠端開視窗紀錄，以及他的 state。
async function seedLegacy(db) {
  await db.exec(`
    insert into auth.users values ('${OWNER}', 'owner@example.com');
    insert into irori.kv (owner, key, value) values ('${OWNER}', 'state', '{"settings":{"user_name":"小良哥"}}'::jsonb);
    insert into relay.nodes (id, name, key_hash, bell_topic, role, can_invite, machine, kind, status, last_seen_at) values
      ('XISU', '希緒', 'kh-xisu', 'bell-xisu', 'owner', false, '家用機', 'other', 'active', now()),
      ('H', '家用工頭', 'kh-h', 'bell-h', 'member', true, '家用機', 'claude', 'active', now()),
      ('w02', 'W02', 'kh-w02', 'bell-w02', 'member', false, '工作機', 'claude', 'active', now()),
      ('aegis', '牧陽 Aegis', 'kh-aegis', 'bell-aegis', 'member', false, '雲端', 'claude', 'active', now()),
      ('W', '工作機', 'revoked:1', 'bell-w', 'member', true, '工作機', 'claude', 'left', now());
    update relay.nodes set can_roster = true where id in ('w02', 'aegis');
  `);
  await call(db, 'irori_relay_roster', 'H', JSON.stringify([{ name: 'H-Irori-2', status: 'idle', cwd_label: 'irori' }]));
  await db.exec(`
    insert into relay.launches (requested_by, node, profile, name, cwd, status) values ('XISU', 'H', 'p', 'old-win', 'D:/x', 'ok');
    update relay.nodes set launcher = '{"profiles":[{"id":"p","label":"P"}],"cwd_allow":["D:/x"],"max_per_hour":6}'::jsonb where id = 'H';
  `);
  // 舊版 send（16 之前沒有 tenant）
  await call(db, 'irori_relay_send', 'XISU', '希緒', 'H', 'H-Irori-2', '舊的一封信', null);
  await call(db, 'irori_relay_send', 'H', 'H-Irori-2', 'XISU', null, '舊的回信', null);
  await call(db, 'irori_relay_room_create', 'XISU', 'rold', 'Irori 開發', ['H', 'H~H-Irori-2']);
  await call(db, 'irori_relay_room_post', 'XISU', null, 'rold', '舊群組的第一句', [], true);
}

test('回填：租戶 1 原地長出來，現有節點、信、群組、紀錄全部歸租戶 1，主人進白名單', { skip }, async () => {
  const db = await newDb('15_usage.sql');
  await seedLegacy(db);
  const stats = async () => ({
    nodes: (await one(db, 'select count(*)::int n from relay.nodes')).n,
    messages: (await one(db, 'select count(*)::int n from relay.messages')).n,
  });
  const before = await stats();
  await db.exec(sqlFile('16_tenants.sql'));
  assert.deepEqual(await stats(), before, '16 只新增、不刪不改資料筆數');
  const t = await one(db, 'select * from relay.tenants');
  assert.equal(t.id, T1);
  assert.equal(t.serial, 1);
  assert.equal(t.owner_user, OWNER);
  assert.equal(t.character_node, 'XISU');
  assert.equal(t.id_prefix, null);
  assert.equal(t.owner_name, '小良哥');
  for (const tbl of ['nodes', 'messages', 'rooms', 'launches']) {
    assert.equal((await one(db, `select count(*)::int n from relay.${tbl} where tenant_id is distinct from $1`, [T1])).n, 0, `${tbl} 全是租戶 1`);
  }
  const acct = await one(db, 'select * from irori.accounts');
  assert.deepEqual([acct.email, acct.user_id, acct.tenant_id, acct.role, acct.status, acct.source], ['owner@example.com', OWNER, T1, 'admin', 'active', 'legacy']);
  // 重跑：沒有重複、沒有變動
  await db.exec(sqlFile('16_tenants.sql'));
  assert.equal((await one(db, 'select count(*)::int n from relay.tenants')).n, 1);
  assert.equal((await one(db, 'select count(*)::int n from irori.accounts')).n, 1);
  // 17：加限制；重跑也沒事
  await db.exec(sqlFile('17_tenants_enforce.sql'));
  await db.exec(sqlFile('17_tenants_enforce.sql'));
  // 小良哥原本的路徑一個字都沒變：auth 認得 XISU 的金鑰，租戶 1；名單、信箱、群組照舊
  const auth = await authRows(db, 'kh-xisu');
  assert.deepEqual([auth[0].id, auth[0].role, auth[0].tenant_id], ['XISU', 'owner', T1]);
  const list = await call(db, 'irori_relay_list', T1);
  assert.deepEqual(list.map((n) => n.id), ['H', 'XISU', 'aegis', 'w02']);
  assert.deepEqual(list.find((n) => n.id === 'H').agents.map((a) => a.name), ['H-Irori-2']);
  const inbox = await call(db, 'irori_relay_inbox', 'H');
  assert.equal(inbox[0].body, '舊的一封信');
  assert.equal(inbox[0].trust, 'owner');
  const rooms = await call(db, 'irori_relay_room_list', 'XISU', true);
  assert.equal(rooms.rooms.length, 1);
  assert.equal(rooms.rooms[0].last_from_name, '小良哥', '群組裡主人的顯示名取自租戶，不再寫死');
  await db.close();
});

test('回填：舊資料的擁有者不唯一時租戶 1 先不指定，之後可手動認領', { skip }, async () => {
  const db = await newDb('15_usage.sql');
  await db.exec(`
    insert into auth.users values ('${OWNER}', 'owner@example.com'), ('${U_B}', 'other@example.com');
    insert into irori.kv (owner, key, value) values ('${OWNER}', 'state', '{}'), ('${U_B}', 'state', '{}');
    insert into relay.nodes (id, name, key_hash, bell_topic, role) values ('XISU', '希緒', 'k', 'b', 'owner');`);
  await db.exec(sqlFile('16_tenants.sql'));
  assert.equal((await one(db, 'select owner_user from relay.tenants')).owner_user, null);
  assert.equal((await one(db, 'select count(*)::int n from irori.accounts')).n, 0);
  assert.deepEqual(await call(db, 'irori_tenant_claim_legacy', 'nobody@example.com'), { error: 'not_found' });
  assert.deepEqual(await call(db, 'irori_tenant_claim_legacy', 'owner@example.com'), { ok: true, user_id: OWNER });
  assert.equal((await one(db, 'select owner_user from relay.tenants')).owner_user, OWNER);
  assert.deepEqual(await call(db, 'irori_tenant_claim_legacy', 'other@example.com'), { error: 'already_claimed' });
  await db.close();
});

// ── 之後的測試共用一個「已上線」的資料庫 ──
let live;
async function ctx() {
  if (live) return live;
  const db = await newDb('15_usage.sql');
  await seedLegacy(db);
  await db.exec(sqlFile('16_tenants.sql'));
  await db.exec(sqlFile('17_tenants_enforce.sql'));
  // 邀請並開通兩個新使用者 B、C
  for (const [uid, email, name] of [[U_B, 'b@example.com', '王小明 Ming'], [U_C, 'c@example.com', '']]) {
    await call(db, 'irori_account_invite_create', OWNER, email, `hash-${email}`, 'member', '朋友', 168);
    const r = await call(db, 'irori_account_resolve', uid, email, name, false, 1);
    assert.equal(r.status, 'active', JSON.stringify(r));
  }
  // 各自給一台機器：用角色節點開邀請 → 註冊（B 的機器代號必須以 t2- 開頭）
  const regs = {};
  for (const [owner, id, key] of [['t2-xisu', 't2-home', 'kh-b-home'], ['t3-xisu', 't3-home', 'kh-c-home']]) {
    const inv = await call(db, 'irori_relay_invite', owner, `inv-${id}`, '電腦');
    assert.equal(inv.prefix, `${id.slice(0, 2)}-`);
    regs[id] = await call(db, 'irori_relay_register', `ip-${id}`, `inv-${id}`, id, '家裡電腦', 'claude', '客廳', null, key, `bell-${id}`);
    assert.equal(regs[id].id, id, JSON.stringify(regs[id]));
    await db.exec(`update relay.nodes set can_invite = true where id = '${id}'`);
  }
  live = db;
  return db;
}

test('新使用者：邀請開通→自動建租戶、角色節點、預設稱呼、1 美元額度（只送一次）', { skip }, async () => {
  const db = await ctx();
  const t2 = await one(db, "select * from relay.tenants where serial = 2");
  assert.deepEqual([t2.character_node, t2.id_prefix, t2.owner_name, t2.status], ['t2-xisu', 't2-', '王小明', 'active']);
  const t3 = await one(db, "select * from relay.tenants where serial = 3");
  assert.equal(t3.owner_name, '朋友', 'Google 沒給顯示名就用「朋友」');
  const node = await one(db, "select * from relay.nodes where id = 't2-xisu'");
  assert.deepEqual([node.role, node.tenant_id, node.status], ['owner', t2.id, 'active']);
  assert.match(node.key_hash, /^nokey:/, '角色節點沒有金鑰（irori-api 直接用 RPC）');
  assert.ok(!/^[0-9a-f]{64}$/.test(node.key_hash), '金鑰雜湊欄位不是 SHA-256 十六進位，irori-relay 不可能算出同樣的值');
  const state = await one(db, "select value from irori.kv where owner = $1 and key = 'state'", [U_B]);
  assert.equal(state.value.settings.user_name, '王小明');
  const quota = await one(db, 'select granted_usd::float g, unlimited from irori.usage_quota where owner = $1', [U_B]);
  assert.deepEqual([quota.g, quota.unlimited], [1, false]);
  // 重複解析、重複兌換：不再開租戶、不再送
  const again = await call(db, 'irori_account_resolve', U_B, 'b@example.com', 'x', false, 1);
  assert.equal(again.status, 'active');
  assert.equal(again.new, false);
  assert.equal((await one(db, 'select count(*)::int n from relay.tenants')).n, 3);
  assert.equal((await one(db, 'select granted_usd::float g from irori.usage_quota where owner = $1', [U_B])).g, 1);
  // 小良哥（管理者）無上限
  await call(db, 'irori_account_resolve', OWNER, 'owner@example.com', '小良哥', true, 1);
  assert.equal((await one(db, 'select unlimited from irori.usage_quota where owner = $1', [OWNER])).unlimited, true);
});

test('租戶隔離：寄信——跨租戶一律 unknown_to_node，別名 XISU 解成自己的角色節點', { skip }, async () => {
  const db = await ctx();
  // B 的電腦寄給 T1 的 H、XISU 的別名、T1 的代號
  assert.deepEqual(await call(db, 'irori_relay_send', 't2-home', null, 'H', null, 'hi', null), { error: 'unknown_to_node' });
  assert.deepEqual(await call(db, 'irori_relay_send', 't2-home', null, 't3-xisu', null, 'hi', null), { error: 'unknown_to_node' });
  const toAlias = await call(db, 'irori_relay_send', 't2-home', null, 'XISU', null, '給我自己的希緒', null);
  assert.ok(toAlias.id);
  assert.equal(toAlias.bell_topic, (await one(db, "select bell_topic from relay.nodes where id = 't2-xisu'")).bell_topic);
  const m = await one(db, 'select * from relay.messages where id = $1', [toAlias.id]);
  assert.deepEqual([m.to_node, m.tenant_id], ['t2-xisu', (await one(db, 'select id from relay.tenants where serial = 2')).id]);
  // T1 的 H 寄 XISU 還是 T1 的 XISU；寄給 B 的節點失敗
  const t1 = await call(db, 'irori_relay_send', 'H', null, 'XISU', null, '給小良哥的希緒', null);
  assert.equal(t1.bell_topic, 'bell-xisu');
  assert.deepEqual(await call(db, 'irori_relay_send', 'H', null, 't2-xisu', null, 'hi', null), { error: 'unknown_to_node' });
  // 信箱互不相見，且 trust 只看同租戶寄件者的 role
  const inboxB = await call(db, 'irori_relay_inbox', 't2-xisu');
  assert.deepEqual(inboxB.map((x) => [x.body, x.trust]), [['給我自己的希緒', 'member']]);
  const inboxT1 = (await call(db, 'irori_relay_inbox', 'XISU')).map((x) => x.body);
  assert.ok(!inboxT1.includes('給我自己的希緒'));
  // 角色節點（owner）寄的信對自己租戶的機器是 trust=owner；T1 的機器收不到
  const own = await call(db, 'irori_relay_send', 't2-xisu', '希緒', 't2-home', null, '交辦', null);
  const home = await call(db, 'irori_relay_inbox', 't2-home');
  assert.deepEqual(home.map((x) => [x.body, x.trust]), [['交辦', 'owner']]);
  assert.equal((await call(db, 'irori_relay_inbox', 'H')).filter((x) => x.body === '交辦').length, 0);
  // reply_to 指到別租戶的信：忽略（不洩漏、不串）
  const sneaky = await call(db, 'irori_relay_send', 't2-home', null, 'XISU', null, '回', (await one(db, "select id from relay.messages where body = '舊的一封信'")).id);
  assert.equal((await one(db, 'select reply_to from relay.messages where id = $1', [sneaky.id])).reply_to, null);
  void own;
});

test('租戶隔離：資料庫底線——跨租戶的信直接寫入會被複合外鍵擋下；每租戶只能有一個現役角色節點', { skip }, async () => {
  const db = await ctx();
  const tB = (await one(db, 'select id from relay.tenants where serial = 2')).id;
  await fails(() => db.exec(`insert into relay.messages (from_node, to_node, body, tenant_id) values ('t2-home', 'H', 'x', '${tB}')`), /violates foreign key/);
  await fails(() => db.exec(`insert into relay.messages (from_node, to_node, body, tenant_id) values ('t2-home', 't2-xisu', 'x', '${T1}')`), /violates foreign key/);
  await fails(() => db.exec(`insert into relay.nodes (id, name, key_hash, bell_topic, role, tenant_id) values ('t2-two', 'x', 'k2', 'b2', 'owner', '${tB}')`), /unique|duplicate/);
  await fails(() => db.exec(`insert into relay.nodes (id, name, key_hash, bell_topic, role) values ('nope', 'x', 'k3', 'b3', 'member')`), /null value|not-null/);
  await fails(() => db.exec(`insert into relay.launches (requested_by, node, profile, name, cwd, tenant_id) values ('t2-xisu', 'H', 'p', 'n', 'c', '${tB}')`), /violates foreign key/);
});

test('租戶隔離：名單、邀請、重設碼、改資料都只在自己的租戶', { skip }, async () => {
  const db = await ctx();
  const idsOf = async (tid) => (await call(db, 'irori_relay_list', tid)).map((n) => n.id);
  const tB = (await one(db, 'select id from relay.tenants where serial = 2')).id;
  assert.deepEqual(await idsOf(tB), ['t2-home', 't2-xisu']);
  assert.deepEqual(await idsOf(T1), ['H', 'XISU', 'aegis', 'w02']);
  assert.deepEqual((await call(db, 'irori_relay_list_by_node', 't2-home')).map((n) => n.id), ['t2-home', 't2-xisu']);
  // 舊的無參數版只回租戶 1（舊版 irori-relay 過渡期）
  assert.deepEqual((await call(db, 'irori_relay_list')).map((n) => n.id), ['H', 'XISU', 'aegis', 'w02']);
  // B 的角色節點對 T1 的節點：改資料 404、發重設碼 404
  assert.deepEqual(await call(db, 'irori_relay_update', 't2-xisu', 'H', '偷改', null), { error: 'not_found' });
  assert.equal((await one(db, "select machine from relay.nodes where id = 'H'")).machine, '家用機');
  assert.deepEqual(await call(db, 'irori_relay_reissue', 't2-xisu', 'hash-x1', 'H'), { error: 'not_found' });
  // 機器節點不是 owner：不能發重設碼
  assert.deepEqual(await call(db, 'irori_relay_reissue', 't2-home', 'hash-x2', 't2-xisu'), { error: 'forbidden' });
  // B 自己的
  assert.deepEqual(await call(db, 'irori_relay_update', 't2-xisu', 't2-home', '書房', null), { ok: true });
  // B 的邀請：前綴一律 t2-；用它註冊成別的前綴被擋；兌換後新節點屬於 B
  const inv = await call(db, 'irori_relay_invite', 't2-xisu', 'inv-b-ai', 'AI');
  assert.equal(inv.prefix, 't2-');
  const bad = await call(db, 'irori_relay_register', 'ip1', 'inv-b-ai', 'AGENT', 'AI', 'gpt', '雲端', null, 'kh-bad', 'bell-bad');
  assert.deepEqual([bad.error, bad.prefix], ['bad_id_prefix', 't2-']);
  const ok = await call(db, 'irori_relay_register', 'ip1', 'inv-b-ai', 't2-gpt', 'AI', 'gpt', '雲端', null, 'kh-gpt', 'bell-gpt');
  assert.equal(ok.id, 't2-gpt');
  assert.equal((await one(db, "select tenant_id from relay.nodes where id = 't2-gpt'")).tenant_id, tB);
  // T1 的 owner 邀請不限前綴（維持舊行為）
  assert.equal((await call(db, 'irori_relay_invite', 'XISU', 'inv-t1', null)).prefix, null);
  // 已離開的舊代號：別的租戶不能接手（W 是租戶 1 離開的節點）
  const takeover = await call(db, 'irori_relay_invite', 't3-xisu', 'inv-c-take', null);
  const r3 = await call(db, 'irori_relay_register', 'ip2', 'inv-c-take', 't3-ok', 'x', 'claude', '電腦', null, 'kh-ok', 'bell-ok');
  assert.equal(r3.id, 't3-ok', String(takeover.prefix));
  // 租戶 1 離開過的代號 W 因前綴規則 C 本來就註冊不了；即使直接測 T1 邀請+C 無關：T1 邀請可以重用自己離開的 W
  const reuse = await call(db, 'irori_relay_register', 'ip3', 'inv-t1', 'W', '工作機', 'claude', '工作機', null, 'kh-w2', 'bell-w2');
  assert.equal(reuse.id, 'W');
  // 租戶 1 的（不限前綴的）邀請不能佔用 t<數字>- 開頭的代號（那是留給其他租戶的）
  await call(db, 'irori_relay_invite', 'XISU', 'inv-t1-squat', null);
  assert.equal((await call(db, 'irori_relay_register', 'ip3b', 'inv-t1-squat', 't9-evil', 'x', 'claude', '電腦', null, 'kh-sq', 'bell-sq')).error, 'id_taken');
  // 重設碼兌換：碼的租戶要與節點相同
  await call(db, 'irori_relay_reissue', 'XISU', 'reis-1', 'H');
  assert.deepEqual(await call(db, 'irori_relay_redeem_reissue', 'ip4', 'reis-1', 'H', 'newkey', 'newbell'), { id: 'H', bell_topic: 'newbell' });
  // 在還沒有冒用空間的前提下，也確認 id_taken：T1 現役節點 H 不可被別租戶用邀請覆蓋
  const inv2 = await call(db, 'irori_relay_invite', 't3-xisu', 'inv-c-2', null);
  assert.equal(inv2.prefix, 't3-');
  assert.deepEqual((await call(db, 'irori_relay_register', 'ip5', 'inv-c-2', 'H', 'x', 'claude', '電腦', null, 'k', 'b')).error, 'bad_id_prefix');
});

test('名單的引擎欄位（19_roster_engine）：帶 engine 就存並回傳；沒帶或格式不對＝null，不因此整份名單被拒；仍只在自己的租戶', { skip }, async () => {
  const db = await ctx();
  await db.exec(sqlFile('19_roster_engine.sql'));
  await db.exec(sqlFile('19_roster_engine.sql'));   // 可重複執行
  const rep = await call(db, 'irori_relay_roster', 'H', JSON.stringify([
    { name: 'Gemini', status: 'login-required', cwd_label: '工作者', engine: 'gemini' },
    { name: 'H-Irori-2', status: 'idle' },
    { name: 'Bad', status: 'idle', engine: 'Gemini; drop table x' },
  ]));
  assert.deepEqual(rep, { count: 3 });
  const h = (await call(db, 'irori_relay_list', T1)).find((n) => n.id === 'H');
  const by = Object.fromEntries(h.agents.map((a) => [a.name, a]));
  assert.deepEqual(by.Gemini, { name: 'Gemini', status: 'login-required', cwd_label: '工作者', engine: 'gemini' });
  assert.equal(by['H-Irori-2'].engine, null);
  assert.equal(by.Bad.engine, null);
  // 別的租戶的名單看不到這些視窗
  const tB = (await one(db, 'select id from relay.tenants where serial = 2')).id;
  assert.equal((await call(db, 'irori_relay_list', tB)).some((n) => (n.agents ?? []).some((a) => a.name === 'Gemini')), false);
  // 還原成沒有 engine 的名單（讓後面的測試維持原狀）
  await call(db, 'irori_relay_roster', 'H', JSON.stringify([{ name: 'H-Irori-2', status: 'idle', cwd_label: 'irori' }]));
});

test('租戶隔離：群組——別租戶看不到、讀不到、發不了言、加不了人、改不了置頂；自動收入也不跨', { skip }, async () => {
  const db = await ctx();
  // T1 有群組 rold（seedLegacy）。B 建自己的群組
  const created = await call(db, 'irori_relay_room_create', 't2-xisu', 'rb1', 'B 的群組', ['t2-home']);
  assert.equal(created.id, 'rb1');
  // 不能把別租戶的人加進自己的群組
  assert.equal((await call(db, 'irori_relay_room_create', 't2-xisu', 'rb2', 'x', ['H'])).error, 'bad_member');
  assert.equal((await call(db, 'irori_relay_room_add', 't2-xisu', 'rb1', 'H')).error, 'bad_member');
  assert.equal((await call(db, 'irori_relay_room_add', 'XISU', 'rb1', 'H')).error, 'not_found', 'T1 也不能對 B 的群組加人');
  // 列表
  assert.deepEqual((await call(db, 'irori_relay_room_list', 't2-xisu', true)).rooms.map((r) => r.id), ['rb1']);
  assert.deepEqual((await call(db, 'irori_relay_room_list', 'XISU', true)).rooms.map((r) => r.id), ['rold']);
  assert.deepEqual((await call(db, 'irori_relay_room_list', 't2-home', false)).rooms.map((r) => r.id), ['rb1']);
  // B 的 owner（'~owner' 成員 key）嘗試讀／寫 T1 的 rold：成員身分只在自己的租戶有效
  for (const owner of [true, false]) {
    const node = owner ? 't2-xisu' : 't2-home';
    assert.equal((await call(db, 'irori_relay_room_read', node, null, 'rold', null, 50, owner, true, null)).error, 'not_member');
    assert.equal((await call(db, 'irori_relay_room_members', node, null, 'rold', owner)).error, 'not_member');
    assert.equal((await call(db, 'irori_relay_room_pin_get', node, null, 'rold', owner)).error, 'not_member');
    assert.equal((await call(db, 'irori_relay_room_post', node, null, 'rold', '闖入', [], owner)).error, 'not_member');
  }
  assert.equal((await call(db, 'irori_relay_room_pin_set', 't2-xisu', 'rold', '偷改', 0)).error, 'not_found');
  assert.equal((await call(db, 'irori_relay_room_remove', 't2-xisu', 'rold', 'H')).error, 'not_found');
  assert.equal((await call(db, 'irori_relay_room_set_prefixes', 't2-xisu', 'rold', ['H'])).error, 'not_found');
  // 反向：T1 讀不到 B 的
  assert.equal((await call(db, 'irori_relay_room_read', 'XISU', null, 'rb1', null, 50, true, true, null)).error, 'not_member');
  // T1 的群組內容沒被動過
  const t1msgs = await call(db, 'irori_relay_room_read', 'XISU', null, 'rold', null, 50, true, true, null);
  assert.deepEqual(t1msgs.messages.map((m) => m.body), ['舊群組的第一句']);
  // B 在自己的群組發言：主人顯示名是 B 的稱呼；門鈴只響 B 的節點
  const post = await call(db, 'irori_relay_room_post', 't2-xisu', null, 'rb1', '哈囉', [], true);
  assert.ok(post.seq);
  assert.deepEqual(post.bell_topics.sort(), [(await one(db, "select bell_topic from relay.nodes where id = 't2-home'")).bell_topic]);
  const read = await call(db, 'irori_relay_room_read', 't2-home', null, 'rb1', null, 50, false, true, null);
  assert.equal(read.messages[0].from_name, '王小明');
  assert.equal(read.messages[0].trust, 'owner');
  // 自動收入：B 的視窗名符合 T1 群組的前綴 → 不會被收進 T1 的群組
  await call(db, 'irori_relay_room_set_prefixes', 'XISU', 'rold', ['Auto']);
  await call(db, 'irori_relay_roster', 't2-home', JSON.stringify([{ name: 'Auto-1', status: 'idle' }]));
  assert.deepEqual(await call(db, 'irori_relay_room_auto_rules', 't2-home'), [], 'B 看到的規則裡沒有 T1 的群組');
  assert.deepEqual((await call(db, 'irori_relay_room_auto_rules', 'H')).map((r) => r.room), ['rold']);
  const apply = await call(db, 'irori_relay_room_auto_apply', 't2-home', JSON.stringify([{ room: 'rold', name: 'Auto-1' }]));
  assert.deepEqual([apply.added, apply.left], [0, 0]);
  assert.equal((await one(db, "select count(*)::int n from relay.room_members where room_id = 'rold' and member like 't2-home%'")).n, 0);
  assert.deepEqual((await call(db, 'irori_relay_room_auto_rules')).map((r) => r.room), ['rold'], '舊的無參數版只回租戶 1');
});

test('租戶隔離：遠端開視窗——只能對同租戶的電腦下令，看不到別租戶的紀錄', { skip }, async () => {
  const db = await ctx();
  const launcher = JSON.stringify({ profiles: [{ id: 'p', label: 'P' }], cwd_allow: ['C:/w'], max_per_hour: 5 });
  assert.deepEqual(await call(db, 'irori_relay_set_launcher', 't2-home', launcher), { ok: true });
  // T1 的 owner 對 B 的電腦下令 / B 對 T1 的 H 下令：都是 not_found
  assert.equal((await call(db, 'irori_relay_launch', 'XISU', 't2-home', 'p', 'win-x', 'C:/w', null)).error, 'not_found');
  assert.equal((await call(db, 'irori_relay_launch', 't2-xisu', 'H', 'p', 'win-y', 'D:/x', null)).error, 'not_found');
  const ok = await call(db, 'irori_relay_launch', 't2-xisu', 't2-home', 'p', 'win-b', 'C:/w', null);
  assert.ok(ok.id);
  assert.equal((await one(db, 'select tenant_id from relay.launches where id = $1', [ok.id])).tenant_id, (await one(db, 'select id from relay.tenants where serial = 2')).id);
  // 名單與紀錄分開
  const lB = await call(db, 'irori_relay_launchers', 't2-xisu', null);
  assert.deepEqual(lB.machines.map((m) => m.node), ['t2-home']);
  assert.deepEqual(lB.launches.map((l) => l.name), ['win-b']);
  const lT1 = await call(db, 'irori_relay_launchers', 'XISU', null);
  assert.deepEqual(lT1.machines.map((m) => m.node), ['H']);
  assert.deepEqual(lT1.launches.map((l) => l.name), ['old-win']);
  // 用別人的 launch id 查：回空
  const spy = await call(db, 'irori_relay_launchers', 'XISU', [ok.id]);
  assert.deepEqual(spy.launches, []);
  // 機器橋只拿得到自己的待辦
  assert.equal((await call(db, 'irori_relay_launch_pending', 'H')).length, 0);
  assert.equal((await call(db, 'irori_relay_launch_pending', 't2-home')).length, 1);
});

test('帳號：沒受邀拒絕；邀請（綁信箱）自動開通；碼只能用一次、過期與作廢無效、信箱要對', { skip }, async () => {
  const db = await ctx();
  const resolve = (uid, email, name = '', env = false) => call(db, 'irori_account_resolve', uid, email, name, env, 1);
  assert.equal((await resolve(U_D, 'd@example.com')).status, 'none', '沒有邀請就是沒有權限');
  assert.equal((await resolve(U_D, '')).status, 'none');
  // 邀請綁信箱：大小寫不拘；之後該信箱登入自動開通
  const inv = await call(db, 'irori_account_invite_create', OWNER, 'D@Example.com', 'code-d', 'member', '同事', 24);
  assert.ok(inv.id);
  assert.deepEqual(await call(db, 'irori_account_invite_create', OWNER, 'b@example.com', 'code-b2', 'member', null, 24), { error: 'already_member' });
  const d = await resolve(U_D, 'd@example.com', 'Dora');
  assert.equal(d.status, 'active');
  assert.equal(d.role, 'member');
  assert.equal(d.new, true);
  assert.equal(d.owner_name, 'Dora');
  assert.equal((await one(db, 'select used_by from irori.account_invites where id = $1', [inv.id])).used_by, U_D);
  // 邀請已用掉：同一封邀請不能再讓別人用（email 綁定）
  assert.equal((await call(db, 'irori_account_redeem', U_E, 'e@example.com', '', 'code-d', 1)).error, 'invalid_invite');
  // 無信箱的邀請碼：兌換一次；第二個人再用就無效
  await call(db, 'irori_account_invite_create', OWNER, null, 'code-open', 'member', null, 24);
  assert.equal((await call(db, 'irori_account_redeem', U_E, 'e@example.com', 'Eve', 'code-open', 1)).status, 'active');
  assert.equal((await call(db, 'irori_account_redeem', 'f0000000-0000-4000-8000-00000000000f', 'f@example.com', '', 'code-open', 1)).error, 'invalid_invite');
  // 已是成員的人再兌換
  assert.equal((await call(db, 'irori_account_redeem', U_E, 'e@example.com', '', 'code-open', 1)).error, 'already_member');
  // 綁信箱的碼，別的信箱兌換失敗；不存在的碼
  await call(db, 'irori_account_invite_create', OWNER, 'g@example.com', 'code-g', 'member', null, 24);
  assert.equal((await call(db, 'irori_account_redeem', 'a0000000-0000-4000-8000-0000000000a1', 'x@example.com', '', 'code-g', 1)).error, 'email_mismatch');
  assert.equal((await call(db, 'irori_account_redeem', 'a0000000-0000-4000-8000-0000000000a1', 'x@example.com', '', 'nope', 1)).error, 'invalid_invite');
  // 作廢、過期
  const rv = await call(db, 'irori_account_invite_create', OWNER, null, 'code-rev', 'member', null, 24);
  assert.deepEqual(await call(db, 'irori_account_invite_revoke', rv.id), { ok: true });
  assert.equal((await call(db, 'irori_account_redeem', 'a0000000-0000-4000-8000-0000000000a2', 'y@example.com', '', 'code-rev', 1)).error, 'invalid_invite');
  assert.equal((await call(db, 'irori_account_invite_revoke', rv.id)).error, 'not_found');
  await call(db, 'irori_account_invite_create', OWNER, null, 'code-exp', 'member', null, 24);
  await db.exec("update irori.account_invites set expires_at = now() - interval '1 hour' where code_hash = 'code-exp'");
  assert.equal((await call(db, 'irori_account_redeem', 'a0000000-0000-4000-8000-0000000000a3', 'z@example.com', '', 'code-exp', 1)).error, 'invalid_invite');
  await call(db, 'irori_account_invite_create', OWNER, 'late@example.com', 'code-late', 'member', null, 24);
  await db.exec("update irori.account_invites set expires_at = now() - interval '1 hour' where code_hash = 'code-late'");
  assert.equal((await resolve('a0000000-0000-4000-8000-0000000000a4', 'late@example.com')).status, 'none', '過期的邀請不會自動開通');
});

test('帳號：IRORI_OWNER_EMAILS（p_env_admin）仍是退路——自動變管理者；停用其他人不影響它', { skip }, async () => {
  const db = await ctx();
  const root = 'a0000000-0000-4000-8000-0000000000e1';
  const r = await call(db, 'irori_account_resolve', root, 'root@example.com', '管理員', true, 1);
  assert.deepEqual([r.status, r.role, r.source], ['active', 'admin', 'env']);
  assert.ok(r.node, '也有自己的租戶與角色節點');
  assert.equal((await one(db, 'select unlimited from irori.usage_quota where owner = $1', [root])).unlimited, true);
  // 帳號被停用過但在 env 名單裡：仍然進得來（緊急管理員）
  await call(db, 'irori_account_set_status', 'root@example.com', 'suspended');
  const back = await call(db, 'irori_account_resolve', root, 'root@example.com', '', true, 1);
  assert.deepEqual([back.status, back.role], ['active', 'admin']);
  // 舊資料的擁有者用 env 名單登入：既有帳號與租戶 1 不變
  const own = await call(db, 'irori_account_resolve', OWNER, 'owner@example.com', '', true, 1);
  assert.deepEqual([own.status, own.tenant_id, own.node, own.role], ['active', T1, 'XISU', 'admin']);
});

test('帳號：停用→登入被拒、租戶的機器橋金鑰暫時失效；恢復後回來；列表不含內容', { skip }, async () => {
  const db = await ctx();
  assert.equal((await authRows(db, 'kh-b-home')).length, 1);
  assert.deepEqual(await call(db, 'irori_account_set_status', 'b@example.com', 'suspended'), { ok: true, user_id: U_B });
  assert.equal((await call(db, 'irori_account_resolve', U_B, 'b@example.com', '', false, 1)).status, 'suspended');
  assert.equal((await authRows(db, 'kh-b-home')).length, 0, '停用後機器橋金鑰不認');
  assert.equal((await authRows(db, 'kh-xisu')).length, 1, '其他租戶不受影響');
  assert.equal((await call(db, 'irori_account_set_status', 'nobody@example.com', 'suspended')).error, 'not_found');
  assert.equal((await call(db, 'irori_account_set_status', 'b@example.com', 'weird')).error, 'bad_request');
  assert.deepEqual(await call(db, 'irori_account_set_status', 'b@example.com', 'active'), { ok: true, user_id: U_B });
  assert.equal((await authRows(db, 'kh-b-home')).length, 1);
  assert.equal((await call(db, 'irori_account_resolve', U_B, 'b@example.com', '', false, 1)).status, 'active');
  const list = await call(db, 'irori_account_list');
  const b = list.accounts.find((a) => a.email === 'b@example.com');
  assert.deepEqual([b.role, b.status, b.tenant, b.machines], ['member', 'active', 2, 2]); // t2-home 與 t2-gpt
  assert.deepEqual([Number(b.quota.granted), Number(b.quota.used), b.quota.unlimited], [1, 0, false]);
  assert.ok(Array.isArray(list.invites));
  assert.ok(!JSON.stringify(list).includes('舊的一封信'));
  // 同一個 email 綁在別的登入身分上：不自動接手
  assert.equal((await call(db, 'irori_account_resolve', 'a0000000-0000-4000-8000-0000000000a9', 'b@example.com', '', false, 1)).status, 'none');
});

test('租戶稱呼同步：settings.user_name 改了，群組顯示名跟著變', { skip }, async () => {
  const db = await ctx();
  assert.equal(await call(db, 'irori_tenant_set_owner_name', U_C, '  阿華  '), true);
  assert.equal(await call(db, 'irori_tenant_set_owner_name', U_C, '阿華'), false, '沒變就不寫');
  assert.equal(await call(db, 'irori_tenant_set_owner_name', U_C, ''), false);
  assert.equal(await call(db, 'irori_tenant_set_owner_name', '00000000-0000-4000-8000-0000000000aa', '誰'), false, '沒有租戶的人什麼都不做');
  await call(db, 'irori_relay_room_create', 't3-xisu', 'rc1', 'C 的群組', []);
  await call(db, 'irori_relay_room_post', 't3-xisu', null, 'rc1', 'hi', [], true);
  const r = await call(db, 'irori_relay_room_read', 't3-xisu', null, 'rc1', null, 10, true, true, null);
  assert.equal(r.messages[0].from_name, '阿華');
  assert.equal((await call(db, 'irori_tenant_of_user', U_C)).owner_name, '阿華');
  assert.equal(await call(db, 'irori_tenant_of_user', '00000000-0000-4000-8000-0000000000bb'), null);
  assert.equal((await call(db, 'irori_relay_whoami', (await one(db, 'select id from relay.tenants where serial = 3')).id)).node, 't3-xisu');
});

test('回退：down 腳本＋重跑舊檔 → 舊流程照常；再重新上線（16、17）也行', { skip }, async () => {
  const db = await newDb('15_usage.sql');
  await seedLegacy(db);
  await db.exec(sqlFile('16_tenants.sql'));
  await db.exec(sqlFile('17_tenants_enforce.sql'));
  await call(db, 'irori_account_invite_create', OWNER, 'b@example.com', 'hb', 'member', null, 24);
  await call(db, 'irori_account_resolve', U_B, 'b@example.com', 'B', false, 1);
  await db.exec(fs.readFileSync(path.join(SQL_DIR, 'rollback', '16_tenants_down.sql'), 'utf8'));
  for (const f of ['01_relay.sql', '02_members.sql', '05_rooms.sql', '07_launch.sql']) await db.exec(sqlFile(f));
  // 舊的函式本體回來了：auth 沒有 tenant_id 欄位，list 無參數、寄信不分租戶
  const auth = await authRows(db, 'kh-xisu');
  assert.deepEqual(Object.keys(auth[0]).sort(), ['bell_topic', 'can_invite', 'id', 'role']);
  assert.ok((await call(db, 'irori_relay_list')).length >= 5);
  const s = await call(db, 'irori_relay_send', 'XISU', null, 'H', null, '回退後的信', null);
  assert.ok(s.id);
  assert.equal((await call(db, 'irori_relay_room_list', 'XISU', true)).rooms.length, 1);
  // 限制都拿掉了（舊函式的 insert 不帶 tenant_id 也能成功）
  await db.exec("insert into relay.nodes (id, name, key_hash, bell_topic) values ('plain', 'x', 'kk', 'bb')");
  // 資料都還在
  assert.equal((await one(db, 'select count(*)::int n from relay.tenants')).n, 2);
  // 再上線：16、17 重跑（把 plain 補回租戶 1）
  await db.exec(sqlFile('16_tenants.sql'));
  await db.exec(sqlFile('17_tenants_enforce.sql'));
  assert.equal((await one(db, "select tenant_id from relay.nodes where id = 'plain'")).tenant_id, T1);
  assert.equal((await authRows(db, 'kh-xisu'))[0].tenant_id, T1);
  await db.close();
});

test('所有 16 新增的函式都只授權 service_role（匿名與登入者不能呼叫）', { skip }, async () => {
  const db = await ctx();
  const r = await rows(db, `
    select p.proname, pg_get_function_identity_arguments(p.oid) as args,
           has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as auth,
           has_function_privilege('service_role', p.oid, 'execute') as svc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like 'irori_account_%' or p.proname like 'irori_tenant_%' or p.proname = 'irori_relay_whoami'
          or p.proname = 'irori_relay_list_by_node')`);
  assert.ok(r.length >= 10);
  for (const f of r) {
    assert.deepEqual([f.anon, f.auth, f.svc], [false, false, true], `${f.proname}(${f.args})`);
  }
  assert.equal((await one(db, "select relrowsecurity from pg_class where oid = 'relay.tenants'::regclass")).relrowsecurity, true);
  assert.equal((await one(db, "select relrowsecurity from pg_class where oid = 'irori.accounts'::regclass")).relrowsecurity, true);
  assert.equal((await one(db, "select relrowsecurity from pg_class where oid = 'irori.account_invites'::regclass")).relrowsecurity, true);
});

void ISO;
