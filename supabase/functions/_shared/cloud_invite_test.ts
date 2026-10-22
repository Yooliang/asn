// 雲端代理邀請（issue #13）：後台三個動作 cloud_node_create／cloud_node_list／cloud_node_revoke 的守門測試。
// 重點：沒有本人登入憑證什麼都不能做（節點金鑰不算）；金鑰只在建立當下回一次、資料庫與紀錄都不會有明文；只能撤銷自己邀請的雲端代理。
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { ACCOUNT_ACTIONS, type AccountDeps, handleAccountAction } from "./account.ts";

const UID = "3f2b7c1e-9a41-4c1b-8d52-0a6f6c7e1b10";
const JWT = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
const bearer = `Bearer ${JWT}`;
const ACTIONS = ["cloud_node_create", "cloud_node_list", "cloud_node_revoke"];

type Call = { fn: string; args: Record<string, unknown> };

function fake(over: Partial<AccountDeps> = {}, rpcReply: (fn: string) => unknown = () => ({})) {
  const calls: Call[] = [];
  const deps: AccountDeps = {
    verifyJwt: async (t) => (t === JWT ? { id: UID, email: "a@example.com", name: "阿明" } : null),
    rpc: async (fn, args) => { calls.push({ fn, args }); return { data: rpcReply(fn), error: null }; },
    sha256Hex: async (s) => "hash-" + [...s].reverse().join(""),
    newSecrets: () => ({ key: "CLOUDKEY_secret_value", bellTopic: "relay-bell-xyz" }),
    ...over,
  };
  return { deps, calls };
}

Deno.test("三個動作都登錄成帳號動作（要登入憑證）", () => {
  for (const a of ACTIONS) assert(ACCOUNT_ACTIONS.has(a), a);
});

Deno.test("沒有本人的登入憑證：401，完全不碰資料庫（節點金鑰、anon／service 金鑰都不算）", async () => {
  for (const action of ACTIONS) {
    for (const h of [null, "", "Bearer " + "x".repeat(40), "Bearer service_role_looking_thing_aaaaaaaa", "Basic abc"]) {
      const f = fake();
      // 第三個參數是 Authorization；第四個是 x-relay-key——帶了節點金鑰也一樣進不來
      const r = await handleAccountAction(f.deps, action, h, "a-valid-looking-node-key", { name: "小真", node: "t5-abcd1234" });
      assertEquals(r.status, 401, `${action} ${h}`);
      assertEquals(f.calls.length, 0, `${action} 不該碰資料庫`);
    }
  }
});

Deno.test("cloud_node_create：金鑰只在回應出現一次；資料庫只收雜湊；身分取自憑證不取自 body", async () => {
  const f = fake({}, () => ({ id: "t5-abcd1234", name: "小真" }));
  const r = await handleAccountAction(f.deps, "cloud_node_create", bearer, null, { name: " 小真 ", user: "evil", p_user: "evil" });
  assertEquals(r.status, 200);
  assertEquals(r.body, { id: "t5-abcd1234", name: "小真", key: "CLOUDKEY_secret_value" });
  assertEquals(f.calls.length, 1);
  assertEquals(f.calls[0].fn, "asn_cloud_node_create");
  assertEquals(f.calls[0].args.p_user, UID);
  assertEquals(f.calls[0].args.p_name, "小真");
  assertEquals(f.calls[0].args.p_key_hash, "hash-" + [..."CLOUDKEY_secret_value"].reverse().join(""));
  assertEquals(JSON.stringify(f.calls).includes("CLOUDKEY_secret_value"), false, "金鑰明文不能送進資料庫");
});

Deno.test("cloud_node_create：每次都是新金鑰；失敗時不回金鑰也不把金鑰寫進 log", async () => {
  let n = 0;
  const f = fake({ newSecrets: () => ({ key: "K" + ++n, bellTopic: "b" + n }) }, () => ({ id: "x", name: "a" }));
  const a = await handleAccountAction(f.deps, "cloud_node_create", bearer, null, { name: "a" });
  const b = await handleAccountAction(f.deps, "cloud_node_create", bearer, null, { name: "a" });
  assertNotEquals(a.body.key, b.body.key);

  const logs: string[] = [];
  const orig = console.error;
  console.error = (...x: unknown[]) => { logs.push(x.map(String).join(" ")); };
  try {
    const boom = fake({ newSecrets: () => ({ key: "LOGLEAK_key_value", bellTopic: "b" }), rpc: async () => ({ data: null, error: { message: "db down" } }) });
    const r = await handleAccountAction(boom.deps, "cloud_node_create", bearer, null, { name: "a" });
    assertEquals(r, { status: 500, body: { error: "internal" } });
  } finally {
    console.error = orig;
  }
  assertEquals(logs.some((l) => l.includes("LOGLEAK_key_value")), false, "log 裡不能有金鑰");
  for (const [code, status] of [["too_many", 429], ["tenant_inactive", 403], ["bad_request", 400]] as const) {
    const g = fake({}, () => ({ error: code }));
    const r = await handleAccountAction(g.deps, "cloud_node_create", bearer, null, { name: "a" });
    assertEquals(r.status, status, code);
    assertEquals("key" in r.body, false, "失敗時不回金鑰");
  }
});

Deno.test("cloud_node_create：名稱不合格 400（空的、沒給、不是字串），不碰資料庫", async () => {
  for (const bad of [null, [], {}, { name: "" }, { name: "   " }, { name: 5 }, { name: "\n\t" }]) {
    const f = fake();
    assertEquals((await handleAccountAction(f.deps, "cloud_node_create", bearer, null, bad)).status, 400, JSON.stringify(bad));
    assertEquals(f.calls.length, 0);
  }
});

Deno.test("cloud_node_list：只傳登入使用者；回應裡沒有金鑰欄位", async () => {
  const rows = [{ id: "t5-abcd1234", name: "小真", created_at: "2026-10-22T00:00:00Z", last_seen_at: null, online: false }];
  const f = fake({}, () => rows);
  const r = await handleAccountAction(f.deps, "cloud_node_list", bearer, null, { user: "evil" });
  assertEquals(r.status, 200);
  assertEquals(r.body, { nodes: rows });
  assertEquals(f.calls, [{ fn: "asn_cloud_node_list", args: { p_user: UID } }]);
  assertEquals(JSON.stringify(r.body).includes("key"), false);
  // 後端回非陣列也不丟例外
  const g = fake({}, () => null);
  assertEquals((await handleAccountAction(g.deps, "cloud_node_list", bearer, null, null)).body, { nodes: [] });
});

Deno.test("cloud_node_revoke：憑證決定使用者；別人的／不是雲端代理的／不存在的一律 404；節點格式要合格", async () => {
  const f = fake({}, () => ({ ok: true }));
  const r = await handleAccountAction(f.deps, "cloud_node_revoke", bearer, null, { node: "t5-abcd1234", user: "evil", p_user: "evil" });
  assertEquals(r.status, 200);
  assertEquals(r.body, { ok: true });
  assertEquals(f.calls, [{ fn: "asn_cloud_node_revoke", args: { p_user: UID, p_node: "t5-abcd1234" } }]);
  const nf = fake({}, () => ({ error: "not_found" }));
  const e = await handleAccountAction(nf.deps, "cloud_node_revoke", bearer, null, { node: "someone-elses" });
  assertEquals(e, { status: 404, body: { error: "not_found" } });
  for (const bad of [null, [], {}, { node: "" }, { node: 5 }, { node: "a b" }, { node: "x".repeat(33) }]) {
    const g = fake();
    assertEquals((await handleAccountAction(g.deps, "cloud_node_revoke", bearer, null, bad)).status, 400, JSON.stringify(bad));
    assertEquals(g.calls.length, 0);
  }
  const boom = fake({ rpc: async () => ({ data: null, error: { message: "db secret" } }) });
  const b = await handleAccountAction(boom.deps, "cloud_node_revoke", bearer, null, { node: "w02" });
  assertEquals(b.status, 500);
  assertEquals(JSON.stringify(b.body).includes("secret"), false);
});

Deno.test("relay/index.ts：三個動作走帳號動作那一段（在節點金鑰驗證之前、只收 POST）", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  const acct = src.indexOf("ACCOUNT_ACTIONS.has(action)");
  const nodeKey = src.search(/req\.headers\.get\("x-relay-key"\);\r?\n\s*if \(!key\)/);
  assert(acct > 0 && nodeKey > acct);
  for (const a of ACTIONS) assert(!src.includes(`"${a}"`), `${a} 不該另外掛在節點金鑰那一側`);
});

Deno.test("migration：函式只授權 service_role；撤銷讓金鑰與門鈴頻道失效；只動自己的雲端代理；金鑰不進資料庫", async () => {
  const sql = (await Deno.readTextFile(new URL("../../migrations/20261022050000_cloud_agent_invite.sql", import.meta.url))).replace(/\r\n/g, "\n");
  for (const fn of ["asn_cloud_node_create(uuid, text, text, text)", "asn_cloud_node_list(uuid)", "asn_cloud_node_revoke(uuid, text)"]) {
    assert(sql.includes(`revoke all on function public.${fn} from public, anon, authenticated;`), fn);
    assert(sql.includes(`grant execute on function public.${fn} to service_role;`), fn);
  }
  assert(!/grant execute[^;]*to (anon|authenticated|public)/.test(sql));
  const revoke = sql.slice(sql.indexOf("function public.asn_cloud_node_revoke"));
  assert(revoke.includes("status = 'left'") && revoke.includes("key_hash = 'revoked:'") && revoke.includes("bell_topic = 'revoked-bell-'"));
  assert(revoke.includes("owner_user = p_user") && revoke.includes("created_via = 'cloud-invite'"), "只撤銷自己名下、邀請建立的雲端代理");
  const list = sql.slice(sql.indexOf("function public.asn_cloud_node_list"), sql.indexOf("function public.asn_cloud_node_revoke"));
  assert(!list.includes("key_hash") && !list.includes("bell_topic"), "列表不含金鑰雜湊與門鈴頻道");
  assert(!/p_key\b[^_]/.test(sql.replace(/p_key_hash/g, "")), "資料庫函式不收金鑰明文，只收雜湊");
  assert(sql.includes("'cloud-invite'") && sql.includes("nodes_created_via_check"));
  const down = await Deno.readTextFile(new URL("../../sql/rollback/20261022050000_cloud_agent_invite_down.sql", import.meta.url));
  assert(down.includes("drop function if exists public.asn_cloud_node_create"));
});
