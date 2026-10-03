// 「視窗曾寄信給某節點／視窗」記號的檔名：send.mjs 寫、bridge.mjs 讀（兩邊必須一致）。
import crypto from 'node:crypto'
export const sentMarkName = (fromWindow, toNode, toAgent) =>
  crypto.createHash('sha1').update(JSON.stringify([fromWindow ?? '', toNode ?? '', toAgent ?? ''])).digest('hex')
