-- 冪等寄信（#1135）：寄信請求可能已到達後台、回應卻在客戶端讀失敗。客戶端每封信帶一個 client_id（UUID），重試時沿用，
-- 後台據此去重：同一個寄件節點內，同一個 client_id 只會有一封信。
--  1. relay.messages 多一個 client_id 欄位（預設 null；舊信、舊客戶端都是 null）。
--  2. 部分唯一索引 (from_node, client_id) where client_id is not null：只在同一個寄件節點內去重，不同節點用同一個 client_id 不算重複。
--  3. 新函式 asn_relay_send_idem：同一個交易內先以 (寄件節點, client_id) 加鎖，查到已有就回第一次那封的 id 並標 duplicate（不再寄、不報錯）；
--     沒有才呼叫既有的 asn_relay_send／asn_relay_send_voice，成功後把 client_id 記在回傳的那封信（扇出時記在第一列）。
--     寄信失敗（例如寄太快）不記，之後重試照常寄。
--  4. 新函式 asn_relay_send_lookup：只查 (寄件節點, client_id) 有沒有已寄出的信，回 {"id": ...} 或 null；Edge 用它在處理附件之前先認出重複。
-- 既有的寄信函式（asn_relay_send／_core／_voice）一個字都不動、簽名不變，所以不會多出同名多載；舊客戶端不帶 client_id，走原路徑，行為完全不變。
-- 權限：兩支新函式都是 security definer、search_path 為空，收回 public／anon／authenticated，只授權 service_role。
-- 部署順序：先套本 migration，再部署 relay 函式，最後發新版客戶端。可重跑。
-- 回復：supabase/sql/rollback/20261111120000_send_client_id_down.sql（刪兩支函式、索引與欄位；已存的 client_id 隨欄位移除，信不動）。
begin;

alter table relay.messages add column if not exists client_id uuid;

create unique index if not exists relay_messages_from_client_uidx
  on relay.messages (from_node, client_id) where client_id is not null;

create or replace function public.asn_relay_send_idem(
  p_client_id uuid,
  p_from_node text, p_from_agent text, p_to_node text, p_to_agent text, p_body text, p_reply_to uuid,
  p_expects_reply boolean default null::boolean, p_signed_user uuid default null::uuid,
  p_as_person boolean default false, p_voice boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_id uuid;
  v_r jsonb;
begin
  if p_client_id is null then
    -- 沒帶 client_id：與原寄信完全相同
    if p_voice is true then
      return public.asn_relay_send_voice(p_from_node, p_from_agent, p_to_node, p_to_agent, p_body, p_reply_to,
                                         p_expects_reply, p_signed_user, p_as_person, true);
    end if;
    return public.asn_relay_send(p_from_node, p_from_agent, p_to_node, p_to_agent, p_body, p_reply_to,
                                 p_expects_reply, p_signed_user, p_as_person);
  end if;

  -- 同一個 (寄件節點, client_id) 的請求排隊：後到的等前一個交易結束，就能看到它寫下的信
  perform pg_advisory_xact_lock(hashtextextended('asn_send_idem:' || coalesce(p_from_node, '') || ':' || p_client_id::text, 0));

  select m.id into v_id from relay.messages m
    where m.from_node = p_from_node and m.client_id = p_client_id;
  if found then
    return jsonb_build_object('id', v_id, 'duplicate', true);
  end if;

  if p_voice is true then
    v_r := public.asn_relay_send_voice(p_from_node, p_from_agent, p_to_node, p_to_agent, p_body, p_reply_to,
                                       p_expects_reply, p_signed_user, p_as_person, true);
  else
    v_r := public.asn_relay_send(p_from_node, p_from_agent, p_to_node, p_to_agent, p_body, p_reply_to,
                                 p_expects_reply, p_signed_user, p_as_person);
  end if;
  if v_r ? 'id' and not (v_r ? 'error') then
    update relay.messages set client_id = p_client_id
      where id = (v_r ->> 'id')::uuid and from_node = p_from_node;
  end if;
  return v_r;
end;
$function$;

revoke all on function public.asn_relay_send_idem(uuid, text, text, text, text, text, uuid, boolean, uuid, boolean, boolean) from public, anon, authenticated;
grant execute on function public.asn_relay_send_idem(uuid, text, text, text, text, text, uuid, boolean, uuid, boolean, boolean) to service_role;

create or replace function public.asn_relay_send_lookup(p_node text, p_client_id uuid)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select jsonb_build_object('id', m.id)
    from relay.messages m
   where p_client_id is not null and m.from_node = p_node and m.client_id = p_client_id
   limit 1;
$function$;

revoke all on function public.asn_relay_send_lookup(text, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_send_lookup(text, uuid) to service_role;

commit;
