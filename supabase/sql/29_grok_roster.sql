-- 29_grok_roster.sql：對雲端代理節點 grok（xAI Grok bot，relay/cloud-agent）開 can_roster，讓它能回報 roster、在 ASN 好友名單顯示成一個好友。
-- 背景：irori_relay_roster（04／19）只放行 can_invite 或 can_roster 的現役節點，否則 403 forbidden；
--   20_roster_default.sql 之後「新註冊」的節點預設 can_roster=true，所以只要 20 已套用，註冊後本來就會是 true，這支是明確補上、也涵蓋 20 沒套用的情況。
-- 套用時機：【節點 grok 註冊之後】執行才有作用（節點還不存在時是空操作，不會報錯，也不會替未來的節點預先開權限）。
--   重新註冊（on conflict）不會動 can_roster，所以只要跑一次。
-- 執行方式：npx supabase db query --linked -f supabase/sql/29_grok_roster.sql（可重複執行；supabase/sql 沒有自動套用，一律手動）
-- 回復：update relay.nodes set can_roster = false where id = 'grok';
update relay.nodes set can_roster = true where id = 'grok' and status = 'active';
