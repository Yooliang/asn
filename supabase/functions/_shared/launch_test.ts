// 執行：SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x deno test -A supabase/functions/
import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleNodeLaunchAction, LAUNCH_NAME_RE, type LaunchDeps, listLaunchers, parseLaunch, requestLaunch, sanitizeLauncher } from "./launch.ts";

type Call = { fn: string; args: Record<string, unknown> };
function fakeDeps(answer: (c: Call) => unknown = () => ({ id: "11111111-1111-1111-1111-111111111111", bell_topic: "bell-H" })) {
  const calls: Call[] = [];
  const rings: string[] = [];
  const deps: LaunchDeps = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      return Promise.resolve({ data: answer({ fn, args }), error: null });
    },
    ring: (t) => {
      rings.push(t);
      return Promise.resolve();
    },
  };
  return { deps, calls, rings };
}
const OK = { node: "H", profile: "default", name: "H-英雄-2", cwd: "D:\\Github\\eiyuu-md" };

Deno.test("視窗名：英數、連字號、中文；不能以連字號開頭、不能有空白引號分號、最多 40 字", () => {
  for (const ok of ["H-英雄-2", "a", "工頭", "X".repeat(40), "9-a"]) assert(LAUNCH_NAME_RE.test(ok), ok);
  for (const bad of ["", "-rf", "--help", "a b", "a;b", "a'b", 'a"b', "a$b", "a`b", "a&b", "a|b", "X".repeat(41), "a/b", "a\\b", "名字\n下一行", "a{b}"]) {
    assert(!LAUNCH_NAME_RE.test(bad), bad);
  }
});

Deno.test("parseLaunch：格式不對在進資料庫前就擋下，第一句話空白當沒有", () => {
  assertEquals(parseLaunch({ ...OK, first_message: "  " }), { ...OK, first_message: null });
  assertEquals(parseLaunch({ ...OK, first_message: " 開始做吧 " }), { ...OK, first_message: "開始做吧" });
  assertEquals(parseLaunch({ ...OK, name: "-x" }), { error: "bad_name" });
  assertEquals(parseLaunch({ ...OK, node: "H;drop" }), { error: "bad_request" });
  assertEquals(parseLaunch({ ...OK, profile: "" }), { error: "bad_profile" });
  assertEquals(parseLaunch({ ...OK, cwd: 3 }), { error: "bad_cwd" });
  assertEquals(parseLaunch({ ...OK, first_message: "x".repeat(4001) }), { error: "bad_first_message" });
  assertEquals(parseLaunch([OK]), { error: "bad_request" });
  // 指令內容不會被帶進請求：多餘的欄位一律丟掉
  assertEquals(parseLaunch({ ...OK, command: "calc.exe", args: ["x"] }), { ...OK, first_message: null });
});

Deno.test("requestLaunch：通過就呼叫 irori_relay_launch（actor 由呼叫端決定）並敲機器門鈴", async () => {
  const { deps, calls, rings } = fakeDeps();
  const r = await requestLaunch(deps, "XISU", { ...OK, first_message: "hi", requested_by: "偽造" });
  assertEquals(r, { status: 200, body: { id: "11111111-1111-1111-1111-111111111111" } });
  assertEquals(calls, [{ fn: "irori_relay_launch", args: { p_actor: "XISU", p_node: "H", p_profile: "default", p_name: "H-英雄-2", p_cwd: OK.cwd, p_first: "hi" } }]);
  assertEquals(rings, ["bell-H"]);
});

Deno.test("requestLaunch：資料庫拒絕時對應狀態碼，不敲門鈴；格式錯不碰資料庫", async () => {
  for (const [code, status] of [["forbidden", 403], ["rate_limited", 429], ["name_taken", 409], ["bad_cwd", 400], ["no_launcher", 409], ["not_found", 404]] as const) {
    const { deps, rings } = fakeDeps(() => ({ error: code }));
    const r = await requestLaunch(deps, "w02", OK);
    assertEquals([r.status, r.body.error], [status, code]);
    assert(typeof r.body.detail === "string" && r.body.detail.length > 0);
    assertEquals(rings, []);
  }
  const { deps, calls } = fakeDeps();
  assertEquals((await requestLaunch(deps, "XISU", { ...OK, name: "a b" })).status, 400);
  assertEquals(calls, []);
});

Deno.test("節點動作：launch_pending／launch_result 只帶自己的節點；result 狀態與 id 要對", async () => {
  const { deps, calls } = fakeDeps(({ fn }) => (fn === "irori_relay_launch_pending" ? [{ id: "x" }] : { ok: true }));
  assertEquals(await handleNodeLaunchAction(deps, { id: "H" }, "launch_pending", { node: "W" }), { status: 200, body: { launches: [{ id: "x" }] } });
  const id = "22222222-2222-2222-2222-222222222222";
  assertEquals((await handleNodeLaunchAction(deps, { id: "H" }, "launch_result", { id, status: "ok", detail: "已開啟", node: "W" })).status, 200);
  assertEquals((await handleNodeLaunchAction(deps, { id: "H" }, "launch_result", { id, status: "taken" })).status, 400);
  assertEquals((await handleNodeLaunchAction(deps, { id: "H" }, "launch_result", { id: "nope", status: "ok" })).status, 400);
  assertEquals(calls, [
    { fn: "irori_relay_launch_pending", args: { p_node: "H" } },
    { fn: "irori_relay_launch_result", args: { p_node: "H", p_id: id, p_status: "ok", p_detail: "已開啟" } },
  ]);
});

Deno.test("節點動作：launch／launchers 用節點自己的身分（owner 與否交給 SQL）", async () => {
  const { deps, calls } = fakeDeps(({ fn }) => (fn === "irori_relay_launch" ? { error: "forbidden" } : { machines: [], launches: [] }));
  assertEquals((await handleNodeLaunchAction(deps, { id: "w02" }, "launch", OK)).status, 403);
  assertEquals((await handleNodeLaunchAction(deps, { id: "w02" }, "launchers", {})).status, 200);
  assertEquals(calls.map((c) => c.args.p_actor), ["w02", "w02"]);
  assertEquals((await handleNodeLaunchAction(deps, { id: "w02" }, "launch_everything", {})).status, 404);
});

Deno.test("listLaunchers：ids 只收 UUID、最多 20 筆", async () => {
  const id = "33333333-3333-3333-3333-333333333333";
  const { deps, calls } = fakeDeps(() => ({ machines: [], launches: [] }));
  assertEquals((await listLaunchers(deps, "XISU", `${id},${id}`)).status, 200);
  assertEquals(calls[0].args.p_ids, [id, id]);
  assertEquals((await listLaunchers(deps, "XISU", "1;drop")).status, 400);
  assertEquals((await listLaunchers(deps, "XISU", Array(21).fill(id))).status, 400);
  assertEquals((await listLaunchers(deps, "XISU")).status, 200);
  assertEquals(calls.at(-1)!.args.p_ids, null);
});

Deno.test("sanitizeLauncher：上傳的摘要只留 id／label／cwd_allow／max_per_hour，指令內容不上雲", () => {
  const raw = {
    profiles: [{ id: "default", label: "一般", command: "powershell.exe", args: ["-Command", "x"] }],
    cwd_allow: ["D:\\Github"], max_per_hour: 6, secret: "k",
  };
  const out = sanitizeLauncher(raw);
  assertEquals(out, { profiles: [{ id: "default", label: "一般" }], cwd_allow: ["D:\\Github"], max_per_hour: 6 });
  assert(!JSON.stringify(out).includes("powershell"));
  assertEquals(sanitizeLauncher(null), null);
  assertEquals(sanitizeLauncher({ profiles: "x" }), { error: "bad_request" });
});
