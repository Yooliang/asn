-- 04_roster.sql：roster 回報權限與邀請權限分開。
-- 用途：Aegis 轉接橋（節點 aegis）與 w02 需要回報成員／視窗名單，但不該有邀請權（can_invite）。
--   新增 relay.nodes.can_roster；irori_relay_roster 改成 can_invite 或 can_roster 都可回報；並開給 w02、aegis。
-- 執行方式：npx supabase db query --linked -f supabase/sql/04_roster.sql（可重複執行）
-- 權限：create or replace function 會保留原函式既有的 grant／revoke（只有 service_role 能執行），不必重複。

alter table relay.nodes add column if not exists can_roster boolean not null default false;

create or replace function public.irori_relay_roster(p_node text, p_agents jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_n int;
begin
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active' and (can_invite or can_roster)) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_agents is null or jsonb_typeof(p_agents) <> 'array' or jsonb_array_length(p_agents) > 100 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_agents) a
    where jsonb_typeof(a) <> 'object' or jsonb_typeof(a->'name') is distinct from 'string'
       or char_length(a->>'name') not between 1 and 60
       or char_length(coalesce(a->>'status', '')) > 20 or char_length(coalesce(a->>'cwd_label', '')) > 80
  ) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  delete from relay.roster where node = p_node;
  -- same name twice in one report: the last one wins
  insert into relay.roster (node, name, status, cwd_label)
    select distinct on (a.v->>'name') p_node, a.v->>'name', nullif(a.v->>'status', ''), nullif(a.v->>'cwd_label', '')
    from jsonb_array_elements(p_agents) with ordinality as a(v, ord)
    order by a.v->>'name', a.ord desc;
  get diagnostics v_n = row_count;
  return jsonb_build_object('count', v_n);
end;
$$;

update relay.nodes set can_roster = true where id in ('w02','aegis');
