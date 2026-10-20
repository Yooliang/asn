import { assertEquals } from "jsr:@std/assert@1";
import {
  checkTtsRequest, handleTts, TTS_DEFAULT_VOICE, TTS_MAX_CHARS, TTS_VOICES, TtsLimiter, ttsVoicesResponse, type TtsDeps,
} from "./tts.ts";

const env = (m: Record<string, string>) => (k: string) => m[k];
const ON = env({ ASN_EDGE_TTS_URL: "https://worker.example/tts", ASN_EDGE_TTS_SECRET: "s3cret" });

function deps(over: Partial<TtsDeps> = {}): TtsDeps {
  return {
    env: ON,
    fetch: (() => Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))) as typeof fetch,
    now: () => 1_000_000,
    limiter: new TtsLimiter(),
    ...over,
  };
}

Deno.test("tts 請求檢查：預設值、整理文字", () => {
  assertEquals(checkTtsRequest({ text: "  你好\u0007  " }), {
    ok: true, req: { text: "你好", voice: TTS_DEFAULT_VOICE, rate: 0, pitch: 0 },
  });
  assertEquals(checkTtsRequest({ text: "a", voice: "zh-TW-YunJheNeural", rate: -20, pitch: 5 }), {
    ok: true, req: { text: "a", voice: "zh-TW-YunJheNeural", rate: -20, pitch: 5 },
  });
});

Deno.test("tts 請求檢查：壞輸入一律擋下", () => {
  for (const bad of [null, undefined, "x", 5, [], {}, { text: 5 }, { text: "   " }, { text: "\u0001\u0002" }]) {
    assertEquals(checkTtsRequest(bad).ok, false, JSON.stringify(bad));
  }
  assertEquals(checkTtsRequest({ text: "x".repeat(TTS_MAX_CHARS) }).ok, true);
  assertEquals(checkTtsRequest({ text: "x".repeat(TTS_MAX_CHARS + 1) }), { ok: false, status: 413, error: "text_too_long" });
  // 字數用字元算，不是 UTF-16 單位：1000 個表情符號仍算 1000 字
  assertEquals(checkTtsRequest({ text: "😀".repeat(TTS_MAX_CHARS) }).ok, true);
  for (const v of ["", "zh-TW-HsiaoChenNeural'><x/>", "xx-XX-EvilNeural", 5, "eleven:abc", "../x"]) {
    assertEquals(checkTtsRequest({ text: "a", voice: v }), { ok: false, status: 400, error: "bad_voice" }, String(v));
  }
  for (const [rate, pitch] of [[51, 0], [0, -51], [1.5, 0], ["5", 0], [0, "x"]]) {
    assertEquals(checkTtsRequest({ text: "a", rate, pitch }), { ok: false, status: 400, error: "bad_prosody" }, `${rate},${pitch}`);
  }
});

Deno.test("tts 沒設秘密變數：503，而且不呼叫任何外部服務", async () => {
  let called = 0;
  const f = (() => { called++; return Promise.resolve(new Response("x")); }) as typeof fetch;
  for (const e of [env({}), env({ ASN_EDGE_TTS_URL: "https://w/tts" }), env({ ASN_EDGE_TTS_SECRET: "s" })]) {
    const r = await handleTts(deps({ env: e, fetch: f }), "T", { text: "你好" });
    assertEquals(r.status, 503);
    assertEquals(await r.json(), { error: "tts_disabled" });
  }
  assertEquals(called, 0);
});

Deno.test("tts 成功：轉給 Worker 帶秘密標頭，回 audio/mpeg", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const f = ((url: string, init: RequestInit) => {
    seen = { url, init };
    return Promise.resolve(new Response(new Uint8Array([9, 8, 7]), { status: 200 }));
  }) as unknown as typeof fetch;
  const r = await handleTts(deps({ fetch: f }), "T", { text: "你好", voice: "zh-TW-HsiaoYuNeural", rate: 5 });
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("content-type"), "audio/mpeg");
  assertEquals([...new Uint8Array(await r.arrayBuffer())], [9, 8, 7]);
  assertEquals(seen!.url, "https://worker.example/tts");
  const h = seen!.init.headers as Record<string, string>;
  assertEquals(h["x-asn-tts-secret"], "s3cret");
  assertEquals(JSON.parse(seen!.init.body as string), { text: "你好", voice: "zh-TW-HsiaoYuNeural", rate: 5, pitch: 0 });
});

Deno.test("tts Worker 出錯、連不上、回空檔：502 tts_failed，回應不洩漏秘密與 Worker 內文", async () => {
  const cases: Array<() => Promise<Response>> = [
    () => Promise.resolve(new Response("secret s3cret leaked", { status: 502 })),
    () => Promise.resolve(new Response("nope", { status: 401 })),
    () => Promise.reject(new Error("network down s3cret")),
    () => Promise.resolve(new Response(new Uint8Array(0), { status: 200 })),
  ];
  for (const c of cases) {
    const r = await handleTts(deps({ fetch: (() => c()) as typeof fetch }), "T", { text: "你好" });
    assertEquals(r.status, 502);
    const t = await r.text();
    assertEquals(t, JSON.stringify({ error: "tts_failed" }));
  }
});

Deno.test("tts 頻率限制：每分鐘 12 次、每節點各算各的、過一分鐘恢復", async () => {
  const lim = new TtsLimiter(3, 100);
  let t = 0;
  const d = deps({ limiter: lim, now: () => t });
  for (let i = 0; i < 3; i++) assertEquals((await handleTts(d, "A", { text: "x" })).status, 200);
  assertEquals((await handleTts(d, "A", { text: "x" })).status, 429);
  assertEquals((await handleTts(d, "B", { text: "x" })).status, 200, "別的節點不受影響");
  t = 61_000;
  assertEquals((await handleTts(d, "A", { text: "x" })).status, 200, "滿一分鐘後恢復");
});

Deno.test("tts 頻率限制：每小時上限；被拒絕的請求不計次、不呼叫 Worker", async () => {
  const lim = new TtsLimiter(100, 5);
  let calls = 0;
  const f = (() => { calls++; return Promise.resolve(new Response(new Uint8Array([1]), { status: 200 })); }) as typeof fetch;
  let t = 0;
  const d = deps({ limiter: lim, fetch: f, now: () => t });
  for (let i = 0; i < 5; i++) { t = i * 10_000; assertEquals((await handleTts(d, "A", { text: "x" })).status, 200); }
  t = 100_000;
  assertEquals((await handleTts(d, "A", { text: "x" })).status, 429);
  assertEquals(calls, 5);
  // 壞請求在限流之前就被擋，不吃額度
  const lim2 = new TtsLimiter(1, 1);
  assertEquals((await handleTts(deps({ limiter: lim2 }), "A", { text: "" })).status, 400);
  assertEquals((await handleTts(deps({ limiter: lim2 }), "A", { text: "x" })).status, 200);
});

Deno.test("tts_voices：只列白名單聲音，並說明有沒有啟用", async () => {
  const on = await ttsVoicesResponse({ env: ON }).json();
  assertEquals(on.enabled, true);
  assertEquals(on.default, TTS_DEFAULT_VOICE);
  assertEquals(on.voices.map((v: { id: string }) => v.id), Object.keys(TTS_VOICES));
  const off = await ttsVoicesResponse({ env: env({}) }).json();
  assertEquals(off.enabled, false);
});

// relay/index.ts 是 Deno.serve 入口、無法直接 import：守「tts 動作在金鑰驗證之後、用共用邏輯、只傳金鑰所屬節點」
Deno.test("relay/index.ts：tts 動作排在金鑰驗證之後，節點代號取自金鑰（me.id）", async () => {
  const src = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  const auth = src.indexOf("irori_relay_auth");
  const tts = src.indexOf('action === "tts"');
  const voices = src.indexOf('action === "tts_voices"');
  assertEquals(auth > 0 && tts > auth && voices > auth, true, "tts 要在金鑰驗證之後");
  const block = src.slice(tts, tts + 600);
  assertEquals(block.includes("handleTts(") && block.includes("me.id"), true);
  assertEquals(block.includes("b.node") || block.includes("b?.node"), false, "不接受 body 指定節點");
});
