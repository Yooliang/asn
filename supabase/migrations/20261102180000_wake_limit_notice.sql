-- 【獨立區塊】AI 互相叫醒達上限時，群組裡要看得到（todo-next-179）。上限本身不改。
-- 起因：達上限後 AI 的 @ 點名照樣寫進群組，但不會叫醒人，發言的人和群組裡的人都看不到任何提示。
-- 這個 migration 只做一件事：public.asn_relay_room_post 在這一輪第一次達上限時，多寫一則系統訊息。
--   函式本體跟正式庫逐行比對過，只多加行（宣告一行、一個 if 區塊），原有的行不動；回傳值不變（wake_limited、suppressed 本來就有）。
--   系統訊息經既有的 relay.group_system_msg：不叫醒任何 AI、不計額度；relay.room_ai_rounds 只算 AI 的訊息，所以也不算輪數；Jev 的 isSilentAiMsg 也排除 system。
-- security definer 函式碰到的資料表：public.asn_relay_room_post 與原本相同（relay.room_messages、relay.room_members、relay.nodes、relay.rooms、relay.tenants、relay.roster 等，經既有輔助函式）；這次多讀 relay.room_messages（判斷這一輪寫過沒有），多寫的那一則也在 relay.room_messages。
-- 授權不變：create or replace 保留原有的 revoke／grant；沒有新函式、新資料表、新 policy。
-- 部署順序：本 migration → relay（Edge Function，回應多帶 wake_limited）→ 發新版 ASN。提早上任何一步都不會壞。
-- 回復：supabase/sql/rollback/20261102180000_wake_limit_notice_down.sql（換回原本的函式；已寫的系統訊息留著）。
begin;

CREATE OR REPLACE FUNCTION public.asn_relay_room_post(p_node text, p_agent text, p_room text, p_body text, p_mentions text[], p_owner boolean DEFAULT false, p_signed_user uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_key text := relay.room_actor_key(p_node, p_agent, p_owner, p_signed_user, p_room);
  v_trust text;
  v_seq bigint;
  v_mentions text[];
  v_recent int;
  v_rt uuid;
  v_st uuid;
  v_sup text[];
  v_human boolean;
  v_limited boolean := false;
  v_notice constant text := '（AI 之間互相叫醒已達上限，之後 AI 的點名不會叫醒人，對方只留未讀。真人發言後重新計算；主人可在設定調高上限。）';
begin
  if v_key is null then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_body is null or char_length(p_body) < 1 or char_length(p_body) > 20000 then
    return jsonb_build_object('error', 'bad_body');
  end if;
  if not relay.room_can(p_room, p_node, v_key) then
    return jsonb_build_object('error', 'not_member');
  end if;
  if not p_owner and p_agent is not null and btrim(p_agent) <> ''
     and not exists (select 1 from relay.roster where node = p_node and name = p_agent) then
    return jsonb_build_object('error', 'unknown_agent');
  end if;
  if v_key <> '~owner' then
    select count(*) into v_recent from relay.room_messages
      where room_id = p_room and from_member = v_key and at > now() - interval '1 hour'
        and not is_seed and from_kind is distinct from 'system';
    if v_recent >= 20 then
      return jsonb_build_object('error', 'rate_limited');
    end if;
  end if;
  v_trust := case when p_owner or public.asn_user_owns_node(p_signed_user, p_node)
                  then 'owner' else 'member' end;
  select coalesce(array_agg(s.m), array[]::text[]) into v_mentions from (
    select distinct q.rk as m from (
      select relay.room_resolve_key(p_room, x) as rk from unnest(coalesce(p_mentions, array[]::text[])) x
    ) q
    where q.rk is not null and q.rk <> v_key and relay.room_is_member(p_room, q.rk) order by q.rk limit 8
  ) s;
  select tenant_id into v_rt from relay.rooms where id = p_room;
  v_st := relay.member_tenant(v_key, v_rt);
  v_human := v_trust = 'owner' or v_key = '~owner' or v_key like '~u:%';
  -- AI 發言：本輪之前已經叫醒了上限那麼多輪，就不再叫醒被點名的 AI（真人、主持人的點名不受影響）
  if not v_human and relay.room_ai_chain_blocked(p_room, v_key) then
    select coalesce(array_agg(k), array[]::text[]) into v_sup from unnest(v_mentions) k
      where k <> '~owner' and k not like '~u:%';
    v_limited := coalesce(array_length(v_sup, 1), 0) > 0;
  else
    v_sup := relay.room_wake_filter(p_room, v_st, v_rt, v_mentions);
  end if;
  v_seq := relay.room_append(p_room, v_key, v_trust, p_body, v_mentions, case when v_human then 'human' else 'ai' end, false,
                             (select t.owner_user from relay.tenants t where t.id = v_st), now(), v_sup);
  update relay.room_members set read_seq = v_seq where room_id = p_room and member = v_key;
  -- 這一輪第一次達上限：寫一則系統訊息讓大家看得到（系統訊息不算輪數、不叫醒人）；同一輪只寫一則，真人發言後重新算
  if v_limited and not exists (
    select 1 from relay.room_messages m
    where m.room_id = p_room and m.from_kind = 'system' and m.body = v_notice
      and m.seq > coalesce((select max(h.seq) from relay.room_messages h
                            where h.room_id = p_room and not h.is_seed and relay.msg_kind(h.from_kind, h.from_member, h.trust) = 'human'), 0)
  ) then
    perform relay.group_system_msg(p_room, v_key, v_notice);
  end if;
  return jsonb_build_object('seq', v_seq, 'from', v_key, 'bell_topics', to_jsonb(relay.room_bells(p_room)), 'suppressed', to_jsonb(v_sup),
                            'wake_limited', v_limited);
end;
$function$;

commit;
