-- 附件不齊提示（#1205）：寄信後核對「這次請求帶的附件，哪些沒有實際綁在那封信上」。
-- 新函式 asn_relay_attach_missing(p_node, p_ids, p_message_id)：回 p_ids 裡「沒有綁在 p_message_id 上」的附件編號（去重、依傳入順序）。
--   綁上的條件看資料列本身：owner_node＝p_node 且 message_id＝p_message_id；看結果、不看這次綁了幾筆，
--   所以第一次寄與重複送來的請求同時在跑時，對方已經綁好的不會被誤判成缺。
--   不存在、不屬於寄件人的編號也算缺，但只會回傳 p_ids 裡出現過的編號，不會多洩漏任何資訊。
-- 純讀取，不寫入任何資料；既有的 attach_claim／attach_bind 一個字都不動。
-- 權限：security definer、search_path 為空，收回 public／anon／authenticated，只授權 service_role。
-- 部署順序：先套本 migration，再部署 relay 函式；Edge 找不到這支函式時退回舊行為（不提示缺件）。可重跑。
-- 回復：supabase/sql/rollback/20261112000000_attach_missing_down.sql。
begin;

create or replace function public.asn_relay_attach_missing(p_node text, p_ids uuid[], p_message_id uuid)
 returns uuid[]
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select coalesce(array_agg(s.x order by s.o), array[]::uuid[])
    from (select t.x, min(t.o) as o
            from unnest(coalesce(p_ids, array[]::uuid[])) with ordinality as t(x, o)
           group by t.x) s
   where not exists (
     select 1 from relay.attachments a
      where a.id = s.x and a.owner_node = p_node and a.message_id = p_message_id
   );
$function$;

revoke all on function public.asn_relay_attach_missing(text, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.asn_relay_attach_missing(text, uuid[], uuid) to service_role;

commit;
