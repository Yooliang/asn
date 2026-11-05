// 設定頁「配對的電腦」（#597）的畫面邏輯。配對的判斷都在 Rust（device_id.rs），這裡只整理要顯示的東西。
const clean = (s, n = 80) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').slice(0, n)

export const TEXT = {
  title: '配對的電腦',
  lead: '配對後，才能從別台看這台夥伴的畫面。每兩台要各自確認一次，可以過幾天再回另一台按。',
  startLabel: '和這台配對',
  start: '發起配對',
  pendingOut: name => `等你到「${name}」確認。請比對這組號碼，兩邊一樣才按確認（可以先用手機拍下）：`,
  pendingIn: name => `「${name}」想配對。確認後，它可以看這台夥伴的畫面（看的時候這台會顯示，也可以按結束）。請比對這組號碼，和那台一樣才按確認：`,
  confirm: '號碼相同，確認',
  reject: '不是我，拒絕',
  cancel: '撤回',
  dismiss: '知道了',
  revoke: '撤銷',
  noPeers: '還沒有配對的電腦。',
  peerCanView: '它可以看這台',
  iCanView: '這台可以看它',
  keyChanged: '這台電腦的金鑰變了，可能是重裝過。如果你沒有重裝它，不要確認。要重新配對，請先撤銷。',
  stale: '這筆是用這台舊的金鑰發起的，請對方重新發起。',
  pinWarn: '之後從別台看畫面時要先按 PIN 或指紋。你沒按「看畫面」卻跳出 PIN 提示，不要按。',
  status: {
    paired: '配對好了。',
    rejected: '對方拒絕了配對。',
    expired: '對方 7 天內沒有確認，這筆已經結束。',
    cancelled: '這筆已經撤回。',
    bad_signature: '對方的確認對不上，沒有配對。如果一直這樣，請先不要配對這台。',
    key_changed: '這台電腦的金鑰變了，沒有配對。要重新配對，請先在下面撤銷。',
  },
}

const ERR = [
  ['no_key', '那台電腦的 ASN 版本太舊，還不能配對。'],
  ['busy', '這台已經有一筆配對在等對方確認。'],
  ['rate_limited', '發起太多次了，請晚一點再試。'],
  ['forbidden', '只有你本人登入的電腦能配對。'],
  ['not_found', '這筆配對已經結束了。'],
  ['金鑰', null],
  ['尚未登入', '請先登入再配對。'],
]
export function errorText(e) {
  const s = String(e?.message ?? e ?? '')
  for (const [k, t] of ERR) if (s.includes(k)) return t ?? s
  return '操作沒有成功，請稍後再試。'
}

/** 後台和本機合起來的狀態 → 畫面。欄位壞掉的丟掉 */
export function normalizeView(raw) {
  const arr = v => (Array.isArray(v) ? v : [])
  const isId = v => typeof v === 'string' && v.length > 0
  return {
    peers: arr(raw?.peers).filter(p => isId(p?.node)).map(p => ({
      node: p.node, name: clean(p.name) || '某台電腦', fingerprint: clean(p.fingerprint, 40),
      peerCanViewMe: p.peer_can_view_me === true, iCanViewPeer: p.i_can_view_peer === true,
    })),
    incoming: arr(raw?.incoming).filter(r => isId(r?.id)).map(r => ({
      id: r.id, node: clean(r.from_node), name: clean(r.from_name) || '某台電腦', fingerprint: clean(r.fingerprint, 40),
      keyChanged: r.key_changed === true, stale: r.stale === true,
    })),
    outgoing: arr(r0(raw)).filter(r => isId(r?.id)).map(r => ({
      id: r.id, node: clean(r.to_node), name: clean(r.to_name) || '某台電腦', fingerprint: clean(r.fingerprint, 40), status: String(r.status ?? ''),
    })),
  }
}
function r0(raw) { return raw?.outgoing }

/** 可以配對的電腦：名單上別台、還沒配對、也沒有在等的。手機不列（這一版只做電腦） */
export function pairTargets(friends, selfNode, view) {
  const taken = new Set([...view.peers.map(p => p.node), ...view.outgoing.filter(o => o.status === 'pending').map(o => o.node)])
  const out = new Map()
  for (const f of Array.isArray(friends) ? friends : []) {
    if (!f?.node || f.node === selfNode || !f.device || taken.has(f.node) || f.phone === true || f.platform === 'android') continue
    if (!out.has(f.node)) out.set(f.node, { node: f.node, name: clean(f.device) })
  }
  return [...out.values()]
}

/** 這一輪新出現、要跳提醒的配對請求 */
export function newIncoming(view, seen) {
  return view.incoming.filter(r => !seen.has(r.id))
}
