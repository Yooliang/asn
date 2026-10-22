// 節點信箱（沒帶 agent 的 inbox）的排除清單：`exclude=名字1,名字2`＝這一頁不要回寄給這些視窗名的信。
// 內建收發室對寄給 ASN 自己視窗的信不 ack，一多就占滿「最舊 50 封」那一頁、擋住別人的新信（行頭堵塞）。
// 只在有帶且合格時才多傳 p_exclude_agents；沒帶＝舊呼叫完全不變。
import { parseAgentName } from "./agent_inbox.ts";

export type InboxRpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;

export const MAX_EXCLUDE = 50;

// 逗號分隔的視窗名；不合格的名字（空、控制字元、過長、頭尾有空白）略過，超過上限只取前面的；一個都沒有回 null
export function parseExclude(raw: string | null | undefined): string[] | null {
  if (typeof raw !== "string" || raw === "") return null;
  const names: string[] = [];
  for (const part of raw.split(",")) {
    const n = parseAgentName(part);
    if (n && !names.includes(n)) names.push(n);
    if (names.length >= MAX_EXCLUDE) break;
  }
  return names.length ? names : null;
}

export async function readNodeInbox(rpc: InboxRpc, nodeId: string, rawExclude: string | null | undefined): Promise<{ data: unknown; error: unknown }> {
  const ex = parseExclude(rawExclude);
  if (!ex) return await rpc("asn_relay_inbox", { p_node: nodeId });
  const r = await rpc("asn_relay_inbox", { p_node: nodeId, p_exclude_agents: ex });
  // migration 還沒套（函式沒有這個參數）時退回原本的讀法，不讓收信整個壞掉
  if (r.error) return await rpc("asn_relay_inbox", { p_node: nodeId });
  return r;
}
