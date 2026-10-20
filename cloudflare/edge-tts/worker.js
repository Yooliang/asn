// ASN Edge TTS 代理：後端 POST {text, voice, rate, pitch} → audio/mpeg。
// 為什麼要有這支：Supabase Edge Function（AWS）連微軟 Edge TTS 的 WebSocket 一律 403，Cloudflare Workers 出口則連得上。
// 邏輯對應本機版 tts.py（日文假名分段、rate/pitch 單位）與 edge-tts 套件（連線協定）。

import { TRUSTED_CLIENT_TOKEN, generateSecMsGecV2 } from "./drm.js";

// ── 以下常數要跟 Python edge-tts 套件（constants.py，目前對到 7.3.1）同步；微軟改版時先看套件有沒有更新 ──
// Sec-MS-GEC token 的演算法在 drm.js（對到 drm.py）
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split(".")[0];
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`; // 7.3.1 起改成 2-，搭配 v2 token
const WSS_BASE = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"; // Workers 的 fetch 要寫 https，不是 wss
const ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`;
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
// ── 同步區結束 ──

const JA_VOICE = "ja-JP-NanamiNeural";
const MAX_CHARS = 2000;
const MAX_CHUNK_BYTES = 4096; // edge-tts 單次 SSML 文字的位元組上限
const MAX_CHUNKS = 12; // 每個 chunk 一條 WebSocket（子請求），設上限避免被濫用
const WS_TIMEOUT_MS = 60000;
const VOICE_RE = /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z]+Neural$/;

// 平假名、片假名、半形片假名、長音符號、波浪號（同 tts.py）
const KANA = "\\u3040-\\u30FF\\u31F0-\\u31FF\\uFF66-\\uFF9F\\u30FC\\u301C";
const KANA_RUN = new RegExp(`[${KANA}]+`, "g");
const SPEAKABLE = new RegExp(`[\\p{L}\\p{N}_${KANA}]`, "u");

const enc = new TextEncoder();
const dec = new TextDecoder();
const uuid = () => crypto.randomUUID().replace(/-/g, "");
const signed = (n, unit) => `${n >= 0 ? "+" : "-"}${Math.abs(n)}${unit}`; // 對應 Python 的 f"{n:+d}"

async function secretOk(got, want) {
  if (!got || !want) return false;
  const [a, b] = await Promise.all([got, want].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  return crypto.subtle.timingSafeEqual(a, b); // 先雜湊成等長再比，長度也不外洩
}

const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
// 微軟不收控制字元
const stripControl = (s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");

// 切成 [{ja, text}]，只有標點的片段丟掉（同 tts.py split_runs）
function splitRuns(text) {
  const runs = [];
  let pos = 0;
  for (const m of text.matchAll(KANA_RUN)) {
    if (m.index > pos) runs.push({ ja: false, text: text.slice(pos, m.index) });
    runs.push({ ja: true, text: m[0] });
    pos = m.index + m[0].length;
  }
  if (pos < text.length) runs.push({ ja: false, text: text.slice(pos) });
  return runs.filter((r) => SPEAKABLE.test(r.text));
}

// 依 edge-tts 規則切段：已跳脫的文字，每段不超過 limit 位元組，優先在換行／空格切，不切斷 UTF-8 字元與 &...; 實體
function splitByBytes(escaped, limit) {
  const out = [];
  let rest = escaped;
  while (enc.encode(rest).length > limit) {
    // 找出不超過 limit 位元組的最長字元前綴
    let bytes = 0, cut = 0;
    for (const ch of rest) {
      const n = enc.encode(ch).length;
      if (bytes + n > limit) break;
      bytes += n;
      cut += ch.length;
    }
    let split = Math.max(rest.lastIndexOf("\n", cut - 1), rest.lastIndexOf(" ", cut - 1)) + 1;
    if (split <= 0) split = cut;
    // 不要把 &amp; 之類切在中間
    const amp = rest.lastIndexOf("&", split - 1);
    if (amp > 0 && rest.indexOf(";", amp) >= split) split = amp;
    const piece = rest.slice(0, split).trim();
    if (piece) out.push(piece);
    rest = rest.slice(split);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

const jsDate = () => new Date().toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, "$1 $3 $2 $4 $5 GMT+0000 (Coordinated Universal Time)");

// 一段已跳脫的文字 → MP3 bytes（一條 WebSocket）
async function synthChunk(escaped, voice, rate, pitch) {
  const id = uuid();
  const url = `${WSS_BASE}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${id}&Sec-MS-GEC=${generateSecMsGecV2()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
  const resp = await fetch(url, {
    headers: {
      Upgrade: "websocket",
      Origin: ORIGIN,
      "User-Agent": USER_AGENT,
      Pragma: "no-cache",
      "Cache-Control": "no-cache",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: `muid=${uuid().toUpperCase()};`,
    },
  });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`微軟拒絕連線 HTTP ${resp.status}`);
  ws.accept();
  const parts = [];
  try {
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等微軟回應逾時")), WS_TIMEOUT_MS);
      const finish = (fn, v) => { clearTimeout(timer); fn(v); };
      ws.addEventListener("message", (e) => {
        if (typeof e.data === "string") {
          if (e.data.includes("Path:turn.end")) finish(resolve);
          return;
        }
        const b = new Uint8Array(e.data);
        if (b.length < 2) return;
        const hl = (b[0] << 8) | b[1];
        if (dec.decode(b.subarray(2, 2 + hl)).includes("Path:audio") && b.length > 2 + hl) parts.push(b.slice(2 + hl));
      });
      ws.addEventListener("error", () => finish(reject, new Error("WebSocket 錯誤")));
      ws.addEventListener("close", () => finish(resolve));
    });
    const ts = jsDate();
    ws.send(
      `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
      `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`,
    );
    ws.send(
      `X-RequestId:${id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n` + // Z 是微軟 Edge 自己的 bug，照抄
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'>` +
      `<prosody pitch='${pitch}' rate='${rate}' volume='+0%'>${escaped}</prosody></voice></speak>`,
    );
    await done;
  } finally {
    try { ws.close(); } catch { /* 已關 */ }
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  if (!total) throw new Error("微軟沒有回傳聲音");
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// 對應 tts.py _edge：日文假名用日文人聲（音調只套一半），其他用選定人聲，最後接成一段
async function synthesize(text, voice, rateN, pitchN) {
  const runs = splitRuns(text);
  if (!runs.length) runs.push({ ja: false, text });
  const jobs = [];
  for (const r of runs) {
    const v = r.ja ? JA_VOICE : voice;
    const pitch = signed(r.ja ? Math.trunc(pitchN / 2) : pitchN, "Hz");
    for (const piece of splitByBytes(xmlEscape(stripControl(r.text)), MAX_CHUNK_BYTES)) jobs.push({ piece, v, pitch });
  }
  if (jobs.length > MAX_CHUNKS) throw new HttpError(413, "文字太長");
  const rate = signed(rateN, "%");
  const audio = await Promise.all(jobs.map((j) => synthChunk(j.piece, j.v, rate, j.pitch)));
  return new Blob(audio);
}

const plain = (status, msg) => new Response(msg, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export default {
  async fetch(req, env) {
    // 不開 CORS：只給後端呼叫，不處理 OPTIONS
    if (new URL(req.url).pathname !== "/tts") return plain(404, "not found");
    if (req.method !== "POST") return plain(405, "method not allowed");
    if (!(await secretOk(req.headers.get("x-asn-tts-secret"), env.ASN_TTS_SECRET))) return plain(401, "unauthorized");
    try {
      let b;
      try { b = await req.json(); } catch { throw new HttpError(422, "body 不是合法 JSON"); }
      const t = typeof b?.text === "string" ? b.text : "";
      if (!t.trim()) throw new HttpError(422, "text 不能是空的");
      if (t.length > MAX_CHARS) throw new HttpError(413, "文字太長");
      const voice = b.voice ?? "zh-TW-HsiaoYuNeural";
      if (typeof voice !== "string" || !VOICE_RE.test(voice)) throw new HttpError(422, "voice 格式不對");
      const rate = b.rate ?? 0;
      const pitch = b.pitch ?? 0;
      if (!Number.isInteger(rate) || !Number.isInteger(pitch) || Math.abs(rate) > 100 || Math.abs(pitch) > 100) {
        throw new HttpError(422, "rate／pitch 要是整數（rate 單位 %、pitch 單位 Hz）");
      }
      const audio = await synthesize(t, voice, rate, pitch);
      return new Response(audio, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
    } catch (e) {
      if (e instanceof HttpError) return plain(e.status, e.message);
      console.error("synth failed", String(e));
      return plain(502, "語音合成失敗");
    }
  },
};
