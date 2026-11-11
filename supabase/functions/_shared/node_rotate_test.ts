import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleNodeRotate, NODE_ROTATE_ACTION } from "./node_rotate.ts";

const ME = { id: "phn1a1" };
const HASH = "ab".repeat(32);
const RID = "00000000-0000-4000-8000-0000000000aa";

type Call = { fn: string; args: Record<string, unknown> };
// deno-lint-ignore no-explicit-any
function mk(answer: any) {
  const calls: Call[] = [];
  const rpc = (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    return Promise.resolve({ data: answer, error: null });
  };
  return { rpc, calls };
}

Deno.test("動作名", () => assertEquals(NODE_ROTATE_ACTION, "node_rotate_key"));

Deno.test("成功：節點取自金鑰，只傳雜湊與 rotation_id", async () => {
  const f = mk({ ok: true });
  const r = await handleNodeRotate(f, ME, { new_hash: HASH, rotation_id: RID, node: "other", p_node: "other" });
  assertEquals(r, { status: 200, body: { ok: true } });
  assertEquals(f.calls, [{ fn: "asn_relay_node_rotate_key", args: { p_node: "phn1a1", p_new_hash: HASH, p_rotation_id: RID } }]);
});

Deno.test("格式不對一律 400，不打資料庫", async () => {
  for (const p of [{}, { new_hash: HASH }, { rotation_id: RID }, { new_hash: HASH.toUpperCase(), rotation_id: RID }, { new_hash: "ab", rotation_id: RID },
    { new_hash: HASH, rotation_id: "nope" }, { new_hash: 5, rotation_id: RID }, { new_hash: HASH, rotation_id: ["x"] }]) {
    const f = mk({ ok: true });
    const r = await handleNodeRotate(f, ME, p as never);
    assertEquals(r.status, 400, JSON.stringify(p));
    assertEquals(f.calls.length, 0);
  }
});

Deno.test("錯誤對應：rate_limited 429、not_found 404、bad_request 400；未知錯誤當 400", async () => {
  for (const [e, s] of [["rate_limited", 429], ["not_found", 404], ["bad_request", 400], ["weird", 400]] as const) {
    const r = await handleNodeRotate(mk({ error: e }), ME, { new_hash: HASH, rotation_id: RID });
    assertEquals(r.status, s, e);
  }
});

Deno.test("資料庫例外：500 internal，log 不含雜湊", async () => {
  const out: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => out.push(a.map(String).join(" "));
  try {
    const rpc = () => Promise.resolve({ data: null, error: { message: "boom " + HASH } });
    const r = await handleNodeRotate({ rpc }, ME, { new_hash: HASH, rotation_id: RID });
    assertEquals(r.status, 500);
  } finally { console.error = orig; }
  assert(!out.join("\n").includes(HASH));
});

Deno.test("守門：index.ts 在節點金鑰認證之後才處理 node_rotate_key，只允許 POST，節點用 me", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  const auth = src.indexOf('db.rpc("asn_relay_auth"');
  const at = src.indexOf("action === NODE_ROTATE_ACTION");
  assert(auth > 0 && at > auth, "要在金鑰認證之後");
  const blk = src.slice(src.indexOf("action === NODE_ROTATE_ACTION"), src.indexOf("action === NODE_ROTATE_ACTION") + 500);
  assert(blk.includes('req.method !== "POST"'));
  assert(blk.includes("handleNodeRotate("));
  assert(blk.includes(", me,"), "節點取自金鑰");
});
