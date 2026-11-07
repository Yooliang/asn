// 設定「設備與帳號」分類：設備 → 廠商 → 帳號 三層（廠商的 accounts 是帳號清單，畫面一個帳號一列）（純邏輯，node 與瀏覽器都能跑）。
// 設備一律用設備名稱，不顯示節點代號與夥伴 ID；沒回報的顯示「未回報」。
// 資料來源都是現有的：名單（有哪些視窗、各用哪家引擎、在線狀態）、啟動器回報（那台裝了哪些 CLI）、
// Claude 帳號遠端回報（acct_remote_list）、本機的 Claude 帳號庫與 Codex 目前登入。沒有新增任何後台回報。
import { launchDeviceRows } from './partner-launch-ui.mjs'
import { isDeviceHidden, isDeviceRemoved } from './device-order.mjs'
import { MODEL_CATALOG } from './model-catalog.mjs'
import { engineKey, engineRank } from './tabs.mjs'
import { agoText } from './cloud-invite.mjs'
import { accountLine, loginIncomplete, loginFailed } from './claude-accounts.mjs'
import { UNNAMED_DEVICE } from './text.mjs'
import { quotaView } from './account-quota.mjs'
import { ROSTER_TEXT, nodeLabelOf, rosterAccountsOn, rosterLookup, rosterQuota } from './account-roster.mjs'
import { modelVendorKey } from './vendor-icons.mjs'
import { CORE_VENDORS, STATE, STATE_TEXT, deviceKindLabel, deviceStateLine, installAction, isCloudNode, isPhoneDevice, reportFreshness, vendorState } from './device-state.mjs'

export const NOT_REPORTED = '未回報'
export const SELF_LABEL = '這台電腦'
// 引擎名稱 → 廠商鍵（gpt 與 codex 是同一家）；asn 視窗與其他不算廠商
const VENDOR_OF = { gpt: 'codex' }
const SKIP = new Set(['asn', 'other', ''])
export const VENDOR_LABEL = { claude: 'Claude', codex: 'OpenAI（Codex）', gemini: 'Gemini', grok: 'Grok', pi: 'Pi', acp: 'ACP 工作者', deepseek: 'DeepSeek', minimax: 'MiniMax', aegis: 'Aegis' }
const vendorLabel = k => VENDOR_LABEL[k] ?? k.charAt(0).toUpperCase() + k.slice(1)
// pi 只是執行殼：它背後實際用的模型廠商（名單 model 欄「提供者/模型」對得到的）。modelVendorKey 回的鍵 → 給人看的名字
const PI_VIA_LABEL = { claude: 'Claude', gpt: 'OpenAI', gemini: 'Gemini', grok: 'Grok', deepseek: 'DeepSeek', minimax: 'MiniMax' }
export function piBackends(friends) {
  const keys = []
  for (const f of friends ?? []) {
    if (String(f?.engine ?? '').trim().toLowerCase() !== 'pi') continue
    const k = modelVendorKey(f?.model)
    if (k && PI_VIA_LABEL[k] && !keys.includes(k)) keys.push(k)
  }
  return keys
}
const vendorKey = e => { const k = String(e ?? '').trim().toLowerCase(); return VENDOR_OF[k] ?? k }
// 一台的啟動器 profiles：電腦版放 { profiles }，手機版放整筆電腦設定 { launcher: { profiles } }；沒開放（沒有）回 null
export const profilesOf = l => (Array.isArray(l?.profiles) ? l.profiles : Array.isArray(l?.launcher?.profiles) ? l.launcher.profiles : null)

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
 * asn：節點 → 在線的 ASN 視窗列；launchers：節點 → 啟動器回報。電腦版放啟動器本身 { profiles }，手機版放整筆電腦設定 { launcher: { profiles } }（兩種都認）；
 *   本機那筆可多帶 detected: false＝本機偵測還沒跑完（這時不能說「未安裝」）
 * 每一台多帶 cloud：true／false／null（雲端夥伴，見 device-state.mjs 的 isCloudNode；null＝資料還不夠）
 * machines：節點 → { platform }（後台回報的平台，#652）。電腦版是 remoteMachines、手機版是 machinesByNode
 * reports：節點 → { error, asnOnline, reportedAt, accounts:[{vendor,email,plan,current}] }（acct_remote_list 的結果）
 * self：{ claude:[{email,plan,current}], codex:{ loggedIn, text } }（本機的帳號庫與 Codex 登入）
 * roster：後台的帳號列表（account-roster.mjs，#374）。別台設備的帳號額度優先看列表（用廠牌＋帳號對）；
 *   列表沒有這個帳號、或後台讀不到（null）就退回那台自己回報的數字。本機這台照 #1339 一律用本機紀錄，不看列表。
 */
export function buildDeviceTree({ friends = [], nodeOrder = [], deviceOrder = [], shown = [], removed = [], selfNode = '', asn = {}, launchers = {}, machines = {}, reports = {}, self = {}, roster = null, selfIsPhone = false, now = Date.now() } = {}) {
  const rows = launchDeviceRows(friends, { selfNode, nodeOrder, deviceOrder })
  const look = rosterLookup(roster)
  const nodeLabel = nodeLabelOf(friends, { selfNode, selfLabel: SELF_LABEL })
  // 別台設備一個帳號的額度：列表有就用列表，沒有就用那台回報的（舊的回報只有 Claude 有額度）
  const remoteQuota = (k, a) => {
    const e = look(k, a.email)
    if (e) return { quota: rosterQuota(e, { nodeLabel, now }) }
    return k === 'claude' ? { quota: quotaView(a, now) } : {}
  }
  return rows.map(d => {
    const node = d.key
    const isSelf = node === selfNode
    const mine = friends.filter(f => f.node === node)
    const named = mine.find(f => f.device)?.device ?? ''
    const label = named || (isSelf ? SELF_LABEL : UNNAMED_DEVICE)
    // 手機：後台回報的平台優先（launchers[node].platform，#652），沒有再看名單的種類
    const platform = String(machines[node]?.platform ?? launchers[node]?.platform ?? '').toLowerCase()
    // 手機版（selfIsPhone）的本機一定是手機：不等後台回報的平台（還沒讀到、或舊版沒回報時，不能先顯示成電腦）
    const phone = (isSelf && selfIsPhone) || isPhoneDevice({ platform, kinds: mine.map(f => f.kind) })
    const isOn = isSelf || (Array.isArray(asn[node]) && asn[node].length > 0) || mine.some(f => f.status && f.status !== 'offline')
    const rep = reports[node] ?? null
    const asnOnline = Array.isArray(asn[node]) && asn[node].length > 0
    // 雲端夥伴（#930）：只標記，不改這裡的分組與顯示（之後的 PR 才用它分出「雲端夥伴」）
    // 夥伴全部明確離線（status 是 offline）才算；名單沒帶狀態＝不知道，不算離線
    const partnersOffline = mine.length > 0 && mine.every(f => String(f.status ?? '').toLowerCase() === 'offline')
    const cloud = isCloudNode({ phone, self: isSelf, asnOnline, rep: reports[node], engines: mine.map(f => engineKey(f)), partnersOffline })

    // 這台有哪些廠商：視窗用的引擎、啟動器回報的 CLI、帳號回報裡的廠商、本機登入的帳號
    const keys = new Set()
    for (const f of mine) { const k = vendorKey(engineKey(f)); if (!SKIP.has(k)) keys.add(k) }
    for (const p of profilesOf(launchers[node]) ?? []) {
      const cat = MODEL_CATALOG.find(m => m.profileId === p?.id)
      const k = vendorKey(cat?.id ?? p?.id)
      if (!SKIP.has(k)) keys.add(k)
    }
    // 這台裝了哪些 AI：視窗在用的引擎、啟動器回報的 CLI；啟動器沒開放（沒有 profiles）就是「不知道」，不能當成沒裝
    const installedKeys = new Set()
    for (const f of mine) { const k = vendorKey(engineKey(f)); if (!SKIP.has(k)) installedKeys.add(k) }
    for (const p of profilesOf(launchers[node]) ?? []) {
      const cat = MODEL_CATALOG.find(m => m.profileId === p?.id)
      const k = vendorKey(cat?.id ?? p?.id)
      if (!SKIP.has(k)) installedKeys.add(k)
    }
    // 沒有啟動器回報、或本機偵測還沒跑完（detected: false）＝不知道，不能說「沒裝」
    const installedKnown = profilesOf(launchers[node]) !== null && launchers[node]?.detected !== false
    const installedOf = k => (installedKeys.has(k) ? true : (installedKnown ? false : null))
    const accts = {}
    if (isSelf) {
      accts.claude = (self.claude ?? []).map(a => ({ email: a.email, plan: a.plan, current: a.current === true, incomplete: loginIncomplete(a), quota: quotaView(a, now) }))
      if (accts.claude.length) keys.add('claude')
      accts.grok = (self.grok ?? []).map(a => ({ email: a.email, plan: '', current: a.current === true }))
      if (accts.grok.length) keys.add('grok')
      if (self.codex?.loggedIn) { keys.add('codex'); accts.codex = [{ email: self.codex.text, plan: '', current: true }] }
    } else if (rep && !rep.error) {
      for (const a of rep.accounts ?? []) {
        const k = vendorKey(a?.vendor)
        if (SKIP.has(k) || !a?.email) continue
        keys.add(k)
        ;(accts[k] ??= []).push({ email: a.email, plan: a.plan, current: a.current === true, incomplete: k === 'claude' && loginIncomplete(a), ...(k === 'claude' && loginFailed(a) ? { loginFailed: true } : {}), ...remoteQuota(k, a) })
      }
    }
    // Gemini（#374 之三）：不在各台的帳號回報裡，帳號與額度只在列表；認「哪台讀的」。這台有 Gemini 帳號才算有這個廠商
    if (!accts.gemini?.length) {
      const g = rosterAccountsOn(roster, 'gemini', node, { nodeLabel, now })
      if (g.length) { accts.gemini = g; keys.add('gemini') }
    }
    const ago = !isSelf && rep && !rep.error ? agoText(rep.reportedAt, now) : ''
    const vendors = [...keys].sort((a, b) => engineRank(a) - engineRank(b) || a.localeCompare(b)).map(k => {
      const list = accts[k] ?? []
      const v = accountView(list, { loggedOut: isSelf && (k === 'claude' || k === 'codex') })
      // Claude 與 Grok 的帳號能切換，而且對方電腦的 ASN 要在線、至少有兩個帳號
      const canPick = (k === 'claude' || k === 'grok') && !isSelf && list.length >= 2
      const switchable = canPick && rep?.asnOnline === true
      // pi：列出它背後用的廠商（Claude、DeepSeek…）；只有一家時圖示也換成那一家，對不到就維持 Pi 的圖與名字
      const via = k === 'pi' ? piBackends(mine) : []
      // 有 Gemini 但列表裡沒有它的帳號：還沒讀到額度，提示開 Gemini 視窗
      const note = k === 'gemini' && !list.length ? { note: ROSTER_TEXT.geminiOff } : {}
      // 這一家在這台的狀態（已登入／登入失效／已安裝還沒登入／沒登入／未安裝／還沒收到回報）：給「設備」頁用，帳號頁不看
      const st = vendorState({ isSelf, rep, accounts: list, installed: installedOf(k), now })
      const action = installAction({ vendor: k, isSelf, phone, online: isOn, asnOnline: rep?.asnOnline, state: st.state })
      return { key: k, label: vendorLabel(k), state: st.state, stateText: st.text, ...(st.reason ? { stateReason: st.reason } : {}), ...(action ? { action } : {}), ...note, ...(via.length ? { via: via.map(x => PI_VIA_LABEL[x]).join('、'), iconKey: via.length === 1 ? via[0] : 'pi' } : {}), account: v.text, reported: v.reported, extra: v.extra, accounts: list, switchable, switchHint: canPick && !switchable ? '對方電腦的 ASN 沒有在線，無法切換' : '' }
    })
    // 主要幾家 AI 這台沒用到的：本機偵測得到就說未安裝；別台看啟動器有沒有回報，沒回報就老實說不確定
    const have = new Set(vendors.map(v => v.key))
    const missing = (phone ? [] : CORE_VENDORS).filter(k => !have.has(k)).map(k => {
      const inst = installedOf(k)
      const fresh = isSelf || reportFreshness(rep, now) === 'fresh'
      const state = !fresh ? STATE.NO_REPORT : inst === false ? STATE.NOT_INSTALLED : STATE.UNKNOWN_INSTALL
      const action = installAction({ vendor: k, isSelf, phone, online: isOn, asnOnline: rep?.asnOnline, state })
      return { key: k, label: vendorLabel(k), state, stateText: STATE_TEXT[state], ...(action ? { action } : {}) }
    })
    return {
      key: node, label, self: isSelf, platform, phone, cloud, missing, stateLine: deviceStateLine({ vendors, missing, phone, online: isOn, self: isSelf }), hidden: isDeviceHidden(node, friends, { selfNode, shown }), removed: isDeviceRemoved(node, removed, { selfNode }), kind: phone ? '手機' : '電腦', kindLabel: deviceKindLabel({ kind: phone ? '手機' : '電腦', cloud }), online: isOn, onlineText: isOn ? '在線' : '離線',
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
