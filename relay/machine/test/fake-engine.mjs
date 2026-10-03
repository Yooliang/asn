// 轉接器契約測試用的假引擎：只實作介面，不碰 claude。由 IRORI_ENGINES=<本檔路徑> 載入。
// 環境變數：FAKE_ENGINE_WINDOWS（JSON 檔：[{name,status,cwd_label,hidden?}]）、FAKE_ENGINE_RECORD（deliver 記錄檔，一行一筆 JSON）、
//   FAKE_ENGINE_REPLY（有值就在 onSent 後以該視窗名義回覆這段文字）、FAKE_ENGINE_FAIL（有值就回 onFail 而不是 onSent，值＝原因）
import fs from 'node:fs'

export function createEngine({ log, workDir, mailboxName }) {
  let handlers = null
  const read = () => { try { return JSON.parse(fs.readFileSync(process.env.FAKE_ENGINE_WINDOWS, 'utf8')) } catch { return [] } }
  return {
    id: 'fake',
    capabilities: () => ({ listWindows: true, deliver: true, openWindow: false, selfRecv: false, identity: false }),
    start(h) { handlers = h; log(`fake engine started mailbox=${mailboxName} workDir=${workDir}`) },
    stop() {},
    async listWindows() {
      const all = read().map(w => ({ ...w, engine: 'fake', pid: 0 }))
      return { all, windows: all.filter(w => !w.hidden) }
    },
    async listNames() { return new Set(read().map(w => w.name)) },
    activityOf: () => 0,
    deliver({ id, to, text }) {
      fs.appendFileSync(process.env.FAKE_ENGINE_RECORD, JSON.stringify({ id, to, text }) + '\n')
      setTimeout(() => {
        if (process.env.FAKE_ENGINE_FAIL) { void handlers.onFail(id, process.env.FAKE_ENGINE_FAIL); return }
        void handlers.onSent(id)
        if (process.env.FAKE_ENGINE_REPLY) setTimeout(() => void handlers.onReply(to, process.env.FAKE_ENGINE_REPLY), 50)
      }, 20)
    },
  }
}
