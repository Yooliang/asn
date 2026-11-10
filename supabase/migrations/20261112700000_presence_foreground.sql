-- #1281：推播把手機 App 喚醒時會寫一筆在線，之後 3 分鐘內的信就不再推。
-- 做法：asn_presence 多一欄 fg_at（最後一次「在前景」的時間），只給推播判斷（asn_relay_push_targets）用；
-- 夥伴名單的「在線」顯示、遠端更新／登入等其他讀 asn_presence 的地方照舊看 updated_at，不動。
-- asn_relay_asn_presence_set 多一個選填參數 p_foreground：
--   true  → fg_at = now()
--   false → fg_at = null（要清掉，不然切到背景後還會被擋最多 3 分鐘）
--   null（舊版 App、電腦版不帶旗標）→ 視同前景，fg_at = now()，行為與現行相同
-- push_targets 只看 fg_at：fg_at 是 null 就代表不在前景（被清掉，或從沒在前景過），沒有退回看 updated_at 的規則。
-- 既有列用 updated_at 回填 fg_at，升級瞬間在線的人不會被當成背景多推一次。
-- 部署順序：先跑這支並部署新版 Edge，再發新版 App。舊版 App 不帶旗標，行為不變。
-- 回復：supabase/sql/rollback/20261112700000_presence_foreground_down.sql
begin;

alter table relay.asn_presence add column if not exists fg_at timestamptz;
update relay.asn_presence set fg_at = updated_at where fg_at is null;

-- 每個函式名只留一個簽章：drop 舊的 5 參數版再建 6 參數版（新參數有預設值，舊呼叫端與 irori_ 舊名包裝照常能呼叫）
drop function if exists public.asn_relay_asn_presence_set(text, text, text, text, text);

create or replace function public.asn_relay_asn_presence_set(p_node text, p_window text, p_version text, p_status text, p_psm text, p_foreground boolean default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_window text := btrim(p_window);
  v_psm text := nullif(btrim(coalesce(p_psm, '')), '');
begin
  if v_window is null or char_length(v_window) not between 1 and 40 or v_window ~ '[[:cntrl:]]' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not exists (select 1 from relay.nodes where id = p_node and status = 'active') then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_status = 'offline' then
    delete from relay.asn_presence where node = p_node and window_name = v_window;
    return jsonb_build_object('ok', true);
  end if;
  if p_status is null or p_status not in ('online', 'away', 'busy')
     or p_version is null or p_version !~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(-[0-9A-Za-z.]{1,16})?$'
     or (v_psm is not null and (char_length(v_psm) > 80 or v_psm ~ '[[:cntrl:]]')) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not exists (select 1 from relay.asn_presence where node = p_node and window_name = v_window)
     and (select count(*) from relay.asn_presence where node = p_node) >= 20 then
    return jsonb_build_object('error', 'too_many');
  end if;
  insert into relay.asn_presence (node, window_name, version, status, psm, updated_at, fg_at)
    values (p_node, v_window, p_version, p_status, v_psm, now(), case when p_foreground is false then null else now() end)
  on conflict (node, window_name) do update
    set version = excluded.version, status = excluded.status, psm = excluded.psm, updated_at = excluded.updated_at, fg_at = excluded.fg_at;
  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.asn_relay_asn_presence_set(text, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.asn_relay_asn_presence_set(text, text, text, text, text, boolean) to service_role;

-- 要推誰：只看 fg_at（3 分鐘內有前景回報就不推）；其餘與 20261109100000 相同
create or replace function public.asn_relay_push_targets(p_user uuid, p_kind text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_out jsonb;
begin
  if p_kind is null or p_kind not in ('owner_mail', 'waiting') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if p_user is null then
    return jsonb_build_object('targets', '[]'::jsonb);
  end if;
  with due as (
    select t.node
      from relay.push_tokens t join relay.nodes n on n.id = t.node
     where n.owner_user = p_user and n.status = 'active' and n.platform = 'android'
       and t.updated_at > now() - interval '30 days'
       and not exists (select 1 from relay.asn_presence p where p.node = t.node and p.fg_at > now() - interval '3 minutes')
  ), sent as (
    update relay.push_tokens t set last_sent_at = now()
      from due
     where t.node = due.node and (t.last_sent_at is null or t.last_sent_at < now() - interval '60 seconds')
    returning t.node, t.token
  )
  select coalesce(jsonb_agg(jsonb_build_object('node', node, 'token', token) order by node), '[]'::jsonb) into v_out from sent;
  return jsonb_build_object('targets', v_out);
end;
$function$;

revoke all on function public.asn_relay_push_targets(uuid, text) from public, anon, authenticated;
grant execute on function public.asn_relay_push_targets(uuid, text) to service_role;

commit;
