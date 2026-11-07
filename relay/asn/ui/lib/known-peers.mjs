// 設定頁「認得的電腦」（#597 別台看畫面，0.2.8 改版：不再手動配對）。判斷都在 Rust（device_id.rs），這裡只整理要顯示的東西。
// 兩台第一次連線時各自記住對方的設備金鑰；之後金鑰換了就拒絕並通知本人。這裡只能看、只能「忘記」，不能新增。
const clean = (s, n = 80) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').slice(0, n)

export const TEXT = {
  title: '認得的電腦',
  lead: '別台電腦第一次連到這台（例如看畫面）時，這台會記住它的設備金鑰並通知你。之後它的金鑰換了，這台會拒絕連線並再通知你。',
  none: '還沒有認得的電腦。',
  forget: '忘記這台',
  forgetNote: '只有你確定是自己重裝了那台、或不想再讓它連過來時才按。忘記之後，它下次連過來會當成第一次，並再通知你。',
  firstSeen: t => `第一次記住：${t}`,
  fingerprint: '指紋',
}

const ERR = [['紀錄壞了', '認得的電腦紀錄壞了，請告訴開發團隊。']]
export function errorText(e) {
  const s = String(e?.message ?? e ?? '')
  for (const [k, t] of ERR) if (s.includes(k)) return t
  return '操作沒有成功，請稍後再試。'
}

/** Rust 回的列表 → 畫面。欄位壞掉的丟掉 */
export function normalizeView(raw) {
  const arr = v => (Array.isArray(v) ? v : [])
  return {
    peers: arr(raw?.peers).filter(p => typeof p?.node === 'string' && p.node).map(p => ({
      node: p.node,
      name: clean(p.name) || '某台電腦',
      fingerprint: clean(p.fingerprint, 32),
      firstSeen: Number.isFinite(p.first_seen_ms) && p.first_seen_ms > 0 ? new Date(p.first_seen_ms).toLocaleString('zh-TW', { hour12: false }) : '',
    })),
  }
}
