// 手機上的「認得的電腦」：看電腦畫面時確認那台的指紋、設定頁列出並忘記。
// 判斷（指紋對不對、記住哪一把）都在 Rust（device_id.rs、android.rs）；這裡只有要顯示的字、整理資料，和「確認、忘記之前先過本人確認」的流程。
// 本人確認＝生物辨識，沒設就用螢幕鎖（mobile-confirm.mjs 的 confirmWithToken）：先向 Rust 要一次性憑證（android_known_token），
// 外殼驗證通過才寫憑證檔，再帶著憑證叫 android_known_confirm／android_known_forget；Rust 核對憑證檔才動手。畫面只拿得到憑證字串，寫不了憑證檔。
// 另一條路是掃電腦設定頁上的 QR code（scan）：外殼開相機掃、本人確認後把掃到的字存進 App 私有資料夾，**畫面只拿得到狀態字，拿不到掃到的字**；
// 格式、節點與指紋由 Rust 判斷（android_known_scan_confirm 只收節點與憑證）。
import { confirmWithToken, scanFingerprint } from './mobile-confirm.mjs'
import { invoke as tauriInvoke } from './tauri.mjs'

const clean = (s, n = 80) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').trim().slice(0, n)

export const NO_LOCK_TEXT = '這支手機沒有設定螢幕鎖，請先設定再操作'

/** 這支手機上沒有名字的電腦一律叫這個 */
export const UNNAMED = '未命名的電腦'

/** 名字最多幾個字（和 Rust 端一致） */
export const NAME_MAX = 32

export const TEXT = {
  unnamed: UNNAMED,
  rename: '改名',
  renameSave: '儲存',
  renameCancel: '取消',
  renameLabel: '這台電腦的名字',
  renameHint: '只記在這支手機上；留空就是未命名。',
  stripTitle: '這台還沒確認指紋',
  stripButton: '確認指紋',
  methodBody: '請在那台電腦的設定頁按「顯示 QR code」，再用相機掃它；也可以改成用選的。',
  scanButton: '用相機掃電腦上的 QR code',
  scanFallback: '沒辦法掃，改用選的',
  scanMismatch: '掃到的指紋和這支手機記住的不一樣，可能被換過，已經擋下。請到設定 → 認得的電腦把它忘掉，再重新連線。',
  scanBad: '這不是 ASN 的指紋 QR code，請掃電腦設定頁上的那個。',
  scanNoCamera: '沒辦法用相機，改用選的。',
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

/** 整理名字：控制字元與改變文字方向的字元換成空白、去頭尾空白、最多 32 字（Rust 端還會再整理一次） */
export const cleanName = s => clean(s, NAME_MAX)

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
      const name = cleanName(p.name)
      // name＝本機記的名字（可能是空的，改名輸入框用）；label＝畫面上顯示的。沒名字顯示「未命名的電腦」，指紋只有確認過的才帶（沒確認的畫面不能知道）
      return { node: p.node, name, label: name || UNNAMED, fpShow: confirmed ? groupFp(p.fp) : '', confirmed }
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
export function makeKnownPeers({ confirm = challenge => confirmWithToken(challenge), scan = challenge => scanFingerprint(challenge), invoke = tauriInvoke } = {}) {
  // 回憑證字串（本人驗證過）或 null（取消）；沒設螢幕鎖丟說明。憑證每次都重要，不記住上一次的
  const gate = async (action, node) => {
    const challenge = await invoke('android_known_token', { action, node })
    if (typeof challenge !== 'string' || !challenge) throw new Error('no_token')
    const r = await confirm(challenge)
    if (r === 'ok') return challenge
    if (r === 'no_lock') throw new Error(NO_LOCK_TEXT)
    return null
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
      // name＝這支手機本機記的名字：有就用它（可能是空字串＝未命名），沒有這欄才退回畫面上原有的名字
      return { state: 'ok', id: r.id, options: options.map(String), localName: typeof r.name === 'string' ? cleanName(r.name) : null }
    },
    /**
     * 本人選了第 index 個（-1＝都不一樣）。回 'wrong'｜'none'｜'expired'（題目已收掉）｜'locked'｜'blocked'（Rust 說現在不能答）｜
     * 選對時先過本人確認：'cancel'（取消，沒記住）｜'done'（記住了）｜'not_ready'（Rust 沒記到：金鑰換了、被忘記、過了 60 秒、憑證不對）。
     * 哪一個是對的只有 Rust 知道，這裡只送選了第幾個（node＝這台電腦的節點，要憑證用）
     */
    pick: async (id, index, node) => {
      if (!id || !Number.isInteger(index) || index < -1 || index > 3) return 'expired'
      const r = await invoke('android_known_answer', { id, pick: index })
      if (r === 'wrong' || r === 'none' || r === 'expired' || r === 'locked' || r === 'blocked') return r
      if (r !== 'right') throw new Error('unexpected')
      if (!node) return 'not_ready'
      const challenge = await gate('confirm', node)
      if (!challenge) return 'cancel'
      return (await invoke('android_known_confirm', { id, challenge })) === true ? 'done' : 'not_ready'
    },
    /** 回 'done'｜'cancel' */
    forget: async node => {
      if (!node) return 'cancel'
      const challenge = await gate('forget', node)
      if (!challenge) return 'cancel'
      await invoke('android_known_forget', { node, challenge })
      return 'done'
    },
    /**
     * 掃電腦設定頁上的 QR code 核對指紋。只收節點；掃到的字不會到這裡（外殼存給 Rust，Rust 判斷）。
     * 回 'done'（一樣，已記住）｜'cancel'（取消，什麼都沒做）｜'no_camera'（相機權限被拒或沒有相機：改用選的）｜
     * 'mismatch'（掃到的不一樣，已擋下）｜'bad_qr'（不是 ASN 的指紋 QR code）｜'blocked'／'locked'（這台被擋住或鎖住，不開相機）｜'not_ready'（還沒記住這台、憑證不對或過期）
     */
    scan: async node => {
      if (!node) return 'cancel'
      let challenge
      try { challenge = await invoke('android_known_token', { action: 'scan', node }) } catch (e) {
        const m = String(e?.message ?? e)
        if (m === 'blocked' || m === 'locked' || m === 'not_ready') return m
        throw e
      }
      if (typeof challenge !== 'string' || !challenge) throw new Error('no_token')
      const st = await scan(challenge)
      if (st === 'no_lock') throw new Error(NO_LOCK_TEXT)
      if (st === 'denied' || st === 'no_camera') return 'no_camera'
      if (st === 'bad_qr') return 'bad_qr'
      if (st !== 'ok') return 'cancel'
      const out = await invoke('android_known_scan_confirm', { node, challenge })
      if (out === 'ok') return 'done'
      if (out === 'mismatch' || out === 'bad_qr' || out === 'blocked' || out === 'locked') return out
      if (out === 'not_verified') return 'not_ready'
      throw new Error('unexpected')
    },
    /** 替這台改名（只記在這支手機；不影響信任，所以不用本人確認）。空字串＝未命名。回有沒有改到 */
    rename: async (node, name) => {
      if (!node) return false
      return (await invoke('android_known_rename', { node, name: cleanName(name) })) === true
    },
  }
}

export const knownPeers = makeKnownPeers()
