// 真人好友與群組 第 1a 期：「人」的群組動作（建群組、邀請、接受邀請、一對一升級成群組、退出、帶自己的 AI、主持人確認）。
// 規格：docs/design/HUMANS-AND-GROUPS.md 第 0、2.2、2.3、2.5.1 節。資料與權限的最後一道關在 migrations/20261023170200_groups_p1a_actions.sql。
// 這裡負責：沒有本人簽章（x-asn-user）在打資料庫之前就 401；節點金鑰單獨一律進不來（AI 拿得到金鑰、拿不到登入憑證）；輸入整理與第一層格式檢查；
// 邀請碼只在建立當下回給呼叫者一次（資料庫只存雜湊）；寫入後對所有成員節點敲門鈴；錯誤碼對應中文。

// deno-lint-ignore no-explicit-any
type Json = any;

export const GROUP_ACTIONS = new Set([
  "group_create", "group_invite_create", "group_invite_revoke", "group_invite_preview", "group_invite_accept",
  "group_upgrade", "group_leave", "group_ai_add", "group_ai_remove", "group_allow_others",
  "group_confirm_decide", "group_confirm_list",
]);

export type Reply = { status: number; body: Json };
export type GroupDeps = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: Json; error: unknown }>;
  ring: (topic: string) => Promise<void>;
  /** 驗證 x-asn-user 後的使用者 id；沒簽章或驗證失敗回 null */
  signedUser: () => Promise<string | null>;
  sha256Hex: (s: string) => Promise<string>;
  /** 產生一組新的邀請碼（測試可換成固定值） */
  newCode: () => string;
};

export const INVITE_LINK_BASE = "https://asnmessenger.web.app/i/";
export const INVITE_CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const SEED_DEFAULT = 40;
export const SEED_MAX = 50;
const ROOM_ID = /^[A-Za-z0-9_-]{1,32}$/;
const NODE_ID = /^[A-Za-z0-9_-]{1,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ERROR_TEXT: Record<string, string> = {
  unauthorized: "請先登入，才能使用群組",
  forbidden: "這個動作只有使用者本人能做",
  not_member: "你不在這個群組裡",
  not_found: "找不到（可能已被移除）",
  bad_request: "資料格式不對",
  bad_member: "只能帶自己名下、已上線的夥伴進群組",
  bad_kind: "不認得的危險操作類別",
  id_taken: "群組代號重複，請再試一次",
  room_limit: "你建立或參加的群組已達上限",
  member_limit: "群組人數已達上限",
  rate_limited: "操作太頻繁，稍後再試",
  invalid_invite: "邀請碼不正確",
  invite_used: "這個邀請已經被使用過了",
  invite_expired: "這個邀請已過期（只有 24 小時）",
  invite_revoked: "這個邀請已被撤銷",
  own_invite: "不能接受自己發出的邀請",
  already_member: "你已經在這個群組裡了",
  no_account: "請先登入 ASN 並建立帳號",
  host_must_transfer: "你是主持人，群組裡還有其他真人，請先請他們離開或封存群組",
  already_decided: "這個請求已經處理過了",
  expired: "這個請求已過期",
  no_host: "這個群組找不到主持人",
  internal: "伺服器發生錯誤",
};
export const groupErrorText = (code: string) => ERROR_TEXT[code] ?? "操作失敗";
const STATUS: Record<string, number> = {
  unauthorized: 401, forbidden: 403, not_member: 403, not_found: 404, invalid_invite: 404,
  invite_used: 410, invite_expired: 410, invite_revoked: 410, expired: 410,
  id_taken: 409, room_limit: 409, member_limit: 409, already_member: 409, no_account: 409, host_must_transfer: 409,
  already_decided: 409, no_host: 409, rate_limited: 429, internal: 500,
};
export const groupFail = (code: string): Reply => ({ status: STATUS[code] ?? 400, body: { error: code, detail: groupErrorText(code) } });

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const room = (v: unknown) => (typeof v === "string" && ROOM_ID.test(v) ? v : null);

/** 視窗成員鍵：「節點~視窗名」，恰好一個 ~、不以 ~ 開頭、不含控制字元 */
export function validWindowKey(k: unknown): k is string {
  if (typeof k !== "string" || k.length < 3 || k.length > 120) return false;
  const i = k.indexOf("~");
  return i > 0 && i === k.lastIndexOf("~") && i < k.length - 1 && !/[\u0000-\u001f\u007f]/.test(k);
}
const keyList = (v: unknown, max: number): string[] | null => {
  if (!Array.isArray(v) || v.length > max) return null;
  return v.every(validWindowKey) ? [...new Set(v as string[])] : null;
};

// 本人簽章過的讀寫：發言照舊帶 p_signed_user；讀、列表、成員清單改呼叫帶簽章的新函式（asn_relay_group_*），
// 沒簽章時照舊呼叫原函式（簽章不變、行為與以前相同）
const SIGNED_TARGET: Record<string, string> = {
  asn_relay_room_post: "asn_relay_room_post",
  asn_relay_room_read: "asn_relay_group_read",
  asn_relay_room_list: "asn_relay_group_list",
  asn_relay_room_members: "asn_relay_group_members",
};
export function signedRpc(
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: Json; error: unknown }>, signed: string,
) {
  return (fn: string, args: Record<string, unknown>) => {
    const target = SIGNED_TARGET[fn];
    return target ? rpc(target, { ...args, p_signed_user: signed }) : rpc(fn, args);
  };
}

/** 邀請連結：https://asnmessenger.web.app/i/<碼> */
export const inviteLink = (code: string) => INVITE_LINK_BASE + code;

/** 開頭紀錄則數：沒給用預設 40；整數；0～50（超過截成 50，負數截成 0） */
export function clampSeed(v: unknown): number | null {
  if (v === undefined || v === null) return SEED_DEFAULT;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(Math.max(Math.trunc(v), 0), SEED_MAX);
}

export async function handleGroupAction(deps: GroupDeps, me: { id: string }, action: string, body: unknown): Promise<Reply> {
  if (!GROUP_ACTIONS.has(action)) return groupFail("not_found");
  // 一律先驗本人簽章；沒簽章（例如 AI 只有節點金鑰）在打資料庫之前就 401
  const user = await deps.signedUser();
  if (!user) return groupFail("unauthorized");
  const b = isObj(body) ? body : {};
  const base = { p_user: user, p_node: me.id };

  const run = async (fn: string, args: Record<string, unknown>, shape?: (d: Json) => Json): Promise<Reply> => {
    const { data, error } = await deps.rpc(fn, args);
    if (error) { console.error(fn, error); return groupFail("internal"); }
    if (data?.error) return groupFail(String(data.error));
    for (const t of (data?.bell_topics ?? []) as string[]) await deps.ring(t);
    const out = { ...data };
    delete out.bell_topics;
    return { status: 200, body: shape ? shape(out) : out };
  };

  switch (action) {
    case "group_create": {
      const name = typeof b.name === "string" ? b.name.trim() : "";
      const ai = b.ai === undefined ? [] : keyList(b.ai, 20);
      if (name.length < 1 || name.length > 60 || ai === null) return groupFail("bad_request");
      return await run("asn_relay_group_create", { ...base, p_name: name, p_ai: ai });
    }
    case "group_invite_create": {
      const kind = b.kind;
      if (kind !== "room" && kind !== "conversation") return groupFail("bad_request");
      const seed = clampSeed(b.seed);
      if (seed === null) return groupFail("bad_request");
      let args: Record<string, unknown>;
      if (kind === "room") {
        const r = room(b.room);
        if (!r) return groupFail("bad_request");
        args = { p_room: r, p_src_node: null, p_src_agent: null };
      } else {
        const node = b.node === undefined ? me.id : b.node;
        const agent = b.agent === undefined || b.agent === null || b.agent === "" ? null : b.agent;
        if (typeof node !== "string" || !NODE_ID.test(node)) return groupFail("bad_request");
        if (agent !== null && (typeof agent !== "string" || agent.length > 60 || agent.includes("~"))) return groupFail("bad_request");
        args = { p_room: null, p_src_node: node, p_src_agent: agent };
      }
      // 邀請碼只在這次回應給一次；資料庫只存雜湊
      const code = deps.newCode();
      const r = await run("asn_relay_group_invite_create", {
        ...base, p_kind: kind, ...args, p_seed: seed, p_code_hash: await deps.sha256Hex(code),
      });
      if (r.status !== 200) return r;
      return { status: 200, body: { ...r.body, code, link: inviteLink(code) } };
    }
    case "group_invite_revoke": {
      if (typeof b.id !== "string" || !UUID.test(b.id)) return groupFail("bad_request");
      return await run("asn_relay_group_invite_revoke", { ...base, p_id: b.id });
    }
    case "group_invite_preview":
    case "group_invite_accept": {
      if (typeof b.code !== "string" || !INVITE_CODE_RE.test(b.code)) return groupFail("bad_request");
      const fn = action === "group_invite_preview" ? "asn_relay_group_invite_preview" : "asn_relay_group_invite_accept";
      return await run(fn, { ...base, p_code_hash: await deps.sha256Hex(b.code) });
    }
    case "group_upgrade": {
      const node = b.node === undefined ? me.id : b.node;
      const agent = b.agent === undefined || b.agent === null || b.agent === "" ? null : b.agent;
      const extra = keyList(b.extra, 10);
      const seed = clampSeed(b.seed);
      const name = b.name === undefined || b.name === null ? null : typeof b.name === "string" ? b.name.trim() || null : false;
      if (typeof node !== "string" || !NODE_ID.test(node) || (agent !== null && (typeof agent !== "string" || agent.length > 60 || agent.includes("~")))
        || !extra || extra.length < 1 || seed === null || name === false || (typeof name === "string" && name.length > 60)) {
        return groupFail("bad_request");
      }
      return await run("asn_relay_group_upgrade", { ...base, p_src_node: node, p_src_agent: agent, p_seed: seed, p_name: name, p_extra: extra });
    }
    case "group_leave": {
      const r = room(b.room);
      if (!r) return groupFail("bad_request");
      return await run("asn_relay_group_leave", { ...base, p_room: r });
    }
    case "group_ai_add": {
      const r = room(b.room);
      const keys = keyList(b.keys, 10);
      if (!r || !keys || keys.length < 1) return groupFail("bad_request");
      return await run("asn_relay_group_ai_add", { ...base, p_room: r, p_keys: keys });
    }
    case "group_ai_remove": {
      const r = room(b.room);
      if (!r || !validWindowKey(b.key)) return groupFail("bad_request");
      return await run("asn_relay_group_ai_remove", { ...base, p_room: r, p_key: b.key });
    }
    case "group_allow_others": {
      const r = room(b.room);
      if (!r || !validWindowKey(b.key) || typeof b.allow !== "boolean") return groupFail("bad_request");
      return await run("asn_relay_group_allow_others", { ...base, p_room: r, p_key: b.key, p_allow: b.allow });
    }
    case "group_confirm_decide": {
      const r = room(b.room);
      if (!r || typeof b.id !== "string" || !UUID.test(b.id) || typeof b.approve !== "boolean") return groupFail("bad_request");
      return await run("asn_relay_group_confirm_decide", { ...base, p_room: r, p_id: b.id, p_approve: b.approve });
    }
    case "group_confirm_list": {
      const r = room(b.room);
      if (!r) return groupFail("bad_request");
      return await run("asn_relay_group_confirm_list", { ...base, p_room: r });
    }
  }
  return groupFail("not_found");
}
