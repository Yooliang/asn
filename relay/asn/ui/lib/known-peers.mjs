import { displayDeviceName } from './device-known.mjs'
// 設定頁「認得的電腦」（#597 別台看畫面，0.2.8 改版：不再手動配對）。判斷都在 Rust（device_id.rs），這裡只整理要顯示的東西。
// 兩台第一次連線時各自記住對方的設備金鑰；之後金鑰換了就拒絕並通知本人。這裡只能看、只能「忘記」，不能新增。
const clean = (s, n = 80) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').slice(0, n)

/** 沒有名字的電腦一律叫這個，旁邊照樣顯示完整指紋讓本人核對 */
export const UNNAMED = '未命名的電腦'
export const NAME_MAX = 40

export const TEXT = {
  unnamed: UNNAMED,
  title: '認得的電腦',
  lead: '別台電腦第一次連到這台（例如看畫面）時，這台會記住它的設備金鑰並通知你。之後它的金鑰換了，這台會拒絕連線並再通知你。',
  none: '還沒有認得的電腦。',
  forget: '忘記這台',
  forgetNote: '只有你確定是自己重裝了那台、或不想再讓它連過來時才按。忘記之後，它下次連過來會當成第一次，並再通知你。',
  forgetTitle: '忘記這台電腦？',
  forgetYes: '忘記',
  forgetCancel: '取消',
  // 忘記前的確認句：沒名字就不寫名字、沒指紋就不寫括號（指紋取畫面上分組顯示的前兩組）
  forgetConfirm: (label, fp) => {
    const name = String(label ?? '').trim()
    const g = String(fp ?? '').replace(/\s+/g, '').slice(0, 8).replace(/(.{4})(?=.)/, '$1 ')
    return `忘記${name && name !== UNNAMED ? `「${name}」` : '這台電腦'}${g ? `（指紋 ${g}）` : ''}？之後這台再連上，要重新確認指紋。`
  },
  firstSeen: t => `第一次見到：${t}`,
  fingerprint: '指紋',
  ownFp: fp => `這台電腦的指紋：${groupFp(fp)}`,
  inputNoAsk: '這台要在這裡打字時，不用每次問我',
  inputNoAskWarn: '這台打字時不會再跳出「允許」，但紅條照樣會出現，可以按結束。想每次都問，就取消勾選。',
  inputFirstAsk: '這台第一次在這裡打字時，還是會問你一次。',
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
    ask: rec => { if (rec?.id) box.value = { id: rec.id, text: TEXT.forgetConfirm(rec.label, rec.fingerprint) } },
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
      label: displayDeviceName(clean(p.name, NAME_MAX)) || UNNAMED,   // 畫面上顯示的（像指紋的名字當未命名）
      fingerprint: clean(p.fingerprint, 32),
      inputNoAsk: p.input_no_ask === true,
      inputConfirmed: p.input_confirmed === true,
      loginOk: p.login_ok === true,
      firstSeen: Number.isFinite(p.first_seen_ms) && p.first_seen_ms > 0 ? new Date(p.first_seen_ms).toLocaleString('zh-TW', { hour12: false }) : '',
    })),
  }
}
