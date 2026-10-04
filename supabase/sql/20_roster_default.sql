-- 20_roster_default.sql（2026-10-04，小良哥拍板）
-- 用邀請碼加入的節點（例如 Windows 收發室小程式裝好的電腦）預設就能回報「這台電腦上開了哪些 AI 視窗」（roster）與啟動設定。
-- 註冊（irori_relay_register，16_tenants.sql）沒有指定 can_roster，新節點吃欄位預設值；重新註冊的 on conflict 不動 can_roster。
-- 已存在的節點不改。可重複執行。退回：alter table relay.nodes alter column can_roster set default false;
alter table relay.nodes alter column can_roster set default true;
