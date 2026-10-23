-- #14 R7 部署前在線上確認（唯讀，只查不改）：哪些節點的 role 是 'owner'、誰在用它、有多少信靠它被標成 trust=owner。
-- 套用 20261023050000_trust_owner_signed_only.sql 之後，這些節點寄的信與群組發言不再是 trust=owner（資料不變）。

-- 1. role='owner' 的節點（每個租戶最多一個，有唯一索引）
select t.serial as 租戶序號, n.id as 節點代號, n.name as 名稱, n.status as 狀態, n.owner_user is not null as 已被認領,
       n.machine as 機器, n.last_seen_at as 最後上線
from relay.nodes n join relay.tenants t on t.id = n.tenant_id
where n.role = 'owner'
order by t.serial;

-- 2. 最近 30 天由這些節點寄出的信（沒有本人簽章的才會受影響）
select m.from_node as 寄件節點, count(*) as 信件數, count(*) filter (where not m.owner_signed) as 受影響_沒有簽章
from relay.messages m join relay.nodes n on n.id = m.from_node and n.role = 'owner'
where m.created_at > now() - interval '30 days'
group by m.from_node
order by 2 desc;

-- 3. 最近 30 天由這些節點發的群組訊息（trust 目前是 owner，套用後會是 member）
select rm.from_member as 發言者, count(*) as 則數
from relay.room_messages rm join relay.nodes n on n.id = rm.from_member and n.role = 'owner'
where rm.at > now() - interval '30 days'
group by rm.from_member;

-- 4. 這些節點目前有沒有排隊中的遠端指令（切換帳號、開視窗）——它們靠 role 授權，本次不動
select 'acct_switches' as 種類, count(*) from relay.account_switches where created_at > now() - interval '7 days'
union all
select 'launches', count(*) from relay.launches where created_at > now() - interval '7 days';
