// #1752（接 #931／#1126）整條路的守門：Rust 端送出的摘要 → 後台 sanitizeLauncher → 畫面 remoteModelRows。
// 以前兩段各測各的：畫面的測試自己造帶 mode: 'term' 的假資料，後台把 mode 丟掉，所以畫面的過濾在真實資料上永遠不觸發。
// 這支把兩段接起來，輸入的形狀由 relay/asn/src-tauri/src/bridge/launcher.rs 的 TERM_PROFILES 與 summary() 讀出來，不手寫一份剛好會過的資料。
import { assert, assertEquals } from "jsr:@std/assert@1";
import { sanitizeLauncher } from "./launch.ts";
// @ts-ignore 前端的純函式模組，沒有型別宣告
import { remoteModelRows, remoteTermProfile } from "../../../relay/asn/ui/lib/partner-launch-ui.mjs";
// @ts-ignore
import { isTermProfile } from "../../../relay/asn/ui/lib/model-catalog.mjs";

const LAUNCHER_RS = new URL("../../../relay/asn/src-tauri/src/bridge/launcher.rs", import.meta.url);

type P = Record<string, unknown>;

// 從 launcher.rs 讀出 TERM_PROFILES（id, label, 工具, 設定鍵）；讀不到就紅，不退回手寫的值
function termProfilesFromRust(src: string): { id: string; label: string; engine: string }[] {
  const m = src.match(/const TERM_PROFILES[^=]*=\s*\[([^\]]*)\];/);
  assert(m, "launcher.rs 找不到 TERM_PROFILES：這支守門測試要跟著 Rust 端的形狀走");
  const out = [...m[1].matchAll(/\("([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)"\)/g)].map((x) => ({ id: x[1], label: x[2], engine: x[3] }));
  assert(out.length >= 2, "TERM_PROFILES 至少要有 gemini-term 與 grok-term");
  return out;
}

// Rust 端 summary() 實際送出的一般項目：每個都帶 engine 與 mode（window／background）；asn終端的虛擬項目由 Launcher::summary 另外加上 mode: "term"
function summaryShapeFromRust(src: string, term: { id: string; label: string; engine: string }[]) {
  assert(/"engine":\s*if p\.engine\.is_empty\(\)/.test(src) && /"mode":\s*if p\.mode == LaunchMode::Background/.test(src), "launcher.rs summary() 的欄位形狀變了，請同步這支測試");
  assert(/"mode":\s*"term"/.test(src), "launcher.rs 不再替 asn終端的虛擬項目帶 mode: term？");
  const normal: P[] = [
    { id: "claude", label: "Claude", engine: "claude", mode: "window" },
    { id: "default", label: "一般（含 Chrome）", engine: "claude", mode: "window" },
    { id: "gemini", label: "Gemini", engine: "acp", mode: "background" },
    { id: "grok", label: "Grok", engine: "acp", mode: "background" },
    { id: "pi", label: "pi", engine: "pi", mode: "window" },
  ];
  const virt: P[] = term.map((t) => ({ id: t.id, label: t.label, engine: t.engine, mode: "term" }));
  return { profiles: [...normal, ...virt], cwd_allow: ["D:/Github"], max_per_hour: 6 };
}

const LABELS = ["Claude", "一般（含 Chrome）", "Gemini", "Grok", "pi"];

Deno.test("#1752 整條路：Rust 摘要 → 後台 sanitizeLauncher → 畫面 remoteModelRows，過完後台沒有 *-term，asn終端仍找得到", async () => {
  const src = await Deno.readTextFile(LAUNCHER_RS);
  const term = termProfilesFromRust(src);
  const sent = summaryShapeFromRust(src, term);
  assert(sent.profiles.some((p: P) => p.id === "gemini-term" && p.mode === "term"), "送出的資料要含 gemini-term（mode: term）");
  assert(sent.profiles.some((p: P) => p.id === "grok-term" && p.mode === "term"), "送出的資料要含 grok-term（mode: term）");

  const stored = sanitizeLauncher(sent) as { profiles: P[] };
  assert(stored && !("error" in stored), "後台不該拒收 Rust 送的摘要");

  const rows = remoteModelRows(stored) as { label: string; profileId: string }[];
  assertEquals(rows.map((r) => r.label), LABELS);
  assertEquals(rows.filter((r) => /asn終端/.test(r.label) || /-term$/.test(r.profileId)).length, 0, "畫面上不該有 *-term 的獨立項目");

  // 選 Gemini／Grok 的「asn終端（原生 cli）」時，仍找得到那一家的終端項目
  assertEquals(remoteTermProfile(stored, { id: "gemini" }), "gemini-term");
  assertEquals(remoteTermProfile(stored, { id: "grok" }), "grok-term");
  assertEquals(remoteTermProfile(stored, { id: "claude" }), "");
});

Deno.test("#1752 整條路：後台存下來的 *-term 項目，畫面認得它是 asn終端（不論 mode 有沒有被留下）", async () => {
  const src = await Deno.readTextFile(LAUNCHER_RS);
  const sent = summaryShapeFromRust(src, termProfilesFromRust(src));
  const stored = sanitizeLauncher(sent) as { profiles: P[] };
  const terms = stored.profiles.filter((p) => String(p.id).endsWith("-term"));
  assert(terms.length >= 2);
  for (const p of terms) assert(isTermProfile(p), `${p.id} 過了後台之後畫面要認得它是 asn終端`);
});

Deno.test("#2381 整條路：Rust 送的每個 profile 的 engine 過了後台都還在（claude、acp、pi、asn終端的工具名）", async () => {
  const src = await Deno.readTextFile(LAUNCHER_RS);
  const sent = summaryShapeFromRust(src, termProfilesFromRust(src));
  const stored = sanitizeLauncher(sent) as { profiles: P[] };
  assertEquals(stored.profiles.map((p) => p.engine), sent.profiles.map((p) => p.engine));
  assert(stored.profiles.every((p) => typeof p.engine === "string" && p.engine !== ""));
});
