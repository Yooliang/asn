-- 遠端一次性密碼傳遞加「登入網址」欄位（#628 第 3 段；設計見 docs/design/SECRET-REMOTE.md 與議題 #628）。
-- 用途：新電腦上的 ASN 替使用者登入 AI 引擎時，把官方登入網址隨請求送到本人的手機，本人在手機打開、授權，再把頁面上的授權碼貼回（走既有的加密回傳）。
--
-- 安全重點（asn真條件 A、B、F）：
--  * 帶網址的請求**一定要本人簽章**，而且簽章的人要擁有請求端節點。AI 視窗拿得到節點金鑰、拿不到登入憑證，
--    所以 AI 不能用節點金鑰自己發出帶網址的請求（否則就能推一個假的登入頁到本人手機）。
--  * 網址只收官方登入網域的 https（claude.ai、claude.com、anthropic.com 及其子網域），埠只能 443，不能帶帳號密碼；
--    資料表欄位的檢查約束與函式各檢查一次，Edge Function、電腦與手機的 Rust、手機畫面再各驗一次。
--  * 不改既有資料表以外的東西：只加一個欄位、新增一個函式、取代一個函式（待確認清單多回網址）。
--
-- security definer 函式與它們碰到的資料表（asn真條件 F）：
--  * public.asn_relay_secret_request_link（新）：讀 relay.nodes（經 public.asn_user_owns_node 核對簽章者擁有請求端節點）、
--    讀寫 relay.secret_requests（呼叫既有的 public.asn_relay_secret_request 建立請求，再把 link 寫到那一列）。
--  * public.asn_relay_secret_pending（取代；介面不變）：讀 relay.secret_requests、讀 relay.nodes（設備名稱，經 asn_user_owns_node）。多回 link 欄位。
--  全部 set search_path to ''，只授權 service_role，anon／authenticated／public 都收回。
-- 部署順序：migration → relay 函式 → 發新版 ASN。舊版 Edge Function 呼叫舊的五參數 request 函式，照常運作；舊版 ASN 看到多出來的 link 欄位會略過。
begin;

alter table relay.secret_requests add column if not exists link text;
-- 官方登入網域的 https（埠只能 443）；後面只允許可見的 ASCII 字元（不含空白、控制字元、反斜線），所以網域後面接 @ 之類的手法進不來
alter table relay.secret_requests drop constraint if exists secret_requests_link_ck;
alter table relay.secret_requests add constraint secret_requests_link_ck check (
  link is null or (
    char_length(link) between 12 and 2048
    and link ~ '^https://([a-z0-9-]+\.)*(claude\.ai|claude\.com|anthropic\.com)(:443)?([/?#][\x21-\x5b\x5d-\x7e]*)?$'
  )
);

-- 帶網址的請求：要本人簽章，簽章的人要擁有請求端節點。其餘規則（公鑰唯一、同時上限、每小時上限、有效期限）全沿用既有函式
create or replace function public.asn_relay_secret_request_link(p_node text, p_pub text, p_program text, p_purpose text, p_ttl_seconds integer, p_link text, p_signed_user uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_res jsonb;
begin
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_node) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if p_link is null
     or char_length(p_link) not between 12 and 2048
     or p_link !~ '^https://([a-z0-9-]+\.)*(claude\.ai|claude\.com|anthropic\.com)(:443)?([/?#][\x21-\x5b\x5d-\x7e]*)?$' then
    return jsonb_build_object('error', 'bad_request');
  end if;
  v_res := public.asn_relay_secret_request(p_node, p_pub, p_program, p_purpose, p_ttl_seconds);
  if v_res ? 'error' then
    return v_res;
  end if;
  update relay.secret_requests set link = p_link where id = (v_res ->> 'id')::uuid and requester_node = p_node;
  return v_res;
end;
$function$;

-- 待確認清單多回 link（沒有就是 null）。其餘與原本完全相同
create or replace function public.asn_relay_secret_pending(p_actor text, p_signed_user uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_out jsonb;
begin
  perform public.asn_relay_secret_purge();
  if p_signed_user is null or not public.asn_user_owns_node(p_signed_user, p_actor) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'node', r.requester_node, 'node_name', (select n.name from relay.nodes n where n.id = r.requester_node),
      'program', r.program, 'purpose', r.purpose, 'pub', r.pub, 'link', r.link, 'created_at', r.created_at, 'expires_at', r.expires_at,
      'seconds_left', greatest(0, floor(extract(epoch from (r.expires_at - now()))))::int)
      order by r.created_at), '[]'::jsonb)
    into v_out from relay.secret_requests r
    where r.owner_user = p_signed_user and r.status = 'pending' and r.expires_at > now()
      and public.asn_user_owns_node(p_signed_user, r.requester_node);
  return jsonb_build_object('requests', v_out);
end;
$function$;

revoke all on function public.asn_relay_secret_request_link(text, text, text, text, integer, text, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_secret_request_link(text, text, text, text, integer, text, uuid) to service_role;
revoke all on function public.asn_relay_secret_pending(text, uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_secret_pending(text, uuid) to service_role;

commit;
