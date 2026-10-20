// 念出訊息（TTS）的後台轉呼叫：節點用金鑰驗證後，把文字交給 Cloudflare Worker（cloudflare/edge-tts）合成，回傳音檔。
// 預設只走 Edge TTS（微軟非公開介面，僅個人用，見 docs/VOICE.md）；ElevenLabs、Gemini 等有授權的服務是後續選項。
// 秘密變數 ASN_EDGE_TTS_URL、ASN_EDGE_TTS_SECRET 兩個都設才啟用；沒設就回 503 tts_disabled，不碰任何外部服務。
// 純邏輯都放這裡好測：relay/index.ts 只負責驗金鑰後把請求交進來。

export const TTS_MAX_CHARS = 1000; // 一次最多念這麼多字（Worker 自己的上限是 2000）
export const TTS_TIMEOUT_MS = 70_000; // 長句 Worker 要等微軟逐段合成
export const TTS_MAX_AUDIO_BYTES = 6 * 1024 * 1024;
export const TTS_DEFAULT_VOICE = "zh-TW-HsiaoChenNeural";

// 可選聲音（只收白名單：Worker 會把 voice 直接放進 SSML，不接受任意字串）
export const TTS_VOICES: Record<string, string> = {
  "zh-TW-HsiaoChenNeural": "曉臻（台灣女聲，成熟）",
  "zh-TW-HsiaoYuNeural": "曉雨（台灣女聲，清亮）",
  "zh-TW-YunJheNeural": "雲哲（台灣男聲）",
  "zh-CN-XiaoxiaoNeural": "曉曉（大陸女聲，溫暖）",
  "zh-CN-XiaoyiNeural": "曉伊（大陸女聲，活潑）",
  "en-US-AriaNeural": "Aria（美式英語女聲）",
};

// 頻率限制：每個節點每分鐘 / 每小時最多幾次。放在函式實例的記憶體裡（實例會被回收、也不跨實例），
// 所以只是「擋住失控迴圈」的第一層；真正的花費上限靠 Cloudflare 與微軟那端。要嚴格計次得另開資料表（需要 migration，這期不做）。
export const TTS_PER_MINUTE = 12;
export const TTS_PER_HOUR = 120;

export class TtsLimiter {
  private hits = new Map<string, number[]>();
  constructor(private perMinute = TTS_PER_MINUTE, private perHour = TTS_PER_HOUR) {}
  /** 允許就記一筆並回 true；超過回 false */
  take(node: string, nowMs: number): boolean {
    const hour = (this.hits.get(node) ?? []).filter((t) => nowMs - t < 3_600_000);
    const minute = hour.filter((t) => nowMs - t < 60_000);
    if (minute.length >= this.perMinute || hour.length >= this.perHour) {
      this.hits.set(node, hour);
      return false;
    }
    hour.push(nowMs);
    this.hits.set(node, hour);
    if (this.hits.size > 2000) { // 防止 Map 無限長大
      for (const [k, v] of this.hits) if (v.every((t) => nowMs - t >= 3_600_000)) this.hits.delete(k);
    }
    return true;
  }
}

export type TtsRequest = { text: string; voice: string; rate: number; pitch: number };
export type TtsCheck = { ok: true; req: TtsRequest } | { ok: false; status: number; error: string };

const isInt = (v: unknown, lim: number): v is number => Number.isInteger(v) && Math.abs(v as number) <= lim;
// 控制字元（保留換行與 tab）拿掉
const stripControl = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");

export function checkTtsRequest(b: unknown): TtsCheck {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, status: 400, error: "bad_request" };
  const o = b as Record<string, unknown>;
  if (typeof o.text !== "string") return { ok: false, status: 400, error: "bad_request" };
  const text = stripControl(o.text).trim();
  if (!text) return { ok: false, status: 400, error: "empty_text" };
  if ([...text].length > TTS_MAX_CHARS) return { ok: false, status: 413, error: "text_too_long" };
  const voice = o.voice === undefined || o.voice === null ? TTS_DEFAULT_VOICE : o.voice;
  if (typeof voice !== "string" || !(voice in TTS_VOICES)) return { ok: false, status: 400, error: "bad_voice" };
  const rate = o.rate ?? 0, pitch = o.pitch ?? 0;
  if (!isInt(rate, 50) || !isInt(pitch, 50)) return { ok: false, status: 400, error: "bad_prosody" };
  return { ok: true, req: { text, voice, rate, pitch } };
}

export type TtsDeps = {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  now: () => number;
  limiter: TtsLimiter;
};

export const ttsEnabled = (env: TtsDeps["env"]) => Boolean(env("ASN_EDGE_TTS_URL") && env("ASN_EDGE_TTS_SECRET"));

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** GET action=tts_voices：有沒有啟用、可選的聲音。不耗合成額度 */
export function ttsVoicesResponse(deps: Pick<TtsDeps, "env">): Response {
  return jsonRes(200, {
    enabled: ttsEnabled(deps.env),
    default: TTS_DEFAULT_VOICE,
    voices: Object.entries(TTS_VOICES).map(([id, label]) => ({ id, label })),
  });
}

/** POST action=tts。node＝金鑰所屬節點（由呼叫端驗證過）；成功回 audio/mpeg，失敗回 JSON 錯誤碼 */
export async function handleTts(deps: TtsDeps, node: string, body: unknown): Promise<Response> {
  const url = deps.env("ASN_EDGE_TTS_URL"), secret = deps.env("ASN_EDGE_TTS_SECRET");
  if (!url || !secret) return jsonRes(503, { error: "tts_disabled" });
  const c = checkTtsRequest(body);
  if (!c.ok) return jsonRes(c.status, { error: c.error });
  if (!deps.limiter.take(node, deps.now())) return jsonRes(429, { error: "rate_limited" });
  try {
    const r = await deps.fetch(url, {
      method: "POST",
      // Cloudflare 會擋某些預設 UA，所以明講
      headers: { "content-type": "application/json", "user-agent": "asn-relay/1.0", "x-asn-tts-secret": secret },
      body: JSON.stringify(c.req),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });
    if (!r.ok) {
      // 只記狀態碼，不記內文與秘密
      console.error("tts worker", r.status);
      await r.body?.cancel();
      return jsonRes(502, { error: "tts_failed" });
    }
    const audio = new Uint8Array(await r.arrayBuffer());
    if (audio.length === 0 || audio.length > TTS_MAX_AUDIO_BYTES) return jsonRes(502, { error: "tts_failed" });
    return new Response(audio, { status: 200, headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  } catch (e) {
    console.error("tts error", (e as Error).name);
    return jsonRes(502, { error: "tts_failed" });
  }
}
