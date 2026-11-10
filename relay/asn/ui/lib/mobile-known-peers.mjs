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
  sheetBody: fp => `請到那台電腦的設定頁，確認那裡顯示的這台電腦指紋是 ${fp}（16 個字全部一樣）。一樣再按「記住這台」。`,
  remember: '記住這台',
  decline: '不要',
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
  mismatch: '指紋對不上，沒有記住。請關掉再重新看一次。',
  failed: '操作沒有成功，請稍後再試。',
}

/** 和電腦版同一種寫法：名字後面接「（指紋 xxxxxxxx）」（辨認用的前 8 碼） */
export const fpSuffix = fp8 => `（指紋 ${fp8}）`

/** 給人核對的完整指紋：16 個字元每 4 個一組（和電腦版設定頁一樣）。不是 16 個十六進位字元就回空字串 */
export const groupFp = fp => (FP16.test(String(fp ?? '')) ? String(fp).match(/.{4}/g).join(' ') : '')

const FP16 = /^[0-9a-f]{16}$/

/**
 * Rust 回的「開始看」資料 → 這台電腦的指紋狀態。fp 不是 16 個小寫十六進位字元就當沒有（不顯示確認條）。
 * fp8 一律從 fp 切，不信另外傳來的字。name 是畫面上顯示用的名字（只當文字顯示）
 */
export function peerOf(started, name = '') {
  const fp = typeof started?.fp === 'string' ? started.fp : ''
  const node = typeof started?.node === 'string' ? started.node : ''
  if (!FP16.test(fp) || !node) return null
  return { node, fp, fp8: fp.slice(0, 8), fpShow: groupFp(fp), confirmed: started?.confirmed === true, name: clean(name) || '那台電腦' }
}

/** 要不要顯示「還沒確認指紋」的條 */
export const needsConfirm = peer => !!peer && peer.confirmed !== true

/** Rust 回的設定頁列表 → 畫面。欄位壞掉的丟掉；只有名字、指紋前 8 碼、有沒有確認 */
export function normalizeList(raw) {
  const arr = Array.isArray(raw?.peers) ? raw.peers : []
  return arr
    .filter(p => typeof p?.node === 'string' && p.node && FP16.test(String(p?.fp ?? '')))
    .map(p => ({ node: p.node, name: clean(p.name) || '某台電腦', fpShow: groupFp(p.fp), confirmed: p.confirmed === true }))
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
    /** 回 'done'（記住了）｜'cancel'（本人取消）｜'not_ready'（Rust 說沒記到：還沒記住那台，或指紋對不上） */
    remember: async peer => {
      if (!peer?.node || !FP16.test(String(peer?.fp ?? ''))) return 'not_ready'
      if (!(await gate())) return 'cancel'
      return (await invoke('android_known_confirm', { node: peer.node, fp: peer.fp })) === true ? 'done' : 'not_ready'
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
