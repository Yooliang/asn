import { displayDeviceName, unnamedLabelOf } from './device-known.mjs'
// 設定頁「認得的電腦」（#597 別台看畫面，0.2.8 改版：不再手動配對）。判斷都在 Rust（device_id.rs），這裡只整理要顯示的東西。
// 兩台第一次連線時各自記住對方的設備金鑰；之後金鑰換了就拒絕並通知本人。這裡只能看、只能「忘記」，不能新增。
export const clean = (s, n = 80) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').slice(0, n)

export const NAME_MAX = 40

// 提示句裡的設備名：有名字寫「X」，沒有就寫「這台設備」
const nameOf = label => { const n = String(label ?? '').trim(); return n ? `「${n}」` : '這台設備' }

/** 這台是不是被擋下（同一個代號換了金鑰、指紋對不上）：只看紀錄上的 blocked 旗標，電腦手機同一個判斷 */
export const isBlockedPeer = peer => peer?.blocked === true

export const TEXT = {
  title: '認得的電腦',
  lead: '別台電腦第一次連到這台（例如看畫面）時，這台會記住它的設備金鑰並通知你。之後它的金鑰換了，這台會拒絕連線並再通知你。',
  none: '還沒有認得的電腦。',
  forgetTitle: '忘記這台設備？',
  forgetYes: '忘記',
  forgetCancel: '取消',
  // 忘記前的確認句：沒名字就不寫名字、沒指紋就不寫括號（指紋取畫面上分組顯示的前兩組）
  forgetConfirm: (label, fp) => {
    const name = String(label ?? '').trim()
    const g = String(fp ?? '').replace(/\s+/g, '').slice(0, 8).replace(/(.{4})(?=.)/, '$1 ')
    return `忘記${name ? `「${name}」` : '這台設備'}${g ? `（指紋 ${g}）` : ''}？之後這台再連上，要重新確認指紋。`
  },
  // 「重新認這台」（#1860 C）：只有那台指紋對不上、被擋下時才出現；行為同「忘記」——清掉記住的指紋，下次當第一次
  reaccept: '重新認這台',
  reacceptTitle: '重新認這台設備？',
  reacceptYes: '重新認',
  reacceptNotice: label => {
    const who = nameOf(label)
    return `${who}的指紋和之前不一樣，已經擋下。只有你剛重灌或換掉它時才按「重新認這台」。如果你沒動過它，不要按，並告訴管理的人。`
  },
  reacceptConfirm: label => `重新認${nameOf(label)}？按下去會清掉記住的指紋，它下次連上來會當成第一次，並再通知你。只有你剛重灌或換掉它時才按；如果你沒動過它，不要按，並告訴管理的人。`,
  blockedTag: '已擋下',
  firstSeen: t => `第一次見到：${t}`,
  fingerprint: '指紋',
  ownFp: fp => `這台電腦的指紋：${groupFp(fp)}`,
  loginOk: '允許這支手機替這台登入（Codex 等）',
  loginOkWarn: '勾了之後，這支手機可以要求這台登入別家的 CLI；登入網址和代碼只會加密送到那支手機。只勾你自己的手機。',
}

const ERR = [['紀錄壞了', '記住的設備紀錄壞了，請告訴開發團隊。']]
/** 給人核對的完整指紋：每 4 個字一組（和手機上顯示的一樣） */
export const groupFp = fp => String(fp ?? '').replace(/\s+/g, '').match(/.{1,4}/g)?.join(' ') ?? ''

export function errorText(e) {
  const s = String(e?.message ?? e ?? '')
  for (const [k, t] of ERR) if (s.includes(k)) return t
  return '操作沒有成功，請稍後再試。'
}

/**
 * 「忘記」先確認：ask 記下要忘記的那筆（box.value），yes 才送 known-forget、no 只關掉。
 * box 是 { value }（元件裡用 ref）；forget(id) 由設定頁接成 act('known-forget', id)。
 */
export function createForgetConfirm({ box, forget }) {
  return {
    ask: rec => { if (rec?.id) box.value = { id: rec.id, text: TEXT.forgetConfirm(rec.label, rec.fingerprint), title: TEXT.forgetTitle, yes: TEXT.forgetYes } },
    // 被擋下的那台：同樣清掉記住的指紋，只是問法與按鈕字不同
    askReaccept: rec => { if (rec?.id) box.value = { id: rec.id, text: TEXT.reacceptConfirm(rec.label), title: TEXT.reacceptTitle, yes: TEXT.reacceptYes } },
    yes: () => { const r = box.value; box.value = null; if (r) forget(r.id) },
    no: () => { box.value = null },
  }
}

/** Rust 回的列表 → 畫面。欄位壞掉的丟掉 */
export function normalizeView(raw) {
  const arr = v => (Array.isArray(v) ? v : [])
  return {
    peers: arr(raw?.peers).filter(p => typeof p?.node === 'string' && p.node).map(p => ({
      node: p.node,
      name: clean(p.name, NAME_MAX).trim(),   // 後台的設備名（可能是空的）
      label: displayDeviceName(clean(p.name, NAME_MAX)) || unnamedLabelOf(p.node),   // 畫面上顯示的：像指紋的名字、舊的「未命名的電腦」都當沒名字，改寫辨認線索（#1829）
      fingerprint: clean(p.fingerprint, 32),
      loginOk: p.login_ok === true,
      ...(p.blocked === true ? { blocked: true } : {}),   // 指紋對不上、已被擋下（Rust 在列表裡帶 blocked 才有；沒帶就是沒被擋）
      firstSeenMs: Number.isFinite(p.first_seen_ms) && p.first_seen_ms > 0 ? p.first_seen_ms : 0,
      firstSeen: Number.isFinite(p.first_seen_ms) && p.first_seen_ms > 0 ? new Date(p.first_seen_ms).toLocaleString('zh-TW', { hour12: false }) : '',
    })),
  }
}
