import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { type AccountDeps, bearerToken, cleanDisplayName, handleAccountAction, parseNodeCreate } from "./account.ts";

const UID = "3f2b7c1e-9a41-4c1b-8d52-0a6f6c7e1b10";
const JWT = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
const DEV = "dev_abcdefghijklmnop1234";

type Call = { fn: string; args: Record<string, unknown> };

function fake(over: Partial<AccountDeps> = {}, rpcReply: (fn: string) => unknown = () => ({})) {
  const calls: Call[] = [];
  const tokens: string[] = [];
  const deps: AccountDeps = {
    verifyJwt: async (t) => { tokens.push(t); return t === JWT ? { id: UID, email: "a@example.com", name: "阿明" } : null; },
    rpc: async (fn, args) => { calls.push({ fn, args }); return { data: rpcReply(fn), error: null }; },
    sha256Hex: async (s) => "hash-" + [...s].reverse().join(""),
    newSecrets: () => ({ key: "NEWKEY_secret_value", bellTopic: "relay-bell-xyz" }),
    ...over,
  };
  return { deps, calls, tokens };
}
const bearer = `Bearer ${JWT}`;

Deno.test("bearerToken：只收 Bearer 加合理字元", () => {
  assertEquals(bearerToken(bearer), JWT);
  assertEquals(bearerToken(null), null);
  assertEquals(bearerToken("Basic abc"), null);
  assertEquals(bearerToken("Bearer short"), null);
  assertEquals(bearerToken("Bearer " + JWT + " extra"), null);
});

Deno.test("cleanDisplayName：去控制字元、限 40 字", () => {
  assertEquals(cleanDisplayName(" 阿\n明 "), "阿明");
  assertEquals(cleanDisplayName("字".repeat(60))?.length, 40);
  assertEquals(cleanDisplayName(""), null);
  assertEquals(cleanDisplayName(5), null);
});

Deno.test("parseNodeCreate：電腦名稱與 device_id 要合格", () => {
  assertEquals(parseNodeCreate({ name: "家用機", device_id: DEV }), { name: "家用機", machine: "家用機", device_id: DEV });
  assertEquals(parseNodeCreate({ name: "家用機", machine: "PC-1", device_id: DEV })?.machine, "PC-1");
  assertEquals(parseNodeCreate({ name: "", device_id: DEV }), null);
  assertEquals(parseNodeCreate({ name: "x", device_id: "short" }), null);
  assertEquals(parseNodeCreate({ name: "x", device_id: "bad id with spaces!!!" }), null);
  assertEquals(parseNodeCreate(null), null);
  assertEquals(parseNodeCreate([]), null);
});

Deno.test("沒帶或帶錯登入憑證：401，而且完全不碰資料庫", async () => {
  for (const action of ["account_bootstrap", "node_create", "node_claim"]) {
    for (const h of [null, "Bearer " + "x".repeat(40), "Bearer service_role_looking_thing_aaaaaaaa"]) {
      const f = fake();
      const r = await handleAccountAction(f.deps, action, h, "somekey12345", { name: "a", device_id: DEV });
      assertEquals(r.status, 401, `${action} ${h}`);
      assertEquals(f.calls.length, 0);
    }
  }
});

Deno.test("憑證驗證丟例外：500，不外洩內容", async () => {
  const f = fake({ verifyJwt: async () => { throw new Error("boom secret"); } });
  const r = await handleAccountAction(f.deps, "account_bootstrap", bearer, null, null);
  assertEquals(r.status, 500);
  assertEquals(JSON.stringify(r.body).includes("boom"), false);
  assertEquals(f.calls.length, 0);
});

Deno.test("account_bootstrap：用驗過的使用者 id 呼叫，body 裡的 id 不採用", async () => {
  const f = fake({}, () => ({ created: true, tenant: { serial: 5 }, nodes: [] }));
  const r = await handleAccountAction(f.deps, "account_bootstrap", bearer, null, { user: "evil", p_user: "evil" });
  assertEquals(r.status, 200);
  assertEquals(r.body.created, true);
  assertEquals(f.calls, [{ fn: "asn_account_bootstrap", args: { p_user: UID, p_email: "a@example.com", p_name: "阿明" } }]);
});

Deno.test("node_create：金鑰只在回應出現一次，資料庫只收雜湊", async () => {
  const f = fake({}, () => ({ id: "t5-abcd1234", bell_topic: "relay-bell-xyz", rotated: false }));
  const r = await handleAccountAction(f.deps, "node_create", bearer, null, { name: "家用機", device_id: DEV });
  assertEquals(r.status, 200);
  assertEquals(r.body, { id: "t5-abcd1234", key: "NEWKEY_secret_value", bell_topic: "relay-bell-xyz", rotated: false });
  const args = f.calls[0].args;
  assertEquals(args.p_key_hash, "hash-" + [..."NEWKEY_secret_value"].reverse().join(""));
  assertEquals(args.p_user, UID);
  assertEquals(JSON.stringify(f.calls).includes("NEWKEY_secret_value"), false, "金鑰明文不能送進資料庫");
});

Deno.test("node_create：每次呼叫都產生新金鑰（換新金鑰時舊的失效由資料庫處理）", async () => {
  let n = 0;
  const f = fake({ newSecrets: () => ({ key: "K" + ++n, bellTopic: "b" + n }) }, () => ({ id: "x", bell_topic: "b", rotated: true }));
  const a = await handleAccountAction(f.deps, "node_create", bearer, null, { name: "a", device_id: DEV });
  const b = await handleAccountAction(f.deps, "node_create", bearer, null, { name: "a", device_id: DEV });
  assertNotEquals(a.body.key, b.body.key);
});

Deno.test("node_create：輸入不合格 400；資料庫錯誤碼對映", async () => {
  const f = fake();
  assertEquals((await handleAccountAction(f.deps, "node_create", bearer, null, { name: "a" })).status, 400);
  assertEquals(f.calls.length, 0);
  const many = fake({}, () => ({ error: "too_many" }));
  assertEquals((await handleAccountAction(many.deps, "node_create", bearer, null, { name: "a", device_id: DEV })).status, 429);
  const inactive = fake({}, () => ({ error: "tenant_inactive" }));
  const r = await handleAccountAction(inactive.deps, "node_create", bearer, null, { name: "a", device_id: DEV });
  assertEquals(r.status, 403);
  assertEquals("key" in r.body, false, "失敗時不回金鑰");
});

Deno.test("node_claim：要帶現有節點金鑰，送雜湊；錯誤碼對映", async () => {
  const f = fake({}, () => ({ ok: true, already: false, node: "H" }));
  assertEquals((await handleAccountAction(f.deps, "node_claim", bearer, null, null)).status, 400);
  assertEquals(f.calls.length, 0);
  const r = await handleAccountAction(f.deps, "node_claim", bearer, "existing-node-key", null);
  assertEquals(r.status, 200);
  assertEquals(r.body, { ok: true, already: false, node: "H" });
  assertEquals(f.calls[0], { fn: "asn_node_claim", args: { p_user: UID, p_key_hash: "hash-" + [..."existing-node-key"].reverse().join("") } });
  assertEquals(JSON.stringify(f.calls).includes("existing-node-key"), false);
  for (const [code, status] of [["invalid_key", 403], ["already_claimed", 409], ["tenant_not_yours", 409]] as const) {
    const g = fake({}, () => ({ error: code }));
    const e = await handleAccountAction(g.deps, "node_claim", bearer, "existing-node-key", null);
    assertEquals(e.status, status);
    assertEquals(e.body, { error: code });
  }
});

Deno.test("資料庫回錯誤：500 且不外洩細節", async () => {
  const f = fake({ rpc: async () => ({ data: null, error: { message: "relation secret_table" } }) });
  const r = await handleAccountAction(f.deps, "account_bootstrap", bearer, null, null);
  assertEquals(r.status, 500);
  assertEquals(r.body, { error: "internal" });
});

Deno.test("未知動作：404（驗證通過之後）", async () => {
  const f = fake();
  assertEquals((await handleAccountAction(f.deps, "nope", bearer, null, null)).status, 404);
});

Deno.test("relay/index.ts：帳號動作只收 POST、交給 handleAccountAction（它先驗憑證），且在節點金鑰驗證之前", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  const acct = src.indexOf("ACCOUNT_ACTIONS.has(action)");
  // Windows checkout 可能是 CRLF，所以用正規表示式找位置，不依賴換行字元
  const nodeKey = src.search(/req\.headers\.get\("x-relay-key"\);\r?\n\s*if \(!key\)/);
  assert(acct > 0 && nodeKey > acct, "帳號動作要排在節點金鑰驗證之前");
  const block = src.slice(acct, nodeKey);
  assert(block.includes('req.method !== "POST"'));
  assert(block.includes("handleAccountAction("));
  assert(src.includes("db.auth.getUser(token)") && src.includes("is_anonymous"), "憑證用 auth.getUser 驗，並拒絕匿名使用者");
});

Deno.test("migration：新函式只授權 service_role，資料表開 RLS", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20261021030000_account_login.sql", import.meta.url));
  for (const fn of ["asn_account_bootstrap(uuid, text, text)", "asn_node_claim(uuid, text)", "asn_node_create(uuid, text, text, text, text, text)", "asn_admin_adopt_tenant(text, integer)"]) {
    assert(sql.includes(`revoke all on function public.${fn} from public, anon, authenticated;`), fn);
    assert(sql.includes(`grant execute on function public.${fn} to service_role;`), fn);
  }
  assert(sql.includes("alter table relay.account_events enable row level security;"));
  assert(!/p_key\b[^_]/.test(sql.replace(/p_key_hash/g, "")), "資料庫函式不收金鑰明文，只收雜湊");
});
