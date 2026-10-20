# 調查：集中式／多人共用的 AI 記憶（2026-10-20，兩輪合併）

只讀網路資料。星數取自擷取當下；最近更新日多數未確認；價格多為第三方彙整（二手）。

## 結論
沒有現成框架同時滿足「多使用者、多代理、群組權限、資料庫層強制、防投毒」。協定面也沒有標準：MCP 沒有記憶原語、A2A 不定義共享記憶。建議自建核心（Supabase Postgres＋pgvector＋RLS＋MCP 工具），借用其他專案的設計。

## 候選
| 專案 | 多人模型與權限 | 接法／自架 | 授權、規模 | 來源 |
|---|---|---|---|---|
| Mem0 | user／session／agent；新演算法只增不覆蓋 | SDK、REST、MCP；可自架 | Apache-2.0；67.5k | https://github.com/mem0ai/mem0 |
| Letta | 共享記憶區塊可設唯讀；同時寫入最後寫入者勝 | 自家 SDK；可自架 | Apache-2.0；25.2k | https://docs.letta.com/guides/agents/shared-memory-blocks |
| Graphiti／Zep | group_id 分區；參考 server 不做認證；事實可回溯來源、有有效期 | 函式庫＋MCP；需圖資料庫 | Apache-2.0；32.1k | https://github.com/getzep/graphiti |
| Cognee | 使用者、租戶、角色、資料集 ACL，強制隔離 | Python、MCP；可用 pgvector | 授權未確認；32.6k | https://docs.cognee.ai/core-concepts/multi-user-mode/permissions-system/overview |
| Hindsight | 記憶庫（bank）互相隔離 | REST、MCP；Postgres＋pgvector | MIT（未親見授權檔） | https://github.com/vectorize-io/hindsight |
| Honcho | workspace、peer（真人與代理同級）、session；JWT | Postgres＋pgvector；可自架 | **AGPL-3.0**；7.7k | https://github.com/plastic-labs/honcho |
| mcp-memory-service | X-Agent-ID 標來源；OAuth 2.0；矛盾偵測、舊記憶標「被取代」 | MCP | Apache-2.0；約 2k | https://github.com/doobidoo/mcp-memory-service |
| Supermemory | containerTag 分區；團隊權限要企業版 | API、MCP；可自架 | MIT；31.3k | https://github.com/supermemoryai/supermemory |
| Basic Memory | 本機 Markdown；團隊共享在託管版 | MCP | **AGPL-3.0** | https://github.com/basicmachines-co/basic-memory |
| 官方 MCP memory server | 單一身分、檔案式 | MCP | MIT | https://github.com/modelcontextprotocol/servers/tree/main/src/memory |

研究參考：SAP 共享組織記憶預印本（貢獻需核准、寫入安全閘、信任分數、碰撞檢查）https://arxiv.org/html/2608.00122v1 ；memorywire 提案（remember／recall／forget／merge／expire 五操作、溯源欄位）https://arxiv.org/abs/2606.01138 。

## ASN 建議設計
- 範圍三層：主人私有（主人與名下代理讀；名下代理寫需確認）、群組共享（成員讀；寫入先待審）、代理私有。
- 資料表：`memories(scope, owner_id, group_id, agent_id, source_message_id, status, trust, supersedes)`，pgvector＋RLS。
- 衝突：只增不改，新記憶指向被取代者。
- 溯源：記來源訊息、寫入代理、時間。
- 防投毒：別人的訊息只能產生「未信任」記憶，不進主人範圍；改變行為的記憶（偏好、規則）須主人確認；召回結果放在資料區塊並標來源，系統指令不從記憶載入；提供檢視、刪除、匯出。
- 接法：MCP 工具，命名貼近 memorywire，將來可換底層（Hindsight／Cognee）。
- 順序：先做「主人私有」＋三個工具；群組共享等真人好友與群組上線後再加。估計 2～3 週。
