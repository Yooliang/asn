// 夥伴選單對照表的情境（#1559）：夥伴種類 × 狀態 × 所在電腦 × 登入／電腦設定。
// 對照表（fixtures/partner-menu-matrix.json）是用合併前（main 8a5d8034）的實際輸出產生的；重構後各入口的輸出要跟它逐格相同。
import { barSlots, managePanelItems, moreMenuItems, opsMenuItems, partnerMenuItems, chatGroupItems } from '../ui/lib/actionbar.mjs'
import { manageItems } from '../ui/lib/archive.mjs'
import { phoneOpsRows } from '../ui/lib/mobile-ops.mjs'
import { CLOSED_REASONS } from '../ui/lib/partner-ops.mjs'

export const SELF = 'P'

const KINDS = {
  claude: {},
  pi: { engine: 'pi' },
  gemini: { engine: 'gemini' },
  grokLocal: { engine: 'grok' },
  cloud: { engine: 'cloud' },
  cloudGrok: { engine: 'grok', kind: 'grok' },
  codex: { engine: 'codex' },
  process: { entryKind: 'process', engine: 'codex', agent: 'codex #301（前景）' },
  processGrok: { entryKind: 'process', engine: 'grok', agent: 'grok #302（前景）' },
  processPi: { entryKind: 'process', engine: 'pi', agent: 'pi #303（前景）' },
  processGemini: { entryKind: 'process', engine: 'gemini', agent: 'gemini #304（前景）' },
  term: { entryKind: 'term' },
  archived: { archived: true },
  pending: { pending: true },
  person: { person: true },
  room: { room: true, agent: 'room:g1' },
  asn: { engine: 'asn' },
}
const STATUSES = { claude: ['idle', 'busy', 'offline'], pi: ['idle', 'offline'], gemini: ['idle', 'stopped', 'offline'], grokLocal: ['idle', 'stopped', 'offline'] }
const machines = (over = {}) => ({ P: { online: true, launcher: { profiles: [] } }, Q: { online: true, launcher: { profiles: [] } }, ...over })
const CTXS = {
  ok: { machines: machines(), loaded: true, signedIn: true, checking: false, authError: '', loadError: '' },
  signedOut: { machines: machines(), loaded: true, signedIn: false, checking: false, authError: '', loadError: '' },
  checking: { machines: {}, loaded: false, signedIn: null, checking: true, authError: '', loadError: '' },
  authError: { machines: {}, loaded: false, signedIn: null, checking: false, authError: '逾時', loadError: '' },
  loadError: { machines: {}, loaded: false, signedIn: true, checking: false, authError: '', loadError: '連不上' },
  closed: { machines: machines({ P: { online: true, launcher: null }, Q: { online: true, launcher: null } }), loaded: true, signedIn: true, checking: false, authError: '', loadError: '' },
  machineOffline: { machines: machines({ P: { online: false, launcher: { profiles: [] } }, Q: { online: false, launcher: { profiles: [] } } }), loaded: true, signedIn: true, checking: false, authError: '', loadError: '' },
}
// 那台自己回報了不開放的原因（#1611）：launcher 仍是 null，另帶 launch_closed_reason；只對 claude 的 idle／離線各一份（見 cases 尾端）
const closedWith = reason => ({ machines: machines({ P: { online: true, launcher: null, launch_closed_reason: reason }, Q: { online: true, launcher: null, launch_closed_reason: reason } }), loaded: true, signedIn: true, checking: false, authError: '', loadError: '' })
const CLOSED_WHY_CTXS = { closedNoConsent: closedWith(CLOSED_REASONS.noConsent), closedNoProfile: closedWith(CLOSED_REASONS.noProfile), closedNoCwd: closedWith(CLOSED_REASONS.noCwd) }
const FULL = ['claude', 'pi', 'gemini', 'grokLocal', 'processGrok', 'processGemini']

export function cases() {
  const out = []
  for (const [kind, extra] of Object.entries(KINDS)) {
    for (const status of STATUSES[kind] ?? ['idle', 'offline']) {
      for (const node of kind === 'claude' || kind === 'pi' || kind.startsWith('process') || kind === 'term' ? [SELF, 'Q'] : [SELF]) {
        for (const ctxName of FULL.includes(kind) ? Object.keys(CTXS) : ['ok', 'signedOut']) {
          const friend = { id: `${node}/${kind}`, node, agent: kind, nick: kind, status, ...extra }
          out.push({ name: `${kind}|${status}|${node}|${ctxName}`, friend, ctx: CTXS[ctxName] })
        }
      }
    }
  }
  for (const status of ['idle', 'offline']) {
    for (const [ctxName, ctx] of Object.entries(CLOSED_WHY_CTXS)) {
      const friend = { id: `${SELF}/claude`, node: SELF, agent: 'claude', nick: 'claude', status }
      out.push({ name: `claude|${status}|${SELF}|${ctxName}`, friend, ctx })
    }
  }
  return out
}

// 「更多」選單要的大按鈕格子：照對話頁 actionbar 的算法（ctx 給齊：有語音、能查子代理與工作項目、主控台查到了）
export const slotsOf = (friend, ctx) => Object.fromEntries(barSlots(friend, { selfNode: SELF, api: true, callable: true, subagents: true, tasks: true, console: { state: 'ready', visible: true, reason: '' }, ops: ctx }).map(s => [s.key, s]))

export const row = i => [i.key, i.label, i.ok === undefined ? '-' : i.ok ? 'ok' : 'no', i.reason ?? '', i.sep ? 'sep' : ''].join('|')

// 四個入口（合併前的寫法）：名單右鍵的管理段、Aero「管理」、現代／LINE「更多」、手機「⋯」（管理段＋邀請／群組）
export function surfacesBefore(friend, ctx) {
  return {
    context: partnerMenuItems(friend, ctx, SELF).map(row),
    panel: managePanelItems(friend, ctx, opsMenuItems(friend), { selfNode: SELF }).map(row),
    more: moreMenuItems(friend, { ops: ctx, selfNode: SELF, slots: slotsOf(friend, ctx), term: false, subLabel: '' }).map(row),
    phone: [...phoneOpsRows(manageItems(friend, ctx), friend), ...chatGroupItems(friend)].map(row),
  }
}
