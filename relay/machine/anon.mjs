// Realtime 門鈴用的 anon 公開金鑰：內建新後台的那把，用戶端不必再另外放 anon.key。
// anon 是公開金鑰（任何網頁前端都看得到），可以寫進程式；節點金鑰才是秘密，不在這裡。
// 規則：環境變數 ASN_RELAY_ANON_KEY → anon.key 檔 → 內建；但候選金鑰的專案代號（JWT 的 ref）
// 跟後台網址的專案對不上就跳過（例如切換後殘留的舊 Irori 專案 anon.key），改用內建的。
export const BUILTIN_ANON = {
  etccgmkrosbzpltudlgt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV0Y2NnbWtyb3NienBsdHVkbGd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI0OTk0MDUsImV4cCI6MjEwODA3NTQwNX0.2ew035D3LOskYGxCG2ryIaXz-U9BJcUFXtMKuSCo6QA',
}

// 後台網址 https://<ref>.supabase.co/... → ref；不是 supabase.co 回 ''
export function projectRef(baseUrl) {
  try {
    const h = new URL(baseUrl).hostname
    const m = /^([a-z0-9]{20})\.supabase\.co$/.exec(h)
    return m ? m[1] : ''
  } catch { return '' }
}

// JWT 第二段的 ref；不是 JWT（例如 sb_publishable_…）回 ''
export function anonRef(key) {
  const p = String(key || '').split('.')
  if (p.length !== 3) return ''
  try { return String(JSON.parse(Buffer.from(p[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).ref || '') } catch { return '' }
}

// candidates：依優先順序的候選（空字串略過）；回傳要用的 anon 金鑰，沒有就 ''
export function pickAnon(baseUrl, candidates) {
  const ref = projectRef(baseUrl)
  for (const c of candidates) {
    const k = String(c || '').trim()
    if (!k) continue
    const r = anonRef(k)
    if (!ref || !r || r === ref) return k   // 認不出專案時照用（自架或非 JWT 金鑰）
  }
  return BUILTIN_ANON[ref] || ''
}
