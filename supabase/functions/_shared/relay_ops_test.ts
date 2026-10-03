import { assert, assertEquals } from "jsr:@std/assert@1";
import { b64u, nodeAction, type OpsDeps, sha256Hex } from "./relay_ops.ts";

// deno-lint-ignore no-explicit-any
type Json = any;
const WHO = { tenant: "ta", node: "XISU" };
const UUID = "11111111-1111-4111-8111-111111111111";

function fake(handlers: Record<string, (args: Record<string, unknown>) => Json>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rung: string[] = [];
  const deps: OpsDeps = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      const h = handlers[fn];
      return Promise.resolve(h ? { data: h(args), error: null } : { data: null, error: { message: "no handler" } });
    },
    ring: (t) => { rung.push(t); return Promise.resolve(); },
  };
  return { deps, calls, rung };
}

Deno.test("send：寄件節點永遠是呼叫端給的角色節點（body 的 from_node 無效）、成功才敲門鈴、錯誤對應狀態碼", async () => {
  const f = fake({ irori_relay_send: () => ({ id: UUID, bell_topic: "bell-x" }) });
  const r = await nodeAction(f.deps, WHO, "send", { to_node: "H", body: "hi", from_node: "evil", from_agent: "希緒", reply_to: "nope" });
  assertEquals([r.status, r.body], [200, { id: UUID }]);
  assertEquals(f.calls[0].args.p_from_node, "XISU");
  assertEquals(f.calls[0].args.p_reply_to, null);
  assertEquals(f.rung, ["bell-x"]);
  assertEquals((await nodeAction(f.deps, WHO, "send", { to_node: 1, body: "x" })).status, 400);
  const rl = fake({ irori_relay_send: () => ({ error: "rate_limited" }) });
  assertEquals((await nodeAction(rl.deps, WHO, "send", { to_node: "H", body: "x" })).status, 429);
  assertEquals(rl.rung, []);
  const un = fake({ irori_relay_send: () => ({ error: "unknown_to_node" }) });
  assertEquals((await nodeAction(un.deps, WHO, "send", { to_node: "H", body: "x" })).body, { error: "unknown_to_node" });
});

Deno.test("list／whoami 用租戶；inbox／ack／sent_status 用節點；ids 要是 uuid", async () => {
  const f = fake({
    irori_relay_list: () => [{ id: "H" }], irori_relay_whoami: () => ({ node: "XISU", bell_topic: "b" }),
    irori_relay_inbox: () => [], irori_relay_ack: () => 1, irori_relay_sent_status: () => [],
  });
  assertEquals((await nodeAction(f.deps, WHO, "list")).body, { members: [{ id: "H" }] });
  assertEquals(f.calls[0].args, { p_tenant: "ta" });
  assertEquals((await nodeAction(f.deps, WHO, "whoami")).body, { node: "XISU", bell_topic: "b" });
  await nodeAction(f.deps, WHO, "inbox");
  assertEquals(f.calls.at(-1)!.args, { p_node: "XISU" });
  assertEquals((await nodeAction(f.deps, WHO, "ack", { ids: [UUID] })).body, { acked: 1 });
  assertEquals((await nodeAction(f.deps, WHO, "ack", { ids: ["x"] })).status, 400);
  assertEquals((await nodeAction(f.deps, WHO, "sent_status", { ids: Array(51).fill(UUID) })).status, 400);
  assertEquals((await nodeAction(f.deps, WHO, "nope")).status, 404);
  const none = fake({ irori_relay_whoami: () => null });
  assertEquals((await nodeAction(none.deps, WHO, "whoami")).status, 401);
});

Deno.test("invite／reissue／update：碼只以雜湊進資料庫；forbidden／not_found 對應 403／404", async () => {
  const f = fake({
    irori_relay_invite: () => ({ expires_at: "2030", prefix: "t2-" }), irori_relay_reissue: () => ({ expires_at: "2030" }), irori_relay_update: () => ({ ok: true }),
  });
  const inv = await nodeAction(f.deps, WHO, "invite", { note: "x" });
  assertEquals(inv.status, 200);
  assertEquals(inv.body.prefix, "t2-");
  assertEquals(f.calls[0].args.p_code_hash, await sha256Hex(inv.body.invite));
  const re = await nodeAction(f.deps, WHO, "reissue", { id: "H" });
  assertEquals(f.calls[1].args.p_code_hash, await sha256Hex(re.body.code));
  assertEquals((await nodeAction(f.deps, WHO, "reissue", { id: "bad id!" })).status, 400);
  assertEquals((await nodeAction(f.deps, WHO, "update", { id: "H", machine: "書房" })).body, { ok: true });
  const nf = fake({ irori_relay_update: () => ({ error: "not_found" }), irori_relay_invite: () => ({ error: "forbidden" }) });
  assertEquals((await nodeAction(nf.deps, WHO, "update", { id: "H", name: "x" })).status, 404);
  assertEquals((await nodeAction(nf.deps, WHO, "invite", {})).status, 403);
});

Deno.test("資料庫錯誤回 500 internal（不外洩細節）；b64u／sha256Hex", async () => {
  const f = fake({});
  const r = await nodeAction(f.deps, WHO, "list");
  assertEquals([r.status, r.body], [500, { error: "internal" }]);
  assert(/^[A-Za-z0-9_-]{32}$/.test(b64u(24)));
  assertEquals(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
