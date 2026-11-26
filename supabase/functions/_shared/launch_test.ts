// 執行：SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x deno test -A supabase/functions/
import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleNodeLaunchAction, LAUNCH_NAME_RE, type LaunchDeps, listLaunchers, parseLaunch, requestLaunch, sanitizeLauncher, sanitizePiModels } from "./launch.ts";

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
const OUT = { ...OK, pi_provider: null, pi_model: null };   // 沒帶經 pi 的提供者與模型（D2）＝兩個都是 null

Deno.test("視窗名：英數、連字號、中文；不能以連字號開頭、不能有空白引號分號、最多 40 字", () => {
  for (const ok of ["H-英雄-2", "a", "工頭", "X".repeat(40), "9-a"]) assert(LAUNCH_NAME_RE.test(ok), ok);
  for (const bad of ["", "-rf", "--help", "a b", "a;b", "a'b", 'a"b', "a$b", "a`b", "a&b", "a|b", "X".repeat(41), "a/b", "a\\b", "名字\n下一行", "a{b}"]) {
    assert(!LAUNCH_NAME_RE.test(bad), bad);
  }
});

Deno.test("parseLaunch：格式不對在進資料庫前就擋下，第一句話空白當沒有", () => {
  assertEquals(parseLaunch({ ...OK, first_message: "  " }), { ...OUT, first_message: null });
  assertEquals(parseLaunch({ ...OK, first_message: " 開始做吧 " }), { ...OUT, first_message: "開始做吧" });
  assertEquals(parseLaunch({ ...OK, name: "-x" }), { error: "bad_name" });
  assertEquals(parseLaunch({ ...OK, node: "H;drop" }), { error: "bad_request" });
  assertEquals(parseLaunch({ ...OK, profile: "" }), { error: "bad_profile" });
  assertEquals(parseLaunch({ ...OK, cwd: 3 }), { error: "bad_cwd" });
  assertEquals(parseLaunch({ ...OK, first_message: "x".repeat(4001) }), { error: "bad_first_message" });
  assertEquals(parseLaunch([OK]), { error: "bad_request" });
  // 指令內容不會被帶進請求：多餘的欄位一律丟掉
  assertEquals(parseLaunch({ ...OK, command: "calc.exe", args: ["x"] }), { ...OUT, first_message: null });
});

Deno.test("requestLaunch：通過就呼叫 irori_relay_launch（actor 由呼叫端決定）並敲機器門鈴", async () => {
  const { deps, calls, rings } = fakeDeps();
  const r = await requestLaunch(deps, "XISU", { ...OK, first_message: "hi", requested_by: "偽造" });
  assertEquals(r, { status: 200, body: { id: "11111111-1111-1111-1111-111111111111" } });
  assertEquals(calls, [{ fn: "asn_relay_launch", args: { p_actor: "XISU", p_node: "H", p_profile: "default", p_name: "H-英雄-2", p_cwd: OK.cwd, p_first: "hi" } }]);
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
  const { deps, calls } = fakeDeps(({ fn }) => (fn === "asn_relay_launch_pending" ? [{ id: "x" }] : { ok: true }));
  assertEquals(await handleNodeLaunchAction(deps, { id: "H" }, "launch_pending", { node: "W" }), { status: 200, body: { launches: [{ id: "x" }] } });
  const id = "22222222-2222-2222-2222-222222222222";
  assertEquals((await handleNodeLaunchAction(deps, { id: "H" }, "launch_result", { id, status: "ok", detail: "已開啟", node: "W" })).status, 200);
  assertEquals((await handleNodeLaunchAction(deps, { id: "H" }, "launch_result", { id, status: "taken" })).status, 400);
  assertEquals((await handleNodeLaunchAction(deps, { id: "H" }, "launch_result", { id: "nope", status: "ok" })).status, 400);
  assertEquals(calls, [
    { fn: "asn_relay_launch_pending", args: { p_node: "H" } },
    { fn: "asn_relay_launch_result", args: { p_node: "H", p_id: id, p_status: "ok", p_detail: "已開啟" } },
  ]);
});

Deno.test("節點動作：launch／launchers 用節點自己的身分（owner 與否交給 SQL）", async () => {
  const { deps, calls } = fakeDeps(({ fn }) => (fn === "asn_relay_launch" ? { error: "forbidden" } : { machines: [], launches: [] }));
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

Deno.test("#1752 sanitizeLauncher：mode 只收 term／background／window，其餘丟掉", () => {
  // 30家用（launcher.rs 的 summary）實際送的形狀：asn終端的虛擬項目帶 engine 與 mode
  const raw = {
    profiles: [
      { id: "claude", label: "Claude" },
      { id: "gemini-term", label: "Gemini（asn終端）", engine: "agy", mode: "term" },
      { id: "bg", label: "背景", mode: "background" },
      { id: "w", label: "視窗", mode: "window" },
      { id: "x", label: "亂來", mode: "rm -rf" },
      { id: "y", label: "非字串", mode: 5 },
    ],
    cwd_allow: ["D:\Github"], max_per_hour: 6,
  };
  const out = sanitizeLauncher(raw) as { profiles: Record<string, unknown>[] };
  assertEquals(out.profiles, [
    { id: "claude", label: "Claude" },
    { id: "gemini-term", label: "Gemini（asn終端）", engine: "agy", mode: "term" },
    { id: "bg", label: "背景", mode: "background" },
    { id: "w", label: "視窗", mode: "window" },
    { id: "x", label: "亂來" },
    { id: "y", label: "非字串" },
  ]);
});

Deno.test("#2381 sanitizeLauncher：profile 的 engine 只收小寫英數與 . _ -（最長 30），其餘丟掉；指令內容照舊不上雲", () => {
  const raw = {
    profiles: [
      { id: "a", label: "A", engine: "claude", command: "powershell.exe" },
      { id: "b", label: "B", engine: "acp" },
      { id: "c", label: "C", engine: "pi" },
      { id: "d", label: "D", engine: "codex" },
      { id: "e", label: "E", engine: "agy", mode: "term" },
      { id: "f", label: "F", engine: "Claude" },
      { id: "g", label: "G", engine: "rm -rf" },
      { id: "h", label: "H", engine: "-x" },
      { id: "i", label: "I", engine: "x".repeat(31) },
      { id: "j", label: "J", engine: 5 },
      { id: "k", label: "K", engine: "" },
    ],
    cwd_allow: [],
  };
  const out = sanitizeLauncher(raw) as { profiles: Record<string, unknown>[] };
  assertEquals(out.profiles.map((p) => p.engine), ["claude", "acp", "pi", "codex", "agy", undefined, undefined, undefined, undefined, undefined, undefined]);
  assert(!JSON.stringify(out).includes("powershell"));
});

const MV = (vendor: string, extra: Record<string, unknown> = {}) => ({ vendor, status: "ok", models: [{ id: "gpt-6-luna", name: "GPT-6 Luna" }], ...extra });
const launcherModels = (models: unknown) => (sanitizeLauncher({ profiles: [], cwd_allow: [], models }) as Record<string, unknown>).models as Record<string, unknown>[] | undefined;

Deno.test("#2353 sanitizeModels：廠牌、status、code、stale、age_s 的白名單；reason 與其他欄位不收", () => {
  const out = launcherModels([{ vendor: "gemini", status: "ok", stale: true, code: "timeout", age_s: 1260, reason: "原文 C:\\Users\\x", path: "C:/x", models: [{ id: "g1", name: "G1", extra: 1 }] }])!;
  assertEquals(out, [{ vendor: "gemini", status: "ok", stale: true, code: "timeout", age_s: 1260, models: [{ id: "g1", name: "G1" }] }]);
  assert(!JSON.stringify(out).includes("原文"));
  for (const status of ["ok", "unavailable", "error", "pending"]) assertEquals(launcherModels([{ vendor: "v", status }])![0].status, status);
  for (const code of ["ok", "not_installed", "not_logged_in", "timeout", "too_large", "parse_failed", "spawn_failed", "unsupported"]) assertEquals(launcherModels([{ vendor: "v", status: "error", code }])![0].code, code);
  assertEquals(launcherModels([{ vendor: "v", status: "pending" }]), [{ vendor: "v", status: "pending", models: [] }]);
  // 不合格的整家丟掉，其餘照存
  const bad = [
    "x", null, 5, [], MV("Bad"), MV("1x"), MV("x".repeat(21)), MV("a b"),
    MV("a", { status: "weird" }), MV("a", { status: 3 }), MV("a", { stale: "yes" }), MV("a", { code: "rm -rf" }), MV("a", { code: 5 }),
    MV("a", { age_s: -1 }), MV("a", { age_s: 1.5 }), MV("a", { age_s: "3" }), MV("a", { models: "nope" }),
    MV("good"),
  ];
  assertEquals(launcherModels(bad)!.map((v) => v.vendor), ["good"]);
});

Deno.test("#2353 sanitizeModels：vendor 去重留先出現（且合格）的、最多 8 家、每家最多 200 筆", () => {
  assertEquals(launcherModels([MV("codex", { status: "pending" }), MV("codex", { status: "ok" })])!.map((v) => v.status), ["pending"]);
  assertEquals(launcherModels([MV("codex", { status: "weird" }), MV("codex", { status: "ok" })])!.map((v) => v.status), ["ok"], "不合格的不佔位");
  assertEquals(launcherModels(Array.from({ length: 10 }, (_, i) => MV(`v${i}`)))!.length, 8);
  const many = launcherModels([MV("pi", { models: Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, name: `M${i}` })) })])!;
  assertEquals((many[0].models as unknown[]).length, 200);
});

Deno.test("#2353 sanitizeModels：型號走統一規則；name 1～80 字、不含控制字元與格式字元；壞筆丟掉其他照存", () => {
  const names = ["a\u0001b", "a\u007fb", "a\u0085b", "a\nb", "a\u200bb", "a\u202eb", "a\ufeffb", "a\u00adb", "a\u2066b", "a\u{e0041}b", "", "N".repeat(81)];
  const models = [
    { id: "-x", name: "x" }, { id: "a//b", name: "x" }, { id: "a/..", name: "x" }, { id: "a b", name: "x" }, { id: 5, name: "x" }, { id: "ok0" }, { id: "ok1", name: 3 }, "z", null,
    ...names.map((n, i) => ({ id: `n${i}`, name: n })),
    { id: "openrouter/meta/llama-3", name: "中文 Name (v1)" }, { id: "ok5", name: "N".repeat(80) },
  ];
  const out = launcherModels([MV("v", { models })])![0].models as { id: string }[];
  assertEquals(out.map((m) => m.id), ["openrouter/meta/llama-3", "ok5"]);
});

Deno.test("#2353 sanitizeLauncher：models 緊湊序列化超過 24000 bytes 就丟掉整個 models，並 console.warn；其餘照存", () => {
  const warns: unknown[][] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a); };
  try {
    const huge = [MV("codex", { models: Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`.padEnd(99, "x"), name: "N".repeat(80) })) })];
    const out = sanitizeLauncher({ profiles: [{ id: "a", label: "A" }], cwd_allow: ["D:/x"], max_per_hour: 6, models: huge }) as Record<string, unknown>;
    assertEquals("models" in out, false);
    assertEquals(out.cwd_allow, ["D:/x"]);
    assertEquals(warns.length, 1);
    // 剛好不超過：留下
    const fit = [MV("codex", { models: Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`.padEnd(99, "x"), name: "N".repeat(80) })) })];
    assert(new TextEncoder().encode(JSON.stringify(fit)).length < 24000);
    assertEquals((sanitizeLauncher({ profiles: [], cwd_allow: [], models: fit }) as Record<string, unknown>).models, fit);
    assertEquals(warns.length, 1);
  } finally {
    console.warn = orig;
  }
});

Deno.test("#2353 sanitizeLauncher：沒帶 models 或不是陣列時輸出沒有該鍵；空陣列存空陣列（有回報但沒有可用的）", () => {
  const base = { profiles: [], cwd_allow: [] };
  assertEquals("models" in (sanitizeLauncher(base) as Record<string, unknown>), false);
  assertEquals("models" in (sanitizeLauncher({ ...base, models: "x" }) as Record<string, unknown>), false);
  assertEquals((sanitizeLauncher({ ...base, models: [] }) as Record<string, unknown>).models, []);
});

Deno.test("#2353 sanitizePiModels：改用統一型號規則，a//b、a/.. 被丟掉", () => {
  assertEquals(sanitizePiModels([{ provider: "a//b", model: "x" }, { provider: "p", model: "a/.." }, { provider: "openrouter", model: "meta/llama-3" }]), [{ provider: "openrouter", model: "meta/llama-3" }]);
});

Deno.test("本人簽章：有簽章才帶 p_signed_user（launch、launchers）；沒簽章與以前完全相同（不多帶任何參數）", async () => {
  const USER = "22222222-2222-2222-2222-222222222222";
  const a = fakeDeps();
  assertEquals((await handleNodeLaunchAction(a.deps, { id: "P1" }, "launch", OK, USER)).status, 200);
  assertEquals(a.calls[0].fn, "asn_relay_launch");
  assertEquals(a.calls[0].args.p_signed_user, USER);
  assertEquals(a.calls[0].args.p_actor, "P1", "actor 仍是金鑰所屬的節點，簽章只是證明這個節點是本人的");
  const b = fakeDeps();
  await handleNodeLaunchAction(b.deps, { id: "H" }, "launch", OK);
  assert(!("p_signed_user" in b.calls[0].args), "沒簽章不帶參數：還沒套 migration 的資料庫、舊呼叫端照舊");
  const c = fakeDeps(() => ({ machines: [], launches: [] }));
  assertEquals((await handleNodeLaunchAction(c.deps, { id: "P1" }, "launchers", { ids: null }, USER)).status, 200);
  assertEquals(c.calls[0].args.p_signed_user, USER);
  const d = fakeDeps(() => ({ machines: [], launches: [] }));
  await handleNodeLaunchAction(d.deps, { id: "H" }, "launchers", {});
  assert(!("p_signed_user" in d.calls[0].args));
  // 機器橋取待辦、回報結果的動作不受簽章影響
  const e = fakeDeps(() => []);
  await handleNodeLaunchAction(e.deps, { id: "H" }, "launch_pending", {}, USER);
  assert(!("p_signed_user" in e.calls[0].args));
});

Deno.test("本人簽章：資料庫回 forbidden（簽章的人不擁有這個節點）時，照樣 403，不敲門鈴", async () => {
  const { deps, rings } = fakeDeps(() => ({ error: "forbidden" }));
  const r = await handleNodeLaunchAction(deps, { id: "P1" }, "launch", OK, "33333333-3333-3333-3333-333333333333");
  assertEquals(r.status, 403);
  assertEquals(rings.length, 0);
});

Deno.test("migration：launch／launchers 的擁有者判定＝role=owner 或 簽章的人擁有這個節點（舊的 owner 規則不變）", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20261022070000_launch_signed.sql", import.meta.url));
  assert(/drop function if exists public\.irori_relay_launch\(text, text, text, text, text, text\)/i.test(sql));
  assert(/drop function if exists public\.irori_relay_launchers\(text, uuid\[\]\)/i.test(sql));
  assert((sql.match(/role = 'owner' or public\.asn_user_owns_node\(p_signed_user, p_actor\)/g) ?? []).length === 2, "兩個函式都要這個判定");
  assert(/p_signed_user uuid default null/i.test(sql));
  assert(/grant execute on function public\.irori_relay_launch\(text, text, text, text, text, text, uuid\) to service_role/i.test(sql));
  assert(!/to (anon|authenticated|public)/i.test(sql), "只授權 service_role");
});

Deno.test("啟動設定摘要的 pi_models（#443／#444）：只留 provider／model、格式不合的丟掉不整份拒收、最多 200 筆；沒帶就不加", () => {
  const base = { profiles: [{ id: "pi", label: "Pi" }], cwd_allow: ["C:/x"] };
  const l = sanitizeLauncher({ ...base, pi_models: [
    { provider: "minimax", model: "MiniMax-M3.1-Flash", secret: "不該留" },
    { provider: "-bad", model: "x" }, { provider: "a b", model: "x" }, { provider: "openai-codex", model: 5 }, "壞", null,
    { provider: "openai-codex", model: "gpt-6" },
  ] }) as Record<string, unknown>;
  assertEquals(l.pi_models, [{ provider: "minimax", model: "MiniMax-M3.1-Flash" }, { provider: "openai-codex", model: "gpt-6" }]);
  const many = sanitizeLauncher({ ...base, pi_models: Array.from({ length: 300 }, (_, i) => ({ provider: "p", model: `m${i}` })) }) as Record<string, unknown>;
  assertEquals((many.pi_models as unknown[]).length, 200);
  assertEquals("pi_models" in (sanitizeLauncher(base) as Record<string, unknown>), false, "舊的電腦端不帶：不加這個欄位");
  assertEquals("pi_models" in (sanitizeLauncher({ ...base, pi_models: "x" }) as Record<string, unknown>), false);
  assertEquals("pi_models" in (sanitizeLauncher({ ...base, pi_models: [{ provider: "-", model: "-" }] }) as Record<string, unknown>), false, "全部不合格：不加");
});

Deno.test("parseLaunch：經 pi 的提供者與模型（D2）選填、要一起給、格式照 piModelWire；舊版不帶就是 null", () => {
  assertEquals(parseLaunch({ ...OK, profile: "pi", pi_provider: "minimax", pi_model: "MiniMax-M3.1-Flash" }), { ...OK, profile: "pi", first_message: null, pi_provider: "minimax", pi_model: "MiniMax-M3.1-Flash" });
  assertEquals(parseLaunch({ ...OK }), { ...OUT, first_message: null }, "舊版手機不帶：兩個都是 null");
  for (const bad of [{ pi_provider: "minimax" }, { pi_model: "x" }, { pi_provider: "-x", pi_model: "y" }, { pi_provider: "a b", pi_model: "y" }, { pi_provider: "a", pi_model: "y:z" }, { pi_provider: "a", pi_model: "x".repeat(51) }, { pi_provider: 3, pi_model: "y" }]) {
    assertEquals(parseLaunch({ ...OK, ...bad }), { error: "bad_pi_model" }, JSON.stringify(bad));
  }
});

Deno.test("requestLaunch：帶了經 pi 才呼叫 9 參數的新版本；沒帶照舊呼叫原本的（參數一個都不多）", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const deps = { rpc: (fn: string, a: Record<string, unknown>) => { calls.push([fn, a]); return Promise.resolve({ data: { id: "i", bell_topic: "t" }, error: null }); }, ring: () => Promise.resolve() } as unknown as LaunchDeps;
  await requestLaunch(deps, "P", { ...OK });
  assertEquals(Object.keys(calls[0][1]).sort(), ["p_actor", "p_cwd", "p_first", "p_name", "p_node", "p_profile"]);
  await requestLaunch(deps, "P", { ...OK, profile: "pi", pi_provider: "minimax", pi_model: "M3" }, "u1");
  assertEquals(calls[1][1].p_pi_provider, "minimax");
  assertEquals(calls[1][1].p_pi_model, "M3");
  assertEquals(calls[1][1].p_signed_user, "u1");
  await requestLaunch(deps, "P", { ...OK, profile: "pi", pi_provider: "minimax", pi_model: "M3" });
  assertEquals(calls[2][1].p_signed_user, null, "9 參數版本沒有預設值：沒簽章也要明確帶 null");
});
