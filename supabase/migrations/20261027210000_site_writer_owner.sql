-- 官網內容寫入名單收緊（#400 第 2 期上線前，asn真 審查發現）：
--   20261027200000_site_write.sql 只看「節點所在的租戶在 relay.site_writers 名單上」。
--   但用擁有者的邀請碼註冊的節點也會落在擁有者的租戶裡（例如測試寄件節點 asn-tester，owner_user 是空的），
--   照原本的寫法，這些節點也能改公開的官網內容。
-- 改成：節點必須由「租戶的擁有者本人」認領（nodes.owner_user = tenants.owner_user），才算可寫。
--   擁有者自己的電腦、手機、雲端 AI 節點（都已認領）照常可寫；只靠邀請碼加入、沒有認領或屬於別人的節點一律 not_allowed。
-- 回退：重新套用 20261027200000_site_write.sql 裡的 relay.site_writer_tenant 定義。
begin;

create or replace function relay.site_writer_tenant(p_node text, out p_tenant uuid, out p_err text)
 language plpgsql
 stable
 set search_path to ''
as $function$
begin
  select n.tenant_id into p_tenant
  from relay.nodes n
  join relay.tenants t on t.id = n.tenant_id and t.status = 'active'
  join relay.site_writers w on w.tenant_id = n.tenant_id
  where n.id = p_node and n.status = 'active'
    and n.owner_user is not null and n.owner_user = t.owner_user;
  if p_tenant is null then
    p_err := 'not_allowed';
    return;
  end if;
  if (select count(*) from relay.site_write_log l where l.tenant_id = p_tenant and l.at > now() - interval '1 hour') >= 120 then
    p_tenant := null;
    p_err := 'rate_limited';
  end if;
end;
$function$;

revoke all on function relay.site_writer_tenant(text) from public, anon, authenticated;

commit;
