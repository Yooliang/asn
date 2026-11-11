// 手機上的「認得的電腦」：看電腦畫面時確認那台的指紋、設定頁列出並忘記。
// 判斷（指紋對不對、記住哪一把）都在 Rust（device_id.rs、android.rs）；這裡只有要顯示的字、整理資料，和「確認、忘記之前先過本人確認」的流程。
// 本人確認＝生物辨識，沒設就用螢幕鎖（mobile-confirm.mjs 的 confirmViewer，和看畫面前同一個）。
import { confirmViewer } from './mobile-confirm.mjs'
import { invoke as tauriInvoke } from './tauri.mjs'

const clean = (s, n = 80) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').trim().slice(0, n)

export const NO_LOCK_TEXT = '這支手機沒有設定螢幕鎖，請先設定再操作'

export const TEXT = {
  stripTitle: '這台還沒確認指紋',
  stripButton: '確認指紋',
  sheetTitle: name => `確認「${name}」的指紋`,
  sheetBody: '請看那台電腦的設定頁，選出和那裡顯示的「這台電腦的指紋」完全一樣的那一組。',
  noneOption: '都不一樣',
  cancel: '取消',
  wrong: '選的和電腦上顯示的不一樣，這次沒有記住。10 分鐘後才能再確認。',
  locked: n => `答錯過一次，請 ${n} 分鐘後再確認。`,
  lockedNow: '答錯過一次，請稍後再確認。',
  blocked: '這台的指紋兩次對不上，可能被換過。請到設定 → 認得的電腦把它忘掉，再重新連線。',
  noneMatch: '這台電腦的金鑰可能被換過，請不要記住，並告訴管理的人。要到設定 → 認得的電腦把它忘掉，才能重新確認。',
  expired: '太久沒選，請重新按「確認指紋」。',
  settingTitle: '認得的電腦',
  settingLead: '看過的電腦會記在這支手機上。確認過指紋的，才放心讓它接受這支手機的操作。',
  none: '還沒有認得的電腦。',
  fp: fp => `指紋 ${fp}`,
  confirmed: '已確認',
  unconfirmed: '還沒確認',
  forget: '忘記',
  forgetNote: '只有你確定是那台重灌、換了電腦，或不想再看它時才按。忘記之後，下次連上去會當成第一次。',
  noneSummary: '還沒有認得的電腦',
  summary: n => `${n} 台`,
  notReady: '還沒記住這台電腦，請等畫面出來再按一次。',
  failed: '操作沒有成功，請稍後再試。',
}

/** 和電腦版同一種寫法：名字後面接「（指紋 xxxxxxxx）」（辨認用的前 8 碼） */
export const fpSuffix = fp8 => `（指紋 ${fp8}）`

/** 給人核對的完整指紋：16 個字元每 4 個一組（和電腦版設定頁一樣）。不是 16 個十六進位字元就回空字串 */
export const groupFp = fp => (FP16.test(String(fp ?? '')) ? String(fp).match(/.{4}/g).join(' ') : '')

const FP16 = /^[0-9a-f]{16}$/
const OPTION = /^[0-9a-f]{4}( [0-9a-f]{4}){3}$/

/**
 * Rust 回的「開始看」資料 → 這台電腦的確認狀態。只要有節點就算（不帶指紋：沒確認的電腦，畫面不能知道它的指紋）。
 * name 是畫面上顯示用的名字（只當文字顯示）
 */
export function peerOf(started, name = '') {
  const node = typeof started?.node === 'string' ? started.node : ''
  if (!node) return null
  return { node, confirmed: started?.confirmed === true, name: clean(name) || '那台電腦' }
}

/** 要不要顯示「還沒確認指紋」的條 */
export const needsConfirm = peer => !!peer && peer.confirmed !== true

/** Rust 回的設定頁列表 → 畫面。欄位壞掉的丟掉；指紋只有確認過的才有（沒確認的 fpShow 是空字串，不顯示） */
export function normalizeList(raw) {
  const arr = Array.isArray(raw?.peers) ? raw.peers : []
  return arr
    .filter(p => typeof p?.node === 'string' && p.node)
    .map(p => {
      const confirmed = p.confirmed === true
      return { node: p.node, name: clean(p.name) || '某台電腦', fpShow: confirmed ? groupFp(p.fp) : '', confirmed }
    })
}

/** 設置分頁那一列的摘要 */
export const listSummary = n => (Number.isInteger(n) && n > 0 ? TEXT.summary(n) : TEXT.noneSummary)

export function errorText(e) {
  const s = String(e?.message ?? e ?? '')
  if (s.includes('螢幕鎖')) return s
  return TEXT.failed
}

/**
 * 確認、忘記要做的事。confirm、invoke 可以注入（測試用）。
 * 每次都先過本人確認（'ok' 才繼續；'cancel' 什麼都不送；'no_lock' 丟沒設螢幕鎖的說明），不記住上一次的結果。
 */
export function makeKnownPeers({ confirm = () => confirmViewer(), invoke = tauriInvoke } = {}) {
  const gate = async () => {
    const r = await confirm()
    if (r === 'ok') return true
    if (r === 'no_lock') throw new Error(NO_LOCK_TEXT)
    return false
  }
  return {
    list: async () => normalizeList(await invoke('android_known_list')),
    /**
     * 出四選一的題目：回 { state:'ok', id, options:[4 組分組指紋] }｜{ state:'locked', minutes }（答錯過一次，鎖住中）｜{ state:'blocked' }（答錯兩次，要忘記那台才能重來）；
     * 那台還沒記住或格式不對回 null。四個選項對同一台電腦每次都一樣，由 Rust 固定
     */
    challenge: async peer => {
      if (!peer?.node) return null
      let r
      try { r = await invoke('android_known_challenge', { node: peer.node }) } catch (e) {
        if (String(e?.message ?? e) === 'not_ready') return null
        throw e
      }
      if (r?.state === 'blocked') return { state: 'blocked' }
      if (r?.state === 'locked') return { state: 'locked', minutes: Number.isInteger(r.minutes) && r.minutes > 0 ? r.minutes : 10 }
      if (r?.state !== 'ok') return null
      const options = Array.isArray(r?.options) ? r.options : []
      if (typeof r?.id !== 'string' || !r.id || options.length !== 4 || !options.every(o => OPTION.test(String(o)))) return null
      return { state: 'ok', id: r.id, options: options.map(String) }
    },
    /**
     * 本人選了第 index 個（-1＝都不一樣）。回 'wrong'｜'none'｜'expired'（題目已收掉）｜'locked'｜'blocked'（Rust 說現在不能答）｜
     * 選對時先過本人確認：'cancel'（取消，沒記住）｜'done'（記住了）｜'not_ready'（Rust 沒記到：金鑰換了、被忘記、過了 60 秒）。
     * 哪一個是對的只有 Rust 知道，這裡只送選了第幾個
     */
    pick: async (id, index) => {
      if (!id || !Number.isInteger(index) || index < -1 || index > 3) return 'expired'
      const r = await invoke('android_known_answer', { id, pick: index })
      if (r === 'wrong' || r === 'none' || r === 'expired' || r === 'locked' || r === 'blocked') return r
      if (r !== 'right') throw new Error('unexpected')
      if (!(await gate())) return 'cancel'
      return (await invoke('android_known_confirm', { id })) === true ? 'done' : 'not_ready'
    },
    /** 回 'done'｜'cancel' */
    forget: async node => {
      if (!node) return 'cancel'
      if (!(await gate())) return 'cancel'
      await invoke('android_known_forget', { node })
      return 'done'
    },
  }
}

export const knownPeers = makeKnownPeers()
