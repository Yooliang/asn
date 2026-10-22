import { assert } from "jsr:@std/assert@1";

// 視窗名單的 detail（選填）：migration 要加欄位、roster 存它、list 帶它，並且不能弄壞舊欄位與 asn 區塊
const sql = Deno.readTextFileSync(new URL("../../migrations/20261022040000_roster_detail.sql", import.meta.url));

Deno.test("roster detail migration：加可空欄位、roster 存 detail、list 帶 detail", () => {
  assert(/alter table relay\.roster add column if not exists detail text;/.test(sql), "要加可空的 detail 欄位");
  assert(/insert into relay\.roster \(node, name, status, cwd_label, engine, detail\)/.test(sql), "roster 要存 detail");
  assert(sql.includes("'engine', r.engine, 'detail', r.detail"), "list 要帶 detail");
});

Deno.test("roster detail migration：不弄壞舊行為（舊欄位、asn 區塊、驗證、授權）", () => {
  assert(sql.includes("'name', r.name, 'status', r.status, 'cwd_label', r.cwd_label, 'engine', r.engine"), "舊欄位仍在");
  assert(sql.includes("relay.asn_presence p"), "list 的 asn 區塊要保留");
  assert(sql.includes("(can_invite or can_roster)"), "roster 的權限檢查要保留");
  assert(sql.includes("left(btrim(a.v->>'detail'), 80)"), "detail 要截 80 字");
  assert(sql.includes("grant execute on function public.irori_relay_list(uuid) to service_role;"), "授權要保留");
});
