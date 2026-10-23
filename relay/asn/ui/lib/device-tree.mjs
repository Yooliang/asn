// 設定「設備」分類：設備 → 廠商 → 帳號 三層（純邏輯，node 與瀏覽器都能跑）。
// 設備一律用設備名稱，不顯示節點代號與夥伴 ID；沒回報的顯示「未回報」。
// 資料來源都是現有的：名單（有哪些視窗、各用哪家引擎、在線狀態）、啟動器回報（那台裝了哪些 CLI）、
// Claude 帳號遠端回報（acct_remote_list）、本機的 Claude 帳號庫與 Codex 目前登入。沒有新增任何後台回報。
import { launchDeviceRows } from './partner-launch-ui.mjs'
import { MODEL_CATALOG } from './model-catalog.mjs'
import { engineKey, engineRank } from './tabs.mjs'
import { agoText } from './cloud-invite.mjs'
import { accountLine } from './claude-accounts.mjs'
import { UNNAMED_DEVICE } from './text.mjs'

export const NOT_REPORTED = '未回報'
export const SELF_LABEL = '這台電腦'
const PHONE_KINDS = new Set(['phone', 'mobile', 'android'])
// 引擎名稱 → 廠商鍵（gpt 與 codex 是同一家）；asn 視窗與其他不算廠商
const VENDOR_OF = { gpt: 'codex' }
const SKIP = new Set(['asn', 'other', ''])
export const VENDOR_LABEL = { claude: 'Claude', codex: 'OpenAI（Codex）', gemini: 'Gemini', grok: 'Grok', pi: 'Pi', acp: 'ACP 工作者', deepseek: 'DeepSeek', minimax: 'MiniMax' }
const vendorLabel = k => VENDOR_LABEL[k] ?? k.charAt(0).toUpperCase() + k.slice(1)
const vendorKey = e => { const k = String(e ?? '').trim().toLowerCase(); return VENDOR_OF[k] ?? k }

// 一個廠商底下的帳號 → 顯示用的字
function accountView(rows, { loggedOut = false } = {}) {
  const cur = rows.find(a => a.current)
  const others = rows.filter(a => a !== cur)
  if (!rows.length) return { text: loggedOut ? '目前沒有登入' : NOT_REPORTED, reported: loggedOut, extra: '' }
  if (!cur) return { text: '尚未選用帳號', reported: true, extra: `${rows.length} 個帳號：${rows.map(accountLine).join('、')}` }
  return { text: accountLine(cur), reported: true, extra: others.length ? `另有 ${others.length} 個帳號：${others.map(accountLine).join('、')}` : '' }
}

/**
 * friends：名單（node、device、engine、kind、status）；nodeOrder：節點順序；selfNode：本機節點
 * asn：節點 → 在線的 ASN 視窗列；launchers：節點 → 啟動器回報（profiles）
 * reports：節點 → { error, asnOnline, reportedAt, accounts:[{vendor,email,plan,current}] }（acct_remote_list 的結果）
 * self：{ claude:[{email,plan,current}], codex:{ loggedIn, text } }（本機的帳號庫與 Codex 登入）
 */
export function buildDeviceTree({ friends = [], nodeOrder = [], selfNode = '', asn = {}, launchers = {}, reports = {}, self = {}, now = Date.now() } = {}) {
  const rows = launchDeviceRows(friends, { selfNode, nodeOrder })
  return rows.map(d => {
    const node = d.key
    const isSelf = node === selfNode
    const mine = friends.filter(f => f.node === node)
    const named = mine.find(f => f.device)?.device ?? ''
    const label = named || (isSelf ? SELF_LABEL : UNNAMED_DEVICE)
    const phone = mine.some(f => PHONE_KINDS.has(String(f.kind ?? '').toLowerCase()))
    const isOn = isSelf || (Array.isArray(asn[node]) && asn[node].length > 0) || mine.some(f => f.status && f.status !== 'offline')
    const rep = reports[node] ?? null

    // 這台有哪些廠商：視窗用的引擎、啟動器回報的 CLI、帳號回報裡的廠商、本機登入的帳號
    const keys = new Set()
    for (const f of mine) { const k = vendorKey(engineKey(f)); if (!SKIP.has(k)) keys.add(k) }
    for (const p of launchers[node]?.profiles ?? []) {
      const cat = MODEL_CATALOG.find(m => m.profileId === p?.id)
      const k = vendorKey(cat?.id ?? p?.id)
      if (!SKIP.has(k)) keys.add(k)
    }
    const accts = {}
    if (isSelf) {
      accts.claude = (self.claude ?? []).map(a => ({ email: a.email, plan: a.plan, current: a.current === true }))
      if (accts.claude.length) keys.add('claude')
      if (self.codex?.loggedIn) { keys.add('codex'); accts.codex = [{ email: self.codex.text, plan: '', current: true }] }
    } else if (rep && !rep.error) {
      for (const a of rep.accounts ?? []) {
        const k = vendorKey(a?.vendor)
        if (SKIP.has(k) || !a?.email) continue
        keys.add(k)
        ;(accts[k] ??= []).push({ email: a.email, plan: a.plan, current: a.current === true })
      }
    }
    const ago = !isSelf && rep && !rep.error ? agoText(rep.reportedAt, now) : ''
    const vendors = [...keys].sort((a, b) => engineRank(a) - engineRank(b) || a.localeCompare(b)).map(k => {
      const list = accts[k] ?? []
      const v = accountView(list, { loggedOut: isSelf && (k === 'claude' || k === 'codex') })
      // 只有 Claude 的帳號能切換，而且對方電腦的 ASN 要在線、至少有兩個帳號
      const canPick = k === 'claude' && !isSelf && list.length >= 2
      const switchable = canPick && rep?.asnOnline === true
      return { key: k, label: vendorLabel(k), account: v.text, reported: v.reported, extra: v.extra, switchable, switchHint: canPick && !switchable ? '對方電腦的 ASN 沒有在線，無法切換' : '' }
    })
    return {
      key: node, label, self: isSelf, kind: phone ? '手機' : '電腦', online: isOn, onlineText: isOn ? '在線' : '離線',
      reportedText: ago ? `帳號最後回報：${ago}` : (!isSelf && rep?.error ? '帳號回報讀取失敗' : ''),
      vendors, empty: vendors.length ? '' : '這台設備還沒有回報任何廠商',
    }
  })
}

// 設備分類在分類列表上的一行摘要
export function deviceSummary(devices) {
  const list = Array.isArray(devices) ? devices : []
  if (!list.length) return '還沒有設備'
  const on = list.filter(d => d.online).length
  return `${list.length} 台設備，${on} 台在線`
}
