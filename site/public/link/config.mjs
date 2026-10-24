// 核准頁的固定設定。全部是公開資訊：後台網址，與 Supabase 的 anon 公開金鑰（任何網頁前端都看得到，
// 與 relay/asn/src-tauri/src/identity.rs 的 DEFAULT_URL／BUILTIN_ANON 同值；tests/approve_page.test.mjs 會比對兩邊一致）。
export const SITE_ORIGIN = "https://asnmessenger.web.app"
export const RELAY_URL = "https://etccgmkrosbzpltudlgt.supabase.co/functions/v1/relay"
export const AUTH_BASE = "https://etccgmkrosbzpltudlgt.supabase.co"
export const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV0Y2NnbWtyb3NienBsdHVkbGd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI0OTk0MDUsImV4cCI6MjEwODA3NTQwNX0.2ew035D3LOskYGxCG2ryIaXz-U9BJcUFXtMKuSCo6QA"
