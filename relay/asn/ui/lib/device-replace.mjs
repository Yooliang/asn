// 新設備第一次連上時「是不是取代舊的」卡片（#1860 H PR-2；電腦設定→設備、手機設定→設備共用）。
// 文字只有這一份；卡片的資料整理（view）、操作流程（flow）也只有這一份，兩邊的畫面只負責把它畫出來。
// 畫面上不出現節點代號與 email：節點只留在 view 的 node 欄位給按鈕回呼用，模板不畫它。
import { isPhoneDevice } from './node-platform.mjs'
import { agoText } from './cloud-invite.mjs'

export const REPLACE_TEXT = {
  title: phone => `有一台新的${phone ? '手機' : '電腦'}連上了`,
  intro: name => `「${name}」是第一次連上。它是用來取代哪一台嗎？`,
  keep: '不是，兩台都留',
  replace: name => `取代 ${name}`,
  explain: name => `取代後，${name} 會移到「已移除的設備」，可以恢復；新的這台沿用「${name}」這個名字。`,
  candidateAria: name => `選擇要取代「${name}」`,
  offline: '離線中',
  lastSeen: ago => `離線中 · 最後在線 ${ago}`,
  busy: '處理中…',
  doneRenamed: name => `已取代：「${name}」移到「已移除的設備」，新的這台沿用這個名字。`,
  doneKeptName: name => `已取代：「${name}」移到「已移除的設備」，新的這台保留目前的名字。`,
  doneAlready: '這台新設備已經處理過了。',
  doneKept: '好的，兩台都留，之後不再問這台。',
  failed: '沒有成功，請稍後再試。',
  needLogin: '要先登入 ASN 帳號才能處理新設備。',
}

/** 離線多久的白話：不到一個月寫天，之後寫個月、年（沿用 cloud-invite 的分鐘／小時／天） */
export function lastSeenText(iso, now = Date.now()) {
  const t = Date.parse(iso ?? '')
  if (!Number.isFinite(t)) return REPLACE_TEXT.offline
  const days = Math.floor(Math.max(0, now - t) / 86400000)
  if (days < 30) return REPLACE_TEXT.lastSeen(agoText(new Date(t).toISOString(), now))
  if (days < 365) return REPLACE_TEXT.lastSeen(`${Math.floor(days / 30)} 個月前`)
  return REPLACE_TEXT.lastSeen(`${Math.floor(days / 365)} 年前`)
}

const str = v => (typeof v === 'string' ? v.trim() : '')

/** 後台回的 { cards } 整理成能直接畫的卡片；沒有卡、或卡上沒有候選就不出。pick＝新設備節點 → 選中的舊設備節點（沒選＝第一個） */
export function replaceCardsView(raw, { now = Date.now(), pick = {} } = {}) {
  const cards = Array.isArray(raw?.cards) ? raw.cards : Array.isArray(raw) ? raw : []
  const out = []
  for (const c of cards) {
    const node = str(c?.node)
    const cands = (Array.isArray(c?.candidates) ? c.candidates : [])
      .filter(x => str(x?.node))
      .map(x => ({ node: str(x.node), label: str(x.name) || '舊設備', line: lastSeenText(x.last_seen, now) }))
    if (!node || !cands.length) continue
    const name = str(c.name) || '新設備'
    const sel = cands.some(x => x.node === pick[node]) ? pick[node] : cands[0].node
    const selLabel = cands.find(x => x.node === sel).label
    out.push({
      node, phone: isPhoneDevice({ platform: str(c.platform) }), name, sel,
      title: REPLACE_TEXT.title(isPhoneDevice({ platform: str(c.platform) })), intro: REPLACE_TEXT.intro(name),
      candidates: cands, keepLabel: REPLACE_TEXT.keep, replaceLabel: REPLACE_TEXT.replace(selLabel), explain: REPLACE_TEXT.explain(selLabel),
    })
  }
  return out
}

/** 取代成功後畫面上留一句話（renamed＝後台有沒有把舊名字搬給新設備） */
export const replaceDoneNote = ({ already, renamed }, oldName) => (already ? REPLACE_TEXT.doneAlready : renamed ? REPLACE_TEXT.doneRenamed(oldName) : REPLACE_TEXT.doneKeptName(oldName))

const msgOf = e => String(e?.message ?? e ?? '')

/**
 * 取代後把帳號層的設備設定拉回來：後台已經把舊設備寫進「已移除」並把 rev 往前推，這裡當成「從後台拉到的新版」併入（adoptRemote），
 * 不是本機改完再推——否則推送會撞後台的冷卻。接著重讀名單，新設備的名字才會立刻更新。任何一步失敗只記 log（下一輪輪詢會補上）
 */
export async function syncAfterReplace({ getPrefs, devSync, refreshRoster, log = console.info }) {
  try {
    const r = await getPrefs()
    if (r?.prefs && !devSync.adoptRemote(r.prefs)) log('[ASN] 取代後後台的設備設定沒有比本機新，等下一輪同步')
  } catch (e) { log('[ASN] 取代後讀不到帳號的設備設定', msgOf(e)) }
  try { await refreshRoster() } catch (e) { log('[ASN] 取代後重讀名單沒成功', msgOf(e)) }
}

/**
 * 卡片的操作流程（電腦與手機共用）。state 是會被改的 reactive 物件：{ raw, pick, busy, error, note }。
 * api＝{ candidates(), replace(newNode, oldNode), dismiss(newNode) }；afterReplace(oldNode) 由呼叫端交（同步設定與名單）。
 */
export function createReplaceFlow({ state, api, afterReplace = async () => {}, log = console.info, now = () => Date.now() }) {
  const fail = (what, e) => { log(`[ASN] ${what}沒成功`, msgOf(e)); state.error = msgOf(e) || REPLACE_TEXT.failed }
  async function load() {
    try {
      state.raw = await api.candidates()
    } catch (e) {
      // 沒登入或後台暫時不通時沒有卡可出；卡片是偶爾才出現的提示，不為它在設備頁放一條常駐錯誤，原文寫 log
      log('[ASN] 讀不到新設備卡片', msgOf(e))
    }
  }
  const view = () => replaceCardsView(state.raw, { now: now(), pick: state.pick })
  const choose = (newNode, oldNode) => { state.pick = { ...state.pick, [newNode]: oldNode } }
  async function replace(newNode, oldNode) {
    if (state.busy) return false
    const card = view().find(c => c.node === newNode)
    const old = card?.candidates.find(c => c.node === oldNode)
    if (!card || !old) return false
    state.busy = newNode; state.error = ''; state.note = ''
    try {
      const r = await api.replace(newNode, oldNode)
      state.note = replaceDoneNote({ already: r?.already === true, renamed: r?.renamed === true }, old.label)
    } catch (e) { fail('取代', e); state.busy = ''; return false }
    try { await afterReplace(oldNode, newNode) } catch (e) { log('[ASN] 取代後更新畫面沒成功', msgOf(e)) }
    await load()
    state.busy = ''
    return true
  }
  async function dismiss(newNode) {
    if (state.busy) return false
    state.busy = newNode; state.error = ''; state.note = ''
    try {
      await api.dismiss(newNode)
      state.note = REPLACE_TEXT.doneKept
    } catch (e) { fail('不取代', e); state.busy = ''; return false }
    await load()
    state.busy = ''
    return true
  }
  return { load, view, choose, replace, dismiss }
}

export const newReplaceState = () => ({ raw: null, pick: {}, busy: '', error: '', note: '' })
