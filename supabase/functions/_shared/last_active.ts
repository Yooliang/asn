// 最後活動時間（0.2 E1，#397）：寄信與群組發言成功之後，通知資料庫「這位寄件人剛活動過」。
// 節流（10 秒）在資料庫函式 asn_relay_touch_active 裡做；這裡只負責：
//  - 節點一律是 relay 已驗證的 me.id（呼叫端傳進來，不從請求內容取）；夥伴名字只是 current_name 精確比對用的字串，解不到只寫節點
//  - 不拖慢寄信：有 EdgeRuntime.waitUntil 就丟到背景；沒有就 await，但最多等 1 秒，逾時或失敗只記 log，不影響寄信與發言
//  - 舊後台沒有這個函式（migration 還沒套）時只會失敗一次記 log，照常運作
export type TouchRpc = (fn: string, args: Record<string, unknown>) => Promise<{ data?: unknown; error?: unknown }>;

export const TOUCH_TIMEOUT_MS = 1000;
const MAX_AGENT = 100;

type WaitUntil = (p: Promise<unknown>) => void;
declare const EdgeRuntime: { waitUntil: WaitUntil } | undefined;

function runtimeWaitUntil(): WaitUntil | null {
  try {
    return typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime?.waitUntil === "function" ? (p) => EdgeRuntime!.waitUntil(p) : null;
  } catch {
    return null;
  }
}

// 群組發言的寄件視窗名：as_agent（代發）優先，其次 from_agent（照 rooms.ts 的規則）
export function roomPostAgent(params: Record<string, unknown>): string | null {
  const a = typeof params.as_agent === "string" && params.as_agent ? params.as_agent : typeof params.from_agent === "string" && params.from_agent ? params.from_agent : null;
  return a;
}

export async function touchActive(
  rpc: TouchRpc,
  node: string,
  agent: string | null | undefined,
  opts: { waitUntil?: WaitUntil | null; timeoutMs?: number; log?: (m: string) => void } = {},
): Promise<void> {
  const log = opts.log ?? ((m: string) => console.warn(m));
  const name = typeof agent === "string" && agent.length > 0 && agent.length <= MAX_AGENT ? agent : null;
  let timer: number | undefined;
  const work = (async () => {
    try {
      const r = await rpc("asn_relay_touch_active", { p_node: node, p_agent: name });
      if (r?.error) log("最後活動時間寫入失敗（不影響寄信）");
    } catch {
      log("最後活動時間寫入失敗（不影響寄信）");
    }
  })();
  const bounded = Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(() => { log("最後活動時間寫入逾時（不影響寄信）"); resolve(); }, opts.timeoutMs ?? TOUCH_TIMEOUT_MS) as unknown as number;
    }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  const wu = opts.waitUntil === undefined ? runtimeWaitUntil() : opts.waitUntil;
  if (wu) { wu(bounded); return; }
  await bounded;
}
