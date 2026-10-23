// 執行：SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x deno test -A supabase/functions/_shared/
// 遠端一次性密碼傳遞（#26 第二期）的守門測試。假值只用於測試：沒有任何真實密碼或金鑰。
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import type { LaunchDeps } from "./launch.ts";
import { handleSecretAction, parseSecretReply, parseSecretRequest } from "./secret_remote.ts";

type Call = { fn: string; args: Record<string, unknown> };
function fakeDeps(answer: (c: Call) => { data?: unknown; error?: unknown } = () => ({ data: { ok: true } })) {
  const calls: Call[] = [];
  const rings: string[] = [];
  const deps: LaunchDeps = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      const a = answer({ fn, args });
      return Promise.resolve({ data: a.data ?? null, error: a.error ?? null });
    },
    ring: (t) => {
      rings.push(t);
      return Promise.resolve();
    },
  };
  return { deps, calls, rings };
}
const USER = "99999999-9999-9999-9999-999999999999";
const ID = "22222222-2222-2222-2222-222222222222";
const PUB = "A".repeat(43);
// 假密文：只是長度與字元集合格的字串
const CIPHER = "FAKEcipher_" + "x".repeat(200);
const REQ = { pub: PUB, program: "git.exe", purpose: "git push 到 github" };

Deno.test("本人設備的動作（待確認、回覆）沒有本人簽章：401，完全不打資料庫", async () => {
  const { deps, calls, rings } = fakeDeps();
  for (const [action, params] of [["secret_pending", {}], ["secret_reply", { id: ID, cipher: CIPHER }], ["secret_reply", { id: ID, deny: true }]] as const) {
    const r = await handleSecretAction(deps, { id: "P" }, action, params, null);
    assertEquals([r.status, r.body.error], [401, "unauthorized"], action);
  }
  assertEquals(calls, []);
  assertEquals(rings, []);
});

Deno.test("有簽章：簽章者的 id 與節點一律取自驗證結果，不收請求內容裡自報的", async () => {
  const { deps, calls } = fakeDeps();
  await handleSecretAction(deps, { id: "P" }, "secret_pending", { p_signed_user: "evil", p_actor: "evil" }, USER);
  assertEquals(calls[0], { fn: "asn_relay_secret_pending", args: { p_actor: "P", p_signed_user: USER } });
  await handleSecretAction(deps, { id: "P" }, "secret_reply", { id: ID, cipher: CIPHER, p_signed_user: "evil", p_actor: "evil" }, USER);
  assertEquals(calls[1].args, { p_actor: "P", p_signed_user: USER, p_id: ID, p_cipher: CIPHER, p_deny: false });
});

Deno.test("請求：節點一律是金鑰所屬的自己，欄位整理過；成功敲本人其他設備的門鈴，回應不含密文", async () => {
  const { deps, calls, rings } = fakeDeps(() => ({ data: { id: ID, expires_at: "2026-10-23T00:00:00Z", bell_topics: ["b1", "b2"], cipher: "不該外洩" } }));
  const r = await handleSecretAction(deps, { id: "CLOUD" }, "secret_request", { ...REQ, node: "evil", ttl: 120, extra: 1 }, null);
  assertEquals(r.status, 200);
  assertEquals(r.body, { id: ID, expires_at: "2026-10-23T00:00:00Z" });
  assertEquals(calls[0].args, { p_node: "CLOUD", p_pub: PUB, p_program: "git.exe", p_purpose: "git push 到 github", p_ttl_seconds: 120 });
  assertEquals(rings, ["b1", "b2"]);
});

Deno.test("格式不對在進資料庫前就擋下（公鑰、說明長度與控制字元、有效期限範圍、密文格式）", async () => {
  assertEquals(parseSecretRequest(REQ), { ...REQ, ttl: 180 });
  for (const bad of [null, [], {}, { ...REQ, pub: "short" }, { ...REQ, pub: "A".repeat(44) }, { ...REQ, pub: "A".repeat(42) + "+" },
    { ...REQ, program: "" }, { ...REQ, program: "x".repeat(81) }, { ...REQ, program: "a\nb" }, { ...REQ, purpose: "x".repeat(201) },
    { ...REQ, purpose: "a‮b" }, { ...REQ, ttl: 29 }, { ...REQ, ttl: 601 }, { ...REQ, ttl: 1.5 }, { ...REQ, ttl: "180" }]) {
    assert("error" in parseSecretRequest(bad), JSON.stringify(bad));
  }
  assertEquals(parseSecretReply({ id: ID, deny: true, cipher: CIPHER }), { id: ID, cipher: null, deny: true });
  for (const bad of [{ id: "x", cipher: CIPHER }, { id: ID }, { id: ID, cipher: "short" }, { id: ID, cipher: "x".repeat(2049) }, { id: ID, cipher: "有中文" + "x".repeat(200) },
    { id: ID, cipher: CIPHER, deny: "yes" }]) {
    assert("error" in parseSecretReply(bad), JSON.stringify(bad));
  }
  const { deps, calls } = fakeDeps();
  const r = await handleSecretAction(deps, { id: "P" }, "secret_reply", { id: ID, cipher: "short" }, USER);
  assertEquals([r.status, r.body.error], [400, "bad_cipher"]);
  assertEquals(calls, []);
});

Deno.test("後台判定的錯誤對應成狀態碼：過期 410、重複回覆 409、不是本人 403、找不到 404", async () => {
  for (const [code, status] of [["expired", 410], ["already_answered", 409], ["forbidden", 403], ["not_found", 404], ["not_owned", 409]] as const) {
    const { deps, rings } = fakeDeps(() => ({ data: { error: code } }));
    const r = await handleSecretAction(deps, { id: "P" }, "secret_reply", { id: ID, cipher: CIPHER }, USER);
    assertEquals([r.status, r.body.error], [status, code]);
    assertEquals(rings, [], "失敗不敲門鈴");
  }
});

Deno.test("取回答：只傳請求編號與自己的節點；回應原樣轉出（密文只在這裡出現）", async () => {
  const { deps, calls } = fakeDeps(() => ({ data: { status: "answered", cipher: CIPHER } }));
  const r = await handleSecretAction(deps, { id: "CLOUD" }, "secret_fetch", { id: ID, p_node: "evil" }, null);
  assertEquals(r.body, { status: "answered", cipher: CIPHER });
  assertEquals(calls[0], { fn: "asn_relay_secret_fetch", args: { p_node: "CLOUD", p_id: ID } });
  assertEquals((await handleSecretAction(deps, { id: "CLOUD" }, "secret_fetch", { id: "../x" }, null)).status, 400);
});

Deno.test("守門：資料庫出錯時 log 只有函式名與錯誤代碼，不含密文、公鑰、說明（約束違反的 detail 會帶整列資料）", async () => {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  try {
    const err = { code: "23514", message: "check violation", details: `Failing row contains (${CIPHER}, ${PUB}, git push)` };
    const { deps } = fakeDeps(() => ({ error: err }));
    const a = await handleSecretAction(deps, { id: "P" }, "secret_reply", { id: ID, cipher: CIPHER }, USER);
    const b = await handleSecretAction(deps, { id: "P" }, "secret_request", REQ, null);
    const c = await handleSecretAction(deps, { id: "P" }, "secret_fetch", { id: ID }, null);
    for (const r of [a, b, c]) assertEquals([r.status, r.body.error], [500, "internal"]);
  } finally {
    console.error = orig;
  }
  assert(logged.length >= 3, "出錯時要有記錄");
  const all = logged.join("\n");
  assertFalse(all.includes(CIPHER) || all.includes(PUB) || all.includes("git push"), "log 洩漏了內容：" + all);
});

Deno.test("守門：原始碼裡沒有任何一行 console 輸出請求內容或整個錯誤物件；relay/index.ts 的密碼區塊也沒有 log", async () => {
  const src = await Deno.readTextFile(new URL("./secret_remote.ts", import.meta.url));
  const lines = src.split("\n").filter((l) => /console\./.test(l) && !/^\s*\/\//.test(l));
  assertEquals(lines.length, 1, "只准有一行 console（記函式名與錯誤代碼）：" + lines.join("|"));
  assert(/console\.error\(fn, typeof code === "string" \? code : "error"\)/.test(lines[0]), lines[0]);
  const idx = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  const start = idx.indexOf("if (action && SECRET_ACTIONS.has(action))");
  const block = idx.slice(start, idx.indexOf("遠端切換 Claude 帳號", start));
  assert(start > 0 && block.length > 100);
  assertFalse(/console\./.test(block), "密碼區塊不可 log");
});

Deno.test("守門：密碼區塊不把請求內容放進 ring（門鈴只帶主題，不帶內文）與資料庫以外的地方", async () => {
  const src = await Deno.readTextFile(new URL("./secret_remote.ts", import.meta.url));
  const rings = [...src.matchAll(/deps\.ring\(([^)]*)\)/g)].map((m) => m[1]);
  assertEquals(rings, ["t", "r.data.bell_topic"]);
});
