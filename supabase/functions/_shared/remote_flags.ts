// 電腦端附在名單回報的「別台能不能看這台的畫面（remote_view）、能不能在這台打字（remote_input）」（#1751）。
// 只是提示值，不是權威：別台真的要看或打字時，被看的那台在握手時仍會自己再查一次本機設定，這裡記的值不影響結果。
// 型別只收布林，其他（字串、數字、null…）一律丟掉；丟掉的那個欄位保留舊值，不會把已知的值洗成「不知道」。
// 舊版電腦不帶這兩個欄位＝都沒收到＝回 null，什麼都不寫。

export interface RemoteFlags {
  view: boolean | null;
  input: boolean | null;
}

/** 從名單 body 取兩個開關；一個合格的都沒有回 null（呼叫端就不打資料庫） */
export function sanitizeRemoteFlags(b: unknown): RemoteFlags | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const o = b as Record<string, unknown>;
  const view = typeof o.remote_view === "boolean" ? o.remote_view : null;
  const input = typeof o.remote_input === "boolean" ? o.remote_input : null;
  return view === null && input === null ? null : { view, input };
}
