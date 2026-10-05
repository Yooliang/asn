// 寄信時的 expects_reply 欄位（寄件人明說要不要等回信；小良哥 10/05，SQL 見 supabase/sql/23_relay_expects_reply.sql）。
// irori-relay 的 send 動作與 relay_ops.ts 的 send 共用這個檢查，兩邊行為一致：
//   - 沒給（undefined）或 null：不帶 p_expects_reply 參數給資料庫函式 → 信的欄位是 null（舊版寄件工具＝不知道，收發室退回看內文標記）。
//     不帶參數（而不是帶 null）是為了還沒套 SQL 23 的資料庫、舊簽章的函式也能照舊呼叫。
//   - true／false：照存（true＝寄件人在等回信、false＝只是告知）。
//   - 其他型別（字串 "yes"、數字、物件…）：回 null，呼叫端回 400 bad_expects_reply；不猜意思，免得把「只是告知」錯存成要回信。
export function expectsReplyArgs(v: unknown): Record<string, boolean> | null {
  if (v === undefined || v === null) return {};
  if (typeof v === "boolean") return { p_expects_reply: v };
  return null;
}
