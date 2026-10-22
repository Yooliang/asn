import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ATTACH_KINDS, type AttachDeps, bindAttachments, checkAttachInit, checkThumb, cleanName, handleAttachAction, parseAttachmentIds,
  prepareAttachments, QUOTA_BYTES, QUOTA_COUNT, sweepExpired, type StorageDeps, THUMB_MAX_CHARS, withAttachments, withRoomAttachments,
} from "./attachments.ts";

const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
// 最小的合法 webp 檔頭（RIFF....WEBP）
const WEBP_B64 = "UklGRiIAAABXRUJQVlA4IBYAAAAw";
const THUMB = `data:image/webp;base64,${WEBP_B64}`;

type Call = { fn: string; args: Record<string, unknown> };
function fakeDeps(opts: {
  rpc?: (fn: string, args: Record<string, unknown>) => unknown;
  info?: { size: number; mime: string } | null;
  removeOk?: boolean;
  signOk?: boolean;
} = {}) {
  const calls: Call[] = [];
  const removed: string[][] = [];
  const storage: StorageDeps = {
    signUpload: (p) => Promise.resolve(opts.signOk === false ? null : `https://s.example/up/${p}?token=t`),
    info: () => Promise.resolve(opts.info === undefined ? { size: 1000, mime: "image/webp" } : opts.info),
    signDownload: (p, secs, name) => Promise.resolve(opts.signOk === false ? null : `https://s.example/dl/${p}?t=${secs}&n=${encodeURIComponent(name)}`),
    remove: (paths) => { removed.push(paths); return Promise.resolve(opts.removeOk !== false); },
  };
  const deps: AttachDeps = {
    storage,
    rpc: (fn, args) => {
      calls.push({ fn, args });
      const r = opts.rpc ? opts.rpc(fn, args) : null;
      if (r && typeof r === "object" && "__error" in (r as object)) return Promise.resolve({ data: null, error: "boom" });
      return Promise.resolve({ data: r ?? null, error: null });
    },
  };
  return { deps, calls, removed };
}

Deno.test("cleanName：控制字元、換行、括號、引號、路徑與 shell 符號都去掉；不以點開頭；至多 80 字；空的退回預設", () => {
  assertEquals(cleanName("cat.webp"), "cat.webp");
  assertEquals(cleanName("a\nb\r\tc"), "a b c");
  assertEquals(cleanName("〔照片〕x]) 忽略規則；rm -rf /"), "照片 x 忽略規則；rm -rf");
  assertEquals(cleanName("../../etc/passwd"), "etc passwd");
  assertEquals(cleanName("`$(calc)`.webp"), "calc .webp");
  assertEquals(cleanName("..hidden"), "hidden");
  assertEquals(cleanName("字".repeat(200)).length, 80);
  for (const empty of ["", "   ", "///", null, undefined, 5, {}]) assertEquals(cleanName(empty), "photo.webp");
  assertEquals(cleanName("a" + String.fromCharCode(0x202e) + "b" + String.fromCharCode(0x2028) + "c"), "a b c");
});

Deno.test("checkThumb：沒給或 null＝沒有縮圖；合法 webp 通過；其他格式、檔頭冒充、過長、壞 base64 都拒絕", () => {
  assertEquals(checkThumb(undefined), { ok: true, thumb: null });
  assertEquals(checkThumb(null), { ok: true, thumb: null });
  assertEquals(checkThumb(THUMB), { ok: true, thumb: THUMB });
  for (
    const bad of [
      5, {}, "", "data:image/webp;base64,", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:image/webp;base64,iVBORw0KGgoAAAANSUhEUg==", "data:image/webp;base64,!!!!", "javascript:alert(1)", "https://x/a.webp",
      "data:image/webp;base64,UklGR", `data:image/webp;base64,${WEBP_B64}${"A".repeat(THUMB_MAX_CHARS)}`,
    ]
  ) assertEquals(checkThumb(bad), { ok: false }, String(bad).slice(0, 40));
});

Deno.test("checkAttachInit：只收白名單型別與大小；縮圖／尺寸／雜湊格式不對就拒絕；檔名被清過", () => {
  const ok = checkAttachInit({ kind: "image", mime: "image/webp", name: "貓(1).webp", bytes: 12345, width: 1536, height: 2048, thumb: THUMB, sha256: "a".repeat(64) });
  assert(ok.ok);
  if (ok.ok) {
    assertEquals(ok.value.name, "貓 1 .webp");
    assertEquals([ok.value.width, ok.value.height, ok.value.thumb, ok.value.sha256], [1536, 2048, THUMB, "a".repeat(64)]);
  }
  const min = checkAttachInit({ kind: "image", mime: "image/webp", name: "a.webp", bytes: 1 });
  assert(min.ok && min.value.thumb === null && min.value.width === null && min.value.sha256 === null);
  const base = { kind: "image", mime: "image/webp", name: "a.webp", bytes: 10 };
  const err = (o: Record<string, unknown>) => { const r = checkAttachInit({ ...base, ...o }); return r.ok ? "ok" : r.error; };
  assertEquals(err({ kind: "file" }), "unsupported_type");
  assertEquals(err({ kind: "__proto__" }), "unsupported_type");
  assertEquals(err({ kind: "toString" }), "unsupported_type");
  assertEquals(err({ mime: "image/png" }), "unsupported_type");
  assertEquals(err({ mime: "application/pdf" }), "unsupported_type");
  assertEquals(err({ mime: "image/svg+xml" }), "unsupported_type");
  assertEquals(err({ bytes: ATTACH_KINDS.image.maxBytes + 1 }), "file_too_large");
  assertEquals(err({ bytes: ATTACH_KINDS.image.maxBytes }), "ok");
  for (const b of [0, -1, 1.5, "10", null, NaN]) assertEquals(err({ bytes: b }), "bad_request", String(b));
  assertEquals(err({ width: 0 }), "bad_request");
  assertEquals(err({ height: 1.5 }), "bad_request");
  assertEquals(err({ width: 99999 }), "bad_request");
  assertEquals(err({ thumb: "data:image/png;base64,iVBORw0K" }), "bad_thumb");
  assertEquals(err({ sha256: "xyz" }), "bad_request");
  for (const b of [null, undefined, 5, "x", []]) assertEquals((checkAttachInit(b) as { error: string }).error, "bad_request");
});

Deno.test("checkAttachInit 一般檔案：副檔名在白名單且跟型別對得上才收；25 MB 上限；不能帶縮圖與尺寸；可執行檔與假冒副檔名一律擋", () => {
  const f = (name: string, mime: string, extra: Record<string, unknown> = {}) => checkAttachInit({ kind: "file", mime, name, bytes: 1000, ...extra });
  const okNames: [string, string][] = [
    ["報告.pdf", "application/pdf"], ["a.txt", "text/plain"], ["README.md", "text/markdown"], ["d.json", "application/json"], ["t.csv", "text/csv"],
    ["x.zip", "application/zip"], ["a.DOCX", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["b.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], ["c.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ];
  for (const [n, m] of okNames) assert(f(n, m).ok, n);
  const bad = (name: string, mime: string) => { const r = f(name, mime); return r.ok ? "ok" : r.error; };
  for (const [n, m] of [["a.exe", "application/pdf"], ["a.exe", "application/x-msdownload"], ["a.bat", "text/plain"], ["a.ps1", "text/plain"], ["a.sh", "text/plain"], ["a.js", "text/plain"],
    ["a.pdf", "text/plain"], ["a.txt", "application/pdf"], ["noext", "text/plain"], ["a.pdf.exe", "application/pdf"], ["constructor", "text/plain"], ["a.webp", "image/webp"]]) {
    assertEquals(bad(n, m), "unsupported_type", `${n} ${m}`);
  }
  assertEquals(f("a.zip", "application/zip", { bytes: 25 * 1024 * 1024 }).ok, true);
  assertEquals(bad("a.zip", "application/zip"), "ok");
  const big = f("a.zip", "application/zip", { bytes: 25 * 1024 * 1024 + 1 });
  assert(!big.ok && big.error === "file_too_large");
  assertEquals((f("a.pdf", "application/pdf", { thumb: THUMB }) as { error: string }).error, "bad_request");
  assertEquals((f("a.pdf", "application/pdf", { width: 10 }) as { error: string }).error, "bad_request");
  // 照片仍然只有 5 MB
  assertEquals((checkAttachInit({ kind: "image", mime: "image/webp", name: "a.webp", bytes: 6 * 1024 * 1024 }) as { error: string }).error, "file_too_large");
  // 檔名清理保留副檔名；清完是空的退回「file」（再被副檔名檢查擋掉）
  const r = f("../../a;b.pdf", "application/pdf");
  assert(r.ok && r.value.name === "a b.pdf");
});

Deno.test("parseAttachmentIds：沒給＝空；1～4 個不重複 uuid 通過；其他回 null", () => {
  assertEquals(parseAttachmentIds(undefined), []);
  assertEquals(parseAttachmentIds(null), []);
  assertEquals(parseAttachmentIds([U(1), U(2)]), [U(1), U(2)]);
  assertEquals(parseAttachmentIds([U(1).toUpperCase()]), [U(1)]);
  for (const bad of [[], "x", 5, {}, [U(1), U(1)], ["nope"], [U(1), 5], [U(1), U(2), U(3), U(4), U(5)]]) assertEquals(parseAttachmentIds(bad), null);
});

Deno.test("attach_init：驗證通過才呼叫資料庫；金鑰所屬節點、配額由伺服器端常數帶；回一次性上傳網址", async () => {
  const { deps, calls } = fakeDeps({
    rpc: (fn) => fn === "asn_relay_attach_init" ? { id: U(7), path: "t/H/" + U(7) + ".webp", expires_at: "2026-11-19T00:00:00Z" } : [],
  });
  const r = await handleAttachAction(deps, { id: "H", role: "member" }, "attach_init", { kind: "image", mime: "image/webp", name: "a.webp", bytes: 1000, thumb: THUMB, p_node: "X", owner_node: "X" });
  assertEquals(r.status, 200);
  assertEquals(r.body.id, U(7));
  assertEquals(r.body.upload_url, `https://s.example/up/t/H/${U(7)}.webp?token=t`);
  const init = calls.find((c) => c.fn === "asn_relay_attach_init")!;
  assertEquals(init.args.p_node, "H", "上傳者一律是金鑰所屬節點");
  assertEquals([init.args.p_quota_bytes, init.args.p_quota_count], [QUOTA_BYTES, QUOTA_COUNT]);
  assertEquals(init.args.p_bytes, 1000);
});

Deno.test("attach_init：格式不對不碰資料庫；超大 413、型別 400；配額 413、限流 429、停用節點 403；Storage 失敗 500", async () => {
  const none = fakeDeps();
  assertEquals((await handleAttachAction(none.deps, { id: "H" }, "attach_init", { kind: "image", mime: "image/gif", bytes: 5 })).status, 400);
  assertEquals((await handleAttachAction(none.deps, { id: "H" }, "attach_init", { kind: "image", mime: "image/webp", bytes: 6 * 1024 * 1024 })).status, 413);
  assertEquals(none.calls.length, 0);
  const body = { kind: "image", mime: "image/webp", name: "a.webp", bytes: 5 };
  const st = async (data: unknown, o: { signOk?: boolean } = {}) => (await handleAttachAction(fakeDeps({ rpc: () => data, ...o }).deps, { id: "H" }, "attach_init", body));
  const q = await st({ error: "quota_exceeded", used_bytes: 1, used_count: 2 });
  assertEquals([q.status, q.body.error, q.body.quota_bytes, q.body.quota_count], [413, "quota_exceeded", QUOTA_BYTES, QUOTA_COUNT]);
  assertEquals((await st({ error: "rate_limited" })).status, 429);
  assertEquals((await st({ error: "forbidden" })).status, 403);
  assertEquals((await st({ id: U(1), path: "p", expires_at: "x" }, { signOk: false })).status, 500);
  const e = await handleAttachAction(fakeDeps({ rpc: () => ({ __error: 1 }) }).deps, { id: "H" }, "attach_init", body);
  assertEquals([e.status, e.body.error], [500, "internal"]);
});

Deno.test("attach_commit：已確認直接成功；沒上傳 409；大小型別一致才確認；不符就刪檔並回 400；不是自己的 404", async () => {
  const mk = (peek: unknown, commit: unknown, info?: { size: number; mime: string } | null) => fakeDeps({
    info,
    rpc: (fn, a) => fn === "asn_relay_attach_commit" ? (a.p_bytes === null ? peek : commit) : null,
  });
  const ready = mk({ peek: true, path: "p", status: "ready" }, null);
  assertEquals((await handleAttachAction(ready.deps, { id: "H" }, "attach_commit", { id: U(1) })).status, 200);
  const missing = mk({ peek: true, path: "p", status: "pending" }, null, null);
  assertEquals((await handleAttachAction(missing.deps, { id: "H" }, "attach_commit", { id: U(1) })).status, 409);
  const good = mk({ peek: true, path: "p", status: "pending" }, { ok: true }, { size: 777, mime: "image/webp; charset=x" });
  assertEquals((await handleAttachAction(good.deps, { id: "H" }, "attach_commit", { id: U(1) })).status, 200);
  const c = good.calls.filter((x) => x.fn === "asn_relay_attach_commit")[1];
  assertEquals([c.args.p_bytes, c.args.p_mime, c.args.p_node], [777, "image/webp", "H"]);
  const bad = mk({ peek: true, path: "t/H/x.webp", status: "pending" }, { error: "size_mismatch" }, { size: 9, mime: "image/webp" });
  const r = await handleAttachAction(bad.deps, { id: "H" }, "attach_commit", { id: U(1) });
  assertEquals([r.status, r.body.error], [400, "size_mismatch"]);
  assertEquals(bad.removed, [["t/H/x.webp"]]);
  const other = mk({ error: "not_found" }, null);
  assertEquals((await handleAttachAction(other.deps, { id: "H" }, "attach_commit", { id: U(1) })).status, 404);
  assertEquals((await handleAttachAction(other.deps, { id: "H" }, "attach_commit", { id: "nope" })).status, 400);
});

Deno.test("attach_url：有權限發 300 秒網址；沒權限與不存在都是 404（同一種回應）；過期 410；編號格式不對 400", async () => {
  const ok = fakeDeps({ rpc: () => ({ path: "t/H/a.webp", name: "a.webp", mime: "image/webp", bytes: 5 }) });
  const r = await handleAttachAction(ok.deps, { id: "W" }, "attach_url", { id: U(3) });
  assertEquals(r.status, 200);
  assertEquals([r.body.expires_in, r.body.name, r.body.bytes], [300, "a.webp", 5]);
  assert(String(r.body.url).includes("t=300"));
  assertEquals(ok.calls[0].args, { p_node: "W", p_id: U(3) }, "收件人是金鑰所屬節點，不接受 body 指定");
  const nf = await handleAttachAction(fakeDeps({ rpc: () => ({ error: "not_found" }) }).deps, { id: "W" }, "attach_url", { id: U(3) });
  assertEquals([nf.status, nf.body], [404, { error: "not_found" }]);
  assertEquals((await handleAttachAction(fakeDeps({ rpc: () => ({ error: "expired" }) }).deps, { id: "W" }, "attach_url", { id: U(3) })).status, 410);
  assertEquals((await handleAttachAction(ok.deps, { id: "W" }, "attach_url", { id: "../x" })).status, 400);
  assertEquals((await handleAttachAction(fakeDeps({ rpc: () => ({ path: "p", name: "n", mime: "m", bytes: 1 }), signOk: false }).deps, { id: "W" }, "attach_url", { id: U(3) })).status, 500);
});

Deno.test("attach_sweep：只有 owner 角色節點；清理時先刪檔、成功才記 removed_at；刪檔失敗不記", async () => {
  const rows = [{ id: U(1), path: "a" }, { id: U(2), path: "b" }];
  const f = (removeOk = true) => fakeDeps({ removeOk, rpc: (fn) => fn === "asn_relay_attach_sweep" ? rows : { marked: 2 } });
  assertEquals((await handleAttachAction(f().deps, { id: "H", role: "member" }, "attach_sweep", {})).status, 403);
  const a = f();
  const r = await handleAttachAction(a.deps, { id: "X", role: "owner" }, "attach_sweep", {});
  assertEquals([r.status, r.body.removed], [200, 2]);
  assertEquals(a.removed, [["a", "b"]]);
  assertEquals(a.calls.find((c) => c.fn === "asn_relay_attach_swept")!.args.p_ids, [U(1), U(2)]);
  const b = f(false);
  assertEquals(await sweepExpired(b.deps), 0);
  assertEquals(b.calls.some((c) => c.fn === "asn_relay_attach_swept"), false);
  assertEquals(await sweepExpired(fakeDeps({ rpc: () => [] }).deps), 0);
});

Deno.test("prepareAttachments／bindAttachments：沒附件不碰資料庫；壞編號 400；claim 失敗 400；綁定帶正確目標", async () => {
  const none = fakeDeps();
  assertEquals(await prepareAttachments(none.deps, "H", undefined), { ok: true, ids: [] });
  assertEquals(none.calls.length, 0);
  const bad = await prepareAttachments(none.deps, "H", ["x"]);
  assert(!bad.ok && bad.reply.status === 400);
  const claimBad = await prepareAttachments(fakeDeps({ rpc: () => ({ error: "bad_attachment" }) }).deps, "H", [U(1)]);
  assert(!claimBad.ok && claimBad.reply.status === 400 && claimBad.reply.body.error === "bad_attachment");
  const claimOk = fakeDeps({ rpc: () => ({ ok: true }) });
  assertEquals(await prepareAttachments(claimOk.deps, "H", [U(1)]), { ok: true, ids: [U(1)] });
  assertEquals(claimOk.calls[0].args, { p_node: "H", p_ids: [U(1)] });
  const b1 = fakeDeps({ rpc: () => ({ bound: 1 }) });
  assertEquals(await bindAttachments(b1.deps, "H", [U(1)], { messageId: U(9) }), 1);
  assertEquals(b1.calls[0].args, { p_node: "H", p_ids: [U(1)], p_message_id: U(9), p_room: null, p_seq: null });
  const b2 = fakeDeps({ rpc: () => ({ bound: 1 }) });
  await bindAttachments(b2.deps, "H", [U(1)], { room: "r1", seq: 4 });
  assertEquals(b2.calls[0].args, { p_node: "H", p_ids: [U(1)], p_message_id: null, p_room: "r1", p_seq: 4 });
  assertEquals(await bindAttachments(none.deps, "H", [], { messageId: U(9) }), 0);
  assertEquals(await bindAttachments(fakeDeps({ rpc: () => ({ __error: 1 }) }).deps, "H", [U(1)], { messageId: U(9) }), 0);
});

Deno.test("withAttachments：只給有附件的信加 attachments 欄位（白名單欄位）；沒附件的信原樣；查詢失敗不擋收信", async () => {
  const msgs = [{ id: U(1), body: "a" }, { id: U(2), body: "b" }];
  const rows = [{ message_id: U(2), room_seq: null, id: U(50), kind: "image", name: "p.webp", mime: "image/webp", bytes: 9, width: 1, height: 2, thumb: THUMB, expires_at: "2026-11-19T00:00:00Z", expired: false, secret: "x" }];
  const { deps, calls } = fakeDeps({ rpc: () => rows });
  const out = await withAttachments(deps, msgs);
  assertEquals(out[0], msgs[0]);
  assertEquals(out[1].attachments, [{ id: U(50), kind: "image", name: "p.webp", mime: "image/webp", bytes: 9, width: 1, height: 2, thumb: THUMB, expires_at: "2026-11-19T00:00:00Z", expired: false }]);
  assertEquals(calls[0].args, { p_message_ids: [U(1), U(2)], p_room: null, p_seqs: null });
  assertEquals(await withAttachments(fakeDeps({ rpc: () => ({ __error: 1 }) }).deps, msgs), msgs);
  assertEquals(await withAttachments(none(), []), []);
  function none() { return fakeDeps().deps; }
});

Deno.test("withRoomAttachments：依群組內序號對應", async () => {
  const msgs = [{ seq: 1, body: "a" }, { seq: 2, body: "b" }];
  const rows = [{ message_id: null, room_seq: 2, id: U(60), kind: "image", name: "p.webp", mime: "image/webp", bytes: 9, width: null, height: null, thumb: null, expires_at: "x", expired: true }];
  const { deps, calls } = fakeDeps({ rpc: () => rows });
  const out = await withRoomAttachments(deps, "r1", msgs);
  assertEquals(out[0], msgs[0]);
  assertEquals(out[1].attachments[0].expired, true);
  assertEquals(calls[0].args, { p_message_ids: null, p_room: "r1", p_seqs: [1, 2] });
});

// ---- 下面是「接線」守門：index.ts 是 Deno.serve 入口沒辦法直接 import，這裡讀原始碼確認 ----

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));

Deno.test("relay/index.ts：附件動作在節點驗證之後；send 寄出前驗、寄出後綁、綁完才敲門鈴；inbox 與 room_read 會附帶附件", async () => {
  const src = await read("../relay/index.ts");
  const at = (s: string, from = 0) => src.indexOf(s, from);
  assert(at("ATTACH_ACTIONS.has(action)") > at("asn_relay_auth"), "附件動作要在金鑰驗證之後");
  const send = src.slice(at('action === "send"'), at("// 遠端開視窗"));
  assert(send.includes("prepareAttachments") && send.includes("bindAttachments") && send.includes("ring(t)"));
  assert(send.indexOf("prepareAttachments") < send.indexOf("sendWithPerson("), "先驗附件再寄信");
  assert(send.indexOf("bindAttachments") < send.indexOf("ring(t)"), "先綁再敲門鈴");
  assert(send.includes("me.id"), "綁定與驗證的節點是金鑰所屬節點");
  assertEquals((src.match(/withAttachments\(/g) ?? []).length >= 2, true, "兩種 inbox 都要附帶附件");
  assert(src.includes("withRoomAttachments") && src.includes("beforeRing"));
  assert(src.includes('"attachments"') && src.includes("createSignedUploadUrl") && src.includes("createSignedUrl"));
});

Deno.test("SQL 附件 migration：bucket 私有＋5MB＋只收 webp、限制性政策、RLS、八個函式都收回前端角色只授權 service_role、排程", async () => {
  const sql = await read("../../migrations/20261020000500_attachments.sql");
  assert(sql.includes("'attachments', 'attachments', false, 26214400, array['image/webp'"), "bucket 要私有、25 MB、白名單從 webp 開始");
  for (const m of [ATTACH_KINDS.image.mimes, ATTACH_KINDS.file.mimes].flat()) assert(sql.split("'" + m + "'").length >= 3, `${m} 要同時在 bucket 與表的 check 白名單`);
  assert(ATTACH_KINDS.file.maxBytes === 26214400 && sql.includes("bytes <= 26214400"));
  assert(/as restrictive for all to anon, authenticated/.test(sql));
  assert(sql.includes("alter table relay.attachments enable row level security"));
  const fns = [...sql.matchAll(/create or replace function public\.(irori_relay_attach_\w+)/g)].map((m) => m[1]);
  assertEquals(fns.length, 8);
  for (const f of fns) {
    assert(new RegExp(`revoke all on function public\\.${f}\\(`).test(sql), `${f} 要收回權限`);
    assert(new RegExp(`grant execute on function public\\.${f}\\([^)]*\\) to service_role`).test(sql), `${f} 只授權 service_role`);
  }
  assertEquals((sql.match(/security definer/g) ?? []).length, fns.length);
  assert(!/\bto\s+(anon|authenticated|public)\b/i.test(sql.replaceAll(/revoke[^;]*;/gi, "").replaceAll(/create policy[^;]*;/gi, "")), "不可授權給前端角色");
  assert(sql.includes("'relay-purge-attachments', '27 3 * * *'"));
  assert(sql.includes("interval '30 days'"));
  // 配額與型別在 SQL 與函式兩邊要一致
  assert(sql.includes("bytes <= 5242880") && ATTACH_KINDS.image.maxBytes === 5242880);
  assert(sql.includes("char_length(thumb) <= 12000") && THUMB_MAX_CHARS === 12000);
  assert(sql.includes("char_length(name) <= 80"));
  assert(sql.includes("v_recent >= 30"));
});

Deno.test("SQL 授權：下載只給上傳者、收件節點、群組有效成員；不是這些一律 not_found", async () => {
  const sql = await read("../../migrations/20261020000500_attachments.sql");
  const f = sql.slice(sql.indexOf("irori_relay_attach_access(p_node"), sql.indexOf("-- 清理："));
  assert(f.includes("a.owner_node = p_node"));
  assert(f.includes("m.to_node = p_node"));
  assert(f.includes("rm.left_at is null") && f.includes("split_part(rm.member, '~', 1) = p_node"));
  assert(f.includes("tenant_id is not distinct from v_t"), "限同租戶");
  assert(f.indexOf("v_ok") < f.indexOf("'expired'"), "先判權限再說過期，沒權限的人看不出附件存不存在");
});
