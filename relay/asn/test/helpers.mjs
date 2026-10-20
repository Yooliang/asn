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
    avatar: node => core.api(`avatar&node=${encodeURIComponent(node)}`),
    setAvatar: avatar => core.api('set_avatar', { method: 'POST', body: { avatar } }),
  }
}
export const memStore = (init = null) => {
  const s = { data: init, saves: 0, load: async () => s.data, save: async d => { s.data = JSON.parse(JSON.stringify(d)); s.saves++ } }
  return s
}
export const sleep = ms => new Promise(r => setTimeout(r, ms))
