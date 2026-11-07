// 寄件名保留字檢查：名字進資料庫的其他路徑（名單、夥伴、改名、顯示名、在線回報、開視窗、帳號名稱）都有接上。
// 檢查本身在 reserved_sender.ts（reserved_sender_test.ts 測各種寫法）。
import { assertEquals } from "jsr:@std/assert@1";
import { parseSelfName } from "./node_name.ts";
import { parseAsnPresence } from "./asn_presence.ts";
import { parseWindowRename, renamesFromRoster } from "./window_rename.ts";
import { normalizeRosterAgents } from "./roster.ts";
import { parsePartnerSync, parseSucceed } from "./partners.ts";
import { parseLaunch } from "./launch.ts";
import { parsePartnerOp } from "./partner_ops.ts";
import { cleanDisplayName } from "./account.ts";

const RESERVED = ["ASN 通知", "登入通知收發室", "ASN-通知", "A\u200bSN通知", "收發室。"];

Deno.test("節點顯示名（set_name）與在線回報的視窗名：保留的名字回 null；自己節點的預設橋名放行；人類動作（沒有節點）一律擋", () => {
  for (const n of RESERVED) {
    assertEquals(parseSelfName(n, "H"), null, n);
    assertEquals(parseSelfName(n), null, n);
  }
  assertEquals(parseSelfName("H-收發室", "H"), "H-收發室", "自己的預設橋名");
  assertEquals(parseSelfName("H-收發室", "W"), null);
  assertEquals(parseSelfName("H-收發室"), null);
  assertEquals(parseSelfName("30家用", "H"), "30家用");
  const base = { version: "0.2.11", status: "online" };
  assertEquals(parseAsnPresence({ ...base, window_name: "ASN 通知" }, "H"), null);
  assertEquals(parseAsnPresence({ ...base, window_name: "H-ASN" }, "H")?.window_name, "H-ASN");
});

Deno.test("視窗改名：新名字是保留的不行；舊名不檢查（讓已經掛著保留名字的人可以改掉）；名單裡夾帶的改名一樣", () => {
  assertEquals(parseWindowRename("小乙", "ASN 通知", "H"), null);
  assertEquals(parseWindowRename("小乙", "登入通知收發室", "H"), null);
  assertEquals(parseWindowRename("登入通知收發室", "小乙", "H"), { from: "登入通知收發室", to: "小乙" });
  assertEquals(parseWindowRename("小乙", "H-收發室", "H"), { from: "小乙", to: "H-收發室" });
  assertEquals(parseWindowRename("小乙", "H-收發室", "W"), null);
  assertEquals(renamesFromRoster([{ renamed_from: "小乙", name: "ASN 通知" }, { renamed_from: "小丙", name: "小丁" }], "H"), [{ from: "小丙", to: "小丁" }]);
});

Deno.test("名單回報：保留名字的視窗不收進名單，其他視窗照常；自己節點的預設橋名放行", () => {
  const got = normalizeRosterAgents([{ name: "小乙" }, { name: "ASN 通知" }, { name: "看畫面收發室" }, { name: "H-收發室" }, { name: "W-收發室" }, { status: "idle" }], "H");
  assertEquals(got.map((a) => a.name), ["小乙", "H-收發室", undefined]);
  assertEquals(normalizeRosterAgents([{ name: "H-收發室" }]).length, 0, "不知道節點就不放行");
});

Deno.test("夥伴同步與接班：保留名字的視窗不收；接班的新名字是保留的回 null", () => {
  const ws = parsePartnerSync({ windows: [{ name: "小乙" }, { name: "ASN 通知" }, { name: "H-收發室" }, { name: "登入通知收發室" }] }, "H");
  assertEquals(ws?.map((w) => w.name), ["小乙", "H-收發室"]);
  const ok = { predecessor: "p_" + "0".repeat(20), node: "H", name: "小乙" };
  assertEquals(parseSucceed(ok)?.name, "小乙");
  assertEquals(parseSucceed({ ...ok, name: "ASN 通知" }), null);
  assertEquals(parseSucceed({ ...ok, name: "H-收發室" })?.name, "H-收發室", "新視窗所在節點的預設橋名");
  assertEquals(parseSucceed({ ...ok, name: "W-收發室" }), null);
});

Deno.test("開視窗與夥伴改名：名字是保留的回 bad_name", () => {
  const launch = { node: "H", profile: "claude", cwd: "D:\\x" };
  assertEquals((parseLaunch({ ...launch, name: "小乙" }) as { name?: string }).name, "小乙");
  assertEquals(parseLaunch({ ...launch, name: "登入通知收發室" }), { error: "bad_name" });
  assertEquals(parseLaunch({ ...launch, name: "ASN-通知" }), { error: "bad_name" });
  const op = { node: "H", name: "小乙", op: "rename" };
  assertEquals((parsePartnerOp({ ...op, new_name: "小丙" }) as { new_name?: string }).new_name, "小丙");
  assertEquals(parsePartnerOp({ ...op, new_name: "看畫面收發室" }), { error: "bad_name" });
  assertEquals(parsePartnerOp({ ...op, new_name: "ASN-通知" }), { error: "bad_name" });
});

Deno.test("帳號名稱（群組裡本人發言用的名字）、雲端代理名、登入帶來的名字：保留的回 null，其他不變", () => {
  for (const n of RESERVED) assertEquals(cleanDisplayName(n), null, n);
  assertEquals(cleanDisplayName("甲".repeat(37) + "收發室垃圾字元"), null, "截成 40 字之後結尾是收發室");
  assertEquals(cleanDisplayName("  啟良 "), "啟良");
  assertEquals(cleanDisplayName("牧陽 Aegis"), "牧陽 Aegis");
  assertEquals(cleanDisplayName(""), null);
  assertEquals(cleanDisplayName(5), null);
});

Deno.test("守門：relay/index.ts 與舊 irori-relay 把金鑰決定的節點代號交給名字檢查", async () => {
  const idx = await Deno.readTextFile(new URL("../relay/index.ts", import.meta.url));
  for (const s of ["normalizeRosterAgents(b.agents, me.id)", "renamesFromRoster(b.agents, me.id)", "parseWindowRename(b?.from, b?.to, me.id)", "parseSelfName(b?.name, me.id)", "parseAsnPresence(await req.json().catch(() => null), me.id)"]) {
    assertEquals(idx.includes(s), true, s);
  }
  const old = await Deno.readTextFile(new URL("../irori-relay/index.ts", import.meta.url));
  assertEquals(old.includes("normalizeRosterAgents(b.agents, me.id)"), true);
  const partners = await Deno.readTextFile(new URL("./partners.ts", import.meta.url));
  assertEquals(partners.includes("parsePartnerSync(body, me.id)"), true);
});
