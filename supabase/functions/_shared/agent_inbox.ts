// 視窗自己收信（#84）：inbox／ack 帶 agent=<視窗名> 時，只回／只 ack 寄給該視窗的信。
// 隔離靠兩層：這裡的格式檢查（agent 必填、不能空）＋ SQL（supabase/sql/08_agent_inbox.sql）裡 to_node＝呼叫者節點 且 to_agent＝該視窗名的精確比對。
// 沒帶 agent 的 inbox／ack 仍走原本的節點信箱（機器橋用），完全不變。
export type AgentInboxDeps = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 視窗名：非空字串、不含控制字元、頭尾無空白、至多 100 字（與寄信時 to_agent 的截斷長度一致）；不合格回 null
export function parseAgentName(v: unknown): string | null {
  if (typeof v !== "string" || v.length < 1 || v.length > 100) return null;
  if (/[\u0000-\u001f\u007f]/.test(v) || v.trim() !== v) return null;
  return v;
}

export async function handleAgentInbox(
  deps: AgentInboxDeps,
  me: { id: string },
  action: "inbox" | "inbox_peek" | "ack",
  agentRaw: unknown,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const agent = parseAgentName(agentRaw);
  if (!agent) return { status: 400, body: { error: "bad_agent" } };
  if (action === "inbox") {
    const { data, error } = await deps.rpc("asn_relay_inbox_agent", { p_node: me.id, p_agent: agent });
    if (error) { console.error(error); return { status: 500, body: { error: "internal" } }; }
    return { status: 200, body: { messages: data } };
  }
  if (action === "inbox_peek") {
    // 只看不收（asn-cli recv --peek）：只呼叫唯讀的 asn_relay_inbox_peek，不 ack、不設 delivered_at
    const { data, error } = await deps.rpc("asn_relay_inbox_peek", { p_node: me.id, p_agent: agent });
    if (error) { console.error(error); return { status: 500, body: { error: "internal" } }; }
    return { status: 200, body: data };
  }
  const ids = (body as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(ids) || ids.length > 100 || !ids.every((i) => typeof i === "string" && UUID.test(i))) {
    return { status: 400, body: { error: "bad_ids" } };
  }
  const { data, error } = await deps.rpc("asn_relay_ack_agent", { p_node: me.id, p_agent: agent, p_ids: ids });
  if (error) { console.error(error); return { status: 500, body: { error: "internal" } }; }
  return { status: 200, body: { acked: data } };
}
