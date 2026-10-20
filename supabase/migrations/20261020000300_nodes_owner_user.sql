-- 帳號對應設備：節點可認領到一個登入帳號（auth.users）。
-- null＝舊節點尚未認領。先只加欄位與索引，登入／認領流程之後再做。
alter table relay.nodes
  add column owner_user uuid references auth.users (id) on delete set null;
create index nodes_owner_user_idx on relay.nodes (owner_user) where owner_user is not null;
