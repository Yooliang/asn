// 回報送出端的薄包裝（#2161 2c-2）：之後各搬遷步驟只 import 這個。指令名只寫在 tauri.mjs 的 reportApi。
import { reportApi } from './tauri.mjs'

export const reportSend = (kind, data) => reportApi.send(kind, data)
