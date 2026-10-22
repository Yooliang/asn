// 沒指定收件視窗的信：只有設定了預設收件視窗（ASN_RELAY_DEFAULT_AGENT）而且它在線，才交給它；
// 否則留在信箱不 ack，等 ASN 視窗的本人處理。不再「挑最近有動作的 session 代收」——那會把信丟給不相關的視窗。
export const unaddressedWindowNote = actual =>
  `[收發室] 這封信沒有指定收件視窗，依設定交給你（${actual}）處理。`
