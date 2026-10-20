# 調查：代理互傳訊息的同類專案與標準（2026-10-20）

只讀網路資料。星數取自擷取當下，多數最近更新日未確認。

## Crossroad-A2A（https://github.com/Agent-Tong/Crossroad-A2A）
- 定位：「代理對代理的郵件」，每個代理有信箱；README 自稱 v0.1 beta。
- 傳輸：各機器跑小型「郵局」，簽章後送到中央「Town Hall」路由（Town Hall 不在公開 repo）。網頁型 AI 靠定時拉信（ChatGPT 走 MCP connector，Gemini 走 Google Tasks）。
- 身分：寄件者簽章，身分綁聊天 session，重開 session 需主人重簽。
- 訊息格式：JSON 信封（call_id、from_agent、to_agent、purpose、ref、hop、parent、body）；收信端把 body 放進「對等方資料」區塊，不當主人指令。
- 延遲：分鐘級（Claude Code 送達中位數 274 秒）。
- 授權 Apache-2.0；11 星；1 個提交（2026-10-18）。設計最接近 ASN，只當參考。

## 同類專案與標準
| 項目 | 授權／規模 | 重點 | 來源 |
|---|---|---|---|
| Google A2A | Apache-2.0；26.2k 星 | v1.0；Agent Card（技能、能力、securitySchemes）；Task 狀態；Message parts；Artifact；webhook 推播 | https://github.com/a2aproject/A2A 、 https://a2a-protocol.org/latest/specification/ |
| Claude Code Channels | 官方，研究預覽 | 本機 MCP server 把事件推進執行中的 session；事件排隊、忙時合併；目前限白名單外掛 | https://code.claude.com/docs/en/channels |
| Claude Code Remote Control | 官方 | 人從手機／網頁操作自己的 session，可傳檔 | https://code.claude.com/docs/en/remote-control |
| hcom | MIT；582 星 | 本機 SQLite＋hook；跨機器 MQTT；@tag 群組、@名字 | https://github.com/aannoo/hcom |
| Agentrooms | MIT；893 星 | 房間內 @ 派工，一則訊息可指多個代理 | https://github.com/baryhuang/claude-code-by-agents |
| OpenAgents | Apache-2.0；約 4.2k 星 | 共用工作區；邀請連結加入 | https://github.com/openagents-org/openagents |
| MCP Agent Mail | 2.2k 星；授權未確認 | 代理收件匣、thread、acknowledge；圖片轉 WebP 以內容雜湊儲存 | https://github.com/Dicklesworthstone/mcp_agent_mail |
| CrewAI | MIT；59.9k 星 | 同進程編排，非即時通訊層 | https://github.com/crewAIInc/crewAI |
| Telegram 官方 channel 外掛 | 授權未確認 | 配對碼＋寄件者白名單；圖片落地只帶路徑 | https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram |

## 建議 ASN 參考的前 5 點
1. 信件一律以「標明來源與寄件者的外部資料區塊」交給代理；權限依寄件者（不是房間）判斷。改動小。
2. 群組用 @提及＋「一代理一佇列、串行處理並合併」，沒被 @ 的代理不叫醒。改動中。
3. A2A 轉接層：Agent Card 對應名單、Task 狀態對應「要不要回信」、webhook 對應門鈴。先做唯讀 Agent Card。改動大。
4. 附件改「參照」：檔案存 Storage，信件只帶雜湊／連結，到達時落地。改動中。
5. 送達回條與重試：acknowledge、call_id 去重、離線重送。改動小到中。
