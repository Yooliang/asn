# 調查：通訊加密與代理通訊協定（2026-10-20）

只讀網路資料；工作量為估計。

## 一、端對端加密
| 方案 | 適合 | 開源實作與授權 | 判斷 |
|---|---|---|---|
| Signal（PQXDH＋Double Ratchet） | 一對一 | libsignal：**AGPLv3**，官方不支援 Signal 以外使用 | 不用 |
| MLS（RFC 9420） | 群組與一對一；成員變動成本約 log(N) | OpenMLS（MIT）、mls-rs（Apache-2.0／MIT） | 建議 |
| Matrix Olm／Megolm | 一對一／群組 | vodozemac（Apache-2.0）；Matrix 改用 MLS 仍未就緒 | 不當範本 |
| Wire core-crypto | MLS 實作 | **GPL-3.0** | 不用 |

來源：https://signal.org/docs/specifications/pqxdh/ 、 https://github.com/signalapp/libsignal 、 https://www.rfc-editor.org/rfc/rfc9420.html 、 https://github.com/openmls/openmls 、 https://github.com/awslabs/mls-rs 、 https://github.com/matrix-org/vodozemac 、 https://arewemlsyet.com/

### 代理情境
- 代理要讀明文才能回覆，「端」只能是代理所在設備（對應 ASN 每台設備一把節點金鑰）。
- 雲端代理無法真正端對端加密；介面標示為「信任邊界內」，或用可信執行環境（TEE）方案。
- 加密後伺服器失去搜尋、記憶、依內文解析 @提及；解法：收件人、群組、@提及清單放明文信封，內文與附件加密，搜尋與記憶改在客戶端或代理端做。
- 參考：Knodel 等〈How To Think About End-To-End Encryption and AI〉 https://arxiv.org/html/2412.20231v2

### 分階段
1. 訊息簽章（Ed25519，用節點金鑰）＋好友指紋確認：防冒名、防偽造。約 1～2 週。
2. 一對一端對端加密。約 3～6 週。
3. 群組 MLS（OpenMLS 或 mls-rs）；收發室只轉送密文。約 2～3 個月。

## 二、代理通訊協定
| 協定 | 身分與授權 | 加密／簽章 | 判斷 | 來源 |
|---|---|---|---|---|
| LangChain Agent Protocol | 無（範例 no auth）；LangGraph 用自訂 Auth 類別 | 無 | 不優先相容 | https://github.com/langchain-ai/agent-protocol |
| Google A2A | Agent Card 宣告 API key、OAuth 2.0、OIDC、mTLS | 靠 TLS；Agent Card 可 JWS 簽章 | 最值得相容 | https://a2a-protocol.org/latest/specification/ |
| IBM ACP | 已併入 A2A | — | 不需處理 | — |
| ANP | W3C DID（did:wba） | 一對一端對端加密；群組仍草案 | 觀察 | https://github.com/agent-network-protocol/AgentNetworkProtocol |
| AGNTCY SLIM／OASF | 未確認 | SLIM 以 MLS 做端對端加密（IETF 草案） | 證明「MLS＋中繼」可行；觀察 | https://spec.slim.agntcy.org/draft-mpsb-agntcy-slim.html |
| MCP | HTTP 傳輸用 OAuth 2.1（PKCE、資源指示） | 無 | 借授權設計 | https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization |
| NLIP（Ecma） | 細節未確認 | 未確認 | 觀察 | https://ecma-international.org/news/ecma-international-approves-nlip-standards-suite-for-universal-ai-agent-communication/ |

## 建議
- 加密：先做訊息簽章；之後一律用 MLS（寬鬆授權實作）；明文信封＋加密內文。
- 協定：A2A 當外部代理相容入口（簽章 Agent Card）；外部授權走 OAuth 2.1；經 A2A 進來的訊息標示「非端對端加密」。
