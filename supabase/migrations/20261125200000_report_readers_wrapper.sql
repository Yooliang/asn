-- #2161 第 2b 段：給 Edge function 發門鈴用的「誰該被通知」包裝函式（只新增，不改 2a 的任何函式）。
-- 目的：Edge 的 service_role 呼叫不到 relay.*（relay schema 對 service_role 沒有 usage），所以包一支 security definer 的 public.* 函式，
--   內部呼叫 relay.report_readers（與 asn_relay_report_get 同一份可見規則），並排除寫入者自己（寫入者不需要被自己的回報敲門鈴）。
-- 回傳：{ "readers": ["節點代號",...], "bell_topics": ["門鈴頻道",...] }，兩個陣列等長、依節點代號排序、一一對應。
--   bell_topics 是設計稿之外多帶的：Edge 要對每個讀者敲「他自己的」門鈴頻道，頻道名在 relay.nodes 內、Edge 讀不到，只能由這支函式一併回。
--   節點不存在、已停用、kind 沒登記或停用、沒有其他讀者：一律回 { "readers": [], "bell_topics": [] }（不報錯）。
-- 授權：security definer、search_path 空；只授權 service_role。
-- 回復：supabase/sql/rollback/20261125200000_report_readers_wrapper_down.sql（drop 這一支函式）。
begin;

create or replace function public.asn_relay_report_readers(p_node text, p_kind text)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select jsonb_build_object(
    'readers', coalesce(jsonb_agg(n.id order by n.id), '[]'::jsonb),
    'bell_topics', coalesce(jsonb_agg(n.bell_topic order by n.id), '[]'::jsonb))
  from relay.report_readers(p_node, p_kind) r(id)
  join relay.nodes n on n.id = r.id and n.status = 'active'
  where n.id <> p_node;
$function$;

revoke all on function public.asn_relay_report_readers(text, text) from public, anon, authenticated;
grant execute on function public.asn_relay_report_readers(text, text) to service_role;

commit;
