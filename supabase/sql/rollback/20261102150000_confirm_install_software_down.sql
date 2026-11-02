-- 回復 20261102150000_confirm_install_software.sql：類別換回六類。已存在的 install_software 紀錄先改成 other，不然約束加不回去。
begin;
update relay.room_confirms set kind = 'other' where kind = 'install_software';
alter table relay.room_confirms drop constraint if exists room_confirms_kind_check;
alter table relay.room_confirms add constraint room_confirms_kind_check
  check (kind in ('data_change', 'deploy', 'spend', 'external_send', 'account_config', 'other'));

create or replace function relay.confirm_kind_label(p_kind text)
 returns text language sql immutable set search_path to ''
as $function$
  select case p_kind
    when 'data_change' then '修改或刪除既有資料' when 'deploy' then '部署' when 'spend' then '花錢或付款'
    when 'external_send' then '對外寄送' when 'account_config' then '動到主人的帳號或設定' else '其他不可回復的操作' end;
$function$;

create or replace function public.asn_relay_group_confirm_request(p_node text, p_agent text, p_room text, p_kind text, p_summary text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path to ''
AS $function$
declare
  v_key text := relay.room_caller_key(p_node, p_agent, false);
  v_sum text := btrim(coalesce(p_summary, ''));
  v_host uuid;
  v_hk text;
  v_id uuid;
  v_rt uuid;
  v_seq bigint;
  v_ru uuid;
begin
  if v_key is null or position('~' in v_key) = 0 then return jsonb_build_object('error', 'forbidden'); end if;
  if not relay.room_can(p_room, p_node, v_key) then return jsonb_build_object('error', 'not_member'); end if;
  if p_kind is null or p_kind not in ('data_change', 'deploy', 'spend', 'external_send', 'account_config', 'other') then
    return jsonb_build_object('error', 'bad_kind');
  end if;
  if char_length(v_sum) not between 1 and 500 then return jsonb_build_object('error', 'bad_request'); end if;
  if (select count(*) from relay.room_confirms c where c.room_id = p_room and c.requester = v_key and c.status = 'pending' and c.expires_at > now()) >= 5 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  v_host := relay.room_host(p_room);
  v_hk := case when v_host is null then null else relay.room_human_member(p_room, v_host) end;
  if v_hk is null then return jsonb_build_object('error', 'no_host'); end if;
  select tenant_id into v_rt from relay.rooms where id = p_room;
  v_ru := (select t.owner_user from relay.tenants t where t.id = relay.member_tenant(v_key, v_rt));
  insert into relay.room_confirms (room_id, requester, requester_user, host_user, kind, summary)
    values (p_room, v_key, v_ru, v_host, p_kind, v_sum) returning id into v_id;
  v_seq := relay.room_append(p_room, v_key, 'member',
    '【待主持人確認 #' || substr(v_id::text, 1, 8) || '】' || relay.room_display_name(p_room, v_key)
      || '（' || coalesce(relay.room_owner_name(v_key, v_rt), '?') || '）要做危險操作（' || relay.confirm_kind_label(p_kind) || '）：'
      || v_sum || '。請主持人在群組回覆確認；確認前不會執行。',
    array[v_hk], 'ai', false, v_ru);
  update relay.room_confirms set request_seq = v_seq where id = v_id;
  return jsonb_build_object('id', v_id, 'short', substr(v_id::text, 1, 8), 'seq', v_seq, 'status', 'pending',
                            'bell_topics', to_jsonb(relay.room_bells(p_room)));
end;
$function$;

commit;
