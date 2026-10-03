// 轉接器的「身分判定」登記處（send.mjs／recv.mjs／room.mjs 經 identity.mjs 使用）。
// 每個引擎提供 { engine, inspectCaller() }；inspectCaller 回傳證據 { chain, tableError, viaChain, viaEnv, envSocket, ... }，
// viaChain／viaEnv 命中時是 { pid, name }。findCaller 依序問每個引擎，第一個命中的就是呼叫者所屬的引擎與視窗。
// 新引擎（例如 codex）在這裡加一行；沒有登記的引擎不會被當成寄件人。
import * as claude from './claude-identity.mjs'
import * as codex from './codex-identity.mjs'

export const identityProviders = [
  { engine: 'claude', inspectCaller: claude.inspectCaller, readSession: claude.readSession, sessionsDir: claude.sessionsDir, alivePid: claude.alivePid, processTable: claude.processTable },
  // Codex：環境變數 CODEX_THREAD_ID（codex 對每個 shell 指令注入）對 session_index.jsonl 的名字；排在 claude 後面，claude 視窗裡跑的指令不會有這個變數
  { engine: 'codex', inspectCaller: codex.inspectCaller },
]
