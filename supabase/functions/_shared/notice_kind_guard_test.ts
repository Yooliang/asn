// 通知集中（#848 PR-C）的原始碼守門：信件的 kind 只能由後台通知函式寫入。
//  - 用戶端能呼叫的寄信路徑（relay／irori-relay 的 send、relay_ops 的 send、sendWithPerson、rooms）不得把用戶端帶來的 kind 轉進 RPC 參數；
//  - Edge 程式（非測試）完全不呼叫 asn_relay_send_notice（它沒有授權給任何角色，只給資料庫內的通知函式用）。
import { assert, assertEquals } from "jsr:@std/assert@1";
import { nodeAction } from "./relay_ops.ts";

const FUNCS = new URL("../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, FUNCS)).replace(/\r\n/g, "\n");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");

/** 取出 `<start>` 開頭、到下一個縮排兩格的 `\n  }\n` 為止的區塊 */
function block(src: string, start: string): string {
  const i = src.indexOf(start);
  assert(i >= 0, `找不到 ${start}`);
  return src.slice(i, src.indexOf("\n  }\n", i));
}

function* walk(dir: URL): Generator<URL> {
  for (const e of Deno.readDirSync(dir)) {
    const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) yield* walk(u);
    else if (e.name.endsWith(".ts") && !e.name.endsWith("_test.ts")) yield u;
  }
}

Deno.test("Edge 程式（非測試）不呼叫 asn_relay_send_notice", () => {
  let n = 0;
  for (const f of walk(FUNCS)) {
    n++;
    assert(!Deno.readTextFileSync(f).includes("asn_relay_send_notice"), `${f.pathname} 不該呼叫 asn_relay_send_notice`);
  }
  assert(n > 20);
});

Deno.test("relay／irori-relay 的 send 動作不把 kind 傳進 RPC 參數", () => {
  for (const [file, start] of [
    ["relay/index.ts", 'if (action === "send" && req.method === "POST") {'],
    ["irori-relay/index.ts", 'if (action === "send" && req.method === "POST") {'],
  ] as const) {
    const code = stripComments(block(read(file), start));
    assert(!/\bp_kind\b/.test(code), `${file} send 不該有 p_kind`);
    assert(!/\bkind\b/.test(code), `${file} send 不該碰 kind`);
    assert(!/b\.kind|\.\.\.b\b|\.\.\.raw\b|\.\.\.params\b/.test(code), `${file} send 不該整包展開用戶端內容`);
  }
});

Deno.test("寄信的參數組裝函式與 relay_ops、rooms 不碰 kind", () => {
  const me = stripComments(read("_shared/account_me.ts"));
  for (const name of ["personArgs", "sendWithPerson", "voiceArgs"]) {
    const i = me.indexOf(`function ${name}(`);
    assert(i >= 0, name);
    const body = me.slice(i, me.indexOf("\n}\n", i));
    assert(!/\bkind\b/.test(body), `${name} 不該碰 kind`);
  }
  assert(!/\bkind\b/.test(stripComments(read("_shared/expects_reply.ts"))));
  const ops = stripComments(block(read("_shared/relay_ops.ts"), 'case "send": {'));
  assert(!/\bkind\b/.test(ops), "relay_ops send 不該碰 kind");
  // rooms 的動作寫的是群組訊息表，不經過 asn_relay_send*
  assert(!/asn_relay_send/.test(read("_shared/rooms.ts")));
});

Deno.test("relay_ops 的 send：用戶端帶 kind／p_kind 也不會出現在 RPC 參數", async () => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const deps = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return Promise.resolve({ data: { id: "i1", bell_topic: "t" }, error: null });
    },
    ring: () => Promise.resolve(),
  };
  const r = await nodeAction(deps, { tenant: "T", node: "N" }, "send", {
    to_node: "B", body: "hi", kind: "notice:login", p_kind: "notice:login", from_agent: "ASN 通知",
  });
  assertEquals(r.status, 200);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].fn, "asn_relay_send");
  assert(!("p_kind" in calls[0].args) && !("kind" in calls[0].args));
  assert(!JSON.stringify(calls[0].args).includes("notice:"));
});
