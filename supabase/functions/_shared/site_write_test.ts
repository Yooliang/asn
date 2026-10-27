// 執行：cd supabase/functions && deno test -A _shared/site_write_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkText, handleSiteAction, parseItem, parseMeeting, parseRelease, SITE_ACTIONS } from "./site_write.ts";

type Call = { fn: string; args: Record<string, unknown> };
function fakeDeps(answer: (c: Call) => { data: unknown; error: unknown } = () => ({ data: { ok: true }, error: null })) {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      rpc: (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return Promise.resolve(answer({ fn, args }));
      },
    },
  };
}

const REL = { version: "0.1.96", released_on: "2026-10-28", items: ["新增：`asn site`（#400）"], platforms: ["官網"], commit_sha: "abc1234" };
const MEET = { held_at: "2026-10-28T08:00:00+08:00", attendees: ["主持"], progress: ["x"], decisions: ["無"], assignments: ["無"], improvements: ["無"] };
const ITEM = { item_key: "todo-next-15b", section: "todo", lane: "next", title: "標題", body: "內文", refs: [400], status: "doing" };

Deno.test("SITE_ACTIONS：三個動作", () => {
  assertEquals([...SITE_ACTIONS].sort(), ["site_item_upsert", "site_meeting_add", "site_release_upsert"]);
});

Deno.test("checkText：空白、太長、控制字元 bad；HTML、電子郵件、路徑、金鑰 unsafe；比較符號與小標記 ok", () => {
  assertEquals(checkText("**粗體** `code` #12 延遲 < 5 秒、a<5", 100), "ok");
  assertEquals(checkText("第一行\n- 子項目\t", 100), "ok");
  for (const v of ["", "   ", null, 3, "x".repeat(11), "響\u0007"]) assertEquals(checkText(v, 10), "bad", String(v));
  assertEquals(checkText("中".repeat(10), 10), "ok", "以字元數算");
  for (const v of ["<script>", "</b>", "<!-- x", "a@b.co", "C:\\x", "/home/u", "/Users/u", "~/.asn", "eyJ" + "a".repeat(20), "sk-" + "a".repeat(20), "ghp_" + "a".repeat(20), "service_role"]) {
    assertEquals(checkText(v, 100), "unsafe", v);
  }
});

Deno.test("parseRelease：正常通過且只留約定欄位；更新可只帶部分欄位", () => {
  const r = parseRelease({ ...REL, node: "別人", evil: 1 });
  assert("data" in r);
  assertEquals(r.data, REL);
  assertEquals(parseRelease({ version: "0.1.96", notes: null }), { data: { version: "0.1.96", notes: null } });
  assertEquals(parseRelease({ version: "0.1.96", commit_sha: "" }), { data: { version: "0.1.96", commit_sha: "" } });
});

Deno.test("parseRelease：格式不對指出欄位", () => {
  const bad = (patch: Record<string, unknown>, field: string, error = "bad_request") =>
    assertEquals(parseRelease({ ...REL, ...patch }), { error, field }, JSON.stringify(patch));
  bad({ version: "v0.1" }, "version");
  bad({ version: undefined }, "version");
  bad({ released_on: "2026-02-30" }, "released_on");
  bad({ released_on: "2026/10/28" }, "released_on");
  bad({ items: [] }, "items");
  bad({ items: Array(31).fill("x") }, "items");
  bad({ items: ["x".repeat(1001)] }, "items");
  bad({ items: ["<b>x</b>"] }, "items", "unsafe_content");
  bad({ platforms: Array(11).fill("官網") }, "platforms");
  bad({ commit_sha: "XYZ" }, "commit_sha");
  bad({ notes: "x".repeat(2001) }, "notes");
  bad({ notes: "寄 a@b.co" }, "notes", "unsafe_content");
  assertEquals(parseRelease(null), { error: "bad_request" });
  assertEquals(parseRelease([REL]), { error: "bad_request" });
});

Deno.test("parseMeeting：正常通過；時間要帶時區；五個欄位都要是 1～30 項", () => {
  assertEquals(parseMeeting({ ...MEET, extra: 1 }), { data: MEET });
  assert("data" in parseMeeting({ ...MEET, held_at: "2026-10-28 00:00Z" }));
  const bad = (patch: Record<string, unknown>, field: string, error = "bad_request") =>
    assertEquals(parseMeeting({ ...MEET, ...patch }), { error, field }, JSON.stringify(patch));
  bad({ held_at: "2026-10-28 08:00" }, "held_at");
  bad({ held_at: "2026-10-28T08:00+08" }, "held_at");
  bad({ held_at: 1 }, "held_at");
  bad({ attendees: [] }, "attendees");
  bad({ progress: "x" }, "progress");
  bad({ decisions: ["<i>"] }, "decisions", "unsafe_content");
  bad({ improvements: undefined }, "improvements");
});

Deno.test("parseItem：正常通過；部分更新；格式不對指出欄位", () => {
  assertEquals(parseItem({ ...ITEM, node: "x" }), { data: ITEM });
  assertEquals(parseItem({ item_key: "todo-next-15b", status: "released", version: "0.1.96" }), { data: { item_key: "todo-next-15b", status: "released", version: "0.1.96" } });
  assertEquals(parseItem({ item_key: "a", title: "", version: null }), { data: { item_key: "a", title: "", version: null } });
  const bad = (patch: Record<string, unknown>, field: string, error = "bad_request") =>
    assertEquals(parseItem({ ...ITEM, ...patch }), { error, field }, JSON.stringify(patch));
  bad({ item_key: "Bad" }, "item_key");
  bad({ section: "blog" }, "section");
  bad({ lane: "Next" }, "lane");
  bad({ title: "x".repeat(81) }, "title");
  bad({ title: "兩\n行" }, "title");
  bad({ title: "<b>" }, "title", "unsafe_content");
  bad({ body: "" }, "body");
  bad({ body: "/home/me" }, "body", "unsafe_content");
  bad({ refs: [0] }, "refs");
  bad({ refs: ["1"] }, "refs");
  bad({ refs: [1.5] }, "refs");
  bad({ status: "done" }, "status");
  bad({ version: "next" }, "version");
  bad({ sort_order: -1 }, "sort_order");
  const { lane: _l, ...noLane } = ITEM;
  assertEquals(parseItem(noLane), { error: "bad_request", field: "lane" });
});

Deno.test("handleSiteAction：格式不對不打資料庫", async () => {
  const { deps, calls } = fakeDeps();
  const r = await handleSiteAction(deps, { id: "W1" }, "site_release_upsert", { version: "x" });
  assertEquals(r.status, 400);
  assertEquals(r.body.field, "version");
  assert(r.body.detail.includes("版本"));
  assertEquals(calls.length, 0);
  assertEquals((await handleSiteAction(deps, { id: "W1" }, "site_bogus", {})).status, 400);
});

Deno.test("handleSiteAction：節點一律是金鑰所屬的自己，body 的 node 不採用；回資料庫結果", async () => {
  const { deps, calls } = fakeDeps(() => ({ data: { ok: true, version: "0.1.96", created: true }, error: null }));
  const r = await handleSiteAction(deps, { id: "W1" }, "site_release_upsert", { ...REL, node: "別人", p_node: "別人" });
  assertEquals(r, { status: 200, body: { ok: true, version: "0.1.96", created: true } });
  assertEquals(calls, [{ fn: "asn_relay_site_release_upsert", args: { p_node: "W1", p_release: REL } }]);
  await handleSiteAction(deps, { id: "W1" }, "site_meeting_add", MEET);
  await handleSiteAction(deps, { id: "W1" }, "site_item_upsert", ITEM);
  assertEquals(calls.slice(1).map((c) => [c.fn, Object.keys(c.args)]), [
    ["asn_relay_site_meeting_add", ["p_node", "p_meeting"]],
    ["asn_relay_site_item_upsert", ["p_node", "p_item"]],
  ]);
});

Deno.test("handleSiteAction：資料庫的錯誤代碼轉成狀態碼與中文說明", async () => {
  const run = async (data: unknown, error: unknown = null) =>
    await handleSiteAction(fakeDeps(() => ({ data, error })).deps, { id: "W1" }, "site_item_upsert", ITEM);
  let r = await run({ error: "not_allowed" });
  assertEquals(r.status, 403);
  assert(r.body.detail.includes("名單"));
  r = await run({ error: "rate_limited" });
  assertEquals(r.status, 429);
  r = await run({ error: "bad_lane", field: "lane" });
  assertEquals([r.status, r.body.error, r.body.field], [400, "bad_lane", "lane"]);
  r = await run({ error: "missing_fields", field: "body" });
  assertEquals([r.status, r.body.error], [400, "missing_fields"]);
  assert(r.body.detail.includes("內文"));
  r = await run(null, { message: "boom" });
  assertEquals([r.status, r.body.error], [500, "internal"]);
  r = await run(null);
  assertEquals([r.status, r.body.error], [500, "internal"]);
});
