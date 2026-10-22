import { assert, assertEquals } from "jsr:@std/assert@1";

// 本人寄信的寄件人說明（migration 20261022090000_owner_sender_display.sql）：
//  1. irori_relay_send：to_node 可直接寫人代號 u:xxxxxxxxxxxx（與節點無關）；舊寫法「節點/u:xxx」（含 XISU/u:xxx）照舊
//  2. irori_relay_inbox／inbox_agent：多回 sender_display／sender_device／sender_engine（選填），舊欄位的值不變
// 這裡做靜態檢查：把新 migration 的函式「拿掉新增的部分」後，必須和 account_me 那版逐字相同（等於證明沒弄壞舊行為）。
const read = (f: string) => Deno.readTextFileSync(new URL(`../../migrations/${f}`, import.meta.url)).replace(/\r\n/g, "\n");
const base = read("20261022020000_account_me.sql");
const mig = read("20261022090000_owner_sender_display.sql");

const fn = (sql: string, head: string) => {
  const i = sql.indexOf(head);
  assert(i >= 0, `找不到 ${head}`);
  return sql.slice(i, sql.indexOf("$function$;", i) + "$function$;".length);
};

const SEND = "create or replace function public.irori_relay_send(";
const INBOX = "create or replace function public.irori_relay_inbox(";
const AGENT = "create or replace function public.irori_relay_inbox_agent(";

Deno.test("send：拿掉人代號位址那一段後，與 account_me 版逐字相同（舊行為不變）", () => {
  const now = fn(mig, SEND);
  const a = now.indexOf("  -- 與節點無關的本人位址");
  const b = now.indexOf("  end if;\n", now.indexOf("into v_to;", a)) + "  end if;\n".length;
  assert(a > 0 && b > a, "找不到新增的區塊");
  const rest = now.slice(b);
  assertEquals(now.slice(0, a) + (rest.startsWith("\n") ? rest.slice(1) : rest), fn(base, SEND));
});

Deno.test("send：人代號位址只認這個租戶擁有者的代號；其他一律 unknown_to_node；簽章不變（9 個參數、預設值）", () => {
  const s = fn(mig, SEND);
  assert(s.includes("if p_to_node ~ '^u:[0-9a-f]{12}$' then"));
  assert(s.includes("if v_alias is null or p_to_node <> v_alias then\n      return jsonb_build_object('error', 'unknown_to_node');"));
  assert(s.includes("p_to_agent := v_alias;"), "視同寄給人代號，走同一條扇出");
  assert(s.includes("p_expects_reply boolean default null::boolean, p_signed_user uuid default null::uuid,\n  p_as_person boolean default false)"));
  assert(!/drop function/i.test(mig), "同一個簽章 create or replace，不用先 drop（舊呼叫端不受影響）");
  assert(mig.includes("revoke all on function public.irori_relay_send(text, text, text, text, text, uuid, boolean, uuid, boolean) from public, anon, authenticated;"));
  assert(mig.includes("grant execute on function public.irori_relay_send(text, text, text, text, text, uuid, boolean, uuid, boolean) to service_role;"));
});

for (const head of [INBOX, AGENT]) {
  Deno.test(`${head.split("public.")[1]} 拿掉三個新欄位後，與 account_me 版逐字相同；新欄位選填`, () => {
    const now = fn(mig, head);
    const stripped = now
      .replace(/      'sender_display', case when m\.owner_signed or m\.person_user is not null\n         then \(select nullif\(btrim\(t\.owner_name\), ''\) from relay\.tenants t where t\.id = m\.tenant_id\) end,\n/, "")
      .replace("      'sender_device', f.name,\n", "")
      .replace(/      'sender_engine', case when f\.machine = '雲端代理' then 'cloud'\n         else \(select r\.engine from relay\.roster r where r\.node = m\.from_node and r\.name = m\.from_agent\) end,\n/, "");
    assertEquals(stripped, fn(base, head));
    assert(now.includes("'sender_display'") && now.includes("'sender_device'") && now.includes("'sender_engine'"));
    assert(now.includes("relay.person_view_node(m.tenant_id, m.from_node, m.from_agent, m.person_user)"), "from_node 的值不變");
  });
}

Deno.test("sender_display 只給本人簽章的信，用租戶的 owner_name；沒有任何新增必填欄位", () => {
  assert(mig.includes("when m.owner_signed or m.person_user is not null"));
  assert(mig.includes("relay.tenants t where t.id = m.tenant_id"));
  assert(!/not null/i.test(mig.replace(/is not null/gi, "")), "不加 not null 欄位");
  assert(!/alter table/i.test(mig), "不改任何資料表結構");
});

Deno.test("migration 檔名以 2026102209 開頭、排在 account_me 之後", () => {
  const names = [...Deno.readDirSync(new URL("../../migrations/", import.meta.url))].map((e) => e.name).sort();
  const i = names.indexOf("20261022090000_owner_sender_display.sql");
  assert(i > names.indexOf("20261022020000_account_me.sql") && i >= 0);
});

// ---- 帳號層的名字：account_name 動作 ----
import { ACCOUNT_ACTIONS, type AccountDeps, handleAccountAction } from "./account.ts";

const UID = "3f2b7c1e-9a41-4c1b-8d52-0a6f6c7e1b10";
const JWT = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";

function fakeDeps(user: { name: string | null; email: string | null }, reply: unknown = { name: "啟良" }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const deps: AccountDeps = {
    verifyJwt: (t) => Promise.resolve(t === JWT ? { id: UID, ...user } : null),
    rpc: (fn, args) => { calls.push({ fn, args }); return Promise.resolve({ data: reply, error: null }); },
    sha256Hex: (s) => Promise.resolve(s),
    newSecrets: () => ({ key: "k", bellTopic: "b" }),
  };
  return { deps, calls };
}

Deno.test("account_name：要登入憑證（沒有或無效 401，不碰資料庫）", async () => {
  const { deps, calls } = fakeDeps({ name: "啟良", email: "a@b.c" });
  assert(ACCOUNT_ACTIONS.has("account_name"));
  assertEquals((await handleAccountAction(deps, "account_name", null, null, {})).status, 401);
  assertEquals((await handleAccountAction(deps, "account_name", "Bearer " + "x".repeat(30), null, {})).status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("account_name：沒帶 name ＝讀（p_name 為 null）；預設值取登入資料的 name，沒有就 email @ 前面那段", async () => {
  let t = fakeDeps({ name: "啟良", email: "qi@example.com" });
  let r = await handleAccountAction(t.deps, "account_name", `Bearer ${JWT}`, null, null);
  assertEquals([r.status, r.body], [200, { name: "啟良" }]);
  assertEquals(t.calls[0], { fn: "asn_account_name", args: { p_user: UID, p_name: null, p_default: "啟良" } });
  t = fakeDeps({ name: null, email: "qiliang@example.com" });
  await handleAccountAction(t.deps, "account_name", `Bearer ${JWT}`, null, {});
  assertEquals(t.calls[0].args.p_default, "qiliang");
});

Deno.test("account_name：帶 name ＝改（清理過）；空字串或不是字串回 400；後台回 not_found 轉成 404", async () => {
  const t = fakeDeps({ name: "x", email: null });
  const r = await handleAccountAction(t.deps, "account_name", `Bearer ${JWT}`, null, { name: " 啟\n良 " });
  assertEquals(r.status, 200);
  assertEquals(t.calls[0].args.p_name, "啟良");
  for (const bad of ["", "   ", 5, {}, []]) {
    assertEquals((await handleAccountAction(t.deps, "account_name", `Bearer ${JWT}`, null, { name: bad })).status, 400, String(bad));
  }
  assertEquals(t.calls.length, 1, "不合格的名字不呼叫資料庫");
  const nf = fakeDeps({ name: "x", email: null }, { error: "not_found" });
  assertEquals((await handleAccountAction(nf.deps, "account_name", `Bearer ${JWT}`, null, {})).status, 404);
});

Deno.test("asn_account_name 的 SQL：只授權 service_role、security definer、名字 1～40 字不含控制字元", () => {
  const f = fn(mig, "create or replace function public.asn_account_name(");
  assert(f.includes("security definer") && f.includes("set search_path to ''"));
  assert(f.includes("char_length(v_new) not between 1 and 40 or v_new ~ '[[:cntrl:]]'"));
  assert(mig.includes("revoke all on function public.asn_account_name(uuid, text, text) from public, anon, authenticated;"));
  assert(mig.includes("grant execute on function public.asn_account_name(uuid, text, text) to service_role;"));
});
