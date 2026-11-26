// Rust 端送到畫面的事件表（#2038）：事件名的唯一來源。
// 新增 Rust 事件時要先在這裡登記，test/rust-events-contract.test.mjs 會雙向比對 src-tauri/src 的 emit。
//   scope：'all'＝廣播（所有視窗都收到）；'window'＝只送給發起的那一個視窗（emit_to）
//   platform：'desktop'｜'mobile'｜'both'，只當文件與測試資料，執行期不擋
//   shape：payload 的形狀（文件用；本版不正規化，原樣交給訂閱者）
//   listeners：前端目前有幾種接收處；0＝Rust 送了前端沒人接（契約測試的白名單，不刪 Rust）
export const RUST_EVENTS = Object.freeze({
  // 安裝進度
  'agent-setup': { scope: 'all', platform: 'desktop', shape: '安裝進度 JSON（phase 等）' },
  'agent-setup-remote': { scope: 'all', platform: 'desktop', shape: '{phase,text,cancellable}' },
  // 視窗外框、右下角提示
  'asn:frame': { scope: 'all', platform: 'desktop', shape: 'bool（是否原生外框）' },
  'asn:open': { scope: 'all', platform: 'desktop', shape: '{cid}' },
  'asn:fpshow': { scope: 'window', platform: 'desktop', shape: '{id,until}（指紋 QR 視窗換請求）' },
  // 邀請、正在播放
  'asn:invite': { scope: 'all', platform: 'both', shape: '邀請碼字串' },
  'asn:now-playing': { scope: 'all', platform: 'desktop', shape: '字串' },
  // 下載進度
  'asn:stt-progress': { scope: 'all', platform: 'desktop', shape: '{stage,done,total}' },
  'update-progress': { scope: 'all', platform: 'desktop', shape: '{done,total}' },
  'android-update-progress': { scope: 'all', platform: 'mobile', shape: '{done,total}' },
  // 帳號與登入
  'claude-mod-status': { scope: 'all', platform: 'desktop', shape: '安裝回報物件' },
  'claude-account-auto': { scope: 'all', platform: 'desktop', shape: '物件' },
  'grok-account-auto': { scope: 'all', platform: 'desktop', shape: '物件' },
  'auth-signed-out': { scope: 'all', platform: 'both', shape: '無' },
  'attach-cache-cleared': { scope: 'all', platform: 'both', shape: '無' },
  // 門鈴
  'relay-bell': { scope: 'all', platform: 'both', shape: '{kind}（mail／roster 等；沒帶種類＝null）' },
  'relay-report-bell': { scope: 'all', platform: 'both', shape: '{kind,node}' },
  // 終端
  'term-being-viewed': { scope: 'all', platform: 'desktop', shape: '陣列' },
  'term-req-update': { scope: 'all', platform: 'desktop', shape: 'pending_views()', listeners: 0 },
  'window-spool': { scope: 'all', platform: 'both', shape: '數字（代收區封數）', listeners: 0 },
  'term-view-frame': { scope: 'window', platform: 'desktop', shape: 'ViewFrame{view_id,seq,text,meta}' },
  'term-view-closed': { scope: 'window', platform: 'desktop', shape: '{view_id,reason}' },
  'term-view-input-error': { scope: 'window', platform: 'desktop', shape: '{view_id,message,lost_bytes}' },
  'term-view-remote-frame': { scope: 'window', platform: 'both', shape: '{id,text,meta}' },
  'term-view-remote-end': { scope: 'window', platform: 'both', shape: '{id,text}' },
  'term-view-remote-input-stalled': { scope: 'window', platform: 'both', shape: '{id}', listeners: 0 },
  // 視窗之間的 JS 事件（#2038 PR-7）：由某個視窗的 emit（T.event.emit）廣播給所有視窗（含自己），不是 Rust 送的
  //   origin:'js'＝JS 發的（缺省＝Rust）；from＝送出的視窗；to＝接收的視窗（文件用，執行期不擋）
  'asn:state': { origin: 'js', scope: 'all', platform: 'desktop', shape: '名單快照 { friends, me, ui, … }', from: 'list', to: 'chat,panel' },
  'asn:log': { origin: 'js', scope: 'all', platform: 'desktop', shape: '{ id, log }', from: 'list', to: 'chat' },
  'asn:room': { origin: 'js', scope: 'all', platform: 'desktop', shape: '{ id, cards, note }', from: 'list', to: 'chat' },
  'asn:avatars': { origin: 'js', scope: 'all', platform: 'desktop', shape: '節點→data URL 的物件', from: 'list', to: 'chat,panel' },
  'asn:older': { origin: 'js', scope: 'all', platform: 'desktop', shape: '{ id, more, added, error? }', from: 'list', to: 'chat（一次性）' },
  'asn:attach-done': { origin: 'js', scope: 'all', platform: 'desktop', shape: '{ id, token, ok?, error? }', from: 'list', to: 'chat（一次性）' },
  'asn:panel': { origin: 'js', scope: 'all', platform: 'desktop', shape: '{ kind, key }', from: 'list', to: 'panel' },
  'asn:settings': { origin: 'js', scope: 'all', platform: 'desktop', shape: '設定快照', from: 'list', to: 'panel' },
  'asn:call': { origin: 'js', scope: 'all', platform: 'desktop', shape: '{ id, active }', from: 'chat', to: 'list' },
  'asn:cmd': { origin: 'js', scope: 'all', platform: 'desktop', shape: '{ op, … }', from: 'chat,panel', to: 'list' },
  'asn:set': { origin: 'js', scope: 'all', platform: 'desktop', shape: '{ op, value }', from: 'panel,list', to: 'list' },
  // 外觀：skin-boot.js 是 classic script（要在畫面出來前套好外觀，不能 import），直接聽 Tauri 事件，不經 hub
  'asn:skin': { origin: 'js', scope: 'all', platform: 'desktop', shape: '外觀字串', from: 'list', to: 'skin-boot.js', exception: 'skin-boot' },
})

// 這個事件是 JS 發的（視窗之間），不是 Rust 送的
export const isJsEvent = name => RUST_EVENTS[name]?.origin === 'js'
// Rust 送的事件名（契約測試與 Rust 原始碼的 emit 比對用）
export const rustEventNames = () => Object.keys(RUST_EVENTS).filter(k => !isJsEvent(k))
// JS 發的事件名
export const jsEventNames = () => Object.keys(RUST_EVENTS).filter(isJsEvent)

// 已經搬到 hub 的事件（其餘還是各處直接 listen，之後的 PR 再搬）
export const HUB_MIGRATED = Object.freeze(['agent-setup', 'agent-setup-remote', 'asn:frame', 'asn:open', 'update-progress', 'android-update-progress', 'asn:stt-progress', 'claude-mod-status', 'claude-account-auto', 'grok-account-auto', 'auth-signed-out', 'attach-cache-cleared', 'asn:invite', 'asn:now-playing', 'term-being-viewed', 'relay-bell', 'term-view-frame', 'term-view-closed', 'term-view-input-error', 'term-view-remote-frame', 'term-view-remote-end', 'asn:fpshow', 'asn:state', 'asn:log', 'asn:room', 'asn:avatars', 'asn:older', 'asn:attach-done', 'asn:panel', 'asn:settings', 'asn:call', 'asn:cmd', 'asn:set'])
