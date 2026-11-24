// 測試共用：用 relay-core（沿用 relay/machine 的現成模組）連本機假 relay，組成 AsnCore 的 transport。
import { createCore } from '../../machine/relay-core.mjs'
import { FAKE_KEY } from './fake-relay.mjs'
import { nudgeBody } from '../ui/lib/text.mjs'

export function httpTransport(url, windowName, key = FAKE_KEY) {
  const core = createCore({ baseUrl: url, key, anonKey: '', log: () => {}, workDir: '' })
  const q = encodeURIComponent(windowName)
  return {
    list: () => core.api('list'),
    inbox: () => core.api(`inbox&agent=${q}`),
    ack: ids => core.api(`ack&agent=${q}`, { method: 'POST', body: { ids } }),
    // 照 Rust 的 build_send_body：震動（nudge:true）的內文由「視窗名」組成，nudge 欄位不送給後端
    send: ({ nudge, ...payload }) => core.api('send', { method: 'POST', body: nudge ? { ...payload, body: nudgeBody(windowName) } : payload }),
    sentStatus: ids => core.api('sent_status', { method: 'POST', body: { ids } }).then(r => r?.status ?? []),
    avatar: node => core.api(`avatar&node=${encodeURIComponent(node)}`),
    setAvatar: avatar => core.api('set_avatar', { method: 'POST', body: { avatar } }),
  }
}
export const memStore = (init = null) => {
  // patch：跟後端 settings_patch 一樣——只動給的頂層欄位，null＝刪除，其餘原樣保留（#2162 ⑦）；patches 記下每次送來的欄位
  const s = { data: init, saves: 0, patches: [], load: async () => s.data, save: async d => { s.data = JSON.parse(JSON.stringify(d)); s.saves++ },
    patch: async f => { const p = JSON.parse(JSON.stringify(f)); s.patches.push(p); const d = { ...(s.data ?? {}) }; for (const [k, v] of Object.entries(p)) { if (v === null) delete d[k]; else d[k] = v } s.data = d } }
  return s
}
export const sleep = ms => new Promise(r => setTimeout(r, ms))
